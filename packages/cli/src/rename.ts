import { resolve } from "node:path";
import { renameField as coreRenameField, renameMessage as coreRenameMessage, renameEnumValue as coreRenameEnumValue } from "@zodem/core";
import { loadLock, writeLock } from "@zodem/core/node";
import { loadConfig } from "./config.js";

export interface RenameResult {
  lockPath: string;
  summary: string;
}

async function withLock(cwd: string, mutate: (lock: import("@zodem/core").LockFile) => string): Promise<RenameResult> {
  const { config, root } = await loadConfig(cwd);
  const lockPath = resolve(root, config.lockfile);
  const lock = loadLock(lockPath);
  const summary = mutate(lock);
  writeLock(lockPath, lock);
  return { lockPath, summary };
}

export async function renameField(
  cwd: string,
  messageFullName: string,
  oldName: string,
  newName: string,
): Promise<RenameResult> {
  return withLock(cwd, (lock) => {
    coreRenameField(lock, messageFullName, oldName, newName);
    return `renamed ${messageFullName}.${oldName} -> ${newName}`;
  });
}

export async function renameMessage(cwd: string, oldFullName: string, newFullName: string): Promise<RenameResult> {
  return withLock(cwd, (lock) => {
    coreRenameMessage(lock, oldFullName, newFullName);
    return `renamed ${oldFullName} -> ${newFullName}`;
  });
}

export async function renameEnumValue(
  cwd: string,
  enumFullName: string,
  oldName: string,
  newName: string,
): Promise<RenameResult> {
  return withLock(cwd, (lock) => {
    coreRenameEnumValue(lock, enumFullName, oldName, newName);
    return `renamed ${enumFullName}.${oldName} -> ${newName}`;
  });
}
