import type { Transport } from "@connectrpc/connect";
import { openChannel } from "./channel.js";
import { createTunnelTransport } from "./transport.js";

export type TokenProvider = () =>
  | string
  | undefined
  | Promise<string | undefined>;
export type TokenSource = string | TokenProvider;
export type BridgeConnectionState = "connecting" | "open" | "closed";

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

class ManagedBridgeConnection implements BridgeConnection {
  readonly transport: Transport;
  readonly closed: Promise<void>;
  private currentState: BridgeConnectionState = "open";
  private closeRequested = false;
  private readonly listeners = new Set<BridgeConnectionListener>();

  constructor(
    private readonly channel: Awaited<ReturnType<typeof openChannel>>,
    transportOptions: Parameters<typeof createTunnelTransport>[1],
    initialListener?: BridgeConnectionListener,
  ) {
    if (initialListener) this.listeners.add(initialListener);
    this.transport = createTunnelTransport(channel, transportOptions);
    this.closed = channel.closed.then(
      () => this.transition("closed", this.closeRequested ? "local" : "remote"),
      (error) => this.transition("closed", "error", error),
    );
  }

  get state(): BridgeConnectionState {
    return this.currentState;
  }

  subscribe(listener: BridgeConnectionListener): () => void {
    this.listeners.add(listener);
    listener({ state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.closeRequested = true;
    await this.channel.close();
    await this.closed;
  }

  private transition(
    state: BridgeConnectionState,
    reason?: BridgeConnectionEvent["reason"],
    error?: unknown,
  ): void {
    if (this.currentState === state) return;
    this.currentState = state;
    const event = { state, reason, error };
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Opens one WebSocket carrying one HTTP/2 session. It never reconnects, retries,
 * or replays an RPC. Token providers are called once for this new channel.
 */
export async function openBridgeConnection(
  options: BridgeConnectionOptions,
): Promise<BridgeConnection> {
  options.onStateChange?.({ state: "connecting" });
  try {
    const [tunnelToken, backendBearerToken] = await Promise.all([
      resolveToken(options.tunnelToken),
      resolveToken(options.backendBearerToken),
    ]);
    const channel = await openChannel(options.url, tunnelToken ?? "", {
      target: options.target,
    });
    const connection = new ManagedBridgeConnection(
      channel,
      {
        bearerToken: backendBearerToken,
        authority: options.authority ?? options.target ?? "backend",
        scheme: options.scheme,
      },
      options.onStateChange,
    );
    options.onStateChange?.({ state: "open" });
    return connection;
  } catch (error) {
    options.onStateChange?.({ state: "closed", reason: "error", error });
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
      entry = { references: 0, connection: openBridgeConnection(options) };
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
    await Promise.allSettled(
      entries.map(async (entry) => (await entry.connection).close()),
    );
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
