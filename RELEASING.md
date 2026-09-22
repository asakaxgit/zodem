# Releasing

Publishing to npm is automated via [Changesets](https://github.com/changesets/changesets) and
GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)), using npm's
OIDC-based **trusted publishing** — no `NPM_TOKEN` secret exists anywhere in this repo or its
CI. This page covers the one-time npm-side setup that makes that possible, then the ongoing
day-to-day flow.

## One-time npm bootstrap (human only — needs an npmjs.com login)

I can't do any of this myself; it needs an interactive session on npmjs.com.

1. **Create the `@zodem` organization** on npm (Settings → Organizations → Create), or confirm
   it already exists. The free tier is fine — nothing here needs a paid plan, since every
   package publishes with `access: public` (see `publishConfig` in each `packages/*/package.json`),
   and only *private* packages require a paid org.

2. **Publish each package once, by hand, to create its registry entry.** npm's Trusted
   Publisher setting is configured on a package's own settings page, which only exists once
   the package has been published at least once. From the repo root:

   ```bash
   pnpm install
   pnpm build
   npm login   # once, interactively
   for pkg in core proto codec cli llm; do
     (cd "packages/$pkg" && npm publish --access public)
   done
   ```

   (If npm has since added support for registering a Trusted Publisher *before* a package's
   first publish — check the "Trusted Publisher" section on npmjs.com directly, this is a
   fairly new and fast-moving feature — you can skip this step and let the very first
   automated run in step 4 do the initial publish instead.)

3. **Configure a Trusted Publisher for each of the five packages**, on each package's
   npmjs.com settings page → "Publishing access" → "Trusted Publisher" → GitHub Actions:
   - Organization or user: `asakaxgit`
   - Repository: `zodem`
   - Workflow filename: `release.yml`
   - Environment: leave blank (this workflow doesn't use a GitHub Environment)

   Repeat for `@zodem/core`, `@zodem/proto`, `@zodem/codec`, `@zodem/cli`, `@zodem/llm`.

Once this is done, `release.yml` can publish every future version with no npm credentials
in CI at all — just the `id-token: write` permission already in the workflow.

**Heads up on timing:** the very first time `release.yml` runs on `main` with zero pending
changesets, it will attempt to publish whatever versions are currently in `package.json`
(`0.1.0` as of writing). If that happens before you've completed the steps above, it will
simply fail with an npm auth error — harmless, not a partial or corrupted publish, just a red
X on that workflow run. Either do steps 1–3 before merging changes that land with no pending
changeset, or don't worry about one expected failed run and re-trigger the workflow (push an
empty commit, or re-run it from the Actions tab) once bootstrapping is done.

## All five packages version together (lockstep)

`.changeset/config.json`'s `fixed` group lists all five `@zodem/*` packages, so any changeset
that bumps *one* of them bumps all five to the same new version, together — even if a
changeset only names one package. This is enforced by the config, not by convention, so it
holds regardless of which of the two ways below you create a changeset.

## Ongoing release flow

There are two ways to create the changeset that starts a release — pick whichever's more
convenient. Either way, what happens next is identical (step 3 onward).

**Option A — locally, as part of a normal PR:**

1. When your change should ship a new version, run:

   ```bash
   pnpm changeset
   ```

   Pick the semver bump (patch/minor/major — it'll apply to all five packages regardless of
   which one(s) you select, per the lockstep note above) and write a one-line summary — this
   becomes the changelog entry. Commit the generated `.changeset/*.md` file as part of your PR.

2. Merge your PR to `main` as usual.

**Option B — the "Bump version" workflow, with no local checkout:**

1. Go to Actions → **Bump version** → "Run workflow". Pick `patch`/`minor`/`major` from the
   dropdown and type a one-line summary.
2. It opens a small PR containing just the generated changeset file (no code changes). Review
   and merge it.

Both options land the same kind of changeset file on `main`, just through a different path
(Option A rides along with a normal code-change PR; Option B is for bumping the version on its
own, with nothing else to review). Neither one bumps `package.json` or publishes anything by
itself — that's step 3 onward, below, and it's the same regardless of which option you used.

3. `release.yml` runs on the push to `main`, sees the pending changeset(s), and opens (or
   updates) a single **"Version Packages"** pull request — it bumps `package.json` for all
   five packages, updates each one's `CHANGELOG.md`, and consumes the changeset file(s). This
   PR accumulates every pending changeset until it's merged, so multiple unrelated changes can
   ship together in one release, or you can merge it right away for a fast release — your call.

4. When you merge the **Version Packages** PR, `release.yml` runs again, finds no pending
   changesets, and runs `pnpm release` (build, then `changeset publish`) — publishing all five
   packages via trusted publishing.

No local `npm publish`/`npm login` is ever needed again after the one-time bootstrap above.

### A change that doesn't need a release

If a PR touches a package's files but shouldn't trigger a version bump (a test-only change, a
comment, CI config), run `pnpm changeset add --empty` instead of `pnpm changeset` — this
satisfies `pnpm changeset status` (which `release.yml` doesn't currently enforce as a required
check, but is good practice to keep green) without bumping anything.

### What's excluded

`examples/fullstack/{shared,server,web}` are `@example/*` demo packages, listed in
`.changeset/config.json`'s `ignore` array — they're `"private": true` and never versioned or
published, regardless of what changes inside them.
