import {
  ScalarType,
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescService,
} from "@bufbuild/protobuf";

/** Versioned projection of descriptor semantics retained by Protobuf-ES. */
export interface RuntimeGraph {
  readonly format: "protobuf-es.runtime-graph.v1";
  readonly service: {
    readonly typeName: string;
    readonly methods: readonly RuntimeMethod[];
  };
  readonly messages: readonly RuntimeMessage[];
  readonly enums: readonly RuntimeEnum[];
}

export interface RuntimeMethod {
  readonly name: string;
  readonly localName: string;
  readonly kind: "unary" | "server_streaming" | "client_streaming" | "bidi_streaming";
  readonly input: string;
  readonly output: string;
  readonly idempotency: number;
}

export interface RuntimeMessage {
  readonly typeName: string;
  readonly fields: readonly RuntimeField[];
  readonly oneofs: readonly { readonly name: string; readonly localName: string; readonly fields: readonly number[] }[];
}

export interface RuntimeField {
  readonly number: number;
  readonly name: string;
  readonly localName: string;
  readonly jsonName: string;
  readonly utf8Validation: boolean;
  readonly presence: string;
  readonly oneof: string | null;
  readonly default: RuntimeDefault | null;
  readonly shape: RuntimeFieldShape;
}

export type RuntimeDefault =
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "bytes"; readonly value: string }
  | { readonly type: "integer"; readonly value: string }
  | { readonly type: "number"; readonly value: number | "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { readonly type: "enum"; readonly value: number };

export type RuntimeScalarShape = { readonly kind: "scalar"; readonly scalar: string; readonly longAsString: boolean };
export type RuntimeMessageShape = { readonly kind: "message"; readonly typeName: string; readonly delimitedEncoding: boolean };
export type RuntimeEnumShape = { readonly kind: "enum"; readonly typeName: string };
export type RuntimeFieldShape =
  | RuntimeScalarShape
  | RuntimeMessageShape
  | RuntimeEnumShape
  | { readonly kind: "list"; readonly element: RuntimeScalarShape | RuntimeMessageShape | RuntimeEnumShape; readonly packed: boolean }
  | { readonly kind: "map"; readonly keyScalar: string; readonly value: RuntimeScalarShape | RuntimeMessageShape | RuntimeEnumShape; readonly delimitedEncoding: false };

export interface RuntimeEnum {
  readonly typeName: string;
  readonly open: boolean;
  readonly defaultName: string;
  readonly defaultNumber: number;
  readonly values: readonly { readonly number: number; readonly aliases: readonly { readonly name: string; readonly localName: string }[] }[];
}

declare const contractBrand: unique symbol;

/** A generated, runtime-validated binding between one service and one contract. */
export interface ContractDefinition<S extends DescService = DescService> {
  readonly api: string;
  readonly version: string;
  /** Full compiler lock fingerprint, for identity and diagnostics. */
  readonly fingerprint: string;
  readonly [contractBrand]: S;
}

interface ContractRecord<S extends DescService = DescService> {
  readonly service: S;
  readonly api: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly graph: string;
}

const definitions = new WeakMap<object, ContractRecord>();
const scalarNames = new Map<number, string>(
  Object.entries(ScalarType)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => [value, name]),
);

/**
 * Called by generated code from the explicit `@dunkymole/grpc-bridge/codegen`
 * entry. A descriptor graph mismatch fails at module initialization, before any
 * RPC can be sent. This does not validate source options Protobuf-ES strips.
 */
export function defineContract<S extends DescService>(input: {
  readonly service: S;
  readonly api: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly graph: RuntimeGraph;
}): ContractDefinition<S> {
  if (!input || !isService(input.service)) throw new TypeError("Invalid contract service descriptor");
  for (const [name, value] of [
    ["api", input.api],
    ["version", input.version],
    ["fingerprint", input.fingerprint],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "")
      throw new TypeError(`Invalid contract ${name}`);
  }
  if (!matchesEntire(input.api, /^[A-Za-z0-9._:/-]{1,64}$/))
    throw new TypeError("Contract API must contain 1-64 ASCII letters, digits, or ._:/-");
  if (!isCanonicalVersion(input.version))
    throw new TypeError("Contract version must be canonical MAJOR.MINOR.PATCH");
  if (!matchesEntire(input.fingerprint, /^[a-f0-9]{64}$/i))
    throw new TypeError("Contract fingerprint must be a 64-character SHA-256 hex digest");
  const expected = canonicalJson(input.graph);
  const actual = canonicalJson(runtimeGraph(input.service));
  if (expected !== actual)
    throw new TypeError(`Contract runtime graph does not match ${input.service.typeName}`);
  freezeReachableDescriptors(input.service);

  const artifact = Object.freeze({
    api: input.api,
    version: input.version,
    fingerprint: input.fingerprint.toLowerCase(),
  }) as ContractDefinition<S>;
  definitions.set(artifact, {
    service: input.service,
    api: input.api,
    version: input.version,
    fingerprint: input.fingerprint.toLowerCase(),
    graph: actual,
  });
  return artifact;
}

/** Internal lookup also rejects objects fabricated by plain JavaScript. */
export function contractRecord<S extends DescService>(
  definition: ContractDefinition<S>,
): ContractRecord<S> {
  if ((typeof definition !== "object" && typeof definition !== "function") || definition === null)
    throw new TypeError("A generated contract definition is required");
  const record = definitions.get(definition as object);
  if (!record) throw new TypeError("Unregistered contract definition");
  return record as ContractRecord<S>;
}

/** Build the exact graph projection specified in web/contracts/runtime-graph-v1.md. */
export function runtimeGraph(service: DescService): RuntimeGraph {
  if (!isService(service)) throw new TypeError("Invalid service descriptor");
  const messages = new Map<string, DescMessage>();
  const enums = new Map<string, DescEnum>();
  const visitMessage = (message: DescMessage) => {
    if (messages.has(message.typeName)) return;
    messages.set(message.typeName, message);
    for (const field of message.fields) {
      for (const type of referencedTypes(field)) {
        if (type.kind === "message") visitMessage(type);
        else enums.set(type.typeName, type);
      }
    }
  };
  for (const method of service.methods) {
    visitMessage(method.input);
    visitMessage(method.output);
  }
  return {
    format: "protobuf-es.runtime-graph.v1",
    service: {
      typeName: service.typeName,
      methods: [...service.methods]
        .sort((a, b) => compare(a.name, b.name))
        .map((method) => ({
          name: method.name,
          localName: method.localName,
          kind: method.methodKind,
          input: method.input.typeName,
          output: method.output.typeName,
          idempotency: method.idempotency,
        })),
    },
    messages: [...messages.values()]
      .sort((a, b) => compare(a.typeName, b.typeName))
      .map((message) => ({
        typeName: message.typeName,
        fields: [...message.fields]
          .sort((a, b) => a.number - b.number)
          .map(fieldGraph),
        oneofs: [...message.oneofs]
          .sort((a, b) => compare(a.name, b.name))
          .map((oneof) => ({
            name: oneof.name,
            localName: oneof.localName,
            fields: oneof.fields.map((field) => field.number).sort((a, b) => a - b),
          })),
      })),
    enums: [...enums.values()]
      .sort((a, b) => compare(a.typeName, b.typeName))
      .map((desc) => {
        const grouped = new Map<number, { name: string; localName: string }[]>();
        for (const value of desc.values) {
          const aliases = grouped.get(value.number) ?? [];
          aliases.push({ name: value.name, localName: value.localName });
          grouped.set(value.number, aliases);
        }
        return {
          typeName: desc.typeName,
          open: desc.open,
          defaultName: desc.values[0]?.name ?? "",
          defaultNumber: desc.values[0]?.number ?? 0,
          values: [...grouped]
            .sort(([a], [b]) => a - b)
            .map(([number, aliases]) => ({ number, aliases })),
        };
      }),
  };
}

/** Canonical JSON: UTF-8-compatible JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Runtime graph contains a non-finite number");
    return Object.is(value, -0) ? "-0" : value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object") throw new TypeError("Runtime graph is not JSON data");
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compare)) {
    const item = source[key];
    if (item === undefined) throw new TypeError("Runtime graph contains undefined");
    out[key] = sortJson(item);
  }
  return out;
}

function fieldGraph(field: DescField): RuntimeField {
  let shape: RuntimeFieldShape;
  switch (field.fieldKind) {
    case "scalar":
      shape = scalarShape(field.scalar, field.longAsString);
      break;
    case "message":
      shape = messageShape(field.message.typeName, field.delimitedEncoding);
      break;
    case "enum":
      shape = enumShape(field.enum.typeName);
      break;
    case "list":
      shape = {
        kind: "list",
        element: listElementShape(field),
        packed: field.packed,
      };
      break;
    case "map":
      shape = {
        kind: "map",
        keyScalar: scalarName(field.mapKey),
        value: mapValueShape(field),
        delimitedEncoding: false,
      };
      break;
  }
  return {
    number: field.number,
    name: field.name,
    localName: field.localName,
    jsonName: field.jsonName,
    utf8Validation: field.utf8Validation,
    presence: presenceName(field.presence),
    oneof: field.oneof?.name ?? null,
    default: fieldDefault(field),
    shape,
  };
}

function listElementShape(field: Extract<DescField, { fieldKind: "list" }>) {
  switch (field.listKind) {
    case "scalar": return scalarShape(field.scalar, field.longAsString);
    case "message": return messageShape(field.message.typeName, field.delimitedEncoding);
    case "enum": return enumShape(field.enum.typeName);
  }
}

function mapValueShape(field: Extract<DescField, { fieldKind: "map" }>) {
  switch (field.mapKind) {
    case "scalar": return scalarShape(field.scalar, false);
    case "message": return messageShape(field.message.typeName, false);
    case "enum": return enumShape(field.enum.typeName);
  }
}

function scalarShape(scalar: number, longAsString: boolean): RuntimeScalarShape {
  return { kind: "scalar", scalar: scalarName(scalar), longAsString };
}
function messageShape(typeName: string, delimitedEncoding: boolean): RuntimeMessageShape {
  return { kind: "message", typeName, delimitedEncoding };
}
function enumShape(typeName: string): RuntimeEnumShape { return { kind: "enum", typeName }; }
function scalarName(scalar: number) {
  const name = scalarNames.get(scalar);
  if (!name) throw new TypeError(`Unsupported Protobuf scalar: ${scalar}`);
  return name;
}
function referencedTypes(field: DescField): (DescMessage | DescEnum)[] {
  if (field.fieldKind === "message") return [field.message];
  if (field.fieldKind === "enum") return [field.enum];
  if (field.fieldKind === "list") return field.listKind === "message" ? [field.message] : field.listKind === "enum" ? [field.enum] : [];
  if (field.fieldKind === "map") return field.mapKind === "message" ? [field.message] : field.mapKind === "enum" ? [field.enum] : [];
  return [];
}

function fieldDefault(field: DescField): RuntimeDefault | null {
  if (field.fieldKind !== "scalar" && field.fieldKind !== "enum") return null;
  const value = field.getDefaultValue();
  if (value === undefined) return null;
  if (field.fieldKind === "enum") return { type: "enum", value: value as number };
  if (field.fieldKind !== "scalar") throw new TypeError("Unexpected default on collection/message field");
  switch (field.scalar) {
    case ScalarType.BOOL: return { type: "bool", value: value as boolean };
    case ScalarType.STRING: return { type: "string", value: value as string };
    case ScalarType.BYTES: return { type: "bytes", value: bytesToBase64(value as Uint8Array) };
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return { type: "integer", value: String(value) };
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE: {
      const number = value as number;
      return {
        type: "number",
        value: Number.isNaN(number) ? "NaN" : number === Infinity ? "Infinity" : number === -Infinity ? "-Infinity" : Object.is(number, -0) ? "-0" : number,
      };
    }
    default: return { type: "integer", value: String(value) };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function presenceName(presence: number): string {
  switch (presence) {
    case 0: return "FIELD_PRESENCE_UNKNOWN";
    case 1: return "EXPLICIT";
    case 2: return "IMPLICIT";
    case 3: return "LEGACY_REQUIRED";
    default: throw new TypeError(`Unsupported field presence: ${presence}`);
  }
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function isService(value: unknown): value is DescService {
  const service = value as Partial<DescService> | null;
  return !!service && service.kind === "service" && typeof service.typeName === "string" && Array.isArray(service.methods);
}

function isCanonicalVersion(value: string): boolean {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  return !!match && match[0] === value && match.slice(1).every((part) => Number(part) <= 2_147_483_647);
}

function matchesEntire(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

/** Freeze only the public Desc* graph surfaces consumed by Protobuf-ES. */
function freezeReachableDescriptors(service: DescService): void {
  const messages = new Set<DescMessage>();
  const enums = new Set<DescEnum>();
  const visitMessage = (message: DescMessage) => {
    if (messages.has(message)) return;
    messages.add(message);
    for (const field of message.fields) {
      // Protobuf-ES 2.15 getDefaultValue() closes over this raw proto and reads
      // proto.defaultValue lazily, so protect that own descriptor message too.
      Object.freeze(field.proto);
      Object.freeze(field);
      for (const type of referencedTypes(field)) {
        if (type.kind === "message") visitMessage(type);
        else visitEnum(type);
      }
    }
    for (const oneof of message.oneofs) {
      Object.freeze(oneof.fields);
      Object.freeze(oneof);
    }
    Object.freeze(message.fields);
    Object.freeze(message.field);
    Object.freeze(message.oneofs);
    Object.freeze(message.members);
    Object.freeze(message.nestedMessages);
    Object.freeze(message.nestedEnums);
    Object.freeze(message.nestedExtensions);
    Object.freeze(message);
  };
  const visitEnum = (desc: DescEnum) => {
    if (enums.has(desc)) return;
    enums.add(desc);
    for (const value of desc.values) Object.freeze(value);
    Object.freeze(desc.values);
    Object.freeze(desc.value);
    Object.freeze(desc);
  };
  for (const method of service.methods) {
    visitMessage(method.input);
    visitMessage(method.output);
    Object.freeze(method);
  }
  Object.freeze(service.methods);
  Object.freeze(service.method);
  Object.freeze(service);
}
