import type { z } from "zod";
import type {
  IREnum,
  IREnumValue,
  IRField,
  IRLabel,
  IRMessage,
  IRMethod,
  IRRuleSet,
  IRRuleValue,
  IRService,
  IRType,
  ScalarName,
  WellKnownTypeName,
} from "./ir.js";
import { ZodemError, UnsupportedTypeError } from "./errors.js";
import {
  zodemRegistry,
  getRegisteredMessages,
  getRegisteredServices,
  readFieldMeta,
  type ZodemFieldMeta,
  type ZodemServiceDef,
} from "./registry.js";
import { camelToSnake, pascalCase, upperSnake } from "./naming.js";

// ---------------------------------------------------------------------------
// The Zod-internals boundary.
//
// Zod 4 exposes `_zod.def` as the sanctioned library-author API
// (zod.dev/library-authors), declared publicly as just the base
// `$ZodTypeDef` — `{ type, error?, checks? }`. The per-kind payload
// (`shape`, `element`, `innerType`, `entries`, …) lives on the `$Zod*Def`
// subtypes Zod also exports under `z.core`, each of which redeclares `type`
// as a literal. Unioning the ones this walker actually reads gives a
// genuine discriminated union — `switch (def.type)` narrows to the exact
// def and its payload below, with no cast anywhere downstream.
//
// The step from the declared base type to that union is the one thing the
// type system can't prove on its own, so it happens exactly twice in this
// file — `defOf` and `checkDefsOf` — and nowhere else.
// ---------------------------------------------------------------------------

type AnySchema = z.core.$ZodType;

/**
 * Every def kind this walker reads a payload off. The "-FormatDef" members
 * (e.g. `$ZodStringFormatDef`, produced by `z.email()`) share their base's
 * `type` literal ("string") but additionally carry `format`/`check` —
 * that's the same dual shape `findFormatCheck` below has always handled:
 * format info arrives either directly on the schema's own def, or as a
 * separate check pushed onto `def.checks` by chaining (`z.string().email()`).
 */
type TypedDef =
  | z.core.$ZodStringDef
  | z.core.$ZodStringFormatDef
  | z.core.$ZodNumberDef
  | z.core.$ZodNumberFormatDef
  | z.core.$ZodBigIntDef
  | z.core.$ZodBigIntFormatDef
  | z.core.$ZodArrayDef
  | z.core.$ZodObjectDef
  | z.core.$ZodRecordDef
  | z.core.$ZodEnumDef
  | z.core.$ZodLiteralDef<z.core.util.Literal>
  | z.core.$ZodUnionDef
  | z.core.$ZodDiscriminatedUnionDef
  | z.core.$ZodOptionalDef
  | z.core.$ZodNullableDef
  | z.core.$ZodNonOptionalDef
  | z.core.$ZodDefaultDef
  | z.core.$ZodPrefaultDef
  | z.core.$ZodCatchDef
  | z.core.$ZodReadonlyDef
  | z.core.$ZodPipeDef
  | z.core.$ZodLazyDef;

/**
 * Every remaining Zod `type` literal (boolean, date, unknown/any, custom,
 * tuple, …). The walker reads nothing off these but `type` itself — some
 * map straight to a proto type, the rest are rejected with
 * UnsupportedTypeError — so there's no payload to model here, and modelling
 * only `type` is what keeps every one of those `case`s reachable while
 * still making e.g. `def.shape` a compile error on this branch.
 */
type OpaqueDef = z.core.$ZodTypeDef & { type: Exclude<z.core.$ZodTypeDef["type"], TypedDef["type"]> };

type ZodemDef = TypedDef | OpaqueDef;

const defOf = (schema: AnySchema): ZodemDef => {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the one sanctioned crossing into Zod internals (zod.dev/library-authors). A downcast from the declared base `$ZodTypeDef` to the per-kind subtype Zod actually constructed; everything downstream is fully typed.
  return schema._zod.def as ZodemDef;
};

/** Every check-def kind this walker reads a payload off (`def.checks[i]`). */
type TypedCheckDef =
  | z.core.$ZodCheckLessThanDef
  | z.core.$ZodCheckGreaterThanDef
  | z.core.$ZodCheckMinLengthDef
  | z.core.$ZodCheckMaxLengthDef
  | z.core.$ZodCheckLengthEqualsDef
  | z.core.$ZodCheckNumberFormatDef
  | z.core.$ZodCheckBigIntFormatDef
  | z.core.$ZodCheckStringFormatDef
  | z.core.$ZodCheckRegexDef
  | z.core.$ZodCheckStartsWithDef
  | z.core.$ZodCheckEndsWithDef
  | z.core.$ZodCheckIncludesDef
  | z.core.$ZodCheckLowerCaseDef
  | z.core.$ZodCheckUpperCaseDef;

/**
 * A check kind this walker doesn't model (e.g. "mime_type", "overwrite")
 * still lands here at runtime — the header comment above `STRING_FORMAT_RULE`
 * is the actual contract: anything not matched by a `case`/`if` below is
 * silently skipped, never guessed, so an imprecise type for that case costs
 * nothing.
 */
type ZodemCheckDef = TypedCheckDef;

/** The checks attached to a def, already unwrapped to their own defs. */
const checkDefsOf = (def: ZodemDef): ZodemCheckDef[] => {
  // Every concrete `$ZodCheck<T>[]` a def declares (`$ZodCheck<string>[]`,
  // `$ZodCheck<boolean>[]`, …) is assignable to `$ZodCheck<never>[]` — `in T`
  // is contravariant, and `never` is assignable to any `T` — so this one
  // annotation is enough to unify every def's `checks` into a single
  // concrete array type before mapping over it.
  const checks: readonly z.core.$ZodCheck<never>[] = def.checks ?? [];
  return checks.map((c) => {
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: same Zod-internals boundary as defOf — `$ZodCheckDef` downcast to the per-check subtype Zod constructed.
    return c._zod.def as ZodemCheckDef;
  });
};

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

export type WalkResult = {
  messages: IRMessage[];
  services: IRService[];
  imports: Set<string>;
};

export const walkRegistry = (): WalkResult => {
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
};

// ---------------------------------------------------------------------------
// Unwrap: peel presence/refinement wrappers, accumulating meta as we go.
// ---------------------------------------------------------------------------

type UnwrapResult = {
  schema: AnySchema;
  def: ZodemDef;
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
};

const unwrap = (schema: AnySchema, ctx: WalkerContext): UnwrapResult => {
  const def = defOf(schema);
  const ownMeta = readFieldMeta(schema);

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
      const isPlainTransform = defOf(def.out).type === "transform";
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
};

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

const findFormatCheck = (def: ZodemDef, checkKind: string): string | undefined => {
  for (const cdef of checkDefsOf(def)) {
    if ("format" in cdef && cdef.check === checkKind && typeof cdef.format === "string") return cdef.format;
  }
  return undefined;
};

const scanNumericBounds = (def: ZodemDef): { min?: number; max?: number } => {
  let min: number | undefined;
  let max: number | undefined;
  for (const cdef of checkDefsOf(def)) {
    if (cdef.check === "greater_than") {
      const v = Number(cdef.value) + (cdef.inclusive ? 0 : 1);
      min = min === undefined ? v : Math.max(min, v);
    }
    if (cdef.check === "less_than") {
      const v = Number(cdef.value) - (cdef.inclusive ? 0 : 1);
      max = max === undefined ? v : Math.min(max, v);
    }
  }
  return { min, max };
};

const resolveNumberScalar = (
  def: z.core.$ZodNumberDef | z.core.$ZodNumberFormatDef,
  meta: ZodemFieldMeta,
  path: string,
  warnings: string[],
): ScalarName => {
  if (meta.proto) return meta.proto;
  const format = "format" in def ? def.format : findFormatCheck(def, "number_format");
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
};

const resolveBigintScalar = (def: z.core.$ZodBigIntDef | z.core.$ZodBigIntFormatDef, meta: ZodemFieldMeta): ScalarName => {
  if (meta.proto) return meta.proto;
  const format = "format" in def ? def.format : findFormatCheck(def, "bigint_format");
  return format && BIGINT_FORMAT_TO_SCALAR[format] ? BIGINT_FORMAT_TO_SCALAR[format] : "int64";
};

// ---------------------------------------------------------------------------
// protovalidate (buf.validate) rule collection.
//
// Read straight off the same `def.checks` this file already scans for the
// int32-range warning above, and always collected regardless of whether any
// emitter renders them — a future JSON Schema emitter is one more consumer
// of the same IR. Anything not in these tables is silently skipped, never
// guessed: an unmapped Zod check produces no rule rather than a wrong one.
// ---------------------------------------------------------------------------

// z.email()/.uuid()/.url()/... set `format` on the schema's own def with no
// check entry; z.string().email() etc. push a `string_format` check instead
// (see findFormatCheck's dual-shape handling above) — a format can arrive
// either way, so both are read the same way here.
const STRING_FORMAT_RULE: Record<string, string> = {
  email: "email",
  uuid: "uuid",
  guid: "uuid", // protovalidate has no separate "loose GUID" rule; uuid is the closest fit
  url: "uri",
  ipv4: "ipv4",
  ipv6: "ipv6",
};

/**
 * The union of "format"-carrying string check/def shapes this function reads
 * fields off — spans both a schema's own compound def (e.g. `z.email()`'s
 * `$ZodStringFormatDef`) and a chained check's def (e.g.
 * `z.string().regex(...)`'s `$ZodCheckRegexDef`). A structural shape rather
 * than one of Zod's own exported unions: discriminating on `.format` across
 * a real union whose members don't all share the same extra fields defeats
 * narrowing here (`$ZodCheckStringFormatDef`'s own `.format: string` stays
 * reachable in every case, so `.prefix` etc. would stay inaccessible) —
 * every real caller structurally satisfies this regardless, so passing one
 * in needs no cast.
 */
type StringFormatLike = {
  format: string;
  pattern?: RegExp;
  prefix?: string;
  suffix?: string;
  includes?: string;
};

const applyStringFormat = (rules: Record<string, IRRuleValue>, cdef: StringFormatLike): void => {
  const format = cdef.format;
  if (format === "regex" && cdef.pattern instanceof RegExp) {
    // .source drops the slashes/flags; protovalidate's `pattern` (RE2, no flags support) can only take the bare pattern text.
    rules.pattern = cdef.pattern.source;
    return;
  }
  if (format === "starts_with" && typeof cdef.prefix === "string") {
    rules.prefix = cdef.prefix;
    return;
  }
  if (format === "ends_with" && typeof cdef.suffix === "string") {
    rules.suffix = cdef.suffix;
    return;
  }
  if (format === "includes" && typeof cdef.includes === "string") {
    rules.contains = cdef.includes;
    return;
  }
  const rule = format ? STRING_FORMAT_RULE[format] : undefined;
  if (rule) rules[rule] = true;
};

const collectStringRules = (def: ZodemDef): Record<string, IRRuleValue> => {
  const rules: Record<string, IRRuleValue> = {};
  if ("format" in def && def.check === "string_format") applyStringFormat(rules, def);
  for (const cdef of checkDefsOf(def)) {
    switch (cdef.check) {
      case "min_length":
        rules.min_len = cdef.minimum;
        break;
      case "max_length":
        rules.max_len = cdef.maximum;
        break;
      case "length_equals":
        rules.len = cdef.length;
        break;
      case "string_format":
        applyStringFormat(rules, cdef);
        break;
      default:
        break; // anything else is silently skipped, never guessed — see the header comment above
    }
  }
  return rules;
};

type NumericBound = {
  value: number | bigint;
  inclusive: boolean;
};

/** Tightest greater_than/less_than pair, preserving inclusive/exclusive (unlike scanNumericBounds above, which collapses to inclusive for the int32-range check). */
const collectNumericBounds = (def: ZodemDef): { min?: NumericBound; max?: NumericBound } => {
  let min: NumericBound | undefined;
  let max: NumericBound | undefined;
  // `cdef.value` is typed `util.Numeric` (number | bigint | Date) since a
  // greater_than/less_than check isn't tied to a particular schema kind at
  // the type level — a Date value only occurs for a `z.date()` check, which
  // never reaches this function in practice (collectNumericBounds is only
  // called for a numeric/bigint field's own checks). Narrowed out here
  // rather than asserted away, so that invariant stays checked, not assumed.
  for (const cdef of checkDefsOf(def)) {
    if (cdef.check === "greater_than" && typeof cdef.value !== "object") {
      const candidate: NumericBound = { value: cdef.value, inclusive: cdef.inclusive };
      if (!min || Number(candidate.value) > Number(min.value) || (Number(candidate.value) === Number(min.value) && !candidate.inclusive)) {
        min = candidate;
      }
    } else if (cdef.check === "less_than" && typeof cdef.value !== "object") {
      const candidate: NumericBound = { value: cdef.value, inclusive: cdef.inclusive };
      if (!max || Number(candidate.value) < Number(max.value) || (Number(candidate.value) === Number(max.value) && !candidate.inclusive)) {
        max = candidate;
      }
    }
  }
  return { min, max };
};

const collectNumericRules = (def: ZodemDef): Record<string, IRRuleValue> => {
  const rules: Record<string, IRRuleValue> = {};
  const { min, max } = collectNumericBounds(def);
  if (min) rules[min.inclusive ? "gte" : "gt"] = min.value;
  if (max) rules[max.inclusive ? "lte" : "lt"] = max.value;
  return rules;
};

const NUMERIC_RULE_GROUPS = new Set<ScalarName>([
  "double",
  "float",
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

const collectRules = (def: ZodemDef, group: ScalarName): IRRuleSet | undefined => {
  let rules: Record<string, IRRuleValue>;
  if (group === "string") {
    rules = collectStringRules(def);
  } else if (NUMERIC_RULE_GROUPS.has(group)) {
    rules = collectNumericRules(def);
  } else {
    return undefined;
  }
  return Object.keys(rules).length > 0 ? { group, rules } : undefined;
};

// z.array().min()/.max()/.length() reuse the same "min_length"/"max_length"/
// "length_equals" check kinds z.string() uses (arrays are measured by
// `.length`, same as strings — "min_size"/"max_size" are for Set/Map-like
// values measured by `.size`, which z.array() never produces).
const collectArraySizeRules = (def: z.core.$ZodArrayDef): Record<string, IRRuleValue> => {
  const rules: Record<string, IRRuleValue> = {};
  for (const cdef of checkDefsOf(def)) {
    if (cdef.check === "min_length") rules.min_items = cdef.minimum;
    else if (cdef.check === "max_length") rules.max_items = cdef.maximum;
    else if (cdef.check === "length_equals") {
      rules.min_items = cdef.length;
      rules.max_items = cdef.length;
    }
  }
  return rules;
};

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

type Finalized = {
  type: IRType;
  label: IRLabel;
  /** true if `.nullable()` applied at this field (regardless of how it was represented) */
  nullable: boolean;
  warnings: string[];
  rules?: IRRuleSet;
};

const finalize = (
  baseType: IRType,
  opts: {
    optional: boolean;
    nullable: boolean;
    allowNullableWrapper: boolean;
    path: string;
    warnings: string[];
    ctx: WalkerContext;
    rules?: IRRuleSet;
  },
): Finalized => {
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

  return { type, label, nullable: opts.nullable, warnings, rules: opts.rules };
};

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
const wrapCollectionIfNeeded = (resolved: Finalized, currentMessage: IRMessage, namePreference: string): IRType => {
  if (resolved.label !== "repeated" && resolved.type.kind !== "map") {
    return resolved.type;
  }
  // Depth-unique name: if what we're wrapping is itself already a wrapper
  // message (array-of-array-of-array, ...), base the new name on *its*
  // short name rather than reusing `namePreference` at every level — reusing
  // it would collide with the inner wrapper's name and silently reuse the
  // wrong message.
  const baseName = resolved.type.kind === "message" ? resolved.type.fullName.split(".").pop()! : namePreference;
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
};

// ---------------------------------------------------------------------------
// Concrete type resolution
// ---------------------------------------------------------------------------

const resolveConcreteType = (
  unwrapped: UnwrapResult,
  currentMessage: IRMessage,
  ctx: WalkerContext,
  path: string,
  namePreference: string,
  allowNullableWrapper: boolean,
): Finalized => {
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
};

const resolveConcreteTypeInner = (
  unwrapped: UnwrapResult,
  currentMessage: IRMessage,
  ctx: WalkerContext,
  path: string,
  namePreference: string,
  allowNullableWrapper: boolean,
): Finalized => {
  const { schema, def, optional, nullable, meta } = unwrapped;
  const warnings = [...unwrapped.warnings];

  const regMeta = zodemRegistry.get(schema);
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
      const sizeRules = meta.validate === false ? {} : collectArraySizeRules(def);
      const items = meta.validate === false ? undefined : element.rules;
      const rules: IRRuleSet | undefined =
        Object.keys(sizeRules).length > 0 || items ? { group: "repeated", rules: sizeRules, items } : undefined;
      return { type: elementType, label: "repeated", nullable: false, warnings: [...warnings, ...element.warnings], rules };
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

      const rules: IRRuleSet | undefined =
        keyResolved.rules || valueResolved.rules
          ? { group: "map", rules: {}, keys: keyResolved.rules, values: valueResolved.rules }
          : undefined;
      return {
        type: { kind: "map", key: keyResolved.type.name, value: valueType },
        label: "singular",
        nullable: false,
        warnings: [...warnings, ...keyResolved.warnings, ...valueResolved.warnings],
        rules,
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
      for (const [entryKey, entryVal] of Object.entries(def.entries)) {
        if (/^\d+$/u.test(entryKey)) continue; // reverse-mapped numeric enum key
        void entryVal;
        values.push({ name: `${upperName}_${upperSnake(entryKey)}`, zodValue: entryKey });
      }
      const enumIR: IREnum = { fullName, values, reserved: [] };
      ctx.enumCache.set(schema, enumIR);
      currentMessage.nested.enums.push(enumIR);
      return finalize({ kind: "enum", fullName }, { optional, nullable, allowNullableWrapper, path, warnings, ctx });
    }
    case "literal": {
      const vals = def.values;
      if (vals.length !== 1) {
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
    case "string": {
      const scalar = meta.proto ?? "string";
      const rules = meta.validate === false ? undefined : collectRules(def, scalar);
      return finalize({ kind: "scalar", name: scalar }, { optional, nullable, allowNullableWrapper, path, warnings, ctx, rules });
    }
    case "boolean":
      return finalize(
        { kind: "scalar", name: meta.proto ?? "bool" },
        { optional, nullable, allowNullableWrapper, path, warnings, ctx },
      );
    case "number": {
      const scalar = resolveNumberScalar(def, meta, path, warnings);
      const rules = meta.validate === false ? undefined : collectRules(def, scalar);
      return finalize({ kind: "scalar", name: scalar }, { optional, nullable, allowNullableWrapper, path, warnings, ctx, rules });
    }
    case "bigint": {
      const scalar = resolveBigintScalar(def, meta);
      const rules = meta.validate === false ? undefined : collectRules(def, scalar);
      return finalize({ kind: "scalar", name: scalar }, { optional, nullable, allowNullableWrapper, path, warnings, ctx, rules });
    }
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
};

// ---------------------------------------------------------------------------
// Object -> IRMessage, discriminated unions -> oneof
// ---------------------------------------------------------------------------

export const walkObjectIntoMessage = (
  fullName: string,
  shape: Record<string, AnySchema>,
  ctx: WalkerContext,
  path: string,
): IRMessage => {
  const msg: IRMessage = { fullName, fields: [], oneofs: [], nested: { messages: [], enums: [] }, reserved: [] };
  for (const [key, fieldSchema] of Object.entries(shape)) {
    processField(key, fieldSchema, msg, ctx, `${path}.${key}`);
  }
  return msg;
};

/** `z.discriminatedUnion()` and `z.union()` share `type: "union"` — the discriminator, not the type tag, is what tells them apart. */
const isDiscriminatedUnionDef = (def: ZodemDef): def is z.core.$ZodDiscriminatedUnionDef => {
  return def.type === "union" && "discriminator" in def && typeof def.discriminator === "string";
};

const processField = (key: string, fieldSchema: AnySchema, currentMessage: IRMessage, ctx: WalkerContext, path: string): void => {
  const unwrapped = unwrap(fieldSchema, ctx);
  const namePreference = unwrapped.meta.name ?? pascalCase(key);

  if (isDiscriminatedUnionDef(unwrapped.def)) {
    processDiscriminatedUnion(key, unwrapped, unwrapped.def, currentMessage, ctx, path);
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
    rules: resolved.rules,
    warnings: resolved.warnings,
  } satisfies IRField);
};

const processDiscriminatedUnion = (
  fieldKey: string,
  unwrapped: UnwrapResult,
  def: z.core.$ZodDiscriminatedUnionDef,
  currentMessage: IRMessage,
  ctx: WalkerContext,
  path: string,
): void => {
  const discriminatorKey = def.discriminator;
  const oneofName = camelToSnake(fieldKey);
  const memberFieldNames: string[] = [];
  const sharedWarnings = [...unwrapped.warnings];
  if (unwrapped.nullable) {
    sharedWarnings.push(`${path}: null and absent both collapse to "no case set" for discriminated unions`);
  }

  for (const option of def.options) {
    const optionDef = defOf(option);
    if (optionDef.type !== "object") {
      throw new UnsupportedTypeError(path, "discriminated union branches must be z.object()");
    }
    const discField = optionDef.shape[discriminatorKey];
    if (!discField) {
      throw new UnsupportedTypeError(path, `branch is missing the discriminator key "${discriminatorKey}"`);
    }
    const discFieldDef = unwrap(discField, ctx).def;
    const literalValues = discFieldDef.type === "literal" ? discFieldDef.values : undefined;
    const discValue = literalValues?.[0];
    if (literalValues?.length !== 1 || typeof discValue !== "string") {
      throw new UnsupportedTypeError(
        path,
        `discriminator field "${discriminatorKey}" must be a single string z.literal() per branch`,
      );
    }

    const regMeta = zodemRegistry.get(option);
    let branchFullName: string;
    if (regMeta?.kind === "message") {
      branchFullName = regMeta.fullName;
    } else {
      branchFullName = `${currentMessage.fullName}.${pascalCase(fieldKey)}${pascalCase(discValue)}`;
      const branchShape: Record<string, AnySchema> = { ...optionDef.shape };
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
};

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const walkService = (def: ZodemServiceDef): IRService => {
  const methods: IRMethod[] = [];
  for (const [name, m] of Object.entries(def.methods)) {
    const inputMeta = zodemRegistry.get(m.input);
    const outputMeta = zodemRegistry.get(m.output);
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
};
