import type { JsonSchema } from "../src/schema.js";

const isRecord = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null;
};

/**
 * `JsonSchema` is `Record<string, unknown>` by deliberate design (see
 * `packages/llm/src/schema.ts`'s module comment) — these tests re-narrow
 * `schema.properties` to assert on nested property schemas. Widening the
 * public type to avoid this would be an API change made for a test's
 * convenience, not a real consumer's need.
 */
export const props = (schema: JsonSchema): Record<string, JsonSchema> => {
  const p = schema.properties;
  if (!isRecord(p)) throw new Error(`expected "properties" on ${JSON.stringify(schema)}`);
  const out: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(p)) {
    if (!isRecord(value)) throw new Error(`expected property "${key}" to be an object schema`);
    out[key] = value;
  }
  return out;
};
