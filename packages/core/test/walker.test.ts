import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { resetRegistry, zodem } from "../src/registry.js";
import { walkRegistry } from "../src/walker.js";
import type { IRMessage } from "../src/ir.js";

function findNested(msg: IRMessage, shortName: string): IRMessage {
  const found = msg.nested.messages.find((m) => m.fullName.endsWith(`.${shortName}`));
  if (!found) throw new Error(`nested message "${shortName}" not found on ${msg.fullName}`);
  return found;
}

beforeEach(() => {
  resetRegistry();
});

describe("walker: the handoff §4 example", () => {
  it("walks scalars, enum, nested object, array-free optional, and Timestamp", () => {
    zodem.message("acme.user.v1.User", {
      id: z.string().uuid(),
      email: z.string().email(),
      age: z.number().int().min(0).meta({ proto: "int32" }),
      role: z.enum(["admin", "member"]),
      nickname: z.string().optional(),
      address: z.object({ city: z.string(), country: z.string() }),
      createdAt: z.date(),
    });

    const { messages, imports } = walkRegistry();
    expect(messages).toHaveLength(1);
    const user = messages[0]!;
    expect(user.fullName).toBe("acme.user.v1.User");

    const byName = Object.fromEntries(user.fields.map((f) => [f.jsonName, f]));

    expect(byName.id?.type).toEqual({ kind: "scalar", name: "string" });
    expect(byName.id?.label).toBe("singular");

    expect(byName.email?.type).toEqual({ kind: "scalar", name: "string" });

    expect(byName.age?.type).toEqual({ kind: "scalar", name: "int32" });
    expect(byName.age?.warnings).toEqual([]); // .min(0) alone doesn't prove an upper bound, but proto override + min sets `min`

    expect(byName.role?.type).toEqual({ kind: "enum", fullName: "acme.user.v1.User.Role" });
    expect(byName.role?.label).toBe("singular");

    expect(byName.nickname?.type).toEqual({ kind: "scalar", name: "string" });
    expect(byName.nickname?.label).toBe("optional");

    expect(byName.address?.type).toEqual({ kind: "message", fullName: "acme.user.v1.User.Address" });
    const address = findNested(user, "Address");
    expect(address.fields.map((f) => f.jsonName)).toEqual(["city", "country"]);

    expect(byName.createdAt?.type).toEqual({ kind: "wkt", fullName: "google.protobuf.Timestamp" });
    expect(imports.has("google/protobuf/timestamp.proto")).toBe(true);

    const role = user.nested.enums.find((e) => e.fullName === "acme.user.v1.User.Role");
    expect(role?.values).toEqual([
      { name: "ROLE_ADMIN", zodValue: "admin" },
      { name: "ROLE_MEMBER", zodValue: "member" },
    ]);
  });

  it("warns when int32 has no proven bound, and not when a bound is present", () => {
    zodem.message("acme.a.v1.A", {
      unbounded: z.number().int(),
      bounded: z.number().int().min(0).max(1000),
    });
    const [msg] = walkRegistry().messages;
    const byName = Object.fromEntries(msg!.fields.map((f) => [f.jsonName, f]));
    expect(byName.unbounded?.warnings.length).toBeGreaterThan(0);
    expect(byName.bounded?.warnings).toEqual([]);
  });

  it("uses z.int32()/z.int64() top-level format helpers directly", () => {
    zodem.message("acme.a.v1.A", {
      thirtyTwo: z.int32(),
      sixtyFour: z.int64(),
    });
    const [msg] = walkRegistry().messages;
    const byName = Object.fromEntries(msg!.fields.map((f) => [f.jsonName, f]));
    expect(byName.thirtyTwo?.type).toEqual({ kind: "scalar", name: "int32" });
    expect(byName.sixtyFour?.type).toEqual({ kind: "scalar", name: "int64" });
  });
});

describe("walker: nullable -> wrapper types", () => {
  it("wraps a nullable string in google.protobuf.StringValue", () => {
    zodem.message("acme.a.v1.A", { nickname: z.string().nullable() });
    const { messages, imports } = walkRegistry();
    const field = messages[0]!.fields[0]!;
    expect(field.type).toEqual({ kind: "wkt", fullName: "google.protobuf.StringValue" });
    expect(field.label).toBe("singular");
    expect(field.nullable).toBe(true);
    expect(imports.has("google/protobuf/wrappers.proto")).toBe(true);
  });

  it("errors on nullable sint32 (no wrapper type exists)", () => {
    zodem.message("acme.a.v1.A", { x: z.number().int().meta({ proto: "sint32" }).nullable() });
    expect(() => walkRegistry()).toThrow(/wrapper type/i);
  });

  it("errors on nullable repeated", () => {
    zodem.message("acme.a.v1.A", { xs: z.array(z.string()).nullable() });
    expect(() => walkRegistry()).toThrow(/nullable/i);
  });
});

describe("walker: discriminated unions -> oneof", () => {
  it("builds sibling branch messages and a oneof grouping them", () => {
    const Circle = z.object({ kind: z.literal("circle"), radius: z.number() });
    const Square = z.object({ kind: z.literal("square"), side: z.number() });
    zodem.message("acme.shape.v1.Container", {
      shape: z.discriminatedUnion("kind", [Circle, Square]),
    });

    const [msg] = walkRegistry().messages;
    expect(msg!.oneofs).toEqual([
      { name: "shape", zodFieldKey: "shape", discriminatorKey: "kind", fields: ["circle", "square"] },
    ]);
    const circleField = msg!.fields.find((f) => f.name === "circle")!;
    expect(circleField.type).toEqual({ kind: "message", fullName: "acme.shape.v1.Container.ShapeCircle" });
    expect(circleField.oneof).toBe("shape");
    const circleMsg = findNested(msg!, "ShapeCircle");
    // discriminator key itself must not become a field
    expect(circleMsg.fields.map((f) => f.jsonName)).toEqual(["radius"]);
  });

  it("references a registered zodem.message branch instead of re-nesting it", () => {
    const Circle = zodem.message("acme.shape.v1.Circle", { kind: z.literal("circle"), radius: z.number() });
    zodem.message("acme.shape.v1.Container", {
      shape: z.discriminatedUnion("kind", [Circle, z.object({ kind: z.literal("square"), side: z.number() })]),
    });
    const messages = walkRegistry().messages;
    const container = messages.find((m) => m.fullName === "acme.shape.v1.Container")!;
    const circleField = container.fields.find((f) => f.name === "circle")!;
    expect(circleField.type).toEqual({ kind: "message", fullName: "acme.shape.v1.Circle" });
    expect(container.nested.messages.some((m) => m.fullName.endsWith("Circle"))).toBe(false);
  });
});

describe("walker: arrays", () => {
  it("marks array fields repeated and resolves the element type", () => {
    zodem.message("acme.a.v1.A", { tags: z.array(z.string()) });
    const field = walkRegistry().messages[0]!.fields[0]!;
    expect(field.label).toBe("repeated");
    expect(field.type).toEqual({ kind: "scalar", name: "string" });
  });

  it("wraps array-of-array in a synthesized <Field>List message instead of erroring", () => {
    zodem.message("acme.a.v1.A", { grid: z.array(z.array(z.string())) });
    const [msg] = walkRegistry().messages;
    const field = msg!.fields[0]!;
    expect(field.label).toBe("repeated");
    expect(field.type).toEqual({ kind: "message", fullName: "acme.a.v1.A.GridList" });
    const wrapper = msg!.nested.messages.find((m) => m.fullName === "acme.a.v1.A.GridList")!;
    expect(wrapper.fields).toEqual([
      { name: "values", jsonName: "values", type: { kind: "scalar", name: "string" }, label: "repeated", warnings: [] },
    ]);
    expect(wrapper.isListWrapper).toBe(true); // codecs rely on this flag to skip the normal message shape
  });

  it("cascades the wrapper for three levels of nesting, without name collisions", () => {
    zodem.message("acme.a.v1.A", { cube: z.array(z.array(z.array(z.string()))) });
    const [msg] = walkRegistry().messages;
    const field = msg!.fields[0]!;
    // outer array wraps (repeated CubeList) into CubeListList; middle array wraps (repeated string) into CubeList
    expect(field.type).toEqual({ kind: "message", fullName: "acme.a.v1.A.CubeListList" });

    const innerWrapper = msg!.nested.messages.find((m) => m.fullName === "acme.a.v1.A.CubeList")!;
    expect(innerWrapper.fields[0]).toMatchObject({ name: "values", type: { kind: "scalar", name: "string" }, label: "repeated" });

    const outerWrapper = msg!.nested.messages.find((m) => m.fullName === "acme.a.v1.A.CubeListList")!;
    expect(outerWrapper.fields[0]).toMatchObject({
      name: "values",
      type: { kind: "message", fullName: "acme.a.v1.A.CubeList" },
      label: "repeated",
    });
  });
});

describe("walker: meta pin and name override", () => {
  it("carries a .meta({ field }) pin through .optional()", () => {
    zodem.message("acme.a.v1.A", { x: z.string().meta({ field: 5 }).optional() });
    const field = walkRegistry().messages[0]!.fields[0]!;
    expect(field.pinned).toBe(5);
  });

  it("honors .meta({ name }) for a nested object", () => {
    zodem.message("acme.a.v1.A", { addr: z.object({ city: z.string() }).meta({ name: "Location" }) });
    const [msg] = walkRegistry().messages;
    expect(msg!.fields[0]!.type).toEqual({ kind: "message", fullName: "acme.a.v1.A.Location" });
  });
});

describe("walker: unsupported constructs error with a helpful path", () => {
  it("rejects plain z.union()", () => {
    zodem.message("acme.a.v1.A", { u: z.union([z.string(), z.number()]) });
    expect(() => walkRegistry()).toThrow(/discriminatedUnion/);
  });

  it("names the field path in the error", () => {
    zodem.message("acme.a.v1.A", { bad: z.tuple([z.string()]) });
    expect(() => walkRegistry()).toThrow(/acme\.a\.v1\.A\.bad/);
  });
});

describe("walker: maps", () => {
  it("resolves z.record(string, string) to map<string, string>", () => {
    zodem.message("acme.a.v1.A", { tags: z.record(z.string(), z.string()) });
    const field = walkRegistry().messages[0]!.fields[0]!;
    expect(field.type).toEqual({ kind: "map", key: "string", value: { kind: "scalar", name: "string" } });
    expect(field.label).toBe("singular"); // maps carry no optional/repeated keyword
  });

  it("allows an integral/bool key, and a message value", () => {
    zodem.message("acme.a.v1.A", { byId: z.record(z.int32(), z.object({ name: z.string() })) });
    const field = walkRegistry().messages[0]!.fields[0]!;
    expect(field.type).toEqual({ kind: "map", key: "int32", value: { kind: "message", fullName: "acme.a.v1.A.ById" } });
  });

  it("rejects a float/double key", () => {
    zodem.message("acme.a.v1.A", { bad: z.record(z.number(), z.string()) });
    expect(() => walkRegistry()).toThrow(/map keys must be string or an integral/);
  });

  it("rejects a bytes/message/enum key", () => {
    zodem.message("acme.a.v1.A", { bad: z.record(zodem.bytes(), z.string()) });
    expect(() => walkRegistry()).toThrow(/map keys must be string or an integral/);
  });

  it("wraps an array value in a synthesized message (map values can't be repeated directly)", () => {
    zodem.message("acme.a.v1.A", { groups: z.record(z.string(), z.array(z.string())) });
    const [msg] = walkRegistry().messages;
    const field = msg!.fields[0]!;
    expect(field.type).toEqual({ kind: "map", key: "string", value: { kind: "message", fullName: "acme.a.v1.A.GroupsList" } });
    const wrapper = msg!.nested.messages.find((m) => m.fullName === "acme.a.v1.A.GroupsList")!;
    expect(wrapper.fields[0]).toMatchObject({ name: "values", label: "repeated", type: { kind: "scalar", name: "string" } });
  });

  it("rejects an optional/nullable map value", () => {
    zodem.message("acme.a.v1.A", { bad: z.record(z.string(), z.string().optional()) });
    expect(() => walkRegistry()).toThrow(/map values cannot be optional\/nullable/);
  });
});

describe("walker: z.lazy() recursion", () => {
  it("resolves a self-referential tree through a registered zodem.message()", () => {
    interface CategoryShape {
      name: string;
      children: CategoryShape[];
    }
    const Category: z.ZodType<CategoryShape> = zodem.message("acme.cat.v1.Category", {
      name: z.string(),
      children: z.array(z.lazy(() => Category)),
    }) as unknown as z.ZodType<CategoryShape>;

    const [msg] = walkRegistry().messages;
    expect(msg!.fullName).toBe("acme.cat.v1.Category");
    const childrenField = msg!.fields.find((f) => f.jsonName === "children")!;
    expect(childrenField.label).toBe("repeated");
    expect(childrenField.type).toEqual({ kind: "message", fullName: "acme.cat.v1.Category" });
    expect(msg!.nested.messages).toEqual([]); // no re-nesting, just a reference back to itself
  });

  it("throws a clear, actionable error for an unregistered self-referential z.lazy(), instead of stack-overflowing", () => {
    // biome-ignore lint/suspicious/noExplicitAny: self-referential forward declaration needs an escape hatch from the type checker
    const Self: any = z.lazy(() => z.object({ next: Self.optional() }));
    zodem.message("acme.a.v1.A", { self: Self });
    expect(() => walkRegistry()).toThrow(/self-referential z\.lazy\(\).*zodem\.message/s);
  });
});

describe("walker: services", () => {
  it("requires <Method>Request / <Method>Response naming", () => {
    const Req = zodem.message("acme.a.v1.GetThingRequest", { id: z.string() });
    const Res = zodem.message("acme.a.v1.GetThingResponse", { id: z.string() });
    zodem.service("acme.a.v1.ThingService", { getThing: { input: Req, output: Res } });
    const { services } = walkRegistry();
    expect(services[0]!.methods[0]).toMatchObject({
      name: "GetThing",
      input: "acme.a.v1.GetThingRequest",
      output: "acme.a.v1.GetThingResponse",
      clientStreaming: false,
      serverStreaming: false,
    });
  });

  it("rejects a mismatched response name", () => {
    const Req = zodem.message("acme.a.v1.GetThingRequest", { id: z.string() });
    const Res = zodem.message("acme.a.v1.Thing", { id: z.string() });
    zodem.service("acme.a.v1.ThingService", { getThing: { input: Req, output: Res } });
    expect(() => walkRegistry()).toThrow(/RPC_RESPONSE_STANDARD_NAME/);
  });
});
