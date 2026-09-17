import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

export interface ZodemConfig {
  /** glob patterns (relative to the config file) for modules that call zodem.message() / zodem.service() */
  entry: string[];
  /** directory (relative to the config file) generated .proto files are written under */
  outDir: string;
  /** path (relative to the config file) to the lockfile */
  lockfile: string;
  /** emit protovalidate (buf.validate) field options from Zod checks. Default false — existing output stays byte-identical unless opted in. */
  validate?: boolean;
}

export function defineConfig(config: ZodemConfig): ZodemConfig {
  return config;
}

export interface LoadedConfig {
  config: ZodemConfig;
  configPath: string;
  root: string;
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const configPath = resolve(cwd, "zodem.config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`no zodem.config.ts found at ${configPath}`);
  }
  const jiti = createJiti(configPath, { interopDefault: true });
  const mod = (await jiti.import(configPath)) as { default?: ZodemConfig } | ZodemConfig;
  const config = "default" in mod && mod.default ? mod.default : (mod as ZodemConfig);
  if (!config || !Array.isArray(config.entry) || !config.outDir || !config.lockfile) {
    throw new Error(`${configPath} must export a default defineConfig({ entry, outDir, lockfile })`);
  }
  return { config, configPath, root: dirname(configPath) };
}
