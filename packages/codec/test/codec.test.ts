import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { zodem, resetRegistry, walkRegistry, syncMessage, syncEnum, type IRMessage } from "@zodem/core";
import { loadLock } from "@zodem/core/node";
import { createCodecs } from "../src/codec.js";

beforeEach(() => {
  resetRegistry();
});

function synced(): IRMessage[] {
  const walked = walkRegistry();
  const lock = loadLock("/nonexistent/zodem.lock.json");
  const syncAll = (m: IRMessage): void => {
    syncMessage(m, lock, { allowBreaking: false });
    for (const e of m.nested.enums) syncEnum(e, lock);
    for (const nested of m.nested.messages) syncAll(nested);
  };
  for (const m of walked.messages) syncAll(m);
  return walked.messages;
}

describe("codec: scalars and nesting round-trip", () => {
  it("round-trips the handoff §4 example shape", () => {
    zodem.message("acme.user.v1.User", {
      id: z.string(),
      age: z.number().int().meta({ proto: "int32" }),
      role: z.enum(["admin", "member"]),
      nickname: z.string().optional(),
      address: z.object({ city: z.string(), country: z.string() }),
      createdAt: z.date(),
    });
    const codecs = createCodecs(synced());
    const codec = codecs.get("acme.user.v1.User")!;

    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    const zodValue = {
      id: "u1",
      age: 30,
      role: "admin",
      address: { city: "NYC", country: "US" },
      createdAt,
    };
    const proto = codec.encode(zodValue);
    expect(proto.id).toBe("u1");
    expect(proto.age).toBe(30);
    expect(proto.role).toBe(1); // ROLE_ADMIN = 1
    expect(proto.address).toEqual({ city: "NYC", country: "US" });
    expect(proto.nickname).toBeUndefined(); // omitted, not present in zodValue

    const back = codec.decode(proto);
    expect(back).toEqual(zodValue);
  });

  it("omits an absent optional field on decode rather than emitting undefined", () => {
    zodem.message("acme.a.v1.A", { x: z.string().optional() });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    const decoded = codec.decode({});
    expect("x" in decoded).toBe(false);
  });
});

describe("codec: nullable wrapper round-trip", () => {
  it("maps null <-> absent, and a real value <-> the plain scalar", () => {
    zodem.message("acme.a.v1.A", { bio: z.string().nullable() });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;

    expect(codec.encode({ bio: null })).toEqual({});
    expect(codec.decode({})).toEqual({ bio: null }); // nullable requires the key to be present

    expect(codec.encode({ bio: "hi" })).toEqual({ bio: "hi" });
    expect(codec.decode({ bio: "hi" })).toEqual({ bio: "hi" });
  });
});

describe("codec: repeated fields", () => {
  it("maps arrays element-wise", () => {
    zodem.message("acme.a.v1.A", { tags: z.array(z.string()) });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    expect(codec.encode({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
    expect(codec.decode({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
  });
});

describe("codec: discriminated union <-> oneof ADT", () => {
  it("round-trips through the protobuf-es {case, value} shape", () => {
    const Circle = z.object({ kind: z.literal("circle"), radius: z.number() });
    const Square = z.object({ kind: z.literal("square"), side: z.number() });
    zodem.message("acme.a.v1.Container", { shape: z.discriminatedUnion("kind", [Circle, Square]) });
    const codec = createCodecs(synced()).get("acme.a.v1.Container")!;

    const zodValue = { shape: { kind: "circle" as const, radius: 5 } };
    const proto = codec.encode(zodValue);
    expect(proto.shape).toEqual({ case: "circle", value: { radius: 5 } });

    const back = codec.decode(proto);
    expect(back).toEqual(zodValue);
  });

  it("omits the key when no case is set", () => {
    const Circle = z.object({ kind: z.literal("circle"), radius: z.number() });
    zodem.message("acme.a.v1.Container", { shape: z.discriminatedUnion("kind", [Circle]) });
    const codec = createCodecs(synced()).get("acme.a.v1.Container")!;
    expect(codec.decode({})).toEqual({});
  });
});

describe("codec: maps", () => {
  it("round-trips a map<string, string>", () => {
    zodem.message("acme.a.v1.A", { tags: z.record(z.string(), z.string()) });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    const value = { tags: { en: "hello", ja: "こんにちは" } };
    expect(codec.encode(value)).toEqual({ tags: { en: "hello", ja: "こんにちは" } });
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });

  it("runs the value codec per entry (map<string, enum>)", () => {
    zodem.message("acme.a.v1.A", { rolesByUser: z.record(z.string(), z.enum(["admin", "member"])) });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    const value = { rolesByUser: { alice: "admin" as const, bob: "member" as const } };
    const proto = codec.encode(value);
    expect(proto.rolesByUser).toEqual({ alice: 1, bob: 2 }); // ROLE_ADMIN=1, ROLE_MEMBER=2
    expect(codec.decode(proto)).toEqual(value);
  });
});

describe("codec: z.lazy() recursion", () => {
  it("round-trips a self-referential tree without hitting the stale-placeholder bug", () => {
    interface CategoryShape {
      name: string;
      children: CategoryShape[];
    }
    const Category: z.ZodType<CategoryShape> = zodem.message("acme.cat.v1.Category", {
      name: z.string(),
      children: z.array(z.lazy(() => Category)),
    }) as unknown as z.ZodType<CategoryShape>;

    const codec = createCodecs(synced()).get("acme.cat.v1.Category")!;
    // non-empty children is essential here: an empty array never actually
    // *invokes* the recursive field's encode/decode closure, so it would not
    // have caught the placeholder bug this test exists to guard against.
    const value: CategoryShape = {
      name: "root",
      children: [
        { name: "child-1", children: [] },
        { name: "child-2", children: [{ name: "grandchild", children: [] }] },
      ],
    };

    const proto = codec.encode(value as unknown as Record<string, unknown>);
    expect(proto.children).toHaveLength(2);
    expect((proto.children as Record<string, unknown>[])[1]!.children).toHaveLength(1);

    const back = codec.decode(proto);
    expect(back).toEqual(value);
  });
});

describe("codec: synthesized list-wrapper messages (nested repeated/map values)", () => {
  it("round-trips array-of-array as a plain nested array, not a { values } object", () => {
    zodem.message("acme.a.v1.A", { matrix: z.array(z.array(z.string())) });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    const value = { matrix: [["a", "b"], ["c"]] };

    const proto = codec.encode(value);
    // on the wire this is `repeated MatrixList matrix`, each a { values: [...] } message —
    // but the codec must hide that entirely; the Zod side never sees a wrapper object.
    expect(proto.matrix).toEqual([{ values: ["a", "b"] }, { values: ["c"] }]);
    expect(codec.decode(proto)).toEqual(value);
  });

  it("round-trips a map value that's an array, as a plain array, not a { values } object", () => {
    zodem.message("acme.a.v1.A", { groups: z.record(z.string(), z.array(z.string())) });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    const value = { groups: { fruits: ["apple", "banana"], veggies: ["carrot"] } };

    const proto = codec.encode(value);
    expect(proto.groups).toEqual({ fruits: { values: ["apple", "banana"] }, veggies: { values: ["carrot"] } });
    expect(codec.decode(proto)).toEqual(value);
  });
});

describe("codec: decode() accepts any object, no cast required", () => {
  it("decodes a class instance directly — no `as unknown as Record<string, unknown>` needed", () => {
    // A protobuf-es generated Message is a class instance with no index
    // signature, same shape category as this: decode's parameter type must
    // be `unknown`, not `Record<string, unknown>`, or every real caller
    // would need a cast just to call it. This test would fail to typecheck
    // (not just fail at runtime) if that regressed.
    class FakeProtoMessage {
      city = "Kyoto";
      country = "JP";
    }
    zodem.message("acme.a.v1.A", { city: z.string(), country: z.string() });
    const codec = createCodecs(synced()).get("acme.a.v1.A")!;
    expect(codec.decode(new FakeProtoMessage())).toEqual({ city: "Kyoto", country: "JP" });
  });
});
