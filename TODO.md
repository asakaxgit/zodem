# TODO

Reconciled from the original project handoff doc against the current codebase. Checked items
are verified shipped (tests pass, behavior confirmed in this repo); unchecked items are not
yet implemented anywhere in the tree.

## Roadmap phases

- [x] **Phase 1 — MVP generator**: walker, IR, lockfile (load/validate/sync/write), `.proto`
      emitter for scalars, objects (top-level + nested), enums, arrays, optionals, `z.date()`;
      `zodem generate` / `zodem generate --check`; discriminated-union → `oneof` spike
- [x] **Phase 1.5 — `zodem rename`**: `field`, `message`, `enum-value`, all lockfile-only and
      number-preserving
- [x] **Phase 2 — structure**: maps (`z.record` → `map<K,V>`), full oneof support, `z.lazy()`
      recursion, remaining well-known types, collection wrapper messages for nested
      repeated/map values, multi-package output with cross-package imports
- [ ] **Phase 3 — safety**
  - [x] removed messages/enums are tombstoned (`removed: true`, warned on generate, field/value
        numbers kept claimed) rather than dropped
  - [ ] `buf breaking` as an optional extra CI check — not wired in; `buf lint`/`buf build` run
        today only inside the CLI test suite, not as a top-level CI or `zodem` step
- [x] **Phase 4 — services**: `zodem.service()` → `service`/`rpc` emission, including
      `stream: "server" | "client" | "bidi"`
- [ ] **Phase 5 — validation**: emit `buf.validate` (protovalidate) annotations from Zod checks
      (`min`, `max`, `email`, `uuid`, `regex`, …) so non-TS backends get the same rules — not
      started; zero references to protovalidate anywhere in the codebase
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
- [ ] Whether to move protovalidate emission earlier than Phase 5 — still open, unstarted

## Not yet built

- [ ] JSON Schema / LLM tool-call & structured-output emission from the same IR — this is the
      "AI" destination in the README tagline; no code exists for it yet. Would be a new
      emitter alongside `@zodem/proto` and `@zodem/codec`, consuming the same walker output.
- [ ] `buf breaking` wired into CI as a real gate (see Phase 3 above)
- [ ] A lint script / ESLint config — none exists in any package today
- [ ] A `LICENSE` file — repo currently has none

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
