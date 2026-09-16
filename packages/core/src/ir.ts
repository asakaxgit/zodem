export type ScalarName =
  | "double"
  | "float"
  | "int32"
  | "int64"
  | "uint32"
  | "uint64"
  | "sint32"
  | "sint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "bool"
  | "string"
  | "bytes";

export type WellKnownTypeName =
  | "google.protobuf.Timestamp"
  | "google.protobuf.Value"
  | "google.protobuf.Struct"
  | "google.protobuf.DoubleValue"
  | "google.protobuf.FloatValue"
  | "google.protobuf.Int64Value"
  | "google.protobuf.UInt64Value"
  | "google.protobuf.Int32Value"
  | "google.protobuf.UInt32Value"
  | "google.protobuf.BoolValue"
  | "google.protobuf.StringValue"
  | "google.protobuf.BytesValue";

export type IRType =
  | { kind: "scalar"; name: ScalarName }
  | { kind: "message"; fullName: string }
  | { kind: "enum"; fullName: string }
  | { kind: "map"; key: ScalarName; value: IRType }
  | { kind: "wkt"; fullName: WellKnownTypeName };

export type IRLabel = "singular" | "optional" | "repeated";

export interface IRField {
  /** proto field name (snake_case) */
  name: string;
  /** original Zod object key */
  jsonName: string;
  /** filled by lock sync */
  number?: number;
  type: IRType;
  label: IRLabel;
  oneof?: string;
  /** from .meta({ field }) */
  pinned?: number;
  /** true if the Zod field used `.nullable()` — decode must emit `null`, not omit the key */
  nullable?: boolean;
  warnings: string[];
}

export interface IROneof {
  name: string;
  /** the Zod object key on the parent that holds the discriminated union */
  zodFieldKey: string;
  /** the discriminator key inside each branch object (not itself emitted as a field) */
  discriminatorKey: string;
  /** proto field names of the member fields, in declaration order */
  fields: string[];
}

export interface IRReserved {
  number: number;
  name: string;
}

export interface IRMessage {
  fullName: string;
  fields: IRField[];
  oneofs: IROneof[];
  nested: { messages: IRMessage[]; enums: IREnum[] };
  /** filled by lock sync */
  reserved: IRReserved[];
}

export interface IREnumValue {
  name: string;
  zodValue: string;
  number?: number;
}

export interface IREnum {
  fullName: string;
  values: IREnumValue[];
  reserved: IRReserved[];
}

export interface IRMethod {
  name: string;
  input: string;
  output: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  warnings: string[];
}

export interface IRService {
  fullName: string;
  methods: IRMethod[];
}

export interface IRFile {
  package: string;
  path: string;
  imports: string[];
  messages: IRMessage[];
  enums: IREnum[];
  services: IRService[];
}
