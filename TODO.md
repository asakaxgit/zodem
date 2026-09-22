# TODO

Reconciled from the original project handoff doc against the current codebase. Checked items
are verified shipped (tests pass, behavior confirmed in this repo); unchecked items are not
yet implemented anywhere in the tree.

## Priority

- [x] **Japanese documentation** — `README.ja.md`, full translation, linked from the top of
      both READMEs via a language switcher. Code blocks/CLI output/error text kept verbatim in
      English (literal tool output must stay accurate); only prose, headings, and table
      descriptions are translated. Internal anchors retargeted to the Japanese headings.

## Roadmap phases

- [x] **Phase 1 — MVP generator**: walker, IR, lockfile (load/validate/sync/write), `.proto`
      emitter for scalars, objects (top-level + nested), enums, arrays, optionals, `z.date()`;
      `zodem generate` / `zodem generate --check`; discriminated-union → `oneof` spike
- [x] **Phase 1.5 — `zodem rename`**: `field`, `message`, `enum-value`, all lockfile-only and
      number-preserving
- [x] **Phase 2 — structure**: maps (`z.record` → `map<K,V>`), full oneof support, `z.lazy()`
      recursion, remaining well-known types, collection wrapper messages for nested
      repeated/map values, multi-package output with cross-package imports
- [x] **Phase 3 — safety**
  - [x] removed messages/enums are tombstoned (`removed: true`, warned on generate, field/value
        numbers kept claimed) rather than dropped
  - [x] `buf breaking` as an optional extra CI check — `example:buf:lint` runs blocking, and
        `example:buf:breaking` runs on every PR (`continue-on-error: true`, reports drift against
        `main` without gating the merge); `buf lint`/`buf build` still also run in the CLI suite
- [x] **Phase 4 — services**: `zodem.service()` → `service`/`rpc` emission, including
      `stream: "server" | "client" | "bidi"`
- [x] **Phase 5 — validation**: emit `buf.validate` (protovalidate) annotations from Zod checks
      (`min`, `max`, `email`, `uuid`, `regex`, …), opt-in via `validate: true` in
      `zodem.config.ts` (default off — existing output stays byte-identical), per-field opt-out
      via `.meta({ validate: false })`. Rules are always collected into the IR regardless of the
      flag, never touch the lockfile's type key, so adding/removing a check is never a breaking
      change. The full-stack example vendors `buf/validate/validate.proto` and turns it on.
- [x] **Phase 6 — runtime**: `@zodem/codec` (Zod value ↔ protobuf-es object), Connect-ES
      server/client wiring — demonstrated end-to-end in `examples/fullstack/`

## Open design questions from the handoff — how they actually landed

- [x] `z.number()` default scalar — shipped as **`double`** (the handoff's own proposal was
      `int64`); `.int()` / a `z.int32()`/`z.int64()` format, or `.meta({ proto: "..." })`,
      override it
- [x] `.nullable()` semantics — shipped as a **`google.protobuf.*Value` wrapper** (the handoff
      floated plain `optional` as the default instead); `sint*`/`fixed*` scalars have no
      wrapper and throw rather than silently picking one
- [x] Output file naming convention — `outputPathFor()`: package name with its trailing
      version segment (`v1`, `v2beta1`, …) stripped for the file base, e.g.
      `acme.user.v1` → `acme/user/v1/user.proto`
- [x] Codec design — shipped as a **runtime**, IR-driven codec, not generated code
- [x] Whether to move protovalidate emission earlier than Phase 5 — resolved by shipping it now,
      as part of closing out the remaining TODO items rather than waiting

## Not yet built

- [x] JSON Schema / LLM tool-call & structured-output emission — this is the "AI" destination
      in the README tagline. Shipped as `@zodem/llm`, deliberately **not** built on the
      walker/IR: that IR is protobuf-shaped (rejects `z.union()`/`z.tuple()`/`z.intersection()`/
      `z.map()`/`z.set()`), and Zod 4.6.5 already ships a complete native `z.toJSONSchema()` that
      has none of those restrictions — reusing the walker would have been strictly more limited
      for no benefit. Built directly on `@zodem/core`'s existing `getRegisteredMessages()` /
      `getRegisteredServices()` plus Zod's own schema + `toJSONSchema()`. Two small additive
      changes to `@zodem/core`: `ZodemFieldMeta` gained `llm?: false | { name? }` (omit/rename a
      field for the LLM-facing schema only) and `ZodemMethodDef` gained `description?: string`
      (there was no slot for a tool-level description). Also strips zodem's own
      `.meta({ proto, field, name, validate })` keys, which ride the same `z.globalRegistry`
      `toJSONSchema()` reads from and which it otherwise merges into the output unfiltered
      (confirmed against Zod's source) — this was the concrete bug the design had to solve, not
      just a theoretical concern. `toOpenAiTool`/`toAnthropicTool`/`toGeminiTool` wrap a method's
      schema per vendor; Gemini's `$ref`-free OpenAPI-3.0-subset schema throws a clear error for
      genuinely self-referential (`z.lazy()`) input rather than emit broken output, since that
      can't be represented at all, not just inconveniently. Considered depending on the
      third-party `llm-abi` for vendor lowering — passed on it (created 3 weeks prior, v0.5.2,
      1 star, single maintainer) in favor of a small first-party lowering layer.
- [ ] `zodem-form` (naming TBD — `@zodem/form` would match the existing `@zodem/{proto,codec,cli}`
      scoping convention better) — generate a form schema (fields + constraints). Deferred; the
      same "build on the real Zod schema, not the protobuf-shaped walker/IR" reasoning behind
      `@zodem/llm` likely applies here too (forms don't need field-number stability either, and
      JSON Schema is already the native input format for form-rendering libraries like
      react-jsonschema-form), but the actual output shape — field list vs. JSON-Schema-plus-
      UI-schema, widget-hint vocabulary — hasn't been explored. Needs its own planning pass,
      likely reusing `@zodem/llm`'s `toJsonSchema`/meta-stripping machinery rather than
      duplicating it. Open questions from the original handoff: framework-agnostic output vs.
      optional framework bindings (mirroring how `@zodem/codec` stays runtime-agnostic while the
      fullstack example wires up React); package scope/naming.
- [x] A lint script / lint config — root-level `biome.json` (linter only, formatter off to
      avoid mass-reformatting the existing style; `noNonNullAssertion` off, since the codebase
      uses `!` pervasively and deliberately), `pnpm lint` / `pnpm lint:fix`, wired into CI
- [x] Enable `nursery/noUnsafeTypeAssertion` in `biome.json` — the real count was 80 sites, not
      ~40, but they collapsed into five shared root causes (`walker.ts`'s `Record<string, any>`
      def boundary, every codec step being narrowly typed, `validateLock`'s trusted-input
      signature, `JsonSchema`'s open shape, and protobuf-es's exact `MessageInitShape`), each
      fixed once at its boundary — the `cba41fb` move applied four more times. `walker.ts`'s
      `AnyDef` became a real discriminated union of Zod's own exported `z.core.$Zod*Def`/
      `$ZodCheck*Def` types, so `switch (def.type)` narrows natively with zero casts. Landed
      6 permanent `biome-ignore`s (down from 80 sites): two in `walker.ts` (`defOf`/
      `checkDefsOf`, the sanctioned `_zod.def` crossing), one in `lock.ts` (`validateLock`,
      an assertion function whose job is discharging exactly that assertion), one in
      `@zodem/codec` (`asInit`, the codec↔protobuf-es boundary), one in a test fixture (a
      self-referential `z.lazy()` schema, Zod's own documented escape hatch), one in an
      example (`lockJson as LockFile`, deliberately unvalidated per that file's own
      availability-over-strictness design). Also enabled alongside it, per further
      discussion: `useConsistentFunctionStyle` (arrow functions over `function` declarations,
      148 sites, via a one-off codemod — no autofix exists for this rule), `useExhaustiveSwitchCases`,
      the type-aware promise-safety trio (`noFloatingPromises`/`noMisusedPromises`/
      `useAwaitThenable`) plus `noMisleadingReturnType` and `noUselessTypeConversion`
      (`domains: { types: "recommended" }`), and several near-zero-violation idiom rules
      (`useNullishCoalescing`, `useRegexpTest`, `useStringStartsEndsWith`, `useIncludes`,
      `noNegationInEqualityCheck`, `useUnicodeRegex`), plus `useConsistentTypeDefinitions`
      (`type` over `interface`, under `style` since it's stable).
- [ ] A `LICENSE` file — repo currently has none
- [x] A `LICENSE` file — MIT, added at the repo root; `"license": "MIT"` added to the root
      workspace and the four `@zodem/*` package.json files (not the private `@example/*` demo
      packages)

## Branding / publishing action items (handoff, for the human owner)

- [x] Automated npm publishing — `.github/workflows/release.yml`, Changesets-driven, using
      npm's OIDC "trusted publishing" (no `NPM_TOKEN` in CI). All five `@zodem/*` packages
      (`core`, `proto`, `codec`, `cli`, `llm` — the handoff's list above predates `llm`) are
      no longer `"private": true`, and carry the `files`/`publishConfig`/`repository` metadata
      publishing needs. See `RELEASING.md`.
- [ ] Publish a placeholder `zodem` package on npm
- [ ] Create the `@zodem` npm org, and do the one-time npm-side bootstrap the automated
      workflow above depends on (claiming the org, the first manual publish, configuring a
      Trusted Publisher per package) — needs an npmjs.com login, so still a human action;
      the exact steps are in `RELEASING.md`
- [ ] Create a dedicated GitHub org (handoff suggested `zodem-dev`) — the repo currently lives
      at `github.com/asakaxgit/zodem`. Note: `release.yml`'s Trusted Publisher config
      (org/repo/workflow filename) is tied to `asakaxgit/zodem`; moving repos means
      reconfiguring it on npmjs.com for all five packages
- [ ] Check/register domains (e.g. `zodem.dev`) — unchecked as of the handoff
- [ ] Keep pairing the **"Zod'em"** wordmark with "Zod"/"TypeScript" in titles and descriptions,
      per the handoff's branding-risk note — "Zodem" (no apostrophe) collides in search with an
      unrelated zolpidem (sleeping pill) brand
