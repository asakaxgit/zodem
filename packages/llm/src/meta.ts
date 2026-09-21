import { z } from "zod";
import type { ZodemFieldMeta } from "@zodem/core";

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
const PEELABLE = [
  z.ZodOptional,
  z.ZodNullable,
  z.ZodNonOptional,
  z.ZodDefault,
  z.ZodPrefault,
  z.ZodCatch,
  z.ZodReadonly,
] as const;

export function readZodemMeta(schema: z.ZodType): ZodemFieldMeta {
  const own = (z.globalRegistry.get(schema as never) ?? {}) as ZodemFieldMeta;
  for (const ctor of PEELABLE) {
    if (schema instanceof ctor) {
      const inner = (schema as unknown as { unwrap(): z.ZodType }).unwrap();
      return { ...readZodemMeta(inner), ...own };
    }
  }
  return own;
}
