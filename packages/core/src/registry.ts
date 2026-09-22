import { z } from "zod";
import type { ScalarName } from "./ir.js";
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

const PACKAGE_SEGMENT = /^[a-z][a-z0-9_]*$/;
const PASCAL_SEGMENT = /^[A-Z][A-Za-z0-9_]*$/;

function packageOf(fullName: string): string {
  const parts = fullName.split(".");
  parts.pop();
  return parts.join(".");
}

function assertFullName(fullName: string, kind: "message" | "service"): void {
  const segments = fullName.split(".");
  const last = segments[segments.length - 1];
  const pkg = segments.slice(0, -1);
  if (segments.length < 2 || !pkg.every((s) => PACKAGE_SEGMENT.test(s)) || !last || !PASCAL_SEGMENT.test(last)) {
    throw new ZodemError(
      `Invalid ${kind} name "${fullName}": expected a dotted package plus a PascalCase name, ` +
        `e.g. "acme.user.v1.User" (package segments lowercase, final segment PascalCase).`,
    );
  }
}

const registeredNames = new Set<string>();
const messagesByName = new Map<string, z.ZodType>();

function claimName(fullName: string): void {
  if (registeredNames.has(fullName)) throw new DuplicateRegistrationError(fullName);
  registeredNames.add(fullName);
}

/**
 * Declares a top-level protobuf message backed by a Zod object schema.
 * Returns a normal `z.object()` — `.parse()` / `.safeParse()` work exactly
 * as usual — and additionally records the schema's full name so the walker
 * can resolve references to it instead of inlining it as a nested message.
 */
export function message<Shape extends z.core.$ZodShape>(
  fullName: string,
  shape: Shape,
): z.ZodObject<Shape> {
  assertFullName(fullName, "message");
  claimName(fullName);
  const schema = z.object(shape);
  // .register() (not .meta()) so identity is preserved — .meta() clones.
  schema.register(zodemRegistry, { kind: "message", fullName, package: packageOf(fullName) });
  messagesByName.set(fullName, schema);
  return schema;
}

export type RegisteredMessage = {
  fullName: string;
  schema: z.ZodType;
};

export function getRegisteredMessages(): RegisteredMessage[] {
  return [...messagesByName.entries()].map(([fullName, schema]) => ({ fullName, schema }));
}

/** The supported spelling for a `bytes` field (`z.instanceof` isn't reliably introspectable). */
export function bytes(): z.ZodType<Uint8Array, Uint8Array> {
  const schema = z.instanceof(Uint8Array);
  schema.register(zodemRegistry, { kind: "bytes" });
  return schema;
}

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
export function service(
  fullName: string,
  methods: Record<string, ZodemMethodDef>,
): ZodemServiceDef {
  assertFullName(fullName, "service");
  claimName(fullName);
  const def: ZodemServiceDef = { fullName, package: packageOf(fullName), methods };
  serviceRegistry.set(fullName, def);
  return def;
}

export function getRegisteredServices(): ZodemServiceDef[] {
  return [...serviceRegistry.values()];
}

/** Clears module-level registries — used between CLI runs in the same process, and in tests. */
export function resetRegistry(): void {
  registeredNames.clear();
  messagesByName.clear();
  serviceRegistry.clear();
}

export const zodem = { message, service, bytes };
