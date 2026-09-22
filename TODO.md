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

- [ ] JSON Schema / LLM tool-call & structured-output emission from the same IR — this is the
      "AI" destination in the README tagline; no code exists for it yet. Would be a new
      emitter alongside `@zodem/proto` and `@zodem/codec`, consuming the same walker output.
- [ ] `zodem-form` (naming TBD — `@zodem/form` would match the existing `@zodem/{proto,codec,cli}`
      scoping convention better) — generate a form schema (fields + constraints) from the same
      walker/IR. The Phase 5 protovalidate rule collection (`IRField.rules`: min/max length,
      pattern, required, email/uuid/url/ipv4/ipv6 format, numeric bounds, array size, …) maps
      almost directly onto form field constraints, so this is mostly a new emitter, not new
      walker work. Open questions: framework-agnostic output vs. optional framework bindings
      (mirroring how `@zodem/codec` stays runtime-agnostic while the fullstack example wires up
      React); package scope/naming.
- [x] A lint script / lint config — root-level `biome.json` (linter only, formatter off to
      avoid mass-reformatting the existing style; `noNonNullAssertion` off, since the codebase
      uses `!` pervasively and deliberately), `pnpm lint` / `pnpm lint:fix`, wired into CI
- [x] A `LICENSE` file — MIT, added at the repo root; `"license": "MIT"` added to the root
      workspace and the four `@zodem/*` package.json files (not the private `@example/*` demo
      packages)

## Branding / publishing action items (handoff, for the human owner)

- [ ] Publish a placeholder `zodem` package on npm
- [ ] Create the `@zodem` npm org; publish `@zodem/core`, `@zodem/proto`, `@zodem/codec`,
      `@zodem/cli` (all currently `"private": true` at `0.1.0`)
- [ ] Create a dedicated GitHub org (handoff suggested `zodem-dev`) — the repo currently lives
      at `github.com/asakaxgit/zodem`
- [ ] Check/register domains (e.g. `zodem.dev`) — unchecked as of the handoff
- [ ] Keep pairing the **"Zod'em"** wordmark with "Zod"/"TypeScript" in titles and descriptions,
      per the handoff's branding-risk note — "Zodem" (no apostrophe) collides in search with an
      unrelated zolpidem (sleeping pill) brand
