import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createContextKey,
  type ContextValues,
  type Transport,
} from "@connectrpc/connect";
import { H2Error } from "./h2/errors.js";

export interface RetryPolicy {
  /** Includes the original attempt; integer 2–5. */
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  retryableStatusCodes: readonly Code[];
}
export interface RetryOptions {
  /** Default policy. Omit for transparent retries only. */
  policy?: RetryPolicy;
  /** Fully qualified /package.Service/Method; false disables configured retries. */
  methods?: Readonly<Record<string, RetryPolicy | false>>;
  /** Retained serialized request bytes, including gRPC framing. Default 256 KiB. */
  perRpcBufferBytes?: number;
  /** Aggregate retained bytes on this logical connection. Default 4 MiB. */
  bufferBytes?: number;
  /** Optional failure throttling shared by calls on this logical connection. */
  throttling?: { maxTokens: number; tokenRatio: number };
}

export const attemptContext = createContextKey<{ commit(): void } | undefined>(
  undefined,
);
const failures = new WeakMap<
  object,
  { committed: boolean; evidence?: "unsent" | "refused" }
>();
export function attemptError(error: unknown, committed: boolean): ConnectError {
  const result =
    error instanceof ConnectError
      ? error
      : new ConnectError(String(error), Code.Unavailable);
  failures.set(result, {
    committed,
    evidence: error instanceof H2Error ? error.retry : undefined,
  });
  return result;
}

function policyCopy(policy: RetryPolicy): RetryPolicy {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 2 ||
    policy.maxAttempts > 5 ||
    ![
      policy.initialBackoffMs,
      policy.maxBackoffMs,
      policy.backoffMultiplier,
    ].every((v) => Number.isFinite(v) && v > 0) ||
    policy.maxBackoffMs < policy.initialBackoffMs ||
    !policy.retryableStatusCodes.length ||
    policy.retryableStatusCodes.some(
      (v) => !Number.isInteger(v) || v < 1 || v > 16,
    )
  )
    throw new TypeError("Invalid gRPC retry policy");
  return { ...policy, retryableStatusCodes: [...policy.retryableStatusCodes] };
}

/** One source iterator, with immutable protobuf snapshots while retries remain possible. */
class Replay<I extends DescMessage> {
  private source: AsyncIterator<MessageInitShape<I>>;
  private saved: Uint8Array[] = [];
  private bytes = 0;
  private pending?: Promise<IteratorResult<MessageInitShape<I>>>;
  private ended = false;
  committed = false;
  constructor(
    private schema: I,
    input: AsyncIterable<MessageInitShape<I>>,
    private reserve: (n: number) => boolean,
    private release: (n: number) => void,
    private limit: number,
  ) {
    this.source = input[Symbol.asyncIterator]();
  }
  commit = () => {
    this.committed = true;
    this.release(this.bytes);
    this.bytes = 0;
    this.saved = [];
  };
  iterable(): AsyncIterable<MessageInitShape<I>> {
    let index = 0;
    let stopped = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (stopped) return { done: true, value: undefined };
          if (index < this.saved.length)
            return {
              done: false,
              value: fromBinary(this.schema, this.saved[index++]!),
            };
          if (this.ended) return { done: true, value: undefined };
          // An old upload can still be awaiting input when its stream is refused.
          // Its pending read belongs to the logical RPC and is shared with the retry.
          const pending = (this.pending ??= this.source.next().then((next) => {
            if (next.done) {
              this.ended = true;
              return next;
            }
            const bytes = toBinary(
              this.schema,
              create(this.schema, next.value),
            );
            if (!this.committed) {
              const size = bytes.length + 5;
              if (this.bytes + size > this.limit || !this.reserve(size))
                this.commit();
              else {
                this.bytes += size;
                this.saved.push(bytes);
              }
            }
            return {
              done: false as const,
              value: fromBinary(this.schema, bytes),
            };
          }));
          const next = await pending;
          if (this.pending === pending) this.pending = undefined;
          if (!next.done) index++;
          return stopped ? { done: true, value: undefined } : next;
        },
        return: async () => {
          stopped = true;
          return { done: true, value: undefined };
        },
      }),
    };
  }
  close() {
    this.commit();
    this.ended = true;
    void this.source.return?.().catch(() => {});
  }
}

type Select = (
  signal: AbortSignal | undefined,
  timeout: number | undefined,
  wait: boolean,
) => Promise<{ transport: Transport; timeoutMs: number | undefined }>;

export class RetryingTransport {
  readonly transport: Transport;
  private used = 0;
  private options: RetryOptions;
  private tokens: number;
  constructor(
    select: Select,
    stopped: AbortSignal,
    options: RetryOptions = {},
  ) {
    this.options = {
      ...options,
      policy: options.policy && policyCopy(options.policy),
      methods: Object.fromEntries(
        Object.entries(options.methods ?? {}).map(([key, value]) => [
          key,
          value === false ? false : policyCopy(value),
        ]),
      ),
      throttling: options.throttling && { ...options.throttling },
    };
    for (const n of [
      options.bufferBytes ?? 4194304,
      options.perRpcBufferBytes ?? 262144,
    ])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new TypeError("Invalid retry buffer size");
    if (
      options.throttling &&
      ![options.throttling.maxTokens, options.throttling.tokenRatio].every(
        (n) => Number.isFinite(n) && n > 0,
      )
    )
      throw new TypeError("Invalid retry throttling");
    this.tokens = options.throttling?.maxTokens ?? 0;
    this.transport = {
      unary: async (method, signal, timeout, headers, input, context) => {
        const replay = this.replay(
          method.input,
          (async function* () {
            yield input;
          })(),
        );
        try {
          const result = await this.run(
            method,
            signal,
            timeout,
            headers,
            context,
            replay,
            stopped,
            select,
            async (transport, signal, timeout, headers, context) => {
              const value = await replay
                .iterable()
                [Symbol.asyncIterator]()
                .next();
              return transport.unary(
                method,
                signal,
                timeout,
                headers,
                value.value!,
                context,
              );
            },
          );
          this.success();
          return result;
        } finally {
          replay.close();
        }
      },
      stream: async (method, signal, timeout, headers, input, context) => {
        const replay = this.replay(method.input, input);
        try {
          const result = await this.run(
            method,
            signal,
            timeout,
            headers,
            context,
            replay,
            stopped,
            select,
            (transport, signal, timeout, headers, context) =>
              transport.stream(
                method,
                signal,
                timeout,
                headers,
                replay.iterable(),
                context,
              ),
          );
          replay.commit();
          const owner = this;
          return {
            ...result,
            message: (async function* () {
              try {
                yield* result.message;
                owner.success();
              } catch (error) {
                owner.failure(
                  error,
                  owner.options.methods?.[
                    `/${method.parent.typeName}/${method.name}`
                  ] ?? owner.options.policy,
                );
                throw error;
              } finally {
                replay.close();
              }
            })(),
          };
        } catch (error) {
          replay.close();
          throw error;
        }
      },
    };
  }
  private replay<I extends DescMessage>(
    schema: I,
    input: AsyncIterable<MessageInitShape<I>>,
  ) {
    return new Replay(
      schema,
      input,
      (n) => {
        if (this.used + n > (this.options.bufferBytes ?? 4194304)) return false;
        this.used += n;
        return true;
      },
      (n) => {
        this.used -= n;
      },
      this.options.perRpcBufferBytes ?? 262144,
    );
  }
  private success() {
    const throttle = this.options.throttling;
    if (throttle)
      this.tokens = Math.min(
        throttle.maxTokens,
        this.tokens + throttle.tokenRatio,
      );
  }
  private failure(error: unknown, policy: RetryPolicy | false | undefined) {
    if (
      this.options.throttling &&
      policy &&
      error instanceof ConnectError &&
      policy.retryableStatusCodes.includes(error.code)
    )
      this.tokens = Math.max(0, this.tokens - 1);
  }
  private async run<I extends DescMessage, T>(
    method: { parent: { typeName: string }; name: string },
    signal: AbortSignal | undefined,
    timeout: number | undefined,
    header: HeadersInit | undefined,
    context: ContextValues | undefined,
    replay: Replay<I>,
    stopped: AbortSignal,
    select: Select,
    invoke: (
      transport: Transport,
      signal: AbortSignal,
      timeout: number | undefined,
      headers: Headers,
      context: ContextValues,
    ) => Promise<T>,
  ): Promise<T> {
    const key = `/${method.parent.typeName}/${method.name}`;
    const originalHeaders = new Headers(header);
    const policy = this.options.methods?.[key] ?? this.options.policy;
    const deadline =
      timeout !== undefined && timeout > 0
        ? performance.now() + timeout
        : Infinity;
    const abort = new AbortController();
    const cancel = () =>
      abort.abort(new ConnectError("Call canceled", Code.Canceled));
    const shutdown = () =>
      abort.abort(new ConnectError("Channel closed", Code.Unavailable));
    signal?.addEventListener("abort", cancel, { once: true });
    stopped.addEventListener("abort", shutdown, { once: true });
    if (signal?.aborted) cancel();
    if (stopped.aborted) shutdown();
    const timer = Number.isFinite(deadline)
      ? setTimeout(
          () =>
            abort.abort(
              new ConnectError("Deadline exceeded", Code.DeadlineExceeded),
            ),
          Math.max(0, deadline - performance.now()),
        )
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      stopped.removeEventListener("abort", shutdown);
    };
    const inner: ContextValues = {
      get: (key) =>
        key.id === attemptContext.id
          ? ({ commit: replay.commit } as typeof key.defaultValue)
          : (context?.get(key) ?? key.defaultValue),
      set: function (key, value) {
        context?.set(key, value);
        return this;
      },
      delete: function (key) {
        context?.delete(key);
        return this;
      },
    };
    let previous = 0;
    let refused = false;
    let retry = false;
    let backoff = policy ? policy.initialBackoffMs : 0;
    try {
      for (;;) {
        abort.signal.throwIfAborted();
        const remaining = () => {
          if (!Number.isFinite(deadline)) return timeout;
          const left = deadline - performance.now();
          if (left <= 0)
            throw new ConnectError("Deadline exceeded", Code.DeadlineExceeded);
          return left;
        };
        try {
          // select's default wait choice is supplied by the recovery layer.
          const ready = await select(abort.signal, remaining(), retry);
          abort.signal.throwIfAborted();
          const headers = new Headers(originalHeaders);
          headers.delete("grpc-previous-rpc-attempts");
          if (previous)
            headers.set("grpc-previous-rpc-attempts", String(previous));
          const result = await invoke(
            ready.transport,
            abort.signal,
            remaining(),
            headers,
            inner,
          );
          // Streaming results own their remaining deadline/cancellation through the transport.
          // Keep the combined signal alive until the response iterator finishes.
          if (
            result &&
            typeof result === "object" &&
            "stream" in result &&
            result.stream === true &&
            "message" in result
          ) {
            const stream = result as T & { message: AsyncIterable<unknown> };
            const messages = stream.message;
            stream.message = (async function* () {
              try {
                yield* messages;
              } finally {
                cleanup();
              }
            })();
            return result;
          }
          cleanup();
          return result;
        } catch (error) {
          if (abort.signal.aborted) throw abort.signal.reason;
          const info =
            typeof error === "object" && error
              ? failures.get(error)
              : undefined;
          // Transparent refusals do not count as application failures.
          const transparent =
            info?.evidence === "unsent" ||
            (info?.evidence === "refused" && !refused);
          if (!transparent) this.failure(error, policy);
          if (replay.committed || info?.committed) throw error;
          if (transparent) {
            if (info.evidence === "refused") refused = true;
            retry = true;
            await pause(0, abort.signal);
            continue;
          }
          if (
            !policy ||
            !(error instanceof ConnectError) ||
            !policy.retryableStatusCodes.includes(error.code)
          )
            throw error;
          const throttle = this.options.throttling;
          if (
            previous + 1 >= policy.maxAttempts ||
            (throttle && this.tokens <= throttle.maxTokens / 2)
          )
            throw error;
          const pushback = error.metadata.get("grpc-retry-pushback-ms");
          let delay: number;
          if (pushback !== null) {
            if (
              !/^\d+$/.test(pushback) ||
              !Number.isSafeInteger(Number(pushback))
            )
              throw error;
            delay = Number(pushback);
            backoff = policy.initialBackoffMs;
          } else {
            delay = backoff * (0.8 + Math.random() * 0.4);
            backoff = Math.min(
              policy.maxBackoffMs,
              backoff * policy.backoffMultiplier,
            );
          }
          await pause(
            Math.min(delay, Math.max(0, deadline - performance.now())),
            abort.signal,
          );
          previous++;
          retry = true;
        }
      }
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Chunk long delays to avoid JavaScript's 32-bit timeout overflow.
    const end = performance.now() + ms;
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    const tick = () => {
      if (signal.aborted) return cancel();
      const remaining = end - performance.now();
      if (remaining > 0)
        timer = setTimeout(tick, Math.min(remaining, 2147483647));
      else {
        signal.removeEventListener("abort", cancel);
        resolve();
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(tick, Math.min(ms, 2147483647));
    if (signal.aborted) cancel();
  });
}
