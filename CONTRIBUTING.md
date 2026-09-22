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

Enforced by Biome, and `pnpm lint` is part of CI — but knowing *why* a rule
is set the way it is will save you from re-deriving it under review. See
**[CONVENTIONS.md](CONVENTIONS.md)** for the reasoning, with a concrete
example from the codebase for each: `type` over `interface`, arrow functions
over declarations (and the one TypeScript gotcha that trips up), the
project's "fix the type at the boundary, don't cast past it" policy for type
assertions (with the complete list of the six places a cast is genuinely
unavoidable), why `noNonNullAssertion` is off, and a gotcha around the
type-aware lint rules needing Biome's `types` domain explicitly enabled.

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
- If your change should ship a new version of a `@zodem/*` package, run
  `pnpm changeset` and commit the file it generates — see
  [RELEASING.md](RELEASING.md) for the full release flow (publishing is
  automated; you never run `npm publish` yourself).
