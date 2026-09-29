/**
 * Explicit escape hatch for callers that manage Connect transports themselves.
 * The main package entry intentionally does not expose generic transports.
 */
export {
  SharedBridgeConnection,
  createSharedBridgeConnection,
  createBridgeConnection,
  openBridgeConnection,
  waitForReady,
  type BridgeConnection,
  type BridgeConnectionEvent,
  type BridgeConnectionLease,
  type BridgeConnectionListener,
  type BridgeConnectionOptions,
  type BridgeConnectionState,
  type TokenProvider,
  type TokenSource,
} from "./client.js";
export { openChannel, PROFILE } from "./channel.js";
export { createTunnelTransport } from "./transport.js";
export { interceptTransport, type InterceptorOptions } from "./interceptors.js";
export { inputQueue } from "./queue.js";
export type { RetryOptions, RetryPolicy } from "./retry.js";
