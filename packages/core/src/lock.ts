import type { IREnum, IRLabel, IRMessage, IRReserved, IRType } from "./ir.js";
import {
  BreakingChangeError,
  LockfileValidationError,
  RenameError,
  ZodemError,
  PinnedNumberMismatchError,
} from "./errors.js";

export type LockFieldEntry = {
  number: number;
  /** canonical type key, see `typeKey()` */
  type: string;
  label: IRLabel;
};

export type LockMessageEntry = {
  nextField: number;
  fields: Record<string, LockFieldEntry>;
  reserved: IRReserved[];
  /** message existed in a prior generate but is absent from the current schema */
  removed?: boolean;
};

export type LockEnumEntry = {
  nextValue: number;
  values: Record<string, number>;
  reserved: IRReserved[];
  removed?: boolean;
};

export type LockFile = {
  version: 1;
  messages: Record<string, LockMessageEntry>;
  enums: Record<string, LockEnumEntry>;
};

const RESERVED_RANGE_START = 19000;
const RESERVED_RANGE_END = 19999;

export function emptyLock(): LockFile {
  return { version: 1, messages: {}, enums: {} };
}

export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify(sortLock(lock), null, 2)}\n`;
}

/** Parses and validates lockfile JSON already read from disk (or anywhere else). Node-only I/O lives in lock-io.ts. */
export function parseLock(raw: string, sourceForErrors = "<lockfile>"): LockFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LockfileValidationError(`${sourceForErrors} is not valid JSON (${message})`);
  }
  validateLock(parsed);
  return parsed;
}

function sortRecord<T>(record: Record<string, T>, map: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = map(record[key]!);
  }
  return out;
}

function sortLock(lock: LockFile): LockFile {
  return {
    version: lock.version,
    messages: sortRecord(lock.messages, (m) => ({
      nextField: m.nextField,
      fields: sortRecord(m.fields, (f) => f),
      reserved: [...m.reserved].sort((a, b) => a.number - b.number),
      ...(m.removed ? { removed: true as const } : {}),
    })),
    enums: sortRecord(lock.enums, (e) => ({
      nextValue: e.nextValue,
      values: sortRecord(e.values, (v) => v),
      reserved: [...e.reserved].sort((a, b) => a.number - b.number),
      ...(e.removed ? { removed: true as const } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Type keys: canonical string form of an IRType, used for storage and for
// wire-compatibility comparisons.
// ---------------------------------------------------------------------------

export function typeKey(type: IRType): string {
  switch (type.kind) {
    case "scalar":
      return type.name;
    case "message":
      return type.fullName;
    case "enum":
      return `enum:${type.fullName}`;
    case "wkt":
      return type.fullName;
    case "map":
      return `map<${type.key},${typeKey(type.value)}>`;
  }
}

const INT_WIDEN: Record<string, string> = { int32: "int64", uint32: "uint64" };

export function isWireCompatible(from: string, to: string): { ok: boolean; warning?: string } {
  if (from === to) return { ok: true };
  if (INT_WIDEN[from] === to) return { ok: true };
  if (INT_WIDEN[to] === from) return { ok: true, warning: `narrowing ${from} -> ${to}` };

  const fromEnum = from.startsWith("enum:");
  const toEnum = to.startsWith("enum:");
  if (fromEnum && to === "int32") return { ok: true, warning: `enum -> int32` };
  if (toEnum && from === "int32") return { ok: true, warning: `int32 -> enum` };

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Sync: assign/reconcile field & enum-value numbers against the lockfile.
// ---------------------------------------------------------------------------

function checkRange(ownerName: string, number: number): void {
  if (number < 1) {
    throw new LockfileValidationError(`${ownerName} has invalid number ${number}`);
  }
  if (number >= RESERVED_RANGE_START && number <= RESERVED_RANGE_END) {
    throw new LockfileValidationError(
      `${ownerName} uses number ${number}, which is in the protobuf-reserved range ${RESERVED_RANGE_START}-${RESERVED_RANGE_END}`,
    );
  }
}

function allocate(entry: LockMessageEntry): number {
  let n = entry.nextField;
  if (n >= RESERVED_RANGE_START && n <= RESERVED_RANGE_END) n = RESERVED_RANGE_END + 1;
  entry.nextField = n + 1;
  return n;
}

function assertNotReservedOrUsed(
  ownerName: string,
  entry: LockMessageEntry,
  number: number,
  fieldName: string,
): void {
  if (entry.reserved.some((r) => r.number === number)) {
    throw new PinnedNumberMismatchError(ownerName, fieldName, number, "reserved");
  }
  const conflict = Object.entries(entry.fields).find(([name, f]) => f.number === number && name !== fieldName);
  if (conflict) {
    throw new ZodemError(
      `${ownerName}.${fieldName} is pinned to field ${number}, but field ${number} is already used by "${conflict[0]}". Field numbers must be unique.`,
    );
  }
}

export type SyncOptions = {
  allowBreaking: boolean;
};

export type SyncResult = {
  warnings: string[];
};

/** Mutates `ir.fields[].number` and `ir.reserved` in place from `lock`. */
export function syncMessage(ir: IRMessage, lock: LockFile, opts: SyncOptions): SyncResult {
  const warnings: string[] = [];
  const entry: LockMessageEntry = lock.messages[ir.fullName] ?? {
    nextField: 1,
    fields: {},
    reserved: [],
  };
  lock.messages[ir.fullName] = entry;
  delete entry.removed;

  const seen = new Set<string>();
  for (const field of ir.fields) {
    seen.add(field.name);
    const key = typeKey(field.type);
    const existing = entry.fields[field.name];

    if (existing) {
      if (field.pinned !== undefined && field.pinned !== existing.number) {
        throw new PinnedNumberMismatchError(ir.fullName, field.name, field.pinned, existing.number);
      }
      const labelBreaking = (existing.label === "repeated") !== (field.label === "repeated");
      const compat = isWireCompatible(existing.type, key);
      if (labelBreaking || !compat.ok) {
        if (!opts.allowBreaking) {
          throw new BreakingChangeError(ir.fullName, field.name, existing.type, key);
        }
        warnings.push(
          `${ir.fullName}.${field.name}: breaking change allowed (${existing.type} [${existing.label}] -> ${key} [${field.label}])`,
        );
      } else if (compat.warning) {
        warnings.push(`${ir.fullName}.${field.name}: ${compat.warning}`);
      }
      field.number = existing.number;
      existing.type = key;
      existing.label = field.label;
    } else {
      const number = field.pinned ?? allocate(entry);
      checkRange(`${ir.fullName}.${field.name}`, number);
      assertNotReservedOrUsed(ir.fullName, entry, number, field.name);
      if (field.pinned !== undefined) {
        entry.nextField = Math.max(entry.nextField, field.pinned + 1);
      }
      field.number = number;
      entry.fields[field.name] = { number, type: key, label: field.label };
    }
  }

  for (const [name, f] of Object.entries(entry.fields)) {
    if (!seen.has(name)) {
      entry.reserved.push({ number: f.number, name });
      delete entry.fields[name];
    }
  }
  ir.reserved = entry.reserved;
  return { warnings };
}

function allocateEnum(entry: LockEnumEntry): number {
  let n = entry.nextValue;
  if (n >= RESERVED_RANGE_START && n <= RESERVED_RANGE_END) n = RESERVED_RANGE_END + 1;
  entry.nextValue = n + 1;
  return n;
}

/** Mutates `ir.values[].number` and `ir.reserved` in place from `lock`. Value `0` (UNSPECIFIED) is implicit and never stored. */
export function syncEnum(ir: IREnum, lock: LockFile): SyncResult {
  const warnings: string[] = [];
  const entry: LockEnumEntry = lock.enums[ir.fullName] ?? {
    nextValue: 1,
    values: {},
    reserved: [],
  };
  lock.enums[ir.fullName] = entry;
  delete entry.removed;

  const seen = new Set<string>();
  for (const value of ir.values) {
    seen.add(value.name);
    const existing = entry.values[value.name];
    if (existing !== undefined) {
      value.number = existing;
    } else {
      const number = allocateEnum(entry);
      checkRange(`${ir.fullName}.${value.name}`, number);
      value.number = number;
      entry.values[value.name] = number;
    }
  }

  for (const [name, number] of Object.entries(entry.values)) {
    if (!seen.has(name)) {
      entry.reserved.push({ number, name });
      delete entry.values[name];
    }
  }
  ir.reserved = entry.reserved;
  return { warnings };
}

/** Marks lockfile entries absent from the current schema as `removed` rather than deleting them, per D6/§7.2. */
export function markRemovedEntries(
  lock: LockFile,
  presentMessageNames: ReadonlySet<string>,
  presentEnumNames: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(lock.messages)) {
    if (!presentMessageNames.has(name) && !entry.removed) {
      entry.removed = true;
      warnings.push(`message "${name}" is no longer defined in the schema; kept in the lockfile as removed`);
    }
  }
  for (const [name, entry] of Object.entries(lock.enums)) {
    if (!presentEnumNames.has(name) && !entry.removed) {
      entry.removed = true;
      warnings.push(`enum "${name}" is no longer defined in the schema; kept in the lockfile as removed`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Validation (run on every load, per §7.4)
// ---------------------------------------------------------------------------

function validateFieldNumbers(
  ownerName: string,
  fields: Record<string, LockFieldEntry>,
  reserved: IRReserved[],
  next: number,
): void {
  const seen = new Map<number, string>();
  for (const [name, f] of Object.entries(fields)) {
    checkRange(`${ownerName}.${name}`, f.number);
    const clash = seen.get(f.number);
    if (clash !== undefined) {
      throw new LockfileValidationError(
        `${ownerName} has duplicate field number ${f.number} used by both "${clash}" and "${name}"`,
      );
    }
    seen.set(f.number, name);
    if (f.number >= next) {
      throw new LockfileValidationError(
        `${ownerName}.nextField (${next}) must be greater than every assigned number, but "${name}" uses ${f.number}`,
      );
    }
  }
  for (const r of reserved) {
    checkRange(`${ownerName} reserved`, r.number);
    const clash = seen.get(r.number);
    if (clash !== undefined) {
      throw new LockfileValidationError(
        `${ownerName} has field number ${r.number} both active ("${clash}") and reserved ("${r.name}")`,
      );
    }
    seen.set(r.number, r.name);
    if (r.number >= next) {
      throw new LockfileValidationError(
        `${ownerName}.nextField (${next}) must be greater than every reserved number, but "${r.name}" uses ${r.number}`,
      );
    }
  }
}

function validateEnumNumbers(
  ownerName: string,
  values: Record<string, number>,
  reserved: IRReserved[],
  next: number,
): void {
  const seen = new Map<number, string>();
  for (const [name, number] of Object.entries(values)) {
    checkRange(`${ownerName}.${name}`, number);
    const clash = seen.get(number);
    if (clash !== undefined) {
      throw new LockfileValidationError(
        `${ownerName} has duplicate value number ${number} used by both "${clash}" and "${name}"`,
      );
    }
    seen.set(number, name);
    if (number >= next) {
      throw new LockfileValidationError(
        `${ownerName}.nextValue (${next}) must be greater than every assigned number, but "${name}" uses ${number}`,
      );
    }
  }
  for (const r of reserved) {
    checkRange(`${ownerName} reserved`, r.number);
    const clash = seen.get(r.number);
    if (clash !== undefined) {
      throw new LockfileValidationError(
        `${ownerName} has value number ${r.number} both active ("${clash}") and reserved ("${r.name}")`,
      );
    }
    seen.set(r.number, r.name);
    if (r.number >= next) {
      throw new LockfileValidationError(
        `${ownerName}.nextValue (${next}) must be greater than every reserved number, but "${r.name}" uses ${r.number}`,
      );
    }
  }
}

/**
 * `unknown`, not `LockFile`: this function's whole job is turning an
 * unvalidated value (freshly `JSON.parse()`d, in `parseLock`'s case) into a
 * trusted `LockFile` — asserting the input's type up front would just be
 * restating what this function is here to prove. Every field this function
 * itself reads off `candidate` is guarded before use; downstream code sees
 * a real `LockFile` only once every check below has passed.
 */
export function validateLock(lock: unknown): asserts lock is LockFile {
  if (!lock || typeof lock !== "object") {
    throw new LockfileValidationError("root is not an object");
  }
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the one crossing this assertion function makes, from the object check above to the shape it's about to validate field-by-field — see the doc comment above.
  const candidate = lock as LockFile;
  if (candidate.version !== 1) {
    throw new LockfileValidationError(`unsupported lockfile version ${JSON.stringify(candidate.version)}`);
  }
  for (const [name, entry] of Object.entries(candidate.messages ?? {})) {
    validateFieldNumbers(name, entry.fields, entry.reserved, entry.nextField);
  }
  for (const [name, entry] of Object.entries(candidate.enums ?? {})) {
    validateEnumNumbers(name, entry.values, entry.reserved, entry.nextValue);
  }
}

// ---------------------------------------------------------------------------
// Renames (handoff §7.5): identity is by name, so a rename must go through
// here rather than looking like delete-old + add-new to `syncMessage`.
// ---------------------------------------------------------------------------

/** Rewrites a stored type reference (a `LockFieldEntry.type`, or a `messages`/`enums` key) for a message rename. */
function renamedTypeRef(typeStr: string, oldFullName: string, newFullName: string): string {
  const isEnum = typeStr.startsWith("enum:");
  const bare = isEnum ? typeStr.slice(5) : typeStr;
  const renamed =
    bare === oldFullName
      ? newFullName
      : bare.startsWith(`${oldFullName}.`)
        ? newFullName + bare.slice(oldFullName.length)
        : bare;
  return isEnum ? `enum:${renamed}` : renamed;
}

/** Renames a field within one message, preserving its number, type, and label. Does not touch the Zod schema. */
export function renameField(lock: LockFile, messageFullName: string, oldName: string, newName: string): void {
  const entry = lock.messages[messageFullName];
  if (!entry) {
    throw new RenameError(`"${messageFullName}" is not in the lockfile.`);
  }
  if (!(oldName in entry.fields)) {
    if (entry.reserved.some((r) => r.name === oldName)) {
      throw new RenameError(
        `"${messageFullName}.${oldName}" is already reserved (removed), not an active field — it can't be renamed.`,
      );
    }
    throw new RenameError(`"${messageFullName}" has no active field named "${oldName}".`);
  }
  if (newName in entry.fields) {
    throw new RenameError(`"${messageFullName}" already has a field named "${newName}".`);
  }
  if (entry.reserved.some((r) => r.name === newName)) {
    throw new RenameError(
      `"${newName}" is a reserved name on "${messageFullName}" (a previously removed field) and can't be reused.`,
    );
  }
  const field = entry.fields[oldName]!; // proven present by the `in` check above
  delete entry.fields[oldName];
  entry.fields[newName] = field;
}

/**
 * Renames a message, cascading to any nested messages/enums and to every
 * field elsewhere in the lockfile that references the renamed message (or
 * something nested inside it) by type.
 */
export function renameMessage(lock: LockFile, oldFullName: string, newFullName: string): void {
  const entry = lock.messages[oldFullName];
  if (!entry) {
    throw new RenameError(`"${oldFullName}" is not in the lockfile.`);
  }
  if (newFullName in lock.messages) {
    throw new RenameError(`"${newFullName}" already exists in the lockfile.`);
  }

  for (const [key, msgEntry] of Object.entries(lock.messages)) {
    const renamedKey = renamedTypeRef(key, oldFullName, newFullName);
    if (renamedKey !== key) {
      delete lock.messages[key];
      lock.messages[renamedKey] = msgEntry;
    }
  }
  for (const [key, enumEntry] of Object.entries(lock.enums)) {
    const renamedKey = renamedTypeRef(key, oldFullName, newFullName);
    if (renamedKey !== key) {
      delete lock.enums[key];
      lock.enums[renamedKey] = enumEntry;
    }
  }
  for (const msgEntry of Object.values(lock.messages)) {
    for (const field of Object.values(msgEntry.fields)) {
      field.type = renamedTypeRef(field.type, oldFullName, newFullName);
    }
  }
}

/** Renames an enum value within one enum, preserving its number. Does not touch the Zod schema. */
export function renameEnumValue(lock: LockFile, enumFullName: string, oldName: string, newName: string): void {
  const entry = lock.enums[enumFullName];
  if (!entry) {
    throw new RenameError(`"${enumFullName}" is not in the lockfile.`);
  }
  if (!(oldName in entry.values)) {
    if (entry.reserved.some((r) => r.name === oldName)) {
      throw new RenameError(
        `"${enumFullName}.${oldName}" is already reserved (removed), not an active value — it can't be renamed.`,
      );
    }
    throw new RenameError(`"${enumFullName}" has no active value named "${oldName}".`);
  }
  if (newName in entry.values) {
    throw new RenameError(`"${enumFullName}" already has a value named "${newName}".`);
  }
  if (entry.reserved.some((r) => r.name === newName)) {
    throw new RenameError(
      `"${newName}" is a reserved name on "${enumFullName}" (a previously removed value) and can't be reused.`,
    );
  }
  const number = entry.values[oldName]!; // proven present by the `in` check above
  delete entry.values[oldName];
  entry.values[newName] = number;
}
