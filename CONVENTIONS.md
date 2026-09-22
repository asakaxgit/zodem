# Conventions

The rules this codebase follows and why, not just what to run. `pnpm lint` enforces most of
this (`biome.json`) — this document is for the reasoning Biome's error message doesn't have
room for, and for the handful of things it can't check at all.

## `type` over `interface`

`style.useConsistentTypeDefinitions` (`style: "type"`). Not purely
cosmetic: a `type` alias for an object shape gets an implicit index
signature that an `interface` doesn't, which is what lets a value typed via
one satisfy a `Record<string, unknown>`-shaped parameter with no cast. See
`packages/codec/test/codec.test.ts`'s recursive `CategoryShape` fixture for a
case where this mattered in practice.

## Arrow functions over `function` declarations

`nursery.useConsistentFunctionStyle` (`style: "expression"`). `const foo =
(...) => {...}`, not `function foo(...) {...}`. Two things TypeScript itself
cares about here that Biome won't warn you about ahead of time:

- **Assertion functions** (`asserts x is T`) need either a function
  declaration or a variable with an explicit function-type annotation —
  TypeScript won't infer an assertion signature from a bare arrow function's
  body. See `packages/core/src/lock.ts`'s `validateLock` for the pattern:
  `export const validateLock: (lock: unknown) => asserts lock is LockFile = (lock) => {...}`.
- Generator functions, and functions that rely on their own `this` or
  `arguments`, can't become arrow functions at all. There are none of these
  among the project's plain module-level functions today; if you add one
  (e.g. a class method needing dynamic `this`), it's exempt from this rule
  by definition — methods aren't covered by it.

## No unsafe type assertions — fix the type at the boundary, don't cast past it

`nursery.noUnsafeTypeAssertion` bans `as X` other than `as const`. The
project's default move when a value's real type is wider than what a
function needs is to **widen the function's own signature to match reality**
(so every caller drops its cast), not to assert past the mismatch at each
call site. This is exactly what
[#10](https://github.com/asakaxgit/zodem/pull/10) did for `Codec.decode`
(`Record<string, unknown>` → `unknown`, because the real input — a
protobuf-es `Message` instance — has no index signature), and it's the
pattern this repeats throughout:

- **`packages/core/src/walker.ts`**'s `defOf()`/`checkDefsOf()` replaced a
  `Record<string, any>` view of Zod's internals with a real discriminated
  union of Zod's own exported `z.core.$Zod*Def`/`$ZodCheck*Def` types, so
  `switch (def.type)` narrows natively everywhere downstream — no casts, no
  `any`.
- **`packages/codec/src/codec.ts`**'s compiled steps take `unknown`, not
  `Record<string, unknown>`, for the same reason `Codec.decode` does.
- **`packages/core/src/registry.ts`**'s `readFieldMeta()` reads Zod's
  `.meta()` registry (an open `{ [k: string]: unknown }` bag) by checking
  each of zodem's own keys, not by asserting the whole blob into
  `ZodemFieldMeta`.
- **`packages/codec/src/protobuf.ts`**'s `asInit()`/`createFrom()` are the
  single place a codec's plain-object output is asserted into protobuf-es's
  generated `MessageInitShape<Desc>`, so no caller needs `as never`.

A small `isRecord(v): v is Record<string, unknown>` predicate — `typeof v ===
"object" && v !== null` — recurs in several packages (`codec.ts`,
`registry.ts`, `schema.ts`, `tools.ts`). It's **deliberately duplicated**
rather than pulled into a shared util: most of these packages only import
`@zodem/core`'s types (erased by `verbatimModuleSyntax`), and a three-line
predicate isn't worth adding a real runtime dependency edge between
packages to share.

For a value whose kind is a compile-time-only distinction (e.g. telling
`z.discriminatedUnion()` apart from a plain `z.union()`, both `type:
"union"`), write a named type predicate instead of an inline
`typeof`/`instanceof` check — see `isPeelable()`
(`packages/llm/src/meta.ts:23`) and `isDiscriminatedUnionDef()`
(`packages/core/src/walker.ts:836`) for the shape: a function ending in
`: x is T`, with a comment explaining what distinguishes `T` from its
siblings.

**When a cast genuinely can't be avoided** — the value's realness is
guaranteed by something outside the type system (a documented library
contract, a cross-toolchain invariant), not just inconvenient to express —
fold every caller through one named, single-purpose function and put exactly
one `// biome-ignore lint/nursery/noUnsafeTypeAssertion: <reason>` on it,
explaining *why no annotation or predicate can express this*. Where a cheap
runtime check can narrow the gap even a little, add it immediately before
the cast rather than jumping straight to the ignore — four of the six below
do this: a malformed value now fails loudly, right at the boundary, instead
of surfacing as a confusing crash somewhere downstream (or, worse, silently
producing wrong output). As of this writing there are six sites, and that's
the complete list — if you find yourself needing a seventh, look hard for a
boundary fix first (most casts turn out to be one):

| Site | Validated before the cast | Why the cast itself is still needed |
|---|---|---|
| `packages/core/src/walker.ts:100` (`defOf`) | `def.type` is checked to be a `string` (throws a clear `ZodemError` naming the actual value otherwise). | The remaining crossing into Zod's `_zod.def`, the sanctioned library-author API (zod.dev/library-authors) — narrowing which *specific* def shape it is isn't on the public `z.ZodType` surface. |
| `packages/core/src/walker.ts:144` (`checkDefsOf`) | Same check, `cdef.check` is a `string`. | Same boundary, check side. |
| `packages/core/src/lock.ts:447` (inside `validateLock`) | `messages`/`enums` are objects; each entry is an object; each entry's `fields`/`values`/`reserved` are checked structurally (right type, right shape) before any of them is read — see `validateFieldsMap`/`validateReservedList`/`validateValuesMap` just above it. | The one remaining crossing this assertion function makes, narrowing the now-validated shape to the nominal `LockFile` type it's proven to match. |
| `packages/codec/src/protobuf.ts:27` (`asInit`) | Every key in `value` is checked against the schema's real field and oneof-group names (`schema.field`, `schema.oneofs`), catching a naming-derivation mismatch between the codec and protobuf-es before it would otherwise be silently dropped by `create()`. | Each field's *value* still can't be checked without re-deriving protobuf-es's own per-field-type validation — `create()` does that part. |
| `packages/core/test/walker.test.ts:231` | Not applicable — the test's whole point is to construct deliberately invalid input. | Bypasses `z.record()`'s own compile-time key-type constraint on purpose, to prove the *walker* also rejects the same input at runtime. |
| `examples/fullstack/shared/src/codecs.ts:14` | Deliberately **not** validated — see below. | A JSON import's inferred type is already a structural guess, not a checked one. |

That last one is a real, considered exception, not an oversight: the
surrounding comment states the file prefers "availability over strictness"
for a lockfile read that never persists (it's a browser-side module-init
path), so calling `validateLock()` there would add a throw this file
deliberately doesn't want. If that tradeoff ever changes, `validateLock()` is
already there, importable, and does the full check described above.

(There's also one pre-existing `as unknown as z.ZodType<CategoryShape>`-shaped
situation you may run into if you write a self-referential `z.lazy()`
fixture: break the cycle with an explicitly-typed indirection instead of
casting — see `packages/codec/test/codec.test.ts`'s `categoryRef` pattern,
which needs no cast at all.)

## `noNonNullAssertion` is off, on purpose

The codebase uses `!` pervasively where a guard a few lines above already
proves the value is present (`noUncheckedIndexedAccess` is on, so indexed
access is `T | undefined` even after an `in`/`.length`/`.has()` check that
doesn't itself narrow the indexed-access expression). Prefer `!` over a cast
in exactly that situation — it asserts precisely the one thing that isn't
proven (possible `undefined`), not a whole different type.

## Type-aware rules need the `types` domain

`noFloatingPromises`, `noMisusedPromises`, `useAwaitThenable`,
`noMisleadingReturnType`, and `noUselessTypeConversion` all require Biome's
type-inference engine, turned on via `linter.domains.types` in `biome.json`.
This is set to `"recommended"`, not `"all"` — `"all"` also silently enables
`suspicious/noUnnecessaryConditions` and `suspicious/useArraySortCompare`,
neither of which is otherwise configured. If you add another type-aware rule,
confirm it actually fires (test it against a deliberately-bad snippet) rather
than assuming listing it under `nursery` is enough — without the domain
enabled, these rules are silent no-ops.
