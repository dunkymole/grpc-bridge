import { createContextKey, type Transport } from "@connectrpc/connect";
import { RecoveringConnection } from "./recovery.js";
import { openChannel } from "./channel.js";
import { createTunnelTransport } from "./transport.js";

export type TokenProvider = () =>
  | string
  | undefined
  | Promise<string | undefined>;
export type TokenSource = string | TokenProvider;
export type BridgeConnectionState =
  | "connecting"
  | "open"
  | "transient_failure"
  | "closed";

/** Per-RPC option: wait for connectivity, respecting cancellation and deadline. */
export const waitForReady = createContextKey(false);

export interface BridgeConnectionEvent {
  state: BridgeConnectionState;
  reason?: "local" | "remote" | "error";
  error?: unknown;
}

export type BridgeConnectionListener = (event: BridgeConnectionEvent) => void;

export interface BridgeConnectionOptions {
  /** Public ws:// or wss:// bridge endpoint. */
  url: string;
  /** Exact backend host:port selected during the WebSocket handshake. */
  target?: string;
  /** Static token or provider resolved once before each new channel is opened. */
  tunnelToken?: TokenSource;
  /** Optional static/provider token sent to the backend as Bearer metadata. */
  backendBearerToken?: TokenSource;
  /** HTTP/2 :authority sent to the backend. Defaults to target, then "backend". */
  authority?: string;
  /** HTTP/2 :scheme. This is metadata; upstream TLS remains bridge policy. */
  scheme?: "http" | "https";
  /** Receives connecting/open/closed transitions, including opening failures. */
  onStateChange?: BridgeConnectionListener;
}

export interface BridgeConnection {
  readonly state: BridgeConnectionState;
  readonly transport: Transport;
  readonly closed: Promise<void>;
  subscribe(listener: BridgeConnectionListener): () => void;
  close(): Promise<void>;
}

async function resolveToken(source?: TokenSource): Promise<string | undefined> {
  return typeof source === "function" ? await source() : source;
}

/** Create a durable channel immediately, including while the backend is unavailable. */
export function createBridgeConnection(
  options: BridgeConnectionOptions,
): BridgeConnection {
  return new RecoveringConnection(async (signal) => {
    const [tunnelToken, backendBearerToken] = await Promise.all([
      resolveToken(options.tunnelToken),
      resolveToken(options.backendBearerToken),
    ]);
    signal.throwIfAborted();
    const channel = await openChannel(options.url, tunnelToken ?? "", {
      target: options.target,
      signal,
    });
    try {
      return {
        channel,
        transport: createTunnelTransport(channel, {
          bearerToken: backendBearerToken,
          authority: options.authority ?? options.target ?? "backend",
          scheme: options.scheme,
        }),
      };
    } catch (error) {
      await channel.close();
      throw error;
    }
  }, options.onStateChange);
}

/** Await the initial connection attempt; subsequent transport loss heals automatically. */
export async function openBridgeConnection(
  options: BridgeConnectionOptions,
): Promise<BridgeConnection> {
  const connection = createBridgeConnection(options) as RecoveringConnection;
  try {
    await connection.initial;
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export interface PooledBridgeConnectionOptions extends BridgeConnectionOptions {
  /**
   * Stable, non-secret identity for the authentication context. Two callers
   * share a channel only when this and all route fields match exactly.
   */
  authenticationContext: string;
}

export interface BridgeConnectionLease {
  readonly state: BridgeConnectionState;
  readonly transport: Transport;
  readonly closed: Promise<void>;
  subscribe(listener: BridgeConnectionListener): () => void;
  /** Releases this reference. The last release closes the shared channel. */
  release(): Promise<void>;
}

interface PoolEntry {
  references: number;
  connection: Promise<BridgeConnection>;
  channel: BridgeConnection;
}

/** Explicit, reference-counted reuse. Idle entries are closed, not cached. */
export class BridgeConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private closed = false;

  async acquire(
    options: PooledBridgeConnectionOptions,
  ): Promise<BridgeConnectionLease> {
    if (this.closed) throw new Error("Bridge connection pool is closed");
    if (!options.authenticationContext)
      throw new Error("authenticationContext must be non-empty");
    const key = poolKey(options);
    let entry = this.entries.get(key);
    if (!entry) {
      const channel = createBridgeConnection(options) as RecoveringConnection;
      const ready = channel.initial.then(
        () => channel,
        async (error) => {
          await channel.close();
          throw error;
        },
      );
      entry = { references: 0, connection: ready, channel };
      this.entries.set(key, entry);
      void entry.connection.then(
        (connection) =>
          connection.closed.finally(() => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
          }),
        () => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
        },
      );
    }
    entry.references++;
    let connection: BridgeConnection;
    try {
      connection = await entry.connection;
      if (this.closed) throw new Error("Bridge connection pool is closed");
    } catch (error) {
      entry.references--;
      throw error;
    }
    let released = false;
    return {
      get state() {
        return connection.state;
      },
      transport: connection.transport,
      closed: connection.closed,
      subscribe: (listener) => connection.subscribe(listener),
      release: async () => {
        if (released) return;
        released = true;
        entry!.references--;
        if (entry!.references === 0) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          await connection.close();
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.channel.close()));
  }
}

function poolKey(options: PooledBridgeConnectionOptions): string {
  const url = new URL(options.url);
  if (options.target !== undefined)
    url.searchParams.set("target", options.target);
  return JSON.stringify([
    url.href,
    options.authority ?? options.target ?? "backend",
    options.scheme ?? "http",
    options.authenticationContext,
  ]);
}

export function createBridgeConnectionPool(): BridgeConnectionPool {
  return new BridgeConnectionPool();
}
