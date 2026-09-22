import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

export type ZodemConfig = {
  /** glob patterns (relative to the config file) for modules that call zodem.message() / zodem.service() */
  entry: string[];
  /** directory (relative to the config file) generated .proto files are written under */
  outDir: string;
  /** path (relative to the config file) to the lockfile */
  lockfile: string;
  /** emit protovalidate (buf.validate) field options from Zod checks. Default false — existing output stays byte-identical unless opted in. */
  validate?: boolean;
};

export const defineConfig = (config: ZodemConfig): ZodemConfig => {
  return config;
};

export type LoadedConfig = {
  config: ZodemConfig;
  configPath: string;
  root: string;
};

const isZodemConfig = (v: Partial<ZodemConfig> | undefined): v is ZodemConfig => {
  return !!v && Array.isArray(v.entry) && !!v.outDir && !!v.lockfile;
};

export const loadConfig = async (cwd: string): Promise<LoadedConfig> => {
  const configPath = resolve(cwd, "zodem.config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`no zodem.config.ts found at ${configPath}`);
  }
  const jiti = createJiti(configPath, { interopDefault: true });
  const mod = await jiti.import<Partial<ZodemConfig> & { default?: ZodemConfig }>(configPath);
  const config = mod.default ?? mod;
  if (!isZodemConfig(config)) {
    throw new Error(`${configPath} must export a default defineConfig({ entry, outDir, lockfile })`);
  }
  return { config, configPath, root: dirname(configPath) };
};
