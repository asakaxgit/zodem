// Node-only entry point (`@zodem/core/node`): everything from the main
// package plus lockfile disk I/O, which needs `node:fs` and so is kept out
// of the browser-safe main entry (see lock-io.ts).
export * from "./index.js";
export { loadLock, writeLock } from "./lock-io.js";
