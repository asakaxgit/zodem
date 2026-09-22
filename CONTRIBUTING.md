# Contributing

## Setup

```bash
pnpm install
pnpm build      # required before typecheck — see "Build order" below
pnpm test
pnpm typecheck
pnpm typecheck:tests
pnpm lint
```

| Script | What it does |
|---|---|
| `pnpm build` | Builds every package (`tsup`). |
| `pnpm test` | Runs every package's Vitest suite. The CLI suite spawns the real built `zodem` binary as a subprocess rather than calling `generate()` in-process — see the comment at the top of `packages/cli/test/generate.test.ts` for why (a Vite/jiti module-graph split that doesn't exist for a real invocation). |
| `pnpm typecheck` | `tsc --noEmit` in every package, scoped to `src/` only (each package's `tsconfig.json` has `rootDir: "src"`). |
| `pnpm typecheck:tests` | `tsc -p tsconfig.test.json`, the *only* thing that type-checks `test/` directories. Add new test-scoped source files to that config's `include`, not to a package's own `tsconfig.json`. |
| `pnpm lint` / `pnpm lint:fix` | Biome, config at `biome.json`. Formatting is off (see the file's own note: turning it on would mass-reformat existing style for no benefit) — this is a linter-only setup. |
| `pnpm example:generate:check` | Fails if `examples/fullstack/shared`'s schemas changed but the committed `.proto`/lockfile weren't regenerated. This is the guarantee the whole project sells, so treat any diff here as a real signal, not noise to `--check` away. |
| `pnpm example:buf:lint` | Runs `buf lint`/`buf build` against the generated output. |

### Build order

`@zodem/core`'s `package.json` resolves its types from `dist/`, so packages that
depend on it (`proto`, `codec`, `cli`, `llm`) can't type-check against a
workspace sibling that hasn't been built yet. Run `pnpm build` before
`pnpm typecheck`, and re-run `pnpm install` once after a fresh clone's first
build — pnpm links workspace `bin` entries (e.g. `zodem`) at install time, and
on a clean checkout `dist/` doesn't exist yet for that first install to find.
This exact sequence is in `.github/workflows/ci.yml`; mirror it locally if
something passes for you but fails in CI.

## Code style

Style is enforced by Biome (`biome.json`), not by convention alone — `pnpm
lint` is part of CI. The rules worth knowing the *reasoning* behind, because
they'll shape how you write new code here:

### `type` over `interface`

`style.useConsistentTypeDefinitions` (`style: "type"`). Not purely
cosmetic: a `type` alias for an object shape gets an implicit index
signature that an `interface` doesn't, which is what lets a value typed via
one satisfy a `Record<string, unknown>`-shaped parameter with no cast. See
`packages/codec/test/codec.test.ts`'s recursive `CategoryShape` fixture for a
case where this mattered in practice.

### Arrow functions over `function` declarations

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

### No unsafe type assertions — fix the type at the boundary, don't cast past it

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
explaining *why no annotation or predicate can express this*. As of this
writing there are six, and that's the complete list — if you find yourself
needing a seventh, look hard for a boundary fix first (most casts turn out
to be one):

| Site | Why |
|---|---|
| `packages/core/src/walker.ts:91` (`defOf`) | The one crossing into Zod's `_zod.def`, the sanctioned library-author API (zod.dev/library-authors) — not on the public `z.ZodType` surface. |
| `packages/core/src/walker.ts:130` (`checkDefsOf`) | Same boundary, check side. |
| `packages/core/src/lock.ts:389` (inside `validateLock`) | The function's whole job is turning an unvalidated value into a `LockFile`; this is the one crossing it makes to do that, with every field guarded before use downstream. |
| `packages/codec/src/protobuf.ts:12` (`asInit`) | The `@zodem/codec` ↔ protobuf-es boundary: the shape is guaranteed by construction (both sides are compiled from the same IR), which is a cross-toolchain guarantee, not one TypeScript can see. |
| `packages/core/test/walker.test.ts:231` | A test that deliberately bypasses a compile-time constraint (`z.record()`'s own key-type parameter) to prove the *walker* also rejects the same input at runtime. |
| `examples/fullstack/shared/src/codecs.ts:14` | Deliberately **unvalidated**, per that file's own comment: it prefers "availability over strictness" for a lockfile read that never persists, so adding `validateLock()` there would introduce a throw path the file intentionally avoids. |

(There's also one pre-existing `as unknown as z.ZodType<CategoryShape>`-shaped
situation you may run into if you write a self-referential `z.lazy()`
fixture: break the cycle with an explicitly-typed indirection instead of
casting — see `packages/codec/test/codec.test.ts`'s `categoryRef` pattern,
which needs no cast at all.)

### `noNonNullAssertion` is off, on purpose

The codebase uses `!` pervasively where a guard a few lines above already
proves the value is present (`noUncheckedIndexedAccess` is on, so indexed
access is `T | undefined` even after an `in`/`.length`/`.has()` check that
doesn't itself narrow the indexed-access expression). Prefer `!` over a cast
in exactly that situation — it asserts precisely the one thing that isn't
proven (possible `undefined`), not a whole different type.

### Type-aware rules need the `types` domain

`noFloatingPromises`, `noMisusedPromises`, `useAwaitThenable`,
`noMisleadingReturnType`, and `noUselessTypeConversion` all require Biome's
type-inference engine, turned on via `linter.domains.types` in `biome.json`.
This is set to `"recommended"`, not `"all"` — `"all"` also silently enables
`suspicious/noUnnecessaryConditions` and `suspicious/useArraySortCompare`,
neither of which is otherwise configured. If you add another type-aware rule,
confirm it actually fires (test it against a deliberately-bad snippet) rather
than assuming listing it under `nursery` is enough — without the domain
enabled, these rules are silent no-ops.

## Pull requests

- Keep commits small and focused on one change each — see the git history
  for the granularity this project uses (a mechanical rename/reformat stays
  separate from the semantic change it enables).
- CI (`.github/workflows/ci.yml`) runs the full sequence in the table above
  plus `buf breaking` (informational only, doesn't gate merge). All of it
  must pass except that last one.
- If a change alters generated `.proto` or lockfile output, say so explicitly
  in the PR description — `pnpm example:generate:check` will catch an
  *unintentional* diff, but it can't tell you whether an intentional one is
  correct.
