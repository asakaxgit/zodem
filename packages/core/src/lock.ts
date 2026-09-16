import type { IREnum, IRField, IRLabel, IRMessage, IRReserved, IRType } from "./ir.js";
import {
  BreakingChangeError,
  LockfileValidationError,
  ZodemError,
  PinnedNumberMismatchError,
} from "./errors.js";

export interface LockFieldEntry {
  number: number;
  /** canonical type key, see `typeKey()` */
  type: string;
  label: IRLabel;
}

export interface LockMessageEntry {
  nextField: number;
  fields: Record<string, LockFieldEntry>;
  reserved: IRReserved[];
  /** message existed in a prior generate but is absent from the current schema */
  removed?: boolean;
}

export interface LockEnumEntry {
  nextValue: number;
  values: Record<string, number>;
  reserved: IRReserved[];
  removed?: boolean;
}

export interface LockFile {
  version: 1;
  messages: Record<string, LockMessageEntry>;
  enums: Record<string, LockEnumEntry>;
}

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
    throw new LockfileValidationError(`${sourceForErrors} is not valid JSON (${(error as Error).message})`);
  }
  const lock = parsed as LockFile;
  validateLock(lock);
  return lock;
}

function sortRecord<T>(record: Record<string, T>, map: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = map(record[key] as T);
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

export interface SyncOptions {
  allowBreaking: boolean;
}

export interface SyncResult {
  warnings: string[];
}

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
  for (const field of ir.fields as IRField[]) {
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

export function validateLock(lock: LockFile): void {
  if (!lock || typeof lock !== "object") {
    throw new LockfileValidationError("root is not an object");
  }
  if (lock.version !== 1) {
    throw new LockfileValidationError(`unsupported lockfile version ${JSON.stringify(lock.version)}`);
  }
  for (const [name, entry] of Object.entries(lock.messages ?? {})) {
    validateFieldNumbers(name, entry.fields, entry.reserved, entry.nextField);
  }
  for (const [name, entry] of Object.entries(lock.enums ?? {})) {
    validateEnumNumbers(name, entry.values, entry.reserved, entry.nextValue);
  }
}
