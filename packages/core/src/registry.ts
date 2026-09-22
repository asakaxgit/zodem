import { z } from "zod";
import { SCALAR_NAMES, type ScalarName } from "./ir.js";
import { DuplicateRegistrationError, ZodemError } from "./errors.js";

/**
 * `.meta({...})` keys zodem reads off Zod schemas. This rides the
 * standard `z.globalRegistry`, not a zodem-specific one, because it must
 * survive being written anywhere in a schema, including by users who never
 * import this package directly (e.g. a shared validation library).
 */
export type ZodemFieldMeta = {
  /** Pin the wire field number. Escape hatch for importing an existing .proto contract. */
  field?: number;
  /** Override the inferred scalar wire type, e.g. "sint32", "fixed64". */
  proto?: ScalarName;
  /** Override the generated nested message/enum name. */
  name?: string;
  /** Set to `false` to suppress protovalidate rule emission for this field, overriding the emitter's `validate` config flag. */
  validate?: false;
  /** Escape hatch for @zodem/llm's JSON Schema/tool-call emission: `false` omits this field from the LLM-facing schema, `{ name }` renames it there — independent of the wire/proto shape either way. */
  llm?: false | { name?: string };
};

export type ZodemMeta =
  | { kind: "message"; fullName: string; package: string }
  | { kind: "bytes" };

/** Identity registry: which schema instances are zodem.message / zodem.bytes. */
export const zodemRegistry = z.registry<ZodemMeta>();

const scalarNames: readonly string[] = SCALAR_NAMES;

const isScalarName = (v: unknown): v is ScalarName => {
  return typeof v === "string" && scalarNames.includes(v);
};

const isRecord = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null && !Array.isArray(v);
};

/**
 * Reads zodem's own keys out of a schema's `.meta()` blob. `z.globalRegistry`
 * is an open metadata bag (`{ [k: string]: unknown }` upstream, shared with
 * whatever else a schema's `.meta()` carries — `.describe()`, JSON Schema
 * `id`/`title`, …), so each key is *checked* here rather than asserted. That
 * also turns a typo like `.meta({ proto: "flaot" })` from something that
 * silently reaches the emitted `.proto` into an error at walk time.
 */
export const readFieldMeta = (schema: z.core.$ZodType): ZodemFieldMeta => {
  const raw = z.globalRegistry.get(schema) ?? {};
  const meta: ZodemFieldMeta = {};
  if (typeof raw.field === "number") meta.field = raw.field;
  if (raw.proto !== undefined) {
    if (!isScalarName(raw.proto)) {
      throw new ZodemError(`.meta({ proto }) must be a protobuf scalar name, got ${JSON.stringify(raw.proto)}`);
    }
    meta.proto = raw.proto;
  }
  if (typeof raw.name === "string") meta.name = raw.name;
  if (raw.validate === false) meta.validate = false;
  if (raw.llm === false) {
    meta.llm = false;
  } else if (isRecord(raw.llm)) {
    meta.llm = typeof raw.llm.name === "string" ? { name: raw.llm.name } : {};
  }
  return meta;
};

const PACKAGE_SEGMENT = /^[a-z][a-z0-9_]*$/u;
const PASCAL_SEGMENT = /^[A-Z][A-Za-z0-9_]*$/u;

const packageOf = (fullName: string): string => {
  const parts = fullName.split(".");
  parts.pop();
  return parts.join(".");
};

const assertFullName = (fullName: string, kind: "message" | "service"): void => {
  const segments = fullName.split(".");
  const last = segments[segments.length - 1];
  const pkg = segments.slice(0, -1);
  if (segments.length < 2 || !pkg.every((s) => PACKAGE_SEGMENT.test(s)) || !last || !PASCAL_SEGMENT.test(last)) {
    throw new ZodemError(
      `Invalid ${kind} name "${fullName}": expected a dotted package plus a PascalCase name, ` +
        `e.g. "acme.user.v1.User" (package segments lowercase, final segment PascalCase).`,
    );
  }
};

const registeredNames = new Set<string>();
const messagesByName = new Map<string, z.ZodType>();

const claimName = (fullName: string): void => {
  if (registeredNames.has(fullName)) throw new DuplicateRegistrationError(fullName);
  registeredNames.add(fullName);
};

/**
 * Declares a top-level protobuf message backed by a Zod object schema.
 * Returns a normal `z.object()` — `.parse()` / `.safeParse()` work exactly
 * as usual — and additionally records the schema's full name so the walker
 * can resolve references to it instead of inlining it as a nested message.
 */
export const message = <Shape extends z.core.$ZodShape>(
  fullName: string,
  shape: Shape,
): z.ZodObject<Shape> => {
  assertFullName(fullName, "message");
  claimName(fullName);
  const schema = z.object(shape);
  // .register() (not .meta()) so identity is preserved — .meta() clones.
  schema.register(zodemRegistry, { kind: "message", fullName, package: packageOf(fullName) });
  messagesByName.set(fullName, schema);
  return schema;
};

export type RegisteredMessage = {
  fullName: string;
  schema: z.ZodType;
};

export const getRegisteredMessages = (): RegisteredMessage[] => {
  return [...messagesByName.entries()].map(([fullName, schema]) => ({ fullName, schema }));
};

/** The supported spelling for a `bytes` field (`z.instanceof` isn't reliably introspectable). */
export const bytes = (): z.ZodType<Uint8Array, Uint8Array> => {
  const schema = z.instanceof(Uint8Array);
  schema.register(zodemRegistry, { kind: "bytes" });
  return schema;
};

export type ZodemMethodDef<
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> = {
  input: In;
  output: Out;
  /** Which side streams. Omit for unary. */
  stream?: "server" | "client" | "bidi";
  /** Human-readable description of this method — used as the tool `description` by @zodem/llm; Zod's `.describe()` only covers fields, not the method itself. */
  description?: string;
};

export type ZodemServiceDef = {
  fullName: string;
  package: string;
  methods: Record<string, ZodemMethodDef>;
};

const serviceRegistry = new Map<string, ZodemServiceDef>();

/** Declares a gRPC/Connect service made of `zodem.message` request/response pairs. */
export const service = (
  fullName: string,
  methods: Record<string, ZodemMethodDef>,
): ZodemServiceDef => {
  assertFullName(fullName, "service");
  claimName(fullName);
  const def: ZodemServiceDef = { fullName, package: packageOf(fullName), methods };
  serviceRegistry.set(fullName, def);
  return def;
};

export const getRegisteredServices = (): ZodemServiceDef[] => {
  return [...serviceRegistry.values()];
};

/** Clears module-level registries — used between CLI runs in the same process, and in tests. */
export const resetRegistry = (): void => {
  registeredNames.clear();
  messagesByName.clear();
  serviceRegistry.clear();
};

export const zodem = { message, service, bytes };
