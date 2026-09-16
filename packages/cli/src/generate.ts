import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";
import { glob } from "tinyglobby";
import {
  markRemovedEntries,
  resetRegistry,
  serializeLock,
  syncEnum,
  syncMessage,
  walkRegistry,
  type IRMessage,
} from "@zodem/core";
import { loadLock, writeLock } from "@zodem/core/node";
import { emitProto, outputPathFor } from "@zodem/proto";
import { loadConfig } from "./config.js";

export interface GenerateOptions {
  cwd: string;
  check: boolean;
  allowBreaking: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateResult {
  /** true if the on-disk .proto output or lockfile would change (or did change, outside --check) */
  changed: boolean;
  warnings: string[];
  files: GeneratedFile[];
  lockPath: string;
  lockContent: string;
}

function packageOf(fullName: string): string {
  const parts = fullName.split(".");
  parts.pop();
  return parts.join(".");
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const { config, root } = await loadConfig(opts.cwd);
  resetRegistry();

  const jiti = createJiti(root, { interopDefault: true });
  const entryFiles = await glob(config.entry, { cwd: root, absolute: true });
  if (entryFiles.length === 0) {
    throw new Error(`no files matched entry patterns [${config.entry.join(", ")}] under ${root}`);
  }
  for (const file of [...entryFiles].sort()) {
    await jiti.import(file);
  }

  const walked = walkRegistry();
  if (walked.messages.length === 0) {
    throw new Error(`no zodem.message() schemas were registered by the entry files`);
  }

  const packages = new Set<string>();
  for (const m of walked.messages) packages.add(packageOf(m.fullName));
  for (const svc of walked.services) packages.add(packageOf(svc.fullName));
  if (packages.size > 1) {
    throw new Error(
      `multiple packages found (${[...packages].join(", ")}); multi-package output is Phase 2, not yet supported`,
    );
  }
  const packageName = [...packages][0] as string;

  const lockPath = resolve(root, config.lockfile);
  const lock = loadLock(lockPath);

  const warnings: string[] = [];
  const presentMessages = new Set<string>();
  const presentEnums = new Set<string>();

  const collectNames = (msg: IRMessage): void => {
    presentMessages.add(msg.fullName);
    for (const e of msg.nested.enums) presentEnums.add(e.fullName);
    for (const nested of msg.nested.messages) collectNames(nested);
  };
  for (const m of walked.messages) collectNames(m);

  const syncAll = (msg: IRMessage): void => {
    const res = syncMessage(msg, lock, { allowBreaking: opts.allowBreaking });
    warnings.push(...res.warnings);
    for (const e of msg.nested.enums) {
      const eres = syncEnum(e, lock);
      warnings.push(...eres.warnings);
    }
    for (const nested of msg.nested.messages) syncAll(nested);
  };
  for (const m of walked.messages) syncAll(m);

  warnings.push(...markRemovedEntries(lock, presentMessages, presentEnums));

  const protoText = emitProto({
    package: packageName,
    messages: walked.messages,
    services: walked.services,
    imports: walked.imports,
  });
  const protoPath = resolve(root, config.outDir, outputPathFor(packageName));
  const lockContent = serializeLock(lock);

  const files: GeneratedFile[] = [{ path: protoPath, content: protoText }];

  const protoChanged = !existsSync(protoPath) || readFileSync(protoPath, "utf8") !== protoText;
  const lockChanged = !existsSync(lockPath) || readFileSync(lockPath, "utf8") !== lockContent;
  const changed = protoChanged || lockChanged;

  if (!opts.check) {
    mkdirSync(dirname(protoPath), { recursive: true });
    writeFileSync(protoPath, protoText, "utf8");
    writeLock(lockPath, lock);
  }

  return { changed, warnings, files, lockPath, lockContent };
}
