import { z } from "zod";
import { readFieldMeta, type ZodemFieldMeta } from "@zodem/core";

/**
 * Peels the same presence/refinement wrappers `packages/core/src/walker.ts`'s
 * `unwrap()` does, merging `.meta()` outermost-wins — but using only Zod's
 * public `.unwrap()` API (`ZodOptional`/`ZodNullable`/etc. `instanceof`
 * checks), never `_zod.def`. Unlike the walker, @zodem/llm doesn't need
 * type resolution, only the merged `ZodemFieldMeta` for a field, so this
 * stays intentionally minimal: it does not peel `.pipe()` and does not
 * recurse into `z.lazy()` — apply `.meta({ llm })` as the outermost call
 * in the chain for those cases.
 */
type Peeled =
  | z.ZodOptional<z.ZodType>
  | z.ZodNullable<z.ZodType>
  | z.ZodNonOptional<z.ZodType>
  | z.ZodDefault<z.ZodType>
  | z.ZodPrefault<z.ZodType>
  | z.ZodCatch<z.ZodType>
  | z.ZodReadonly<z.ZodType>;

const isPeelable = (schema: z.ZodType): schema is Peeled => {
  return (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  );
};

export const readZodemMeta = (schema: z.ZodType): ZodemFieldMeta => {
  const own = readFieldMeta(schema);
  if (isPeelable(schema)) {
    return { ...readZodemMeta(schema.unwrap()), ...own };
  }
  return own;
};
