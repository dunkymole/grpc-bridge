import type { BridgeConnection } from "../src/index.js";
import type { ContractDefinition } from "../src/codegen.js";
import { DemoContract } from "../src/gen/demo_contract.js";
import { DemoService } from "../src/gen/demo_pb.js";

declare const connection: BridgeConnection;

function compileContractSurface() {
  const client = connection.client(DemoContract);
  void client.echo({ text: "typed" });

  // @ts-expect-error strict client requires one generated contract
  connection.client();
  // @ts-expect-error a plain Protobuf-ES service is not a contract artifact
  connection.client(DemoService);
  // @ts-expect-error objects that resemble generated output are not branded
  connection.client({ api: "demo", version: "1.0.0", fingerprint: "0".repeat(64) });
  // @ts-expect-error the strict connection never exposes a generic transport
  connection.transport;
  // @ts-expect-error client methods and input types come from the bound service
  client.noSuchMethod({});
  // @ts-expect-error generated RPC inputs remain precisely inferred
  client.echo({ delayMs: "not a number" });

  return client;
}

void compileContractSurface;
type IsContract = typeof DemoContract extends ContractDefinition<typeof DemoService> ? true : false;
const contractTypeCheck: IsContract = true;
void contractTypeCheck;
