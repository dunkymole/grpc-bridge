import {
  createContextValues,
  type Interceptor,
  type Transport,
} from "@connectrpc/connect";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { runStreamingCall, runUnaryCall } from "@connectrpc/connect/protocol";

export interface InterceptorOptions {
  /** Captured in declaration order when the wrapper is created. */
  interceptors?: readonly Interceptor[];
  /** Logical backend URL for interceptor requests; does not change routing. */
  baseUrl: string;
  /** Internal final check after ordinary hooks and before the inner transport. */
  finalizeRequest?: (request: {
    service: DescService;
    method: DescMethod;
    header: Headers;
  }) => Headers;
}

/**
 * Create a client-scoped Connect transport without opening or owning a connection.
 * Wrap a BridgeConnection or lease's transport to run outside its connection-level
 * interceptors and retries. Calls get independent Headers; the source is unchanged.
 * Closing/releasing the underlying connection remains the caller's responsibility.
 */
export function interceptTransport(
  transport: Transport,
  options: InterceptorOptions,
): Transport {
  if (!options.interceptors?.length && !options.finalizeRequest) return transport;
  const interceptors = [...(options.interceptors ?? [])];
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const finalizeRequest = options.finalizeRequest;
  return {
    unary(method, signal, timeoutMs, header, message, contextValues) {
      const deadline =
        timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
      return runUnaryCall({
        interceptors,
        signal,
        timeoutMs,
        req: {
          stream: false,
          method,
          service: method.parent,
          requestMethod: "POST",
          url: `${baseUrl}/${method.parent.typeName}/${method.name}`,
          header: new Headers(header),
          message,
          contextValues: contextValues ?? createContextValues(),
        },
        next: (req) =>
          transport.unary(
            req.method,
            req.signal,
            deadline === undefined
              ? timeoutMs
              : Math.max(1, deadline - Date.now()),
            finalizeRequest?.(req) ?? req.header,
            req.message,
            req.contextValues,
          ),
      });
    },
    stream(method, signal, timeoutMs, header, message, contextValues) {
      const deadline =
        timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
      return runStreamingCall({
        interceptors,
        signal,
        timeoutMs,
        req: {
          stream: true,
          method,
          service: method.parent,
          requestMethod: "POST",
          url: `${baseUrl}/${method.parent.typeName}/${method.name}`,
          header: new Headers(header),
          message,
          contextValues: contextValues ?? createContextValues(),
        },
        next: (req) =>
          transport.stream(
            req.method,
            req.signal,
            deadline === undefined
              ? timeoutMs
              : Math.max(1, deadline - Date.now()),
            finalizeRequest?.(req) ?? req.header,
            req.message,
            req.contextValues,
          ),
      });
    },
  };
}
