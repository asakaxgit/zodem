import { z } from "zod";
import type {
  IREnum,
  IREnumValue,
  IRField,
  IRLabel,
  IRMessage,
  IRMethod,
  IRService,
  IRType,
  ScalarName,
  WellKnownTypeName,
} from "./ir.js";
import { ZodemError, UnsupportedTypeError } from "./errors.js";
import { zodemRegistry, getRegisteredMessages, getRegisteredServices, type ZodemFieldMeta, type ZodemServiceDef } from "./registry.js";
import { camelToSnake, pascalCase, upperSnake } from "./naming.js";

// Zod 4 internals are read through `_zod.def`, the sanctioned library-author
// API (see zod.dev/library-authors). It isn't meaningfully typeable from the
// outside, so we treat it as `any` at the boundary and rely on tests +
// buf-validated fixtures to catch drift, rather than fighting the type
// checker over a shape that is intentionally loosely typed upstream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDef = Record<string, any>;
type AnySchema = z.ZodType;

function defOf(schema: AnySchema): AnyDef {
  return (schema as unknown as { _zod: { def: AnyDef } })._zod.def;
}

export class WalkerContext {
  imports = new Set<string>();
  visiting = new Set<AnySchema>();
  messageCache = new Map<AnySchema, string>();
  enumCache = new Map<AnySchema, IREnum>();
  /** lazy wrappers currently being unwrapped, keyed by the z.lazy() schema itself (stable identity) */
  visitingLazy = new Set<AnySchema>();

  addImport(path: string): void {
    this.imports.add(path);
  }
}

export interface WalkResult {
  messages: IRMessage[];
  services: IRService[];
  imports: Set<string>;
}

export function walkRegistry(): WalkResult {
  const ctx = new WalkerContext();
  const messages: IRMessage[] = [];
  for (const { fullName, schema } of getRegisteredMessages()) {
    const def = defOf(schema);
    if (def.type !== "object") {
      throw new ZodemError(`"${fullName}" was registered with zodem.message() but is not a z.object()`);
    }
    messages.push(walkObjectIntoMessage(fullName, def.shape, ctx, fullName));
  }
  const services = getRegisteredServices().map((svc) => walkService(svc));
  return { messages, services, imports: ctx.imports };
}

// ---------------------------------------------------------------------------
// Unwrap: peel presence/refinement wrappers, accumulating meta as we go.
// ---------------------------------------------------------------------------

interface UnwrapResult {
  schema: AnySchema;
  def: AnyDef;
  optional: boolean;
  nullable: boolean;
  meta: ZodemFieldMeta;
  warnings: string[];
  /**
   * z.lazy() schemas consumed to reach this result, still marked "in
   * progress" in `ctx.visitingLazy`. The caller that eventually resolves a
   * concrete type from this result (`resolveConcreteType`) is responsible
   * for clearing them — not `unwrap()` itself, since for an anonymous
   * (unregistered) recursive schema the real re-entrance happens later,
   * inside the nested object-shape walk, not during unwrap.
   */
  lazyChain: AnySchema[];
}

function unwrap(schema: AnySchema, ctx: WalkerContext): UnwrapResult {
  const def = defOf(schema);
  const ownMeta = (z.globalRegistry.get(schema as never) ?? {}) as ZodemFieldMeta;

  const wrap = (inner: UnwrapResult, patch: Partial<Omit<UnwrapResult, "meta">> = {}): UnwrapResult => ({
    schema: patch.schema ?? inner.schema,
    def: patch.def ?? inner.def,
    optional: patch.optional ?? inner.optional,
    nullable: patch.nullable ?? inner.nullable,
    meta: { ...inner.meta, ...ownMeta },
    warnings: [...inner.warnings, ...(patch.warnings ?? [])],
    lazyChain: patch.lazyChain ?? inner.lazyChain,
  });

  switch (def.type) {
    case "optional":
      return wrap(unwrap(def.innerType, ctx), { optional: true });
    case "nullable":
      return wrap(unwrap(def.innerType, ctx), { nullable: true });
    case "nonoptional":
      return wrap(unwrap(def.innerType, ctx), { optional: false });
    case "readonly":
    case "default":
    case "prefault":
    case "catch":
      return wrap(unwrap(def.innerType, ctx));
    case "pipe": {
      const inner = unwrap(def.in, ctx);
      const isPlainTransform = defOf(def.out)?.type === "transform";
      return wrap(inner, {
        warnings: isPlainTransform
          ? []
          : [`.pipe() target schema is ignored for the wire type; the input side is used instead`],
      });
    }
    case "lazy": {
      if (ctx.visitingLazy.has(schema)) {
        throw new UnsupportedTypeError(
          "<lazy>",
          "self-referential z.lazy() without a registered zodem.message() has no stable identity to reference; wrap the recursive type in zodem.message() so z.lazy(() => TheMessage) can point at it by name",
        );
      }
      ctx.visitingLazy.add(schema);
      const inner = unwrap(def.getter(), ctx);
      return wrap(inner, { lazyChain: [...inner.lazyChain, schema] });
    }
    default:
      return { schema, def, optional: false, nullable: false, meta: ownMeta, warnings: [], lazyChain: [] };
  }
}

// ---------------------------------------------------------------------------
// Numeric format resolution
// ---------------------------------------------------------------------------

const NUMBER_FORMAT_TO_SCALAR: Record<string, ScalarName> = {
  safeint: "int32",
  int32: "int32",
  uint32: "uint32",
  float32: "float",
  float64: "double",
};

const BIGINT_FORMAT_TO_SCALAR: Record<string, ScalarName> = {
  int64: "int64",
  uint64: "uint64",
};

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function findFormatCheck(def: AnyDef, checkKind: string): string | undefined {
  for (const check of def.checks ?? []) {
    const cdef = defOf(check);
    if (cdef?.check === checkKind && typeof cdef.format === "string") return cdef.format;
  }
  return undefined;
}

function scanNumericBounds(def: AnyDef): { min?: number; max?: number } {
  let min: number | undefined;
  let max: number | undefined;
  for (const check of def.checks ?? []) {
    const cdef = defOf(check);
    if (cdef?.check === "greater_than") {
      const v = Number(cdef.value) + (cdef.inclusive ? 0 : 1);
      min = min === undefined ? v : Math.max(min, v);
    }
    if (cdef?.check === "less_than") {
      const v = Number(cdef.value) - (cdef.inclusive ? 0 : 1);
      max = max === undefined ? v : Math.min(max, v);
    }
  }
  return { min, max };
}

function resolveNumberScalar(def: AnyDef, meta: ZodemFieldMeta, path: string, warnings: string[]): ScalarName {
  if (meta.proto) return meta.proto;
  const format = (def.format as string | undefined) ?? findFormatCheck(def, "number_format");
  const scalar = format && NUMBER_FORMAT_TO_SCALAR[format] ? NUMBER_FORMAT_TO_SCALAR[format] : "double";
  if (scalar === "int32") {
    const { min, max } = scanNumericBounds(def);
    if (min === undefined && max === undefined) {
      warnings.push(`${path}: int32 has no .min()/.max() proving it fits 32 bits; add bounds or .meta({ proto: "int64" })`);
    } else if ((min !== undefined && min < INT32_MIN) || (max !== undefined && max > INT32_MAX)) {
      warnings.push(`${path}: bounds exceed the int32 range; use .meta({ proto: "int64" })`);
    }
  }
  return scalar;
}

function resolveBigintScalar(def: AnyDef, meta: ZodemFieldMeta): ScalarName {
  if (meta.proto) return meta.proto;
  const format = (def.format as string | undefined) ?? findFormatCheck(def, "bigint_format");
  return format && BIGINT_FORMAT_TO_SCALAR[format] ? BIGINT_FORMAT_TO_SCALAR[format] : "int64";
}

// ---------------------------------------------------------------------------
// Nullable -> google.protobuf.*Value wrapper mapping
// ---------------------------------------------------------------------------

const WRAPPER_FOR_SCALAR: Partial<Record<ScalarName, WellKnownTypeName>> = {
  double: "google.protobuf.DoubleValue",
  float: "google.protobuf.FloatValue",
  int64: "google.protobuf.Int64Value",
  uint64: "google.protobuf.UInt64Value",
  int32: "google.protobuf.Int32Value",
  uint32: "google.protobuf.UInt32Value",
  bool: "google.protobuf.BoolValue",
  string: "google.protobuf.StringValue",
  bytes: "google.protobuf.BytesValue",
};

interface Finalized {
  type: IRType;
  label: IRLabel;
  /** true if `.nullable()` applied at this field (regardless of how it was represented) */
  nullable: boolean;
  warnings: string[];
}

function finalize(
  baseType: IRType,
  opts: { optional: boolean; nullable: boolean; allowNullableWrapper: boolean; path: string; warnings: string[]; ctx: WalkerContext },
): Finalized {
  let type = baseType;
  let label: IRLabel;
  const warnings = [...opts.warnings];

  if (opts.nullable) {
    if (!opts.allowNullableWrapper) {
      throw new UnsupportedTypeError(
        opts.path,
        "`.nullable()` has no proto3 representation here (repeated/map elements carry no null state)",
      );
    }
    if (type.kind === "scalar") {
      const wrapper = WRAPPER_FOR_SCALAR[type.name];
      if (!wrapper) {
        throw new UnsupportedTypeError(
          opts.path,
          `\`.nullable()\` on a "${type.name}" field has no google.protobuf wrapper type; use \`.optional()\` instead`,
        );
      }
      opts.ctx.addImport("google/protobuf/wrappers.proto");
      type = { kind: "wkt", fullName: wrapper };
      label = "singular";
      warnings.push(`${opts.path}: null and absent both decode to "not set" (wrapper types collapse the two states)`);
    } else if (type.kind === "enum") {
      label = "optional";
      warnings.push(
        `${opts.path}: enums have no wrapper type; nullable falls back to proto3 "optional", so null and absent collapse`,
      );
    } else {
      label = "singular";
      warnings.push(`${opts.path}: null and absent both decode to "not set" for message-typed fields`);
    }
  } else {
    label = type.kind === "message" || type.kind === "wkt" ? "singular" : opts.optional ? "optional" : "singular";
  }

  return { type, label, nullable: opts.nullable, warnings };
}

// proto3 map keys are string or an integral/bool scalar — no float, double, bytes, message, or enum.
const MAP_KEY_SCALARS = new Set<ScalarName>([
  "string",
  "bool",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
]);

/**
 * proto3 disallows a repeated or map type nested directly inside another
 * repeated or map (array-of-array, map-of-array, map-of-map). Instead of
 * erroring, synthesize a one-field wrapper message — this cascades cleanly
 * for arbitrary depth, since each level only ever wraps its immediate child.
 */
function wrapCollectionIfNeeded(resolved: Finalized, currentMessage: IRMessage, namePreference: string): IRType {
  if (resolved.label !== "repeated" && resolved.type.kind !== "map") {
    return resolved.type;
  }
  // Depth-unique name: if what we're wrapping is itself already a wrapper
  // message (array-of-array-of-array, ...), base the new name on *its*
  // short name rather than reusing `namePreference` at every level — reusing
  // it would collide with the inner wrapper's name and silently reuse the
  // wrong message.
  const baseName = resolved.type.kind === "message" ? (resolved.type.fullName.split(".").pop() as string) : namePreference;
  const wrapperName = `${currentMessage.fullName}.${baseName}List`;
  let wrapper = currentMessage.nested.messages.find((m) => m.fullName === wrapperName);
  if (!wrapper) {
    wrapper = {
      fullName: wrapperName,
      fields: [{ name: "values", jsonName: "values", type: resolved.type, label: resolved.label, warnings: [] }],
      oneofs: [],
      nested: { messages: [], enums: [] },
      reserved: [],
      isListWrapper: true,
    };
    currentMessage.nested.messages.push(wrapper);
  }
  return { kind: "message", fullName: wrapperName };
}

// ---------------------------------------------------------------------------
// Concrete type resolution
// ---------------------------------------------------------------------------

function resolveConcreteType(
  unwrapped: UnwrapResult,
  currentMessage: IRMessage,
  ctx: WalkerContext,
  path: string,
  namePreference: string,
  allowNullableWrapper: boolean,
): Finalized {
  // Any z.lazy() schemas consumed to reach `unwrapped` stay marked "in
  // progress" for this whole call, including any nested object-shape walk
  // below (e.g. the "object" case's walkObjectIntoMessage) — that's what
  // lets an unregistered self-referential lazy schema be caught as a real
  // re-entrance instead of unwinding cleanly and stack-overflowing later.
  try {
    return resolveConcreteTypeInner(unwrapped, currentMessage, ctx, path, namePreference, allowNullableWrapper);
  } finally {
    for (const lazySchema of unwrapped.lazyChain) ctx.visitingLazy.delete(lazySchema);
  }
}

function resolveConcreteTypeInner(
  unwrapped: UnwrapResult,
  currentMessage: IRMessage,
  ctx: WalkerContext,
  path: string,
  namePreference: string,
  allowNullableWrapper: boolean,
): Finalized {
  const { schema, def, optional, nullable, meta } = unwrapped;
  const warnings = [...unwrapped.warnings];

  const regMeta = zodemRegistry.get(schema as never);
  if (regMeta?.kind === "bytes") {
    return finalize({ kind: "scalar", name: "bytes" }, { optional, nullable, allowNullableWrapper, path, warnings, ctx });
  }
  if (regMeta?.kind === "message") {
    return finalize(
      { kind: "message", fullName: regMeta.fullName },
      { optional, nullable, allowNullableWrapper, path, warnings, ctx },
    );
  }

  switch (def.type) {
    case "array": {
      if (nullable) {
        throw new UnsupportedTypeError(
          path,
          "`.nullable()` on a repeated field has no proto3 equivalent; remove it (repeated already allows zero elements)",
        );
      }
      const elementUnwrapped = unwrap(def.element, ctx);
      if (elementUnwrapped.optional || elementUnwrapped.nullable) {
        throw new UnsupportedTypeError(
          `${path}[]`,
          "array elements cannot be optional/nullable in proto3; move the modifier to the whole field",
        );
      }
      const element = resolveConcreteType(elementUnwrapped, currentMessage, ctx, `${path}[]`, namePreference, false);
      const elementType = wrapCollectionIfNeeded(element, currentMessage, namePreference);
      return { type: elementType, label: "repeated", nullable: false, warnings: [...warnings, ...element.warnings] };
    }
    case "record": {
      const keyUnwrapped = unwrap(def.keyType, ctx);
      if (keyUnwrapped.optional || keyUnwrapped.nullable) {
        throw new UnsupportedTypeError(`${path}{key}`, "map keys cannot be optional/nullable");
      }
      const keyResolved = resolveConcreteType(keyUnwrapped, currentMessage, ctx, `${path}{key}`, namePreference, false);
      if (keyResolved.type.kind !== "scalar" || !MAP_KEY_SCALARS.has(keyResolved.type.name)) {
        const got = keyResolved.type.kind === "scalar" ? keyResolved.type.name : keyResolved.type.kind;
        throw new UnsupportedTypeError(
          path,
          `map keys must be string or an integral/bool scalar, got "${got}" — proto3 map keys can't be float, double, bytes, message, or enum`,
        );
      }

      const valueUnwrapped = unwrap(def.valueType, ctx);
      if (valueUnwrapped.optional || valueUnwrapped.nullable) {
        throw new UnsupportedTypeError(`${path}{value}`, "map values cannot be optional/nullable in proto3");
      }
      const valueResolved = resolveConcreteType(valueUnwrapped, currentMessage, ctx, `${path}{value}`, namePreference, false);
      const valueType = wrapCollectionIfNeeded(valueResolved, currentMessage, namePreference);

      return {
        type: { kind: "map", key: keyResolved.type.name, value: valueType },
        label: "singular",
        nullable: false,
        warnings: [...warnings, ...keyResolved.warnings, ...valueResolved.warnings],
      };
    }
    case "object": {
      const nestedFullName = `${currentMessage.fullName}.${namePreference}`;
      if (ctx.visiting.has(schema)) {
        throw new UnsupportedTypeError(path, "circular object reference without z.lazy() is not supported");
      }
      let fullName = ctx.messageCache.get(schema);
      if (!fullName) {
        fullName = nestedFullName;
        ctx.messageCache.set(schema, fullName);
        ctx.visiting.add(schema);
        const nestedMsg = walkObjectIntoMessage(fullName, def.shape, ctx, path);
        ctx.visiting.delete(schema);
        currentMessage.nested.messages.push(nestedMsg);
      }
      return finalize({ kind: "message", fullName }, { optional, nullable, allowNullableWrapper, path, warnings, ctx });
    }
    case "enum": {
      const cached = ctx.enumCache.get(schema);
      if (cached) {
        return finalize({ kind: "enum", fullName: cached.fullName }, { optional, nullable, allowNullableWrapper, path, warnings, ctx });
      }
      const fullName = `${currentMessage.fullName}.${namePreference}`;
      const upperName = upperSnake(namePreference);
      const values: IREnumValue[] = [];
      for (const [entryKey, entryVal] of Object.entries(def.entries as Record<string, string | number>)) {
        if (/^\d+$/.test(entryKey)) continue; // reverse-mapped numeric enum key
        void entryVal;
        values.push({ name: `${upperName}_${upperSnake(entryKey)}`, zodValue: entryKey });
      }
      const enumIR: IREnum = { fullName, values, reserved: [] };
      ctx.enumCache.set(schema, enumIR);
      currentMessage.nested.enums.push(enumIR);
      return finalize({ kind: "enum", fullName }, { optional, nullable, allowNullableWrapper, path, warnings, ctx });
    }
    case "literal": {
      const vals = def.values as unknown[];
      if (!vals || vals.length !== 1) {
        throw new UnsupportedTypeError(path, "z.literal() with multiple values is not supported; use z.enum() instead");
      }
      const v = vals[0];
      let scalar: ScalarName;
      if (meta.proto) scalar = meta.proto;
      else if (typeof v === "string") scalar = "string";
      else if (typeof v === "number") scalar = "double";
      else if (typeof v === "boolean") scalar = "bool";
      else if (typeof v === "bigint") scalar = "int64";
      else throw new UnsupportedTypeError(path, `z.literal() of type ${typeof v} has no proto equivalent`);
      return finalize({ kind: "scalar", name: scalar }, { optional, nullable, allowNullableWrapper, path, warnings, ctx });
    }
    case "unknown":
    case "any":
      ctx.addImport("google/protobuf/struct.proto");
      return finalize(
        { kind: "wkt", fullName: "google.protobuf.Value" },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "date":
      ctx.addImport("google/protobuf/timestamp.proto");
      return finalize(
        { kind: "wkt", fullName: "google.protobuf.Timestamp" },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "string":
      return finalize(
        { kind: "scalar", name: meta.proto ?? "string" },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "boolean":
      return finalize(
        { kind: "scalar", name: meta.proto ?? "bool" },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "number":
      return finalize(
        { kind: "scalar", name: resolveNumberScalar(def, meta, path, warnings) },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "bigint":
      return finalize(
        { kind: "scalar", name: resolveBigintScalar(def, meta) },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "custom":
      throw new UnsupportedTypeError(
        path,
        "z.instanceof()/custom schemas are not supported except zodem.bytes(); use zodem.bytes() for Uint8Array fields",
      );
    case "union":
      throw new UnsupportedTypeError(path, "plain z.union() has no proto equivalent; use z.discriminatedUnion() instead");
    case "intersection":
      throw new UnsupportedTypeError(
        path,
        "z.intersection() is not supported; merge the shapes manually with z.object({ ...a.shape, ...b.shape })",
      );
    case "tuple":
      throw new UnsupportedTypeError(path, "z.tuple() is not supported; use z.array() or separate fields");
    case "map":
      throw new UnsupportedTypeError(path, "z.map() is not supported; model it as z.array(z.object({ key, value }))");
    case "set":
      throw new UnsupportedTypeError(path, "z.set() is not supported; use z.array() with application-level uniqueness");
    case "function":
      throw new UnsupportedTypeError(path, "z.function() has no proto equivalent");
    case "promise":
      throw new UnsupportedTypeError(path, "z.promise() has no proto equivalent; unwrap it before passing to zodem.message()");
    default:
      throw new UnsupportedTypeError(path, `Zod type "${String(def.type)}" is not supported`);
  }
}

// ---------------------------------------------------------------------------
// Object -> IRMessage, discriminated unions -> oneof
// ---------------------------------------------------------------------------

export function walkObjectIntoMessage(
  fullName: string,
  shape: Record<string, AnySchema>,
  ctx: WalkerContext,
  path: string,
): IRMessage {
  const msg: IRMessage = { fullName, fields: [], oneofs: [], nested: { messages: [], enums: [] }, reserved: [] };
  for (const [key, fieldSchema] of Object.entries(shape)) {
    processField(key, fieldSchema, msg, ctx, `${path}.${key}`);
  }
  return msg;
}

function processField(key: string, fieldSchema: AnySchema, currentMessage: IRMessage, ctx: WalkerContext, path: string): void {
  const unwrapped = unwrap(fieldSchema, ctx);
  const namePreference = unwrapped.meta.name ?? pascalCase(key);

  if (unwrapped.def.type === "union" && typeof unwrapped.def.discriminator === "string") {
    processDiscriminatedUnion(key, unwrapped, currentMessage, ctx, path);
    return;
  }

  const resolved = resolveConcreteType(unwrapped, currentMessage, ctx, path, namePreference, true);
  currentMessage.fields.push({
    name: camelToSnake(key),
    jsonName: key,
    type: resolved.type,
    label: resolved.label,
    pinned: unwrapped.meta.field,
    nullable: resolved.nullable,
    warnings: resolved.warnings,
  } satisfies IRField);
}

function processDiscriminatedUnion(
  fieldKey: string,
  unwrapped: UnwrapResult,
  currentMessage: IRMessage,
  ctx: WalkerContext,
  path: string,
): void {
  const def = unwrapped.def;
  const discriminatorKey = def.discriminator as string;
  const oneofName = camelToSnake(fieldKey);
  const memberFieldNames: string[] = [];
  const sharedWarnings = [...unwrapped.warnings];
  if (unwrapped.nullable) {
    sharedWarnings.push(`${path}: null and absent both collapse to "no case set" for discriminated unions`);
  }

  for (const option of def.options as AnySchema[]) {
    const optionDef = defOf(option);
    if (optionDef.type !== "object") {
      throw new UnsupportedTypeError(path, "discriminated union branches must be z.object()");
    }
    const discField = optionDef.shape[discriminatorKey];
    if (!discField) {
      throw new UnsupportedTypeError(path, `branch is missing the discriminator key "${discriminatorKey}"`);
    }
    const discFieldDef = unwrap(discField, ctx).def;
    const literalValues = discFieldDef.type === "literal" ? (discFieldDef.values as unknown[]) : undefined;
    if (!literalValues || literalValues.length !== 1 || typeof literalValues[0] !== "string") {
      throw new UnsupportedTypeError(
        path,
        `discriminator field "${discriminatorKey}" must be a single string z.literal() per branch`,
      );
    }
    const discValue = literalValues[0] as string;

    const regMeta = zodemRegistry.get(option as never);
    let branchFullName: string;
    if (regMeta?.kind === "message") {
      branchFullName = regMeta.fullName;
    } else {
      branchFullName = `${currentMessage.fullName}.${pascalCase(fieldKey)}${pascalCase(discValue)}`;
      const branchShape: Record<string, AnySchema> = { ...(optionDef.shape as Record<string, AnySchema>) };
      delete branchShape[discriminatorKey];
      const nestedMsg = walkObjectIntoMessage(branchFullName, branchShape, ctx, `${path}.${discValue}`);
      currentMessage.nested.messages.push(nestedMsg);
    }

    const memberFieldName = camelToSnake(discValue);
    memberFieldNames.push(memberFieldName);
    currentMessage.fields.push({
      name: memberFieldName,
      jsonName: discValue,
      type: { kind: "message", fullName: branchFullName },
      label: "singular",
      oneof: oneofName,
      warnings: [...sharedWarnings],
    } satisfies IRField);
  }

  currentMessage.oneofs.push({ name: oneofName, zodFieldKey: fieldKey, discriminatorKey, fields: memberFieldNames });
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

function walkService(def: ZodemServiceDef): IRService {
  const methods: IRMethod[] = [];
  for (const [name, m] of Object.entries(def.methods)) {
    const inputMeta = zodemRegistry.get(m.input as never);
    const outputMeta = zodemRegistry.get(m.output as never);
    if (inputMeta?.kind !== "message") {
      throw new ZodemError(`${def.fullName}.${name}: input must be a zodem.message()`);
    }
    if (outputMeta?.kind !== "message") {
      throw new ZodemError(`${def.fullName}.${name}: output must be a zodem.message()`);
    }
    const pascalMethod = pascalCase(name);
    const inputShort = inputMeta.fullName.split(".").pop()!;
    const outputShort = outputMeta.fullName.split(".").pop()!;
    // buf's DEFAULT lint category (RPC_REQUEST_STANDARD_NAME / RPC_RESPONSE_STANDARD_NAME)
    // requires exactly this naming; failing fast here beats a confusing buf-lint failure later.
    if (inputShort !== `${pascalMethod}Request`) {
      throw new ZodemError(
        `${def.fullName}.${name}: input message "${inputShort}" must be named "${pascalMethod}Request" (buf lint RPC_REQUEST_STANDARD_NAME)`,
      );
    }
    if (outputShort !== `${pascalMethod}Response`) {
      throw new ZodemError(
        `${def.fullName}.${name}: output message "${outputShort}" must be named "${pascalMethod}Response" (buf lint RPC_RESPONSE_STANDARD_NAME)`,
      );
    }
    methods.push({
      name: pascalMethod,
      input: inputMeta.fullName,
      output: outputMeta.fullName,
      clientStreaming: m.stream === "client" || m.stream === "bidi",
      serverStreaming: m.stream === "server" || m.stream === "bidi",
      warnings: [],
    });
  }
  return { fullName: def.fullName, methods };
}
