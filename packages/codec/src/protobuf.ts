import { create, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";

/**
 * Bridges a codec's `encode()` output into protobuf-es's generated init
 * types. The shape is guaranteed by construction — the codec is compiled
 * from the same IR the generated code came from — but that's a
 * cross-toolchain guarantee, not one TypeScript can see. This is the single
 * place it's stated, so no caller needs `as never` to pass a codec's output
 * to `create()` or a generated Connect client method.
 */
export const asInit = <Desc extends DescMessage>(schema: Desc, value: Record<string, unknown>): MessageInitShape<Desc> => {
  // Every real key `Codec.encode()` produces is either a plain field's own
  // `localName` or a oneof group's `localName` (protobuf-es's naming for
  // the `{ case, value }` accessor) — this is what the cast below actually
  // claims. Checking it here catches a naming-derivation mismatch between
  // `@zodem/codec`'s snake_case -> camelCase conversion and protobuf-es's
  // own, at the one place it would otherwise be silently dropped by
  // `create()` instead of raising anywhere.
  const validKeys = new Set([...Object.keys(schema.field), ...schema.oneofs.map((o) => o.localName)]);
  for (const key of Object.keys(value)) {
    if (!validKeys.has(key)) {
      throw new Error(
        `asInit: "${key}" is not a field of "${schema.typeName}" (known fields: ${[...validKeys].join(", ") || "<none>"})`,
      );
    }
  }
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the one @zodem/codec ↔ protobuf-es boundary — see the doc comment above. Every key is now checked to name a real field or oneof group; the value each maps to still can't be checked without re-deriving protobuf-es's own field-type validation.
  return value as MessageInitShape<Desc>;
};

/** `create(schema, asInit(schema, value))` in one call. */
export const createFrom = <Desc extends DescMessage>(schema: Desc, value: Record<string, unknown>): MessageShape<Desc> => {
  return create(schema, asInit(schema, value));
};
