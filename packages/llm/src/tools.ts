import type { z } from "zod";
import { getRegisteredServices, ZodemError } from "@zodem/core";
import { toJsonSchema, type JsonSchema } from "./schema.js";

export type ToolInput = {
  name: string;
  description?: string;
  input: z.ZodType;
};

export type OpenAiTool = {
  type: "function";
  function: { name: string; description?: string; parameters: JsonSchema };
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: JsonSchema;
};

export type GeminiTool = {
  name: string;
  description?: string;
  parameters: JsonSchema;
};

const isRecord = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null && !Array.isArray(v);
};

/** Recursively forces `additionalProperties: false` on every object node — best-effort toward OpenAI's Structured Outputs strict mode. Not a full strict-mode guarantee: strict mode also requires every property to be listed in `required` (true optionals must be modeled as nullable unions instead), which this does not attempt. */
const forceNoAdditionalPropertiesValue = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(forceNoAdditionalPropertiesValue);
  if (isRecord(node)) return forceNoAdditionalPropertiesObject(node);
  return node;
};

/** `forceNoAdditionalPropertiesValue`'s object case, split out with its own signature: `toOpenAiTool`'s top-level call always has an object (the JSON Schema root), never an array or primitive, so it can call this directly and get `JsonSchema` back with no cast. */
const forceNoAdditionalPropertiesObject = (node: Record<string, unknown>): JsonSchema => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = forceNoAdditionalPropertiesValue(value);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
};

export const toOpenAiTool = (tool: ToolInput): OpenAiTool => {
  const parameters = forceNoAdditionalPropertiesObject(toJsonSchema(tool.input, { target: "draft-07" }));
  return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
};

export const toAnthropicTool = (tool: ToolInput): AnthropicTool => {
  return { name: tool.name, description: tool.description, input_schema: toJsonSchema(tool.input, { target: "draft-07" }) };
};

const hasRef = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(hasRef);
  if (node && typeof node === "object") {
    return Object.entries(node).some(([key, value]) => key === "$ref" || hasRef(value));
  }
  return false;
};

/**
 * Gemini's function-declaration schema (an OpenAPI 3.0 subset) has no `$ref`
 * support. Zod's default `reused: "inline"` behavior already fully inlines
 * any non-cyclic repeated schema (verified against Zod 4.6.5), so `$ref`
 * only ever appears here for a genuinely self-referential type (`z.lazy()`)
 * — which can't be inlined at all, not even in principle. Error instead of
 * emitting broken output, matching `UnsupportedTypeError`'s precedent in
 * the walker.
 */
export const toGeminiTool = (tool: ToolInput): GeminiTool => {
  const parameters = toJsonSchema(tool.input, { target: "openapi-3.0" });
  if (hasRef(parameters)) {
    throw new ZodemError(
      `Gemini's function-declaration schema doesn't support $ref — "${tool.name}"'s input contains a recursive/self-referential type (e.g. via z.lazy()), which can't be inlined for Gemini specifically. Restructure the input to avoid the cycle, or target a different vendor.`,
    );
  }
  return { name: tool.name, description: tool.description, parameters };
};

export type Vendor = "openai" | "anthropic" | "gemini";
export type VendorTool = OpenAiTool | AnthropicTool | GeminiTool;

const WRAPPERS: Record<Vendor, (tool: ToolInput) => VendorTool> = {
  openai: toOpenAiTool,
  anthropic: toAnthropicTool,
  gemini: toGeminiTool,
};

/** Every method of a registered `zodem.service()`, each wrapped as the given vendor's tool-call format. Method names become tool names; `ZodemMethodDef.description` becomes the tool description. */
export const toolsForService = (serviceFullName: string, vendor: Vendor): VendorTool[] => {
  const service = getRegisteredServices().find((s) => s.fullName === serviceFullName);
  if (!service) throw new ZodemError(`no zodem.service() registered as "${serviceFullName}"`);
  const wrap = WRAPPERS[vendor];
  return Object.entries(service.methods).map(([name, method]) => wrap({ name, description: method.description, input: method.input }));
};
