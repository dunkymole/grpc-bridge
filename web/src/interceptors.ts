import {
  createContextValues,
  type Interceptor,
  type Transport,
} from "@connectrpc/connect";
import { runStreamingCall, runUnaryCall } from "@connectrpc/connect/protocol";

export interface InterceptorOptions {
  interceptors?: readonly Interceptor[];
  /** Logical backend URL, independent of the WebSocket endpoint. */
  baseUrl: string;
}

/** Wrap the logical RPC, outside connection selection and all wire attempts. */
export function interceptTransport(
  transport: Transport,
  options: InterceptorOptions,
): Transport {
  if (!options.interceptors?.length) return transport;
  const interceptors = [...options.interceptors];
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
          url: `${options.baseUrl}/${method.parent.typeName}/${method.name}`,
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
            req.header,
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
          url: `${options.baseUrl}/${method.parent.typeName}/${method.name}`,
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
            req.header,
            req.message,
            req.contextValues,
          ),
      });
    },
  };
}
