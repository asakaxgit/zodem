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

    const back = codec.decode(proto as Record<string, unknown>);
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

    const back = codec.decode(proto as Record<string, unknown>);
    expect(back).toEqual(zodValue);
  });

  it("omits the key when no case is set", () => {
    const Circle = z.object({ kind: z.literal("circle"), radius: z.number() });
    zodem.message("acme.a.v1.Container", { shape: z.discriminatedUnion("kind", [Circle]) });
    const codec = createCodecs(synced()).get("acme.a.v1.Container")!;
    expect(codec.decode({})).toEqual({});
  });
});
