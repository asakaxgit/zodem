import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { emptyLock, parseLock, serializeLock, type LockFile } from "./lock.js";

/**
 * Node-only lockfile I/O, kept out of `index.ts` so a browser bundle that
 * only needs the pure sync/validation logic (e.g. the codec's runtime IR
 * sync) never pulls in `node:fs`. CLI and other Node consumers import this
 * from `@zodem/core/node`.
 */
export function loadLock(path: string): LockFile {
  if (!existsSync(path)) return emptyLock();
  return parseLock(readFileSync(path, "utf8"), path);
}

export function writeLock(path: string, lock: LockFile): void {
  writeFileSync(path, serializeLock(lock), "utf8");
}
