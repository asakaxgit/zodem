import { isMessage } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate, TimestampSchema } from "@bufbuild/protobuf/wkt";
import type { IREnum, IRField, IRMessage, IROneof, IRType, WellKnownTypeName } from "@zodem/core";

const isRecord = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null;
};

type OneofAdt = { case?: string; value?: unknown };

/** protobuf-es models a `oneof` as an ADT: `{ case: "<member>", value: … }`, or `{ case: undefined }` when unset. */
const isOneofAdt = (v: unknown): v is OneofAdt => {
  return isRecord(v) && (v.case === undefined || typeof v.case === "string");
};

/**
 * Runtime, IR-driven codec between `z.infer<Schema>` values and the plain
 * objects protobuf-es (Connect v2) accepts/produces. Built purely from the
 * already lock-synced IR — no dependency on the Zod schema or on generated
 * protobuf-es code, so it works for both requests (encode) and responses
 * (decode) on either side of a Connect call.
 */
export type Codec<T = Record<string, unknown>> = {
  encode(value: T): Record<string, unknown>;
  /**
   * `unknown`, not `Record<string, unknown>`: the real input is a
   * protobuf-es generated `Message` instance, which has no index signature
   * and so isn't structurally assignable to `Record<string, unknown>` —
   * every caller would need `as unknown as Record<string, unknown>` to call
   * this otherwise. decode reads fields off it dynamically regardless of
   * its static type, so `unknown` is both accurate and cast-free for callers.
   */
  decode(message: unknown): T;
};

type CompiledMessage = {
  /**
   * `unknown`, not `Record<string, unknown>` — same reasoning as `Codec.decode`
   * above: the value genuinely arrives untyped from either side of the wire
   * (a nested field's raw value on decode, an arbitrary Zod value on encode),
   * so it's validated once here, at the one place each compiled step is
   * invoked, instead of forcing every call site to assert first.
   */
  encode(value: unknown): Record<string, unknown>;
  decode(message: unknown): Record<string, unknown>;
};

type CompileCtx = {
  allMessages: ReadonlyMap<string, IRMessage>;
  allEnums: ReadonlyMap<string, IREnum>;
  cache: Map<string, CompiledMessage>;
};

const identity = (v: unknown): unknown => v;

export const flattenMessages = (messages: readonly IRMessage[], out = new Map<string, IRMessage>()): Map<string, IRMessage> => {
  for (const m of messages) {
    out.set(m.fullName, m);
    flattenMessages(m.nested.messages, out);
  }
  return out;
};

export const flattenEnums = (messages: readonly IRMessage[], out = new Map<string, IREnum>()): Map<string, IREnum> => {
  for (const m of messages) {
    for (const e of m.nested.enums) out.set(e.fullName, e);
    flattenEnums(m.nested.messages, out);
  }
  return out;
};

/** snake_case -> camelCase, matching protobuf's JSON/JS field-name convention. */
const snakeToCamel = (s: string): string => {
  return s.replace(/_([a-zA-Z0-9])/gu, (_, c: string) => c.toUpperCase());
};

const compileWkt = (fullName: WellKnownTypeName): { encode: (v: unknown) => unknown; decode: (v: unknown) => unknown } => {
  if (fullName === "google.protobuf.Timestamp") {
    return {
      // This step is only installed for a `google.protobuf.Timestamp`
      // field (see the switch above), whose Zod side is always `z.date()` —
      // the IR selection is what proves `v` is a Date here, not the static
      // type, so the guard below is real validation, not decoration.
      encode: (v) => {
        if (!(v instanceof Date)) throw new Error(`codec: expected a Date for a google.protobuf.Timestamp field, got ${typeof v}`);
        return timestampFromDate(v);
      },
      decode: (v) => {
        if (!isMessage(v, TimestampSchema)) throw new Error("codec: expected a google.protobuf.Timestamp message");
        return timestampDate(v);
      },
    };
  }
  // google.protobuf.Value/Struct, and every *Value wrapper type: protobuf-es
  // auto-unwraps wrappers to the plain scalar, and null/undefined are already
  // filtered out by the caller before encode/decode is ever invoked.
  return { encode: identity, decode: identity };
};

/**
 * A synthesized `{ repeated/map values = 1; }` wrapper (see IRMessage.
 * isListWrapper) exists only on the proto side — there is no corresponding
 * Zod wrapper object, just a plain array/record — so encode/decode operate
 * directly on the raw value and transparently add/remove the `{ values }`
 * layer, instead of going through the normal per-field message machinery
 * (which would expect a real `values` property on the Zod side).
 */
const compileListWrapper = (
  target: IRMessage,
  ctx: CompileCtx,
  path: string,
): { encode: (v: unknown) => unknown; decode: (v: unknown) => unknown } => {
  const innerField: IRField | undefined = target.fields[0];
  if (!innerField) throw new Error(`codec: list-wrapper "${target.fullName}" has no fields`);
  const single = compileScalarLike(innerField.type, ctx, path);
  const values =
    innerField.label === "repeated"
      ? {
          encode: (v: unknown) => (Array.isArray(v) ? v.map(single.encode) : []),
          decode: (v: unknown) => (Array.isArray(v) ? v.map(single.decode) : []),
        }
      : single; // map-of-map: innerField.label is "singular" with type.kind "map"
  return {
    encode: (v) => ({ values: values.encode(v) }),
    decode: (v) => {
      if (!isRecord(v)) throw new Error(`codec: expected an object for list-wrapper "${target.fullName}" at ${path}`);
      return values.decode(v.values);
    },
  };
};

const compileScalarLike = (
  type: IRType,
  ctx: CompileCtx,
  path: string,
): { encode: (v: unknown) => unknown; decode: (v: unknown) => unknown } => {
  switch (type.kind) {
    case "scalar":
      return { encode: identity, decode: identity };
    case "wkt":
      return compileWkt(type.fullName);
    case "message": {
      const target = ctx.allMessages.get(type.fullName);
      if (!target) throw new Error(`codec: unknown message "${type.fullName}" referenced at ${path}`);
      if (target.isListWrapper) return compileListWrapper(target, ctx, path);
      const compiled = compileMessage(target, ctx);
      return { encode: compiled.encode, decode: compiled.decode };
    }
    case "enum": {
      const target = ctx.allEnums.get(type.fullName);
      if (!target) throw new Error(`codec: unknown enum "${type.fullName}" referenced at ${path}`);
      // IREnumValue.number is optional in the type (filled by lock sync) but
      // always present by the time a codec is compiled from synced IR — an
      // entry missing it here means the caller skipped syncEnum(), which is
      // a programming error worth a clear message rather than a silent
      // `undefined` key in these maps.
      const toNumber = new Map(
        target.values.map((v) => {
          if (v.number === undefined) throw new Error(`codec: enum "${type.fullName}" value "${v.zodValue}" has no number; was syncEnum() run?`);
          return [v.zodValue, v.number] as const;
        }),
      );
      const toName = new Map([...toNumber.entries()].map(([zodValue, number]) => [number, zodValue] as const));
      return {
        encode: (v) => {
          const n = typeof v === "string" ? toNumber.get(v) : undefined;
          if (n === undefined) throw new Error(`codec: unknown enum value "${String(v)}" for ${type.fullName}`);
          return n;
        },
        decode: (v) => {
          const n = typeof v === "number" ? toName.get(v) : undefined;
          if (n === undefined) throw new Error(`codec: unknown enum number ${String(v)} for ${type.fullName}`);
          return n;
        },
      };
    }
    case "map": {
      // Zod's z.record() is always a plain JS object at runtime — its "key
      // schema" is a validation-time constraint, not a different runtime
      // key type — and protobuf-es likewise represents proto map fields as
      // plain objects. Both sides use string keys end-to-end; a proto
      // integer/bool map key is a known limitation here, not yet exercised
      // by anything in this codebase.
      const valueCodec = compileScalarLike(type.value, ctx, `${path}{value}`);
      return {
        encode: (v) => {
          if (!isRecord(v)) throw new Error(`codec: expected an object for map field at ${path}`);
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v)) out[k] = valueCodec.encode(val);
          return out;
        },
        decode: (v) => {
          if (!isRecord(v)) throw new Error(`codec: expected an object for map field at ${path}`);
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v)) out[k] = valueCodec.decode(val);
          return out;
        },
      };
    }
  }
};

type FieldPlan = {
  zodKey: string;
  protoKey: string;
  nullable: boolean;
  encode: (v: unknown) => unknown;
  decode: (v: unknown) => unknown;
};

const compileField = (f: IRField, ctx: CompileCtx): FieldPlan => {
  const protoKey = snakeToCamel(f.name);
  const zodKey = f.jsonName;
  const single = compileScalarLike(f.type, ctx, `${f.jsonName}`);

  if (f.label === "repeated") {
    return {
      zodKey,
      protoKey,
      nullable: false,
      encode: (v) => (Array.isArray(v) ? v.map(single.encode) : []),
      decode: (v) => (Array.isArray(v) ? v.map(single.decode) : []),
    };
  }
  return { zodKey, protoKey, nullable: f.nullable ?? false, encode: single.encode, decode: single.decode };
};

type OneofPlan = {
  zodFieldKey: string;
  protoKey: string;
  encode: (value: unknown) => { case: string; value: unknown };
  decode: (adt: OneofAdt) => Record<string, unknown> | undefined;
};

const compileOneof = (o: IROneof, parentMsg: IRMessage, ctx: CompileCtx): OneofPlan => {
  const protoKey = snakeToCamel(o.name);
  const members = parentMsg.fields.filter((f) => f.oneof === o.name);

  const byDiscValue = new Map<string, { caseKey: string; compiled: CompiledMessage }>();
  const byCaseKey = new Map<string, { discValue: string; compiled: CompiledMessage }>();

  for (const m of members) {
    if (m.type.kind !== "message") throw new Error(`codec: oneof member "${m.name}" must resolve to a message`);
    const target = ctx.allMessages.get(m.type.fullName);
    if (!target) throw new Error(`codec: unknown oneof member message "${m.type.fullName}"`);
    const compiled = compileMessage(target, ctx);
    const caseKey = snakeToCamel(m.name);
    const discValue = m.jsonName; // the discriminator literal, see walker.ts processDiscriminatedUnion
    byDiscValue.set(discValue, { caseKey, compiled });
    byCaseKey.set(caseKey, { discValue, compiled });
  }

  return {
    zodFieldKey: o.zodFieldKey,
    protoKey,
    encode(value) {
      if (!isRecord(value)) throw new Error(`codec: expected an object for oneof "${o.name}"`);
      const discValue = value[o.discriminatorKey];
      const entry = typeof discValue === "string" ? byDiscValue.get(discValue) : undefined;
      if (!entry) throw new Error(`codec: unknown discriminator value "${String(discValue)}" for oneof "${o.name}"`);
      const { [o.discriminatorKey]: _discard, ...rest } = value;
      return { case: entry.caseKey, value: entry.compiled.encode(rest) };
    },
    decode(adt) {
      if (!adt.case) return undefined;
      const entry = byCaseKey.get(adt.case);
      if (!entry) throw new Error(`codec: unknown oneof case "${adt.case}" for "${o.name}"`);
      const decoded = entry.compiled.decode(adt.value ?? {});
      return { [o.discriminatorKey]: entry.discValue, ...decoded };
    },
  };
};

const compileMessage = (msg: IRMessage, ctx: CompileCtx): CompiledMessage => {
  const cached = ctx.cache.get(msg.fullName);
  if (cached) return cached;

  // Placeholder for the z.lazy() self-reference case: a recursive field
  // (compileField -> compileScalarLike -> compileMessage(msg again)) hits
  // the cache check above and captures a reference to *this* placeholder
  // object before `compiled` below exists. It must therefore delegate by
  // re-reading the cache at call time, not throw unconditionally — encode/
  // decode are only ever actually invoked later, at runtime, long after
  // `compiled` has replaced this entry.
  const placeholder: CompiledMessage = {
    encode: (v) => {
      const real = ctx.cache.get(msg.fullName);
      if (!real || real === placeholder) {
        throw new Error(`codec: "${msg.fullName}" used before its own compilation finished`);
      }
      return real.encode(v);
    },
    decode: (v) => {
      const real = ctx.cache.get(msg.fullName);
      if (!real || real === placeholder) {
        throw new Error(`codec: "${msg.fullName}" used before its own compilation finished`);
      }
      return real.decode(v);
    },
  };
  ctx.cache.set(msg.fullName, placeholder);

  const fieldPlans = msg.fields.filter((f) => !f.oneof).map((f) => compileField(f, ctx));
  const oneofPlans = msg.oneofs.map((o) => compileOneof(o, msg, ctx));

  const compiled: CompiledMessage = {
    encode(value) {
      if (!isRecord(value)) throw new Error(`codec: expected an object to encode "${msg.fullName}", got ${typeof value}`);
      const out: Record<string, unknown> = {};
      for (const plan of fieldPlans) {
        const v = value[plan.zodKey];
        if (v === undefined || v === null) continue;
        out[plan.protoKey] = plan.encode(v);
      }
      for (const plan of oneofPlans) {
        const v = value[plan.zodFieldKey];
        if (v === undefined || v === null) continue;
        out[plan.protoKey] = plan.encode(v);
      }
      return out;
    },
    decode(message) {
      if (!isRecord(message)) throw new Error(`codec: expected an object to decode "${msg.fullName}", got ${typeof message}`);
      const out: Record<string, unknown> = {};
      for (const plan of fieldPlans) {
        const v = message[plan.protoKey];
        if (v === undefined) {
          if (plan.nullable) out[plan.zodKey] = null;
          continue;
        }
        out[plan.zodKey] = plan.decode(v);
      }
      for (const plan of oneofPlans) {
        const adt = message[plan.protoKey];
        if (!isOneofAdt(adt) || adt.case === undefined) continue;
        out[plan.zodFieldKey] = plan.decode(adt);
      }
      return out;
    },
  };
  ctx.cache.set(msg.fullName, compiled);
  return compiled;
};

/** Builds a `Codec` for every message reachable from `messages` (top-level and nested), keyed by full name. */
export const createCodecs = (messages: readonly IRMessage[]): Map<string, Codec> => {
  const allMessages = flattenMessages(messages);
  const allEnums = flattenEnums(messages);
  const ctx: CompileCtx = { allMessages, allEnums, cache: new Map() };

  const result = new Map<string, Codec>();
  for (const msg of allMessages.values()) {
    result.set(msg.fullName, compileMessage(msg, ctx));
  }
  return result;
};
