import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { canonicalJson, defineContract, runtimeGraph, contractRecord } from "../src/contracts.js";
import { contractFinalizer } from "../src/strict-client.js";
import { interceptTransport } from "../src/interceptors.js";
import { contract as DemoContract } from "../src/gen/demo_contract.js";
import { DemoService, MessageSchema } from "../src/gen/demo_pb.js";
import { GraphService } from "../contracts/gen/runtime-graph-v1.conformance_pb.js";

const requests: Headers[] = [];
const direct: Transport = {
  async unary(method, _signal, _timeout, header, message) {
    requests.push(new Headers(header));
    return {
      stream: false,
      method,
      service: method.parent,
      message: fromBinary(method.output, toBinary(method.input, create(method.input, message))),
      header: new Headers(),
      trailer: new Headers(),
    };
  },
  async stream(method, _signal, _timeout, header, message) {
    requests.push(new Headers(header));
    return {
      stream: true,
      method,
      service: method.parent,
      message: (async function* () {
        for await (const item of message)
          yield fromBinary(method.output, toBinary(method.input, create(method.input, item)));
      })(),
      header: new Headers(),
      trailer: new Headers(),
    };
  },
};

test("strict finalizer runs without hooks and replaces reserved metadata on a copy", async () => {
  requests.length = 0;
  const headers = new Headers({ "x-proto-contract": "forged", "x-call": "one" });
  const wrapped = interceptTransport(direct, {
    baseUrl: "http://backend",
    finalizeRequest: contractFinalizer(DemoContract),
  });
  await createClient(DemoService, wrapped).echo({}, { headers });
  assert.equal(requests[0]?.get("x-proto-contract"), "bridge.demo@1.0.0");
  assert.equal(requests[0]?.get("x-call"), "one");
  assert.equal(headers.get("x-proto-contract"), "forged");
  headers.set("x-proto-contract", "mutated-after-call");
  assert.equal(requests[0]?.get("x-proto-contract"), "bridge.demo@1.0.0");
});

test("the final guard follows hooks and resists a post-next header mutation", async () => {
  requests.length = 0;
  const hook: Interceptor = (next) => async (request) => {
    request.header.set("x-proto-contract", "application-value");
    const pending = next(request);
    request.header.set("x-proto-contract", "changed-after-next");
    return pending;
  };
  const wrapped = interceptTransport(direct, {
    baseUrl: "http://backend",
    interceptors: [hook],
    finalizeRequest: contractFinalizer(DemoContract),
  });
  await createClient(DemoService, wrapped).echo({ text: "header race" });
  assert.equal(requests[0]?.get("x-proto-contract"), "bridge.demo@1.0.0");
});

test("final guard rejects a cloned method descriptor before transport", async () => {
  requests.length = 0;
  const substitution: Interceptor = (next) => async (request) => {
    const cloned = { ...request, method: { ...request.method } };
    return next(cloned as never);
  };
  const wrapped = interceptTransport(direct, {
    baseUrl: "http://backend",
    interceptors: [substitution],
    finalizeRequest: contractFinalizer(DemoContract),
  });
  await assert.rejects(createClient(DemoService, wrapped).echo({}), (error: unknown) =>
    error instanceof ConnectError && error.code === Code.InvalidArgument,
  );
  assert.equal(requests.length, 0);
});

test("malformed, forged, and same-name stale contract artifacts are rejected", () => {
  assert.ok(Object.isFrozen(DemoContract));
  assert.throws(
    () => contractRecord({ ...DemoContract } as never),
    /Unregistered contract definition/,
  );
  const graph = structuredClone(runtimeGraph(DemoService));
  (graph.messages[0]!.fields[0] as unknown as { jsonName: string }).jsonName = "staleName";
  assert.throws(
    () => defineContract({
      service: DemoService,
      api: "bridge.demo",
      version: "1.0.0",
      fingerprint: DemoContract.fingerprint,
      graph,
    }),
    /runtime graph does not match/,
  );
  assert.throws(
    () => defineContract({
      service: DemoService,
      api: "bridge.demo",
      version: "01.0.0",
      fingerprint: DemoContract.fingerprint,
      graph: runtimeGraph(DemoService),
    }),
    /canonical MAJOR.MINOR.PATCH/,
  );
  assert.throws(
    () => defineContract({
      service: DemoService,
      api: "bridge.demo\névil",
      version: "1.0.0",
      fingerprint: DemoContract.fingerprint,
      graph: runtimeGraph(DemoService),
    }),
    /ASCII letters/,
  );
});

test("contract identity rejects trailing line terminators in every component", () => {
  const graph = runtimeGraph(DemoService);
  for (const suffix of ["\n", "\r\n"]) {
    assert.throws(() => defineContract({
      service: DemoService,
      api: `bridge.demo${suffix}`,
      version: "1.0.0",
      fingerprint: DemoContract.fingerprint,
      graph,
    }), /API must contain/);
    assert.throws(() => defineContract({
      service: DemoService,
      api: "bridge.demo",
      version: `1.0.0${suffix}`,
      fingerprint: DemoContract.fingerprint,
      graph,
    }), /canonical MAJOR\.MINOR\.PATCH/);
    assert.throws(() => defineContract({
      service: DemoService,
      api: "bridge.demo",
      version: "1.0.0",
      fingerprint: `${DemoContract.fingerprint}${suffix}`,
      graph,
    }), /64-character SHA-256/);
  }
});

test("registered descriptor surfaces are frozen without breaking Protobuf-ES", () => {
  assert.ok(Object.isFrozen(DemoService));
  assert.ok(Object.isFrozen(DemoService.methods));
  assert.ok(Object.isFrozen(DemoService.methods[0]));
  assert.ok(Object.isFrozen(MessageSchema));
  assert.ok(Object.isFrozen(MessageSchema.fields));
  assert.throws(() => (DemoService.methods as unknown[]).push(DemoService.methods[0]), TypeError);
  assert.throws(() => (MessageSchema.fields[0] as unknown as { jsonName: string }).jsonName = "changed", TypeError);
  const field = MessageSchema.fields[0]!;
  assert.throws(() => ((field.proto as unknown as { defaultValue: string }).defaultValue = "changed"), TypeError);
  assert.equal((field as Extract<typeof field, { fieldKind: "scalar" }>).getDefaultValue(), undefined);
  const message = create(MessageSchema, { text: "still serializes", number: 4 });
  assert.deepEqual(fromBinary(MessageSchema, toBinary(MessageSchema, message)), message);
});

test("application descriptor mutation during an RPC is blocked before transport", async () => {
  requests.length = 0;
  const field = MessageSchema.fields[0]!;
  const mutation: Interceptor = (next) => async (request) => {
    assert.throws(() => ((field.proto as unknown as { defaultValue: string }).defaultValue = "late"), TypeError);
    assert.throws(() => ((field as { jsonName: string }).jsonName = "late"), TypeError);
    return next(request);
  };
  const wrapped = interceptTransport(direct, {
    baseUrl: "http://backend",
    interceptors: [mutation],
    finalizeRequest: contractFinalizer(DemoContract),
  });
  await createClient(DemoService, wrapped).echo({ text: "schema stable" });
  assert.equal(requests[0]?.get("x-proto-contract"), "bridge.demo@1.0.0");
});

test("generated Protobuf-ES descriptor equals the normative graph fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("../contracts/runtime-graph-v1.conformance.json", import.meta.url), "utf8"));
  const actual = runtimeGraph(GraphService);
  assert.equal(canonicalJson(actual), canonicalJson(fixture));
  const forward = actual.enums.find((item) => item.typeName.endsWith("ForwardAliases.Value"));
  const swapped = actual.enums.find((item) => item.typeName.endsWith("SwappedAliases.Value"));
  assert.equal(forward!.defaultName, "ZERO");
  assert.deepEqual(forward!.values[1]!.aliases.map((item) => item.name), ["FIRST", "SECOND"]);
  assert.deepEqual(swapped!.values[1]!.aliases.map((item) => item.name), ["SECOND", "FIRST"]);
  assert.notDeepEqual(forward!.values[1], swapped!.values[1]);
});

test("repeated jstype is part of the stale-graph guard", () => {
  const stale = structuredClone(runtimeGraph(GraphService));
  const field = stale.messages.find((message) => message.typeName.endsWith("Request"))!.fields.find((item) => item.number === 10)!;
  assert.equal(field.shape.kind, "list");
  if (field.shape.kind !== "list" || field.shape.element.kind !== "scalar")
    throw new Error("fixture repeated scalar shape changed");
  (field.shape.element as { longAsString: boolean }).longAsString = false;
  assert.throws(
    () => defineContract({
      service: GraphService,
      api: "contract.fixture.v1",
      version: "1.0.0",
      fingerprint: "0".repeat(64),
      graph: stale,
    }),
    /runtime graph does not match/,
  );
});
