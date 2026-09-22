import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generate } from "./generate.js";
import { renameField, renameMessage, renameEnumValue } from "./rename.js";

export { generate } from "./generate.js";
export { defineConfig } from "./config.js";
export { renameField, renameMessage, renameEnumValue } from "./rename.js";
export type { GenerateOptions, GenerateResult, GeneratedFile } from "./generate.js";
export type { ZodemConfig } from "./config.js";
export type { RenameResult } from "./rename.js";

const USAGE = `Usage:
  zodem generate [--check] [--allow-breaking]
  zodem rename field <message> <oldName> <newName>
  zodem rename message <oldFullName> <newFullName>
  zodem rename enum-value <enum> <oldName> <newName>`;

async function runGenerate(values: { check?: boolean; "allow-breaking"?: boolean }): Promise<void> {
  const result = await generate({
    cwd: process.cwd(),
    check: values.check === true,
    allowBreaking: values["allow-breaking"] === true,
  });

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }

  if (values.check) {
    if (result.changed) {
      console.error("zodem generate --check: output is stale; run `zodem generate` to update it");
      process.exitCode = 1;
    } else {
      console.log("zodem generate --check: up to date");
    }
    return;
  }

  console.log(`wrote ${result.files.length} proto file(s) and ${result.lockPath}`);
}

async function runRename(args: string[]): Promise<void> {
  const [kind, ...rest] = args;
  const cwd = process.cwd();

  if (kind === "field" && rest.length === 3) {
    const [messageFullName, oldName, newName] = rest;
    const result = await renameField(cwd, messageFullName!, oldName!, newName!);
    console.log(`${result.summary} in ${result.lockPath}`);
    console.log("Next: rename the field in your Zod schema, then run `zodem generate`.");
    return;
  }
  if (kind === "message" && rest.length === 2) {
    const [oldFullName, newFullName] = rest;
    const result = await renameMessage(cwd, oldFullName!, newFullName!);
    console.log(`${result.summary} in ${result.lockPath}`);
    console.log("Next: rename the message in your Zod schema (the zodem.message() full name), then run `zodem generate`.");
    return;
  }
  if (kind === "enum-value" && rest.length === 3) {
    const [enumFullName, oldName, newName] = rest;
    const result = await renameEnumValue(cwd, enumFullName!, oldName!, newName!);
    console.log(`${result.summary} in ${result.lockPath}`);
    console.log("Next: rename the value in your Zod enum, then run `zodem generate`.");
    console.warn("warning: this rename is wire-compatible but changes the proto JSON encoding for this value.");
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      "allow-breaking": { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  try {
    if (command === "generate") {
      await runGenerate(values);
      return;
    }
    if (command === "rename") {
      await runRename(positionals.slice(1));
      return;
    }
    console.error(USAGE);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Only run the CLI when this module is the entry point, not when imported as
// a library. Compare realpaths, not raw argv[1]/import.meta.url: an npm/pnpm
// bin invocation (`npx zodem`, or a package.json "generate" script) goes
// through node_modules/.bin/zodem, a symlink — argv[1] keeps the symlink
// path while import.meta.url resolves to the real file, so a naive string
// comparison never matches and the CLI silently does nothing.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
