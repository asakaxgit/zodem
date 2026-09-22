export { zodem, message, service, bytes, getRegisteredMessages, getRegisteredServices, zodemRegistry, resetRegistry, readFieldMeta } from "./registry.js";
export type { ZodemFieldMeta, ZodemMeta, ZodemMethodDef, ZodemServiceDef, RegisteredMessage } from "./registry.js";
export { SCALAR_NAMES } from "./ir.js";
export type * from "./ir.js";
export { walkRegistry, walkObjectIntoMessage, WalkerContext } from "./walker.js";
export type { WalkResult } from "./walker.js";
export {
  emptyLock,
  serializeLock,
  parseLock,
  validateLock,
  syncMessage,
  syncEnum,
  markRemovedEntries,
  typeKey,
  isWireCompatible,
  renameField,
  renameMessage,
  renameEnumValue,
} from "./lock.js";
export type { LockFile, LockMessageEntry, LockEnumEntry, LockFieldEntry, SyncOptions, SyncResult } from "./lock.js";
export * from "./errors.js";
export { camelToSnake, pascalCase, upperSnake } from "./naming.js";
