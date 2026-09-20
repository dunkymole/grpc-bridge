import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type DescMethod,
  type MessageInitShape,
  type MessageShape,
} from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import type { H2Connection } from "@debdattabasu/h2ts";
import { frame, unframe, validateStatus } from "./framing.js";

/** Standard Connect typed clients, with native gRPC bytes inside HTTP/2. */
export function createTunnelTransport(
  connection: H2Connection,
  options: {
    bearerToken?: string;
    authority?: string;
    scheme?: "http" | "https";
  } = {},
): Transport {
  // Opt-in default metadata; an explicit per-call authorization takes precedence.
  const authorization = options.bearerToken
    ? new Headers({ authorization: `Bearer ${options.bearerToken}` }).get(
        "authorization",
      )!
    : undefined;
  async function start<I extends DescMessage, O extends DescMessage>(
    method: Omit<DescMethod, "input" | "output"> & { input: I; output: O },
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: HeadersInit | undefined,
    input: AsyncIterable<MessageInitShape<I>>,
  ) {
    const abort = new AbortController();
    const onAbort = () =>
      abort.abort(new ConnectError("Call canceled", Code.Canceled));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(
            () =>
              abort.abort(
                new ConnectError("Deadline exceeded", Code.DeadlineExceeded),
              ),
            timeoutMs,
          )
        : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const iterator = input[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(
              frame(toBinary(method.input, create(method.input, next.value))),
            );
          } catch (error) {
            controller.error(error);
            abort.abort(error);
          }
        },
        cancel() {
          void iterator.return?.().catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers(header);
    if (authorization && !headers.has("authorization"))
      headers.set("authorization", authorization);
    headers.set("content-type", "application/grpc");
    headers.set("te", "trailers");
    headers.set("grpc-accept-encoding", "identity");
    if (timeoutMs !== undefined && timeoutMs > 0)
      headers.set(
        "grpc-timeout",
        `${Math.min(Math.ceil(timeoutMs), 99999999)}m`,
      );
    const translate = (error: unknown) => {
      if (abort.signal.aborted)
        return abort.signal.reason instanceof ConnectError
          ? abort.signal.reason
          : ConnectError.from(abort.signal.reason);
      return error instanceof ConnectError
        ? error
        : new ConnectError(String(error), Code.Unavailable);
    };
    try {
      const response = await connection.request({
        method: "POST",
        path: `/${method.parent.typeName}/${method.name}`,
        authority: options.authority ?? "backend",
        scheme: options.scheme ?? "http",
        headers: Object.fromEntries(headers),
        body,
        signal: abort.signal,
      });
      if (response.status !== 200)
        throw new ConnectError(`HTTP ${response.status}`, Code.Unavailable);
      if (
        !/^application\/grpc(?:[+;]|$)/i.test(
          response.headers["content-type"] ?? "",
        )
      )
        throw new ConnectError("Invalid gRPC content type", Code.Unknown);
      const trailers = new Headers();
      async function* messages(): AsyncGenerator<MessageShape<O>> {
        try {
          for await (const bytes of unframe(response.body))
            yield fromBinary(method.output, bytes);
          const values = response.trailers();
          for (const [key, value] of Object.entries(values ?? {}))
            trailers.set(key, value);
          validateStatus(response.headers, values);
        } catch (error) {
          throw translate(error);
        } finally {
          cleanup();
          abort.abort();
        }
      }
      return {
        header: new Headers(response.headers),
        trailer: trailers,
        message: messages(),
      };
    } catch (error) {
      const translated = translate(error);
      cleanup();
      abort.abort();
      throw translated;
    }
  }
  return {
    async unary(method, signal, timeoutMs, header, input) {
      const result = await start(
        method,
        signal,
        timeoutMs,
        header,
        (async function* () {
          yield input;
        })(),
      );
      let message: MessageShape<typeof method.output> | undefined;
      let count = 0;
      for await (const item of result.message) {
        message = item;
        if (++count > 1)
          throw new ConnectError(
            "Unary returned multiple messages",
            Code.Unknown,
          );
      }
      if (count !== 1 || message === undefined)
        throw new ConnectError("Unary returned no message", Code.Unknown);
      return {
        ...result,
        message,
        stream: false,
        method,
        service: method.parent,
      };
    },
    async stream(method, signal, timeoutMs, header, input) {
      return {
        ...(await start(method, signal, timeoutMs, header, input)),
        stream: true,
        method,
        service: method.parent,
      };
    },
  };
}
