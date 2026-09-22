#!/usr/bin/env node
// Writes a changeset file non-interactively, for the "Bump version" workflow
// (.github/workflows/version-bump.yml) — `pnpm changeset` itself is
// interactive (prompts for packages/bump/summary), which doesn't work from a
// workflow_dispatch input. The package list comes from .changeset/config.json's
// `fixed` group, not a hardcoded list here, so the two can't drift apart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const [bump, ...summaryParts] = process.argv.slice(2);
const summary = summaryParts.join(" ").trim();

const VALID_BUMPS = ["patch", "minor", "major"];
if (!VALID_BUMPS.includes(bump)) {
  console.error(`error: bump must be one of ${VALID_BUMPS.join(", ")}, got ${JSON.stringify(bump)}`);
  process.exit(1);
}
if (!summary) {
  console.error("error: a summary is required");
  process.exit(1);
}

const config = JSON.parse(readFileSync(new URL("../../.changeset/config.json", import.meta.url), "utf8"));
const fixedGroup = config.fixed?.[0];
if (!Array.isArray(fixedGroup) || fixedGroup.length === 0) {
  console.error("error: .changeset/config.json has no fixed group to bump — update this script if that config changed");
  process.exit(1);
}

const frontmatter = fixedGroup.map((pkg) => `"${pkg}": ${bump}`).join("\n");
const slug = `version-bump-${randomBytes(4).toString("hex")}`;

mkdirSync(new URL("../../.changeset/", import.meta.url), { recursive: true });
const path = new URL(`../../.changeset/${slug}.md`, import.meta.url);
writeFileSync(path, `---\n${frontmatter}\n---\n\n${summary}\n`);
console.log(`wrote .changeset/${slug}.md (${bump}, ${fixedGroup.length} packages)`);
