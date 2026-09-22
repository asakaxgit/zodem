import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { zodem, resetRegistry } from "@zodem/core";
import { toJsonSchema } from "../src/schema.js";

beforeEach(() => {
  resetRegistry();
});

describe("toJsonSchema: plain conversion", () => {
  it("converts scalars, arrays, enums, and nested objects", () => {
    const User = zodem.message("acme.user.v1.User", {
      id: z.string().uuid(),
      role: z.enum(["admin", "member"]),
      tags: z.array(z.string()),
      address: z.object({ city: z.string(), country: z.string() }),
    });
    const schema = toJsonSchema(User);
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.id?.type).toBe("string");
    expect(props.role?.enum).toEqual(["admin", "member"]);
    expect(props.tags?.type).toBe("array");
    expect(props.address?.type).toBe("object");
  });

  it("supports union/tuple/intersection — constructs the walker/IR rejects outright", () => {
    const schema = z.object({
      shapeOrSize: z.union([z.string(), z.number()]),
      pair: z.tuple([z.string(), z.number()]),
    });
    const result = toJsonSchema(schema);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.shapeOrSize?.type).toEqual(["string", "number"]);
    expect(props.pair?.type).toBe("array");
  });

  it("does not leak zodem's own .meta() keys (proto/field/name/validate) into the output", () => {
    const User = zodem.message("acme.user.v1.User", {
      id: z.string().meta({ proto: "sint32", field: 7 }),
      role: z.enum(["admin", "member"]).meta({ name: "UserRole" }),
      secret: z.string().meta({ validate: false }),
    });
    const schema = toJsonSchema(User);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const prop of Object.values(props)) {
      expect(prop).not.toHaveProperty("proto");
      expect(prop).not.toHaveProperty("field");
      expect(prop).not.toHaveProperty("name");
      expect(prop).not.toHaveProperty("validate");
      expect(prop).not.toHaveProperty("llm");
    }
  });

  it("`.meta({ llm: false })` omits the field entirely", () => {
    const User = zodem.message("acme.user.v1.User", {
      id: z.string(),
      internalOnly: z.string().meta({ llm: false }),
    });
    const schema = toJsonSchema(User);
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["id"]);
    expect(schema.required).toEqual(["id"]);
  });

  it("`.meta({ llm: { name } })` renames the field", () => {
    const User = zodem.message("acme.user.v1.User", {
      displayName: z.string().meta({ llm: { name: "display_name" } }),
    });
    const schema = toJsonSchema(User);
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["display_name"]);
    expect(schema.required).toEqual(["display_name"]);
  });

  it("honors llm meta regardless of which wrapper layer it's applied on", () => {
    const A = zodem.message("acme.a.v1.A", {
      x: z.string().optional().meta({ llm: false }),
      y: z.string().meta({ llm: false }).optional(),
    });
    const schema = toJsonSchema(A);
    expect(schema.properties).toEqual({});
  });

  it("`.describe()` flows through as `description`, on fields and on the object itself", () => {
    const User = zodem
      .message("acme.user.v1.User", {
        email: z.string().describe("The user's email address"),
      })
      .describe("A user account");
    const schema = toJsonSchema(User);
    expect(schema.description).toBe("A user account");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.email?.description).toBe("The user's email address");
  });

  it("the `target` option changes the emitted dialect", () => {
    const A = zodem.message("acme.a.v1.A", { x: z.string() });
    const draft202012 = toJsonSchema(A, { target: "draft-2020-12" });
    const draft07 = toJsonSchema(A, { target: "draft-07" });
    expect(draft202012.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(draft07.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});
