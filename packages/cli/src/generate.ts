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
  type IRService,
} from "@zodem/core";
import { loadLock, writeLock } from "@zodem/core/node";
import { computeFileImports, emitProto, outputPathFor } from "@zodem/proto";
import { loadConfig } from "./config.js";

export type GenerateOptions = {
  cwd: string;
  check: boolean;
  allowBreaking: boolean;
};

export type GeneratedFile = {
  path: string;
  content: string;
};

export type GenerateResult = {
  /** true if any on-disk .proto output or the lockfile would change (or did change, outside --check) */
  changed: boolean;
  warnings: string[];
  files: GeneratedFile[];
  lockPath: string;
  lockContent: string;
};

function packageOf(fullName: string): string {
  const parts = fullName.split(".");
  parts.pop();
  return parts.join(".");
}

/** Every top-level message's own package, applied recursively to itself and everything nested under it. */
function recordOwnership(msg: IRMessage, pkg: string, out: Map<string, string>): void {
  out.set(msg.fullName, pkg);
  for (const e of msg.nested.enums) out.set(e.fullName, pkg);
  for (const nested of msg.nested.messages) recordOwnership(nested, pkg, out);
}

function groupByPackage(messages: IRMessage[], services: IRService[]): Map<string, { messages: IRMessage[]; services: IRService[] }> {
  const groups = new Map<string, { messages: IRMessage[]; services: IRService[] }>();
  const groupFor = (pkg: string) => groups.get(pkg) ?? groups.set(pkg, { messages: [], services: [] }).get(pkg)!;
  for (const m of messages) groupFor(packageOf(m.fullName)).messages.push(m);
  for (const s of services) groupFor(packageOf(s.fullName)).services.push(s);
  return groups;
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

  const lockPath = resolve(root, config.lockfile);
  const lock = loadLock(lockPath);

  const warnings: string[] = [];
  const presentMessages = new Set<string>();
  const presentEnums = new Set<string>();
  const typeOwnerPackage = new Map<string, string>();

  const collectNames = (msg: IRMessage): void => {
    presentMessages.add(msg.fullName);
    for (const e of msg.nested.enums) presentEnums.add(e.fullName);
    for (const nested of msg.nested.messages) collectNames(nested);
  };
  for (const m of walked.messages) {
    collectNames(m);
    recordOwnership(m, packageOf(m.fullName), typeOwnerPackage);
  }

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

  const validate = config.validate === true;
  const groups = groupByPackage(walked.messages, walked.services);
  const files: GeneratedFile[] = [];
  for (const [packageName, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const protoText = emitProto({
      package: packageName,
      messages: group.messages,
      services: group.services,
      imports: computeFileImports(group.messages, group.services, packageName, typeOwnerPackage, { validate }),
      validate,
    });
    files.push({ path: resolve(root, config.outDir, outputPathFor(packageName)), content: protoText });
  }

  const lockContent = serializeLock(lock);
  const protoChanged = files.some((f) => !existsSync(f.path) || readFileSync(f.path, "utf8") !== f.content);
  const lockChanged = !existsSync(lockPath) || readFileSync(lockPath, "utf8") !== lockContent;
  const changed = protoChanged || lockChanged;

  if (!opts.check) {
    for (const f of files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content, "utf8");
    }
    writeLock(lockPath, lock);
  }

  return { changed, warnings, files, lockPath, lockContent };
}
