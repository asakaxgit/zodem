import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { zodem, resetRegistry } from "@zodem/core";
import { toOpenAiTool, toAnthropicTool, toGeminiTool, toolsForService } from "../src/tools.js";

beforeEach(() => {
  resetRegistry();
});

function registerService() {
  const CreateUserRequest = zodem.message("acme.user.v1.CreateUserRequest", {
    email: z.string().email(),
  });
  const CreateUserResponse = zodem.message("acme.user.v1.CreateUserResponse", {
    id: z.string(),
  });
  zodem.service("acme.user.v1.UserService", {
    createUser: { input: CreateUserRequest, output: CreateUserResponse, description: "Create a new user" },
  });
  return CreateUserRequest;
}

describe("toOpenAiTool", () => {
  it("wraps as { type: 'function', function: { name, description, parameters } }", () => {
    const input = registerService();
    const tool = toOpenAiTool({ name: "createUser", description: "Create a new user", input });
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("createUser");
    expect(tool.function.description).toBe("Create a new user");
    expect(tool.function.parameters.type).toBe("object");
  });

  it("forces additionalProperties: false on every object node", () => {
    const input = z.object({ nested: z.object({ x: z.string() }) });
    const tool = toOpenAiTool({ name: "t", input });
    expect(tool.function.parameters.additionalProperties).toBe(false);
    const nested = (tool.function.parameters.properties as Record<string, Record<string, unknown>>).nested;
    expect(nested?.additionalProperties).toBe(false);
  });
});

describe("toAnthropicTool", () => {
  it("wraps as { name, description, input_schema }", () => {
    const input = registerService();
    const tool = toAnthropicTool({ name: "createUser", description: "Create a new user", input });
    expect(tool.name).toBe("createUser");
    expect(tool.description).toBe("Create a new user");
    expect(tool.input_schema.type).toBe("object");
  });
});

describe("toGeminiTool", () => {
  it("wraps as { name, description, parameters } with no $ref anywhere", () => {
    const Address = z.object({ city: z.string(), country: z.string() });
    const User = zodem.message("acme.user.v1.User", {
      home: Address,
      work: Address, // reused schema — must not produce a $ref (Zod inlines by default)
    });
    const tool = toGeminiTool({ name: "t", input: User });
    expect(JSON.stringify(tool)).not.toContain("$ref");
    expect(tool.parameters.type).toBe("object");
  });

  it("throws a clear, actionable error for a recursive (z.lazy()) schema", () => {
    const Category = zodem.message("acme.cat.v1.Category", {
      name: z.string(),
      children: z.array(z.lazy(() => Category)),
    });
    expect(() => toGeminiTool({ name: "cat", input: Category })).toThrow(/gemini.*\$ref|recursive|self-referential/i);
  });
});

describe("toolsForService", () => {
  it("maps every method of a registered service through the vendor wrapper", () => {
    registerService();
    const tools = toolsForService("acme.user.v1.UserService", "anthropic");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "createUser", description: "Create a new user" });
  });

  it("throws a clear error for an unregistered service name", () => {
    expect(() => toolsForService("acme.user.v1.NoSuchService", "openai")).toThrow(/no zodem\.service\(\)/);
  });
});
