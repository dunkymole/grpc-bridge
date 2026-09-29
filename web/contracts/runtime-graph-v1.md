# Protobuf-ES runtime graph v1

`protobuf-es.runtime-graph.v1` is the deterministic projection used by generated
strict clients. It describes semantics available in the imported Protobuf-ES
runtime descriptors; it is not a replacement for the compiler's complete lock
fingerprint or a claim that Protobuf-ES retained source-only options. The
generator must validate the complete lock against its exact descriptor input,
then emit this projection beside the full lock fingerprint.

The normative object shape is [`runtime-graph-v1.schema.json`](./runtime-graph-v1.schema.json).
[`runtime-graph-v1.conformance.json`](./runtime-graph-v1.conformance.json) is a
cross-language fixture for the Go generator and this runtime. All object keys
are canonicalized recursively in Unicode code-point order before comparison;
array order is meaningful and defined below. Strings are compared exactly as
UTF-8 text. Numeric values are finite JSON numbers; negative zero in a numeric
default is the string `"-0"`.

The JSON fixture is computed from the checked-in `.proto` source and generated
Protobuf-ES descriptor in `contracts/gen/`. Regenerate it with protoc 31.1 and
the pinned Protobuf-ES 2.15.0 plugin:

```sh
protoc -Icontracts \
  --plugin=protoc-gen-es=node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es \
  --es_out=contracts/gen --es_opt=target=ts \
  contracts/runtime-graph-v1.conformance.proto
npm run contracts:verify
```

`contracts:verify` re-runs the pinned generator in a temporary directory and
fails when the checked-in generated descriptor has drifted. The runtime unit
suite separately asserts that projecting that descriptor equals the checked-in
JSON fixture. CI runs both checks.

The root contains the bound service, every reachable message, and every
reachable enum. Reachability starts at every method input and output and follows
message, enum, list-element, and map-value references. Sort methods by Protobuf
method name, messages and enums by fully qualified `typeName`, fields by field
number, oneofs by Protobuf name, and oneof members by field number. Method
`localName`, field `localName`, oneof `localName`, and enum-value `localName`
are part of the projection because generated JavaScript APIs use them.

Scalar shapes use the uppercase `ScalarType` member name and retain
`longAsString`. Each field also records the resolved `utf8Validation` boolean.
Message and enum shapes use their fully qualified type name.
List shapes retain the element shape and `packed`; message list elements also
retain `delimitedEncoding`. Map shapes retain the legal key scalar, value shape,
and the runtime descriptor's `delimitedEncoding` value (currently always
`false`). Map descriptors do not expose `longAsString`; the projection records
only the map value semantics retained by Protobuf-ES.

Each field records field number, Protobuf name, JavaScript local name, JSON name,
resolved presence (`EXPLICIT`, `IMPLICIT`, or `LEGACY_REQUIRED`), containing
oneof name or `null`, normalized runtime default or `null`, and its shape.
Defaults use tagged values: booleans and strings stay native JSON values; bytes
are base64; integral values are decimal strings; enums are numeric; finite
floating point values are JSON numbers, and `NaN`, infinities, and negative zero
use the strings `NaN`, `Infinity`, `-Infinity`, and `-0`. A `null` default means
the runtime descriptor has no declared default; the field's scalar type or
enum's first declaration supplies the ordinary implicit zero/default.

Enums retain `open`, their first declared value as `defaultName/defaultNumber`,
and every numeric value's aliases in original declaration order. Numeric groups
are sorted ascending, but aliases within a group are not sorted. This is
required because Protobuf-ES 2.15 uses the first enum declaration as the
implicit default, while `DescEnum.value[number]` and JSON enum-name output use
the last alias for that number. For example, `ZERO=0, FIRST=1, SECOND=1` has
default `ZERO`; its number-1 alias order is `FIRST, SECOND`, and JSON encoding
of numeric value 1 uses `SECOND`. Swapping the declarations changes runtime
behavior and therefore changes this graph.

The runtime compares the generated expected graph with a projection made from
the imported descriptor at contract-module initialization. It does not perform
network version negotiation. Use the same Protobuf-ES major/minor line when
generating and consuming artifacts; a changed descriptor projection is rejected
before the client can send an RPC.

After successful comparison, the runtime freezes the reachable Protobuf-ES
descriptor objects, lookup records, and collections used by client construction
and the graph projection. This makes the imported descriptor snapshot stable
without rebuilding the full graph for each RPC. Protobuf-ES exposes these
descriptor properties as readonly; callers that need a modified schema must
generate and import a new descriptor module. Field `proto` messages are also
shallow-frozen because Protobuf-ES 2.15's `getDefaultValue()` reads their
`defaultValue` lazily.

Strict clients stamp `x-proto-contract` after all application interceptors and
before retry handling. Its value is exactly `API@MAJOR.MINOR.PATCH`; API is
1-64 ASCII characters from `[A-Za-z0-9._:/-]`, and each version component is a
canonical decimal integer from 0 through 2147483647. The full fingerprint stays
on the local artifact for build identity and diagnostics and is not sent as a
server compatibility requirement.
