import type { IREnum, IRField, IRMessage, IRReserved, IRRuleSet, IRRuleValue, IRService, IRType, WellKnownTypeName } from "@zodem/core";
import { upperSnake } from "@zodem/core";

export type EmitFileInput = {
  package: string;
  messages: IRMessage[];
  services: IRService[];
  imports: Iterable<string>;
  /** Render protovalidate (buf.validate) field options from IRField.rules. Default false — existing output stays byte-identical unless opted in. */
  validate?: boolean;
};

function shortName(fullName: string): string {
  return fullName.split(".").pop() as string;
}

function relativeName(fullName: string, packageName: string): string {
  return fullName.startsWith(`${packageName}.`) ? fullName.slice(packageName.length + 1) : fullName;
}

function typeNameFor(type: IRType, packageName: string): string {
  switch (type.kind) {
    case "scalar":
      return type.name;
    case "message":
    case "enum":
      return relativeName(type.fullName, packageName);
    case "wkt":
      return type.fullName;
    case "map":
      return `map<${type.key}, ${typeNameFor(type.value, packageName)}>`;
  }
}

function emitReserved(reserved: IRReserved[], indent: string): string[] {
  if (reserved.length === 0) return [];
  const numbers = [...reserved].map((r) => r.number).sort((a, b) => a - b);
  const names = [...reserved].map((r) => r.name).sort();
  const lines: string[] = [];
  if (numbers.length > 0) lines.push(`${indent}reserved ${numbers.join(", ")};`);
  if (names.length > 0) lines.push(`${indent}reserved ${names.map((n) => JSON.stringify(n)).join(", ")};`);
  return lines;
}

function renderRuleValue(value: IRRuleValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

// Nested position (repeated.items / map.keys / map.values): those fields are
// the generic FieldConstraints message, so the group name must be spelled
// out as a key — unlike the top-level option, which already selects the
// group via the extension path itself.
function renderRuleSetWrapped(rules: IRRuleSet): string {
  return `${rules.group}: {${renderRuleSetBody(rules)}}`;
}

function renderRuleSetBody(rules: IRRuleSet): string {
  const parts = Object.entries(rules.rules).map(([key, value]) => `${key}: ${renderRuleValue(value)}`);
  if (rules.items) parts.push(`items: {${renderRuleSetWrapped(rules.items)}}`);
  if (rules.keys) parts.push(`keys: {${renderRuleSetWrapped(rules.keys)}}`);
  if (rules.values) parts.push(`values: {${renderRuleSetWrapped(rules.values)}}`);
  return parts.join(", ");
}

function emitFieldLine(field: IRField, packageName: string, indent: string, validate: boolean): string {
  const label = field.oneof ? "" : field.label === "repeated" ? "repeated " : field.label === "optional" ? "optional " : "";
  const typeName = typeNameFor(field.type, packageName);
  const options: string[] = [];
  if (validate && field.rules) {
    options.push(`(buf.validate.field).${field.rules.group} = {${renderRuleSetBody(field.rules)}}`);
  }
  const optionsSuffix = options.length > 0 ? ` [${options.join(", ")}]` : "";
  return `${indent}${label}${typeName} ${field.name} = ${field.number}${optionsSuffix};`;
}

function emitMessage(msg: IRMessage, packageName: string, indentLevel: number, validate: boolean): string[] {
  const indent = "  ".repeat(indentLevel);
  const inner = "  ".repeat(indentLevel + 1);
  const lines: string[] = [`${indent}message ${shortName(msg.fullName)} {`];

  lines.push(...emitReserved(msg.reserved, inner));

  const regularFields = msg.fields
    .filter((f) => !f.oneof)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  for (const field of regularFields) {
    lines.push(emitFieldLine(field, packageName, inner, validate));
  }

  const oneofNames = [...new Set(msg.fields.filter((f) => f.oneof).map((f) => f.oneof as string))].sort();
  for (const oneofName of oneofNames) {
    lines.push(`${inner}oneof ${oneofName} {`);
    const members = msg.fields
      .filter((f) => f.oneof === oneofName)
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    for (const field of members) {
      lines.push(emitFieldLine(field, packageName, `${inner}  `, validate));
    }
    lines.push(`${inner}}`);
  }

  const nestedMessages = [...msg.nested.messages].sort((a, b) => a.fullName.localeCompare(b.fullName));
  for (const nested of nestedMessages) {
    lines.push(...emitMessage(nested, packageName, indentLevel + 1, validate));
  }
  const nestedEnums = [...msg.nested.enums].sort((a, b) => a.fullName.localeCompare(b.fullName));
  for (const en of nestedEnums) {
    lines.push(...emitEnum(en, indentLevel + 1));
  }

  lines.push(`${indent}}`);
  return lines;
}

function emitEnum(en: IREnum, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);
  const inner = "  ".repeat(indentLevel + 1);
  const shortNameVal = shortName(en.fullName);
  const zeroName = `${upperSnake(shortNameVal)}_UNSPECIFIED`;
  const lines: string[] = [`${indent}enum ${shortNameVal} {`];

  lines.push(...emitReserved(en.reserved, inner));
  lines.push(`${inner}${zeroName} = 0;`);
  const sortedValues = [...en.values].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  for (const v of sortedValues) {
    lines.push(`${inner}${v.name} = ${v.number};`);
  }

  lines.push(`${indent}}`);
  return lines;
}

function emitService(svc: IRService, packageName: string): string[] {
  const lines: string[] = [`service ${shortName(svc.fullName)} {`];
  for (const m of svc.methods) {
    const reqType = relativeName(m.input, packageName);
    const resType = relativeName(m.output, packageName);
    const cs = m.clientStreaming ? "stream " : "";
    const ss = m.serverStreaming ? "stream " : "";
    lines.push(`  rpc ${m.name}(${cs}${reqType}) returns (${ss}${resType}) {}`);
  }
  lines.push(`}`);
  return lines;
}

export function emitProto(input: EmitFileInput): string {
  const lines: string[] = [`// Code generated by zodem. DO NOT EDIT.`, `syntax = "proto3";`, "", `package ${input.package};`];

  const imports = [...new Set(input.imports)].sort();
  if (imports.length > 0) {
    lines.push("");
    for (const imp of imports) lines.push(`import "${imp}";`);
  }

  const validate = input.validate ?? false;
  const messages = [...input.messages].sort((a, b) => a.fullName.localeCompare(b.fullName));
  for (const msg of messages) {
    lines.push("");
    lines.push(...emitMessage(msg, input.package, 0, validate));
  }

  const services = [...input.services].sort((a, b) => a.fullName.localeCompare(b.fullName));
  for (const svc of services) {
    lines.push("");
    lines.push(...emitService(svc, input.package));
  }

  lines.push("");
  return lines.join("\n");
}

const VERSION_SEGMENT = /^v\d+(alpha\d*|beta\d*)?$/;

/** "acme.user.v1" -> "acme/user/v1/user.proto" */
export function outputPathFor(packageName: string): string {
  const segments = packageName.split(".");
  const last = segments[segments.length - 1] ?? "";
  const isVersion = VERSION_SEGMENT.test(last) && segments.length > 1;
  const fileBase = isVersion ? segments[segments.length - 2] : last;
  return `${segments.join("/")}/${fileBase}.proto`;
}

const WKT_IMPORT: Partial<Record<WellKnownTypeName, string>> = {
  "google.protobuf.Timestamp": "google/protobuf/timestamp.proto",
  "google.protobuf.Value": "google/protobuf/struct.proto",
  "google.protobuf.Struct": "google/protobuf/struct.proto",
  "google.protobuf.DoubleValue": "google/protobuf/wrappers.proto",
  "google.protobuf.FloatValue": "google/protobuf/wrappers.proto",
  "google.protobuf.Int64Value": "google/protobuf/wrappers.proto",
  "google.protobuf.UInt64Value": "google/protobuf/wrappers.proto",
  "google.protobuf.Int32Value": "google/protobuf/wrappers.proto",
  "google.protobuf.UInt32Value": "google/protobuf/wrappers.proto",
  "google.protobuf.BoolValue": "google/protobuf/wrappers.proto",
  "google.protobuf.StringValue": "google/protobuf/wrappers.proto",
  "google.protobuf.BytesValue": "google/protobuf/wrappers.proto",
};

function collectTypeImports(
  type: IRType,
  selfPackage: string,
  typeOwnerPackage: ReadonlyMap<string, string>,
  out: Set<string>,
): void {
  switch (type.kind) {
    case "scalar":
      return;
    case "wkt": {
      const imp = WKT_IMPORT[type.fullName];
      if (imp) out.add(imp);
      return;
    }
    case "message":
    case "enum": {
      const owner = typeOwnerPackage.get(type.fullName);
      if (owner && owner !== selfPackage) out.add(outputPathFor(owner));
      return;
    }
    case "map":
      collectTypeImports(type.value, selfPackage, typeOwnerPackage, out);
      return;
  }
}

function collectMessageImports(
  msg: IRMessage,
  selfPackage: string,
  typeOwnerPackage: ReadonlyMap<string, string>,
  out: Set<string>,
): void {
  for (const f of msg.fields) collectTypeImports(f.type, selfPackage, typeOwnerPackage, out);
  for (const nested of msg.nested.messages) collectMessageImports(nested, selfPackage, typeOwnerPackage, out);
}

function messageHasRules(msg: IRMessage): boolean {
  return msg.fields.some((f) => f.rules) || msg.nested.messages.some(messageHasRules);
}

/**
 * Every import a package's generated file needs: WKT imports (Timestamp,
 * wrapper types, ...) plus one `import` per *other* package referenced by
 * any message/enum type anywhere in this package's messages or services —
 * `typeOwnerPackage` maps every message/enum full name (including nested
 * ones) to the package of its top-level ancestor. With `opts.validate` and
 * at least one field carrying rules, also imports the protovalidate schema
 * — `ctx.addImport` in the walker can't do this itself, since the CLI (see
 * generate.ts) computes imports here instead of reading the walker's.
 */
export function computeFileImports(
  messages: readonly IRMessage[],
  services: readonly IRService[],
  selfPackage: string,
  typeOwnerPackage: ReadonlyMap<string, string>,
  opts?: { validate?: boolean },
): string[] {
  const out = new Set<string>();
  for (const msg of messages) collectMessageImports(msg, selfPackage, typeOwnerPackage, out);
  for (const svc of services) {
    for (const m of svc.methods) {
      for (const fullName of [m.input, m.output]) {
        const owner = typeOwnerPackage.get(fullName);
        if (owner && owner !== selfPackage) out.add(outputPathFor(owner));
      }
    }
  }
  if (opts?.validate && messages.some(messageHasRules)) out.add("buf/validate/validate.proto");
  return [...out].sort();
}
