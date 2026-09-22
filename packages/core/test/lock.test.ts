import { describe, expect, it } from "vitest";
import {
  emptyLock,
  isWireCompatible,
  markRemovedEntries,
  renameEnumValue,
  renameField,
  renameMessage,
  syncEnum,
  syncMessage,
  typeKey,
  validateLock,
  type LockFile,
} from "../src/lock.js";
import {
  BreakingChangeError,
  LockfileValidationError,
  PinnedNumberMismatchError,
  RenameError,
} from "../src/errors.js";
import type { IREnum, IRMessage, ScalarName } from "../src/ir.js";

const msg = (fullName: string, fields: IRMessage["fields"]): IRMessage => {
  return { fullName, fields, oneofs: [], nested: { messages: [], enums: [] }, reserved: [] };
};

const field = (name: string, typeName: ScalarName = "string"): IRMessage["fields"][number] => {
  return { name, jsonName: name, type: { kind: "scalar", name: typeName }, label: "singular", warnings: [] };
};

describe("syncMessage: allocation", () => {
  it("assigns numbers starting at 1, in field order, and is idempotent", () => {
    const lock = emptyLock();
    const m = msg("a.A", [field("x"), field("y")]);
    syncMessage(m, lock, { allowBreaking: false });
    expect(m.fields.map((f) => f.number)).toEqual([1, 2]);

    const m2 = msg("a.A", [field("x"), field("y")]);
    syncMessage(m2, lock, { allowBreaking: false });
    expect(m2.fields.map((f) => f.number)).toEqual([1, 2]);
  });

  it("reordering Zod keys does not change assigned numbers", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y")]), lock, { allowBreaking: false });

    const reordered = msg("a.A", [field("y"), field("x")]);
    syncMessage(reordered, lock, { allowBreaking: false });
    const byName = Object.fromEntries(reordered.fields.map((f) => [f.name, f.number]));
    expect(byName).toEqual({ x: 1, y: 2 });
  });

  it("a new field gets nextField; existing numbers are untouched", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false });
    const withNew = msg("a.A", [field("x"), field("z")]);
    syncMessage(withNew, lock, { allowBreaking: false });
    expect(withNew.fields.map((f) => f.number)).toEqual([1, 2]);
  });

  it("removing a field reserves it; re-adding gets a new number", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y")]), lock, { allowBreaking: false });

    const removed = msg("a.A", [field("x")]);
    syncMessage(removed, lock, { allowBreaking: false });
    expect(removed.reserved).toEqual([{ number: 2, name: "y" }]);

    const readded = msg("a.A", [field("x"), field("y")]);
    syncMessage(readded, lock, { allowBreaking: false });
    const y = readded.fields.find((f) => f.name === "y")!;
    expect(y.number).toBe(3); // not 2 — a deleted number is never reused, even by its own former name
    expect(readded.reserved).toEqual([{ number: 2, name: "y" }]); // the old reservation is permanent
  });

  it("skips the 19000-19999 implementation-reserved range", () => {
    const lock: LockFile = {
      version: 1,
      messages: { "a.A": { nextField: 18999, fields: {}, reserved: [] } },
      enums: {},
    };
    const m = msg("a.A", [field("x"), field("y")]);
    syncMessage(m, lock, { allowBreaking: false });
    expect(m.fields.map((f) => f.number)).toEqual([18999, 20000]);
  });
});

describe("syncMessage: pinned numbers", () => {
  it("honors a pin on first assignment and bumps nextField past it", () => {
    const lock = emptyLock();
    const f = field("x");
    f.pinned = 5;
    const m = msg("a.A", [f, field("y")]);
    syncMessage(m, lock, { allowBreaking: false });
    expect(m.fields.map((f2) => f2.number)).toEqual([5, 6]);
  });

  it("throws when a pin conflicts with an already-assigned number", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false }); // x -> 1
    const f = field("x");
    f.pinned = 9;
    expect(() => syncMessage(msg("a.A", [f]), lock, { allowBreaking: false })).toThrow(PinnedNumberMismatchError);
  });

  it("throws when a pin targets a reserved number", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y")]), lock, { allowBreaking: false });
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false }); // y -> reserved(2)
    const f = field("z");
    f.pinned = 2;
    expect(() => syncMessage(msg("a.A", [field("x"), f]), lock, { allowBreaking: false })).toThrow(
      PinnedNumberMismatchError,
    );
  });
});

describe("isWireCompatible", () => {
  it("allows identical types", () => {
    expect(isWireCompatible("string", "string").ok).toBe(true);
  });
  it("allows int32 -> int64 silently, warns int64 -> int32", () => {
    expect(isWireCompatible("int32", "int64")).toEqual({ ok: true });
    expect(isWireCompatible("int64", "int32").ok).toBe(true);
    expect(isWireCompatible("int64", "int32").warning).toMatch(/narrowing/u);
  });
  it("allows enum <-> int32 with a warning", () => {
    expect(isWireCompatible("enum:a.A.Role", "int32").ok).toBe(true);
    expect(isWireCompatible("int32", "enum:a.A.Role").ok).toBe(true);
  });
  it("rejects string -> int32", () => {
    expect(isWireCompatible("string", "int32").ok).toBe(false);
  });
});

describe("syncMessage: breaking changes", () => {
  it("throws BreakingChangeError on an incompatible type change", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x", "string")]), lock, { allowBreaking: false });
    expect(() => syncMessage(msg("a.A", [field("x", "int32")]), lock, { allowBreaking: false })).toThrow(
      BreakingChangeError,
    );
  });

  it("succeeds under --allow-breaking and records the new type", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x", "string")]), lock, { allowBreaking: false });
    const m = msg("a.A", [field("x", "int32")]);
    const { warnings } = syncMessage(m, lock, { allowBreaking: true });
    expect(warnings.length).toBeGreaterThan(0);
    expect(m.fields[0]!.number).toBe(1);
    expect(lock.messages["a.A"]!.fields.x!.type).toBe("int32");
  });

  it("treats repeated <-> singular as breaking even for the same element type", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x", "string")]), lock, { allowBreaking: false });
    const repeated = msg("a.A", [{ ...field("x", "string"), label: "repeated" }]);
    expect(() => syncMessage(repeated, lock, { allowBreaking: false })).toThrow(BreakingChangeError);
  });
});

describe("syncEnum", () => {
  const enumIR = (fullName: string, values: string[]): IREnum => {
    return { fullName, values: values.map((v) => ({ name: v.toUpperCase(), zodValue: v })), reserved: [] };
  };

  it("assigns numbers starting at 1 and never stores 0", () => {
    const lock = emptyLock();
    const e = enumIR("a.A.Role", ["admin", "member"]);
    syncEnum(e, lock);
    expect(e.values.map((v) => v.number)).toEqual([1, 2]);
  });

  it("reserves removed values and never reuses their number", () => {
    const lock = emptyLock();
    syncEnum(enumIR("a.A.Role", ["admin", "member"]), lock);
    const shrunk = enumIR("a.A.Role", ["admin"]);
    syncEnum(shrunk, lock);
    expect(shrunk.reserved).toEqual([{ number: 2, name: "MEMBER" }]);
    const regrown = enumIR("a.A.Role", ["admin", "member"]);
    syncEnum(regrown, lock);
    expect(regrown.values.find((v) => v.zodValue === "member")?.number).toBe(3);
  });
});

describe("markRemovedEntries", () => {
  it("marks a message absent from the current schema as removed, and un-marks it if it reappears", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false });
    markRemovedEntries(lock, new Set(), new Set());
    expect(lock.messages["a.A"]!.removed).toBe(true);

    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false });
    expect(lock.messages["a.A"]!.removed).toBeUndefined();
  });
});

describe("validateLock", () => {
  it("accepts a well-formed lockfile", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false });
    expect(() => validateLock(lock)).not.toThrow();
  });

  it("rejects duplicate field numbers", () => {
    const lock: LockFile = {
      version: 1,
      messages: {
        "a.A": {
          nextField: 3,
          fields: { x: { number: 1, type: "string", label: "singular" }, y: { number: 1, type: "string", label: "singular" } },
          reserved: [],
        },
      },
      enums: {},
    };
    expect(() => validateLock(lock)).toThrow(LockfileValidationError);
  });

  it("rejects a number that is both active and reserved", () => {
    const lock: LockFile = {
      version: 1,
      messages: {
        "a.A": {
          nextField: 3,
          fields: { x: { number: 1, type: "string", label: "singular" } },
          reserved: [{ number: 1, name: "old" }],
        },
      },
      enums: {},
    };
    expect(() => validateLock(lock)).toThrow(LockfileValidationError);
  });

  it("rejects nextField that doesn't exceed every assigned number", () => {
    const lock: LockFile = {
      version: 1,
      messages: {
        "a.A": { nextField: 1, fields: { x: { number: 1, type: "string", label: "singular" } }, reserved: [] },
      },
      enums: {},
    };
    expect(() => validateLock(lock)).toThrow(LockfileValidationError);
  });

  it("rejects numbers in the 19000-19999 range", () => {
    const lock: LockFile = {
      version: 1,
      messages: {
        "a.A": { nextField: 19001, fields: { x: { number: 19000, type: "string", label: "singular" } }, reserved: [] },
      },
      enums: {},
    };
    expect(() => validateLock(lock)).toThrow(LockfileValidationError);
  });

  it("rejects an unsupported version", () => {
    expect(() => validateLock({ version: 2, messages: {}, enums: {} })).toThrow(LockfileValidationError);
  });
});

describe("typeKey", () => {
  it("distinguishes message and enum references with the same full name shape", () => {
    expect(typeKey({ kind: "message", fullName: "a.A" })).toBe("a.A");
    expect(typeKey({ kind: "enum", fullName: "a.A" })).toBe("enum:a.A");
  });
  it("renders maps recursively", () => {
    expect(typeKey({ kind: "map", key: "string", value: { kind: "scalar", name: "int32" } })).toBe("map<string,int32>");
  });
  it("ignores IRField.rules — adding/removing a protovalidate rule is never a breaking type change", () => {
    const lock = emptyLock();
    const bare = msg("a.A", [field("name")]);
    syncMessage(bare, lock, { allowBreaking: false });
    expect(bare.fields[0]!.number).toBe(1);

    const withRules = msg("a.A", [
      { ...field("name"), rules: { group: "string", rules: { min_len: 1, max_len: 100 } } },
    ]);
    expect(() => syncMessage(withRules, lock, { allowBreaking: false })).not.toThrow();
    expect(withRules.fields[0]!.number).toBe(1); // same field, same number — not treated as delete+add
  });
});

describe("renameField", () => {
  it("moves the field entry to the new name, keeping its number and type", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y", "int32")]), lock, { allowBreaking: false });

    renameField(lock, "a.A", "y", "z");

    const entry = lock.messages["a.A"]!;
    expect(entry.fields.y).toBeUndefined();
    expect(entry.fields.z).toEqual({ number: 2, type: "int32", label: "singular" });
    expect(entry.fields.x!.number).toBe(1); // untouched
  });

  it("throws when the message isn't in the lockfile", () => {
    expect(() => renameField(emptyLock(), "a.Missing", "x", "y")).toThrow(RenameError);
  });

  it("throws when the old field doesn't exist at all", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false });
    expect(() => renameField(lock, "a.A", "nope", "y")).toThrow(RenameError);
  });

  it("throws a specific message when the old field is reserved, not active", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y")]), lock, { allowBreaking: false });
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false }); // y -> reserved
    expect(() => renameField(lock, "a.A", "y", "z")).toThrow(/reserved/u);
  });

  it("throws when the new name collides with an active field", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y")]), lock, { allowBreaking: false });
    expect(() => renameField(lock, "a.A", "y", "x")).toThrow(RenameError);
  });

  it("throws when the new name collides with a reserved name", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x"), field("y")]), lock, { allowBreaking: false });
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false }); // y -> reserved
    const withZ = msg("a.A", [field("x"), field("z")]);
    syncMessage(withZ, lock, { allowBreaking: false }); // z -> 3
    expect(() => renameField(lock, "a.A", "z", "y")).toThrow(RenameError);
  });
});

describe("renameMessage", () => {
  it("moves the message entry to the new full name, preserving its contents", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", [field("x")]), lock, { allowBreaking: false });

    renameMessage(lock, "a.A", "a.B");

    expect(lock.messages["a.A"]).toBeUndefined();
    expect(lock.messages["a.B"]).toEqual({ nextField: 2, fields: { x: { number: 1, type: "string", label: "singular" } }, reserved: [] });
  });

  it("cascades to nested messages and enums", () => {
    const lock: LockFile = {
      version: 1,
      messages: {
        "a.A": { nextField: 2, fields: {}, reserved: [] },
        "a.A.Address": { nextField: 2, fields: {}, reserved: [] },
      },
      enums: {
        "a.A.Role": { nextValue: 2, values: { ROLE_ADMIN: 1 }, reserved: [] },
      },
    };

    renameMessage(lock, "a.A", "a.B");

    expect(Object.keys(lock.messages).sort()).toEqual(["a.B", "a.B.Address"]);
    expect(Object.keys(lock.enums)).toEqual(["a.B.Role"]);
  });

  it("cascades to every cross-reference elsewhere in the lockfile", () => {
    const lock: LockFile = {
      version: 1,
      messages: {
        "a.A": { nextField: 1, fields: {}, reserved: [] },
        "a.A.Address": { nextField: 1, fields: {}, reserved: [] },
        "a.Other": {
          nextField: 3,
          fields: {
            owner: { number: 1, type: "a.A", label: "singular" },
            address: { number: 2, type: "a.A.Address", label: "singular" },
          },
          reserved: [],
        },
      },
      enums: {
        "a.A.Role": { nextValue: 2, values: { ROLE_ADMIN: 1 }, reserved: [] },
      },
    };
    // a field elsewhere referencing the nested enum
    lock.messages["a.Other"]!.fields.role = { number: 3, type: "enum:a.A.Role", label: "singular" };
    lock.messages["a.Other"]!.nextField = 4;

    renameMessage(lock, "a.A", "a.B");

    const other = lock.messages["a.Other"]!;
    expect(other.fields.owner!.type).toBe("a.B");
    expect(other.fields.address!.type).toBe("a.B.Address");
    expect(other.fields.role!.type).toBe("enum:a.B.Role");
  });

  it("throws when the old message isn't in the lockfile", () => {
    expect(() => renameMessage(emptyLock(), "a.Missing", "a.New")).toThrow(RenameError);
  });

  it("throws when the new full name already exists", () => {
    const lock = emptyLock();
    syncMessage(msg("a.A", []), lock, { allowBreaking: false });
    syncMessage(msg("a.B", []), lock, { allowBreaking: false });
    expect(() => renameMessage(lock, "a.A", "a.B")).toThrow(RenameError);
  });
});

describe("renameEnumValue", () => {
  const enumIR = (fullName: string, values: string[]): IREnum => {
    return { fullName, values: values.map((v) => ({ name: v.toUpperCase(), zodValue: v })), reserved: [] };
  };

  it("moves the value to the new name, keeping its number", () => {
    const lock = emptyLock();
    syncEnum(enumIR("a.A.Role", ["admin", "member"]), lock);

    renameEnumValue(lock, "a.A.Role", "MEMBER", "USER");

    const entry = lock.enums["a.A.Role"]!;
    expect(entry.values.MEMBER).toBeUndefined();
    expect(entry.values.USER).toBe(2);
    expect(entry.values.ADMIN).toBe(1);
  });

  it("throws when the enum isn't in the lockfile", () => {
    expect(() => renameEnumValue(emptyLock(), "a.Missing", "X", "Y")).toThrow(RenameError);
  });

  it("throws a specific message when the old value is reserved, not active", () => {
    const lock = emptyLock();
    syncEnum(enumIR("a.A.Role", ["admin", "member"]), lock);
    syncEnum(enumIR("a.A.Role", ["admin"]), lock); // member -> reserved
    expect(() => renameEnumValue(lock, "a.A.Role", "MEMBER", "USER")).toThrow(/reserved/u);
  });

  it("throws when the new name collides with an active value", () => {
    const lock = emptyLock();
    syncEnum(enumIR("a.A.Role", ["admin", "member"]), lock);
    expect(() => renameEnumValue(lock, "a.A.Role", "MEMBER", "ADMIN")).toThrow(RenameError);
  });
});
