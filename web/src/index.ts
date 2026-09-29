export {
  StrictSharedBridgeConnection as SharedBridgeConnection,
  createBridgeConnection,
  createSharedBridgeConnection,
  openBridgeConnection,
  type BridgeClientOptions,
  type BridgeConnection,
  type BridgeConnectionEvent,
  type BridgeConnectionLease,
  type BridgeConnectionListener,
  type BridgeConnectionOptions,
  type BridgeConnectionState,
} from "./strict-client.js";
export { waitForReady } from "./client.js";
export { inputQueue } from "./queue.js";
export type { RetryOptions, RetryPolicy } from "./retry.js";
export type { ContractDefinition } from "./contracts.js";
export type { TokenProvider, TokenSource } from "./client.js";
