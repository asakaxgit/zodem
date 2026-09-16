import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generate } from "./generate.js";

export { generate } from "./generate.js";
export { defineConfig } from "./config.js";
export type { GenerateOptions, GenerateResult, GeneratedFile } from "./generate.js";
export type { ZodemConfig } from "./config.js";

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
  if (command !== "generate") {
    console.error("Usage: zodem generate [--check] [--allow-breaking]");
    process.exitCode = 1;
    return;
  }

  try {
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
