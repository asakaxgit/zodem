import { create, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";

/**
 * Bridges a codec's `encode()` output into protobuf-es's generated init
 * types. The shape is guaranteed by construction — the codec is compiled
 * from the same IR the generated code came from — but that's a
 * cross-toolchain guarantee, not one TypeScript can see. This is the single
 * place it's stated, so no caller needs `as never` to pass a codec's output
 * to `create()` or a generated Connect client method.
 */
export function asInit<Desc extends DescMessage>(_schema: Desc, value: Record<string, unknown>): MessageInitShape<Desc> {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the one @zodem/codec ↔ protobuf-es boundary — see the doc comment above.
  return value as MessageInitShape<Desc>;
}

/** `create(schema, asInit(schema, value))` in one call. */
export function createFrom<Desc extends DescMessage>(schema: Desc, value: Record<string, unknown>): MessageShape<Desc> {
  return create(schema, asInit(schema, value));
}
