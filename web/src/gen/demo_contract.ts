// Example generated binding for proto/demo.proto. Production bindings should
// be emitted by proto-contract from a descriptor set validated against its lock.
import { defineContract } from "../codegen.js";
import type { RuntimeGraph } from "../codegen.js";
import { DemoService } from "./demo_pb.js";

const graph: RuntimeGraph = {
  format: "protobuf-es.runtime-graph.v1",
  service: {
    typeName: "bridge.demo.v1.DemoService",
    methods: [
      { name: "Chat", localName: "chat", kind: "bidi_streaming", input: "bridge.demo.v1.Message", output: "bridge.demo.v1.Message", idempotency: 0 },
      { name: "Collect", localName: "collect", kind: "client_streaming", input: "bridge.demo.v1.Message", output: "bridge.demo.v1.Message", idempotency: 0 },
      { name: "Count", localName: "count", kind: "server_streaming", input: "bridge.demo.v1.Message", output: "bridge.demo.v1.Message", idempotency: 0 },
      { name: "Echo", localName: "echo", kind: "unary", input: "bridge.demo.v1.Message", output: "bridge.demo.v1.Message", idempotency: 0 },
    ],
  },
  messages: [{
    typeName: "bridge.demo.v1.Message",
    fields: [
      { number: 1, name: "text", localName: "text", jsonName: "text", utf8Validation: true, presence: "IMPLICIT", oneof: null, default: null, shape: { kind: "scalar", scalar: "STRING", longAsString: false } },
      { number: 2, name: "number", localName: "number", jsonName: "number", utf8Validation: true, presence: "IMPLICIT", oneof: null, default: null, shape: { kind: "scalar", scalar: "INT32", longAsString: false } },
      { number: 3, name: "delay_ms", localName: "delayMs", jsonName: "delayMs", utf8Validation: true, presence: "IMPLICIT", oneof: null, default: null, shape: { kind: "scalar", scalar: "INT32", longAsString: false } },
    ],
    oneofs: [],
  }],
  enums: [],
};

export const DemoContract = defineContract({
  service: DemoService,
  api: "bridge.demo",
  version: "1.0.0",
  // SHA-256 of the checked-in demo proto; the coordinated generator emits the
  // full contract-lock fingerprint for application-owned artifacts.
  fingerprint: "e836bb553e403aa7407424da44e075882a69c47938a7bdfd8d49b865fcda4a89",
  graph,
});
