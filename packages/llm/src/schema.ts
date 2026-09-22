import { z } from "zod";
import { readZodemMeta } from "./meta.js";

/** Plain JSON Schema document — deliberately untyped beyond this (see `packages/llm/src/schema.ts`'s module comment for why). */
export type JsonSchema = Record<string, unknown>;

export type ToJsonSchemaOptions = {
  /** Which JSON Schema dialect to emit. Default `"draft-2020-12"`. */
  target?: "draft-2020-12" | "draft-07" | "draft-04" | "openapi-3.0";
};

// The four keys ZodemFieldMeta can carry (packages/core/src/registry.ts).
// None of these are standard JSON Schema keywords, so any occurrence in the
// output is leakage from Zod's z.globalRegistry — see the module comment.
const ZODEM_META_KEYS = ["field", "proto", "name", "validate", "llm"];

/**
 * Rebuilds a `z.object()`'s shape honoring each field's `.meta({ llm })`:
 * `llm: false` omits the field, `llm: { name }` renames its key in the
 * output shape. Only object shapes are rebuilt — nested/array/etc. schemas
 * are walked structurally so a `.meta({ llm })` on a field nested inside an
 * array element or another object still takes effect, without needing to
 * touch Zod internals (`z.ZodArray`/`z.ZodObject` expose their element/shape
 * publicly).
 */
function applyLlmMeta(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const rebuilt: Record<string, z.ZodType> = {};
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const meta = readZodemMeta(fieldSchema);
      if (meta.llm === false) continue;
      const outKey = meta.llm?.name || key;
      rebuilt[outKey] = applyLlmMeta(fieldSchema);
    }
    const rebuiltObject = z.object(rebuilt);
    // Rebuilding drops any meta (e.g. a top-level .describe()) set directly
    // on the original z.object() itself — carry it over so the reconstructed
    // schema still produces the same description/etc. `.meta()`, not
    // `.register()`: this is a throwaway conversion object with no identity
    // to preserve, and `.meta()` is the public API for "attach this data".
    const ownMeta = z.globalRegistry.get(schema);
    return ownMeta ? rebuiltObject.meta(ownMeta) : rebuiltObject;
  }
  if (schema instanceof z.ZodArray) {
    return z.array(applyLlmMeta(schema.element as z.ZodType));
  }
  if (schema instanceof z.ZodOptional) return z.optional(applyLlmMeta(schema.unwrap() as z.ZodType));
  if (schema instanceof z.ZodNullable) return z.nullable(applyLlmMeta(schema.unwrap() as z.ZodType));
  return schema;
}

/** Recursively strips zodem's own `.meta()` keys wherever `z.toJSONSchema()` merged them in (belt-and-suspenders alongside `applyLlmMeta` — this catches leakage from *nested* `zodem.message()` schemas too, reached via inlined/`$ref`'d definitions). */
function stripZodemKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripZodemKeys);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (ZODEM_META_KEYS.includes(key)) continue;
      out[key] = stripZodemKeys(value);
    }
    return out;
  }
  return node;
}

/**
 * Converts a Zod schema to JSON Schema, deliberately bypassing @zodem/core's
 * walker/IR — that IR is shaped for what protobuf can represent (it rejects
 * z.union()/z.tuple()/z.intersection()/z.map()/z.set()), while JSON Schema
 * has no such restriction and Zod already ships a complete, native
 * converter (`z.toJSONSchema`). Reusing the walker here would be strictly
 * more limited for zero benefit.
 *
 * Handles two things `z.toJSONSchema` doesn't do on its own:
 * `.meta({ llm })` field renaming/omission, and stripping zodem's own
 * `.meta({ proto, field, name, validate })` keys — which ride the same
 * `z.globalRegistry` `.meta()` reads from, and which `z.toJSONSchema` merges
 * into its output with no filtering (verified against Zod 4.6.5's source).
 */
export function toJsonSchema(schema: z.ZodType, opts?: ToJsonSchemaOptions): JsonSchema {
  const shaped = applyLlmMeta(schema);
  const raw = z.toJSONSchema(shaped, { target: opts?.target ?? "draft-2020-12" });
  return stripZodemKeys(raw) as JsonSchema;
}
