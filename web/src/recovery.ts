import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  waitForReady,
  type BridgeConnection,
  type BridgeConnectionEvent,
  type BridgeConnectionListener,
  type BridgeConnectionState,
} from "./client.js";

export interface Session {
  channel: { closed: Promise<void>; close(): void | Promise<void> };
  transport: Transport;
}

/** Internal channel state machine. A dispatched RPC always stays on its original session. */
export class RecoveringConnection implements BridgeConnection {
  readonly transport: Transport;
  readonly closed: Promise<void>;
  readonly initial: Promise<void>;
  private finish!: () => void;
  private firstReady!: () => void;
  private firstFailure!: (error: unknown) => void;
  private session?: Session;
  private stateValue: BridgeConnectionState = "connecting";
  private listeners = new Set<BridgeConnectionListener>();
  private changes = new Set<() => void>();
  private stopped = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 1000;

  constructor(
    private readonly dial: (signal: AbortSignal) => Promise<Session>,
    listener?: BridgeConnectionListener,
  ) {
    this.closed = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.initial = new Promise((resolve, reject) => {
      this.firstReady = resolve;
      this.firstFailure = reject;
    });
    void this.initial.catch(() => {});
    if (listener) this.listeners.add(listener);
    this.transport = {
      unary: async (method, signal, timeoutMs, headers, input, context) => {
        const ready = await this.select(
          signal,
          timeoutMs,
          context?.get(waitForReady) ?? false,
        );
        return ready.transport.unary(
          method,
          signal,
          ready.timeoutMs,
          headers,
          input,
          context,
        );
      },
      stream: async (method, signal, timeoutMs, headers, input, context) => {
        const ready = await this.select(
          signal,
          timeoutMs,
          context?.get(waitForReady) ?? false,
        );
        return ready.transport.stream(
          method,
          signal,
          ready.timeoutMs,
          headers,
          input,
          context,
        );
      },
    };
    // Allow callers to receive the object before lifecycle callbacks run.
    queueMicrotask(() => {
      if (!this.stopped.signal.aborted) void this.connect();
    });
  }

  get state() {
    return this.stateValue;
  }

  subscribe(listener: BridgeConnectionListener): () => void {
    this.listeners.add(listener);
    try {
      listener({ state: this.state });
    } catch {
      /* Observers cannot break channel ownership. */
    }
    return () => this.listeners.delete(listener);
  }

  private emit(
    state: BridgeConnectionState,
    reason?: BridgeConnectionEvent["reason"],
    error?: unknown,
  ) {
    this.stateValue = state;
    for (const change of [...this.changes]) change();
    for (const listener of [...this.listeners]) {
      try {
        listener({ state, reason, error });
      } catch {
        /* Observer isolation. */
      }
    }
  }

  private async connect() {
    this.emit("connecting");
    try {
      this.stopped.signal.throwIfAborted();
      const session = await this.dial(this.stopped.signal);
      if (this.stopped.signal.aborted) {
        void session.channel.closed.catch(() => {});
        await session.channel.close();
        return;
      }
      this.session = session;
      this.delay = 1000;
      void session.channel.closed.then(
        () => this.lost(session, "remote"),
        (error) => this.lost(session, "error", error),
      );
      this.emit("open");
      this.firstReady();
    } catch (error) {
      this.firstFailure(error);
      if (!this.stopped.signal.aborted) this.retry("error", error);
    }
  }

  private lost(session: Session, reason: "remote" | "error", error?: unknown) {
    if (this.stopped.signal.aborted || this.session !== session) return;
    this.session = undefined;
    this.retry(reason, error);
  }

  private retry(reason: "remote" | "error", error?: unknown) {
    this.emit("transient_failure", reason, error);
    if (this.stopped.signal.aborted) return;
    const delay = this.delay * (0.8 + Math.random() * 0.4);
    this.delay = Math.min(this.delay * 1.6, 30000);
    this.timer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  private async select(
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    wait: boolean,
  ) {
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (error?: ConnectError) => {
        clearTimeout(timer);
        this.changes.delete(check);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () =>
        done(new ConnectError("Call canceled", Code.Canceled));
      const check = () => {
        if (signal?.aborted) return cancel();
        if (this.state === "closed")
          return done(new ConnectError("Channel closed", Code.Unavailable));
        if (this.session) return done();
        if (!wait && this.state === "transient_failure")
          done(new ConnectError("Channel unavailable", Code.Unavailable));
      };
      this.changes.add(check);
      signal?.addEventListener("abort", cancel, { once: true });
      if (timeoutMs !== undefined && timeoutMs > 0)
        timer = setTimeout(
          () =>
            done(new ConnectError("Deadline exceeded", Code.DeadlineExceeded)),
          timeoutMs,
        );
      check();
    });
    if (signal?.aborted) throw new ConnectError("Call canceled", Code.Canceled);
    const remaining =
      timeoutMs !== undefined && timeoutMs > 0
        ? timeoutMs - (performance.now() - started)
        : timeoutMs;
    if (remaining !== undefined && timeoutMs! > 0 && remaining <= 0)
      throw new ConnectError("Deadline exceeded", Code.DeadlineExceeded);
    if (!this.session)
      throw new ConnectError("Channel unavailable", Code.Unavailable);
    return { transport: this.session.transport, timeoutMs: remaining };
  }

  async close(): Promise<void> {
    if (this.stopped.signal.aborted) return this.closed;
    this.stopped.abort(new ConnectError("Channel closed", Code.Canceled));
    clearTimeout(this.timer);
    const session = this.session;
    this.session = undefined;
    this.firstFailure(new ConnectError("Channel closed", Code.Unavailable));
    this.emit("closed", "local");
    try {
      await session?.channel.close();
    } finally {
      this.finish();
    }
  }
}
