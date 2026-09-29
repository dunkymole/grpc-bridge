import {
  Code,
  ConnectError,
  createClient,
  type Client,
  type Interceptor,
} from "@connectrpc/connect";
import type { DescService } from "@bufbuild/protobuf";
import {
  createBridgeConnection as createRawConnection,
  createSharedBridgeConnection as createRawSharedConnection,
  type BridgeConnectionEvent,
  type BridgeConnectionListener,
  type BridgeConnectionOptions,
  type BridgeConnectionState,
  type BridgeConnection as RawBridgeConnection,
  type BridgeConnectionLease as RawBridgeConnectionLease,
  type SharedBridgeConnection as RawSharedBridgeConnection,
  managedClientTransport,
} from "./client.js";
import { contractRecord, type ContractDefinition } from "./contracts.js";

export type { BridgeConnectionEvent, BridgeConnectionListener, BridgeConnectionOptions, BridgeConnectionState };

export interface BridgeClientOptions {
  /** Client-specific Connect hooks; run before connection hooks and the guard. */
  interceptors?: readonly Interceptor[];
}

export interface BridgeConnection {
  readonly state: BridgeConnectionState;
  readonly closed: Promise<void>;
  subscribe(listener: BridgeConnectionListener): () => void;
  client<S extends DescService>(
    definition: ContractDefinition<S>,
    options?: BridgeClientOptions,
  ): Client<S>;
  close(): Promise<void>;
}

export interface BridgeConnectionLease {
  readonly state: BridgeConnectionState;
  readonly closed: Promise<void>;
  subscribe(listener: BridgeConnectionListener): () => void;
  client<S extends DescService>(
    definition: ContractDefinition<S>,
    options?: BridgeClientOptions,
  ): Client<S>;
  release(): Promise<void>;
}

export class StrictBridgeConnection implements BridgeConnection {
  readonly #raw: RawBridgeConnection;
  constructor(raw: RawBridgeConnection) { this.#raw = raw; }
  get state() { return this.#raw.state; }
  get closed() { return this.#raw.closed; }
  subscribe(listener: BridgeConnectionListener) { return this.#raw.subscribe(listener); }
  client<S extends DescService>(definition: ContractDefinition<S>, options?: BridgeClientOptions): Client<S> {
    return createBoundClient(this.#raw, definition, options);
  }
  close() { return this.#raw.close(); }
}

export class StrictBridgeConnectionLease implements BridgeConnectionLease {
  readonly #raw: RawBridgeConnectionLease;
  constructor(raw: RawBridgeConnectionLease) { this.#raw = raw; }
  get state() { return this.#raw.state; }
  get closed() { return this.#raw.closed; }
  subscribe(listener: BridgeConnectionListener) { return this.#raw.subscribe(listener); }
  client<S extends DescService>(definition: ContractDefinition<S>, options?: BridgeClientOptions): Client<S> {
    return createBoundClient(this.#raw, definition, options);
  }
  release() { return this.#raw.release(); }
}

export class StrictSharedBridgeConnection {
  readonly #raw: RawSharedBridgeConnection;
  constructor(options: BridgeConnectionOptions) { this.#raw = createRawSharedConnection(options); }
  async acquire(): Promise<BridgeConnectionLease> {
    return new StrictBridgeConnectionLease(await this.#raw.acquire());
  }
  dispose() { return this.#raw.dispose(); }
}

export function createBridgeConnection(options: BridgeConnectionOptions): BridgeConnection {
  return new StrictBridgeConnection(createRawConnection(options));
}

export async function openBridgeConnection(options: BridgeConnectionOptions): Promise<BridgeConnection> {
  const raw = createRawConnection(options) as RawBridgeConnection & { initial: Promise<void> };
  try {
    await raw.initial;
    return new StrictBridgeConnection(raw);
  } catch (error) {
    await raw.close();
    throw error;
  }
}

export function createSharedBridgeConnection(options: BridgeConnectionOptions): StrictSharedBridgeConnection {
  return new StrictSharedBridgeConnection(options);
}

function createBoundClient<S extends DescService>(
  owner: object,
  definition: ContractDefinition<S>,
  options?: BridgeClientOptions,
): Client<S> {
  const contract = contractRecord(definition);
  const transport = managedClientTransport(owner, options?.interceptors, contractFinalizer(definition));
  return createClient(contract.service, transport);
}

/** @internal Final method/header guard shared by strict clients and focused tests. */
export function contractFinalizer<S extends DescService>(
  definition: ContractDefinition<S>,
): (request: { service: DescService; method: import("@bufbuild/protobuf").DescMethod; header: Headers }) => Headers {
  const contract = contractRecord(definition);
  const stamp = `${contract.api}@${contract.version}`;
  return ({ service, method, header }) => {
    if (
      service !== contract.service ||
      method.parent !== contract.service ||
      !contract.service.methods.includes(method)
    ) {
      throw new ConnectError("RPC method is outside the generated contract", Code.InvalidArgument);
    }
    // defineContract freezes every reachable runtime descriptor surface.
    contractRecord(definition);
    const stamped = new Headers(header);
    stamped.delete("x-proto-contract");
    stamped.set("x-proto-contract", stamp);
    return stamped;
  };
}
