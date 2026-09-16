import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// This suite spawns the real built CLI as a subprocess rather than calling
// generate() in-process. Vitest loads this test file (and generate.ts, its
// static import) through Vite's SSR module graph, while jiti's *dynamic*
// import of a schema file goes through Node's native loader — those resolve
// to two separate instances of @zodem/core in-process, so resetRegistry()
// on one never reaches the other. That split doesn't exist for a real `one-
// zodem` invocation (a plain Node process with no Vite involved), so testing
// the built binary is both the fix and the more faithful integration test.

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const workspaceRoot = join(cliRoot, "..", "..");
const cliEntry = join(cliRoot, "dist", "index.js");
const bufBin = join(cliRoot, "node_modules", ".bin", "buf");

let root: string;

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliEntry, ...args], { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const CONFIG = `
export default {
  entry: ["schema.ts"],
  outDir: "proto",
  lockfile: "zodem.lock.json",
};
`;

const SCHEMA_V1 = `
import { z } from "zod";
import { zodem } from "@zodem/core";

export const User = zodem.message("acme.user.v1.User", {
  id: z.string().uuid(),
  email: z.string().email(),
  age: z.number().int().min(0).max(150).meta({ proto: "int32" }),
  role: z.enum(["admin", "member"]),
  nickname: z.string().optional(),
  address: z.object({ city: z.string(), country: z.string() }),
  createdAt: z.date(),
});
`;

// same as V1 but "nickname" removed and "phone" added — exercises reserved + breaking rails
const SCHEMA_V2 = `
import { z } from "zod";
import { zodem } from "@zodem/core";

export const User = zodem.message("acme.user.v1.User", {
  id: z.string().uuid(),
  email: z.string().email(),
  age: z.number().int().min(0).max(150).meta({ proto: "int32" }),
  role: z.enum(["admin", "member"]),
  phone: z.string().optional(),
  address: z.object({ city: z.string(), country: z.string() }),
  createdAt: z.date(),
});
`;

const SCHEMA_REORDERED = `
import { z } from "zod";
import { zodem } from "@zodem/core";

export const User = zodem.message("acme.user.v1.User", {
  createdAt: z.date(),
  address: z.object({ country: z.string(), city: z.string() }),
  nickname: z.string().optional(),
  role: z.enum(["member", "admin"]),
  age: z.number().int().min(0).max(150).meta({ proto: "int32" }),
  email: z.string().email(),
  id: z.string().uuid(),
});
`;

const SCHEMA_BREAKING = `
import { z } from "zod";
import { zodem } from "@zodem/core";

export const User = zodem.message("acme.user.v1.User", {
  id: z.number(),
});
`;

function writeProject(schema: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "zodem.config.ts"), CONFIG, "utf8");
  writeFileSync(join(root, "schema.ts"), schema, "utf8");
}

function protoPath(): string {
  return join(root, "proto", "acme", "user", "v1", "user.proto");
}

function lockPath(): string {
  return join(root, "zodem.lock.json");
}

beforeAll(() => {
  execFileSync("pnpm", ["-r", "run", "build"], { cwd: workspaceRoot, stdio: "pipe" });
  expect(existsSync(cliEntry)).toBe(true);
}, 120_000);

beforeEach(() => {
  root = mkdtempSync(join(cliRoot, ".tmp-generate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("zodem generate: end-to-end", () => {
  it("creates the lockfile and proto on first run, and is idempotent on the second", () => {
    writeProject(SCHEMA_V1);
    const first = runCli(["generate"], root);
    expect(first.status).toBe(0);
    expect(existsSync(protoPath())).toBe(true);
    expect(existsSync(lockPath())).toBe(true);

    const protoBefore = readFileSync(protoPath(), "utf8");
    const lockBefore = readFileSync(lockPath(), "utf8");

    const second = runCli(["generate"], root);
    expect(second.status).toBe(0);
    expect(readFileSync(protoPath(), "utf8")).toBe(protoBefore);
    expect(readFileSync(lockPath(), "utf8")).toBe(lockBefore);
  });

  it("--check exits 0 when up to date and non-zero after a schema edit, writing nothing", () => {
    writeProject(SCHEMA_V1);
    runCli(["generate"], root);

    const clean = runCli(["generate", "--check"], root);
    expect(clean.status).toBe(0);

    writeFileSync(join(root, "schema.ts"), SCHEMA_V2, "utf8");
    const stale = runCli(["generate", "--check"], root);
    expect(stale.status).not.toBe(0);
    expect(readFileSync(lockPath(), "utf8")).not.toContain("phone"); // --check must write nothing
  });

  it("removing a field reserves its number; re-running with the field back draws a new number", () => {
    writeProject(SCHEMA_V1);
    runCli(["generate"], root);

    writeFileSync(join(root, "schema.ts"), SCHEMA_V2, "utf8");
    const result = runCli(["generate"], root);
    expect(result.status).toBe(0);
    const proto = readFileSync(protoPath(), "utf8");
    expect(proto).toContain('reserved "nickname"');
    expect(proto).toContain("string phone = 8;"); // not 5 — the old number stays reserved
  });

  it("rejects a breaking type change without --allow-breaking, and accepts it with the flag", () => {
    writeProject(SCHEMA_V1);
    runCli(["generate"], root);

    writeFileSync(join(root, "schema.ts"), SCHEMA_BREAKING, "utf8");
    const blocked = runCli(["generate"], root);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/[Bb]reaking/);

    const forced = runCli(["generate", "--allow-breaking"], root);
    expect(forced.status).toBe(0);
  });

  it("reordering schema keys changes nothing on disk", () => {
    writeProject(SCHEMA_V1);
    runCli(["generate"], root);
    const before = readFileSync(lockPath(), "utf8");

    writeFileSync(join(root, "schema.ts"), SCHEMA_REORDERED, "utf8");
    const result = runCli(["generate", "--check"], root);
    expect(result.status).toBe(0);
    expect(readFileSync(lockPath(), "utf8")).toBe(before);
  });

  it("produces output that passes buf lint and buf build", () => {
    writeProject(SCHEMA_V1);
    const result = runCli(["generate"], root);
    expect(result.status).toBe(0);

    writeFileSync(
      join(root, "proto", "buf.yaml"),
      "version: v2\nmodules:\n  - path: .\nlint:\n  use:\n    - STANDARD\n",
      "utf8",
    );

    execFileSync(bufBin, ["lint"], { cwd: join(root, "proto"), stdio: "pipe" });
    execFileSync(bufBin, ["build"], { cwd: join(root, "proto"), stdio: "pipe" });
  });
});
