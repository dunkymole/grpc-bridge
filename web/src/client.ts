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

export interface BridgeConnectionLease {
  readonly state: BridgeConnectionState;
  readonly transport: Transport;
  /** Resolves when the underlying connection closes, not on this lease's release. */
  readonly closed: Promise<void>;
  subscribe(listener: BridgeConnectionListener): () => void;
  /** Stop using this lease after release. The last release closes the connection. */
  release(): Promise<void>;
}

interface SharedEntry {
  references: number;
  ready: Promise<BridgeConnection>;
  connection: BridgeConnection;
}

/** One configured destination and authentication policy, opened lazily by acquire(). */
export class SharedBridgeConnection {
  private readonly options: BridgeConnectionOptions;
  private entry?: SharedEntry;
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly closing = new Set<Promise<void>>();

  constructor(options: BridgeConnectionOptions) {
    // Snapshot configuration; token providers can still refresh credentials.
    this.options = { ...options };
  }

  async acquire(): Promise<BridgeConnectionLease> {
    if (this.disposed) throw new Error("Shared bridge connection is disposed");
    let entry = this.entry;
    if (!entry) {
      const connection = createBridgeConnection(
        this.options,
      ) as RecoveringConnection;
      entry = {
        references: 0,
        connection,
        ready: connection.initial.then(() => connection),
      };
      this.entry = entry;
    }
    const current = entry;
    current.references++;
    let connection: BridgeConnection;
    try {
      connection = await current.ready;
      if (this.disposed)
        throw new Error("Shared bridge connection is disposed");
    } catch (error) {
      current.references--;
      if (this.entry === current) this.entry = undefined;
      await this.closeEntry(current);
      throw error;
    }
    let release: Promise<void> | undefined;
    return {
      get state() {
        return connection.state;
      },
      transport: connection.transport,
      closed: connection.closed,
      subscribe: (listener) => connection.subscribe(listener),
      release: () => {
        if (release) return release;
        current.references--;
        if (current.references === 0) {
          if (this.entry === current) this.entry = undefined;
          release = this.closeEntry(current);
        } else {
          release = Promise.resolve();
        }
        return release;
      },
    };
  }

  /** Permanently rejects acquisitions, cancels pending opens, and closes active leases. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const entry = this.entry;
    this.entry = undefined;
    if (entry) this.closeEntry(entry);
    this.disposal = Promise.all([...this.closing]).then(() => {});
    return this.disposal;
  }

  private closeEntry(entry: SharedEntry): Promise<void> {
    const closing = entry.connection.close();
    this.closing.add(closing);
    void closing.then(
      () => this.closing.delete(closing),
      () => this.closing.delete(closing),
    );
    return closing;
  }
}

export function createSharedBridgeConnection(
  options: BridgeConnectionOptions,
): SharedBridgeConnection {
  return new SharedBridgeConnection(options);
}
