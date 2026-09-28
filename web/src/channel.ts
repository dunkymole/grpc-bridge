import { H2Connection } from "./h2/connection.js";
import { Code, ConnectError } from "@connectrpc/connect";

export const PROFILE = "grpc-tunnel.v1";
const MAX_QUEUE = 1024 * 1024;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One versioned WebSocket = one HTTP/2 session. Never reconnect or replay RPCs. */
export async function openChannel(
  url: string,
  token = "",
  options: { target?: string; signal?: AbortSignal } = {},
): Promise<H2Connection> {
  options.signal?.throwIfAborted();
  const endpoint = new URL(url);
  if (options.target !== undefined)
    endpoint.searchParams.set("target", options.target);
  const ws = new WebSocket(
    endpoint,
    token ? [PROFILE, `auth.${token}`] : [PROFILE],
  );
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      ws.close();
      reject(new ConnectError("Tunnel opening canceled", Code.Canceled));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      options.signal?.removeEventListener("abort", abort);
      ws.close();
      reject(new ConnectError("Tunnel handshake timed out", Code.Unavailable));
    }, 5000);
    ws.onopen = () => {
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (ws.protocol !== PROFILE) {
        ws.close();
        reject(
          new ConnectError("Unsupported tunnel profile", Code.Unavailable),
        );
      } else resolve();
    };
    ws.onerror = ws.onclose = () => {
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      reject(new ConnectError("Tunnel handshake failed", Code.Unavailable));
    };
  });
  let ended = false;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const fail = (message: string) => {
          if (ended) return;
          ended = true;
          controller.error(new ConnectError(message, Code.Unavailable));
          ws.close();
        };
        ws.onmessage = (event) => {
          if (ended) return;
          if (!(event.data instanceof ArrayBuffer)) {
            fail("Non-binary tunnel data");
            return;
          }
          const data = new Uint8Array(event.data);
          if (data.length > (controller.desiredSize ?? 0)) {
            fail("Tunnel receive queue exceeded");
            return;
          }
          controller.enqueue(data);
        };
        ws.onclose = () =>
          fail("Tunnel closed; in-flight calls were not replayed");
        ws.onerror = () => fail("Tunnel transport failed");
      },
      cancel() {
        ended = true;
        ws.close();
      },
    },
    { highWaterMark: MAX_QUEUE, size: (chunk) => chunk.byteLength },
  );
  const writable = new WritableStream<Uint8Array>({
    async write(bytes) {
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        const until = Date.now() + 30000;
        while (ws.bufferedAmount > 65536 && ws.readyState === WebSocket.OPEN) {
          if (Date.now() > until) {
            ws.close();
            throw new ConnectError("Tunnel send stalled", Code.Unavailable);
          }
          await sleep(5);
        }
        if (ws.readyState !== WebSocket.OPEN)
          throw new ConnectError("Tunnel closed", Code.Unavailable);
        ws.send(bytes.subarray(offset, offset + 16384));
      }
    },
    close() {
      ws.close();
    },
    abort() {
      ws.close();
    },
  });
  return new H2Connection(
    { readable, writable },
    {
      settings: { enablePush: false, initialWindowSize: 65535 },
      connectionWindowSize: 262144,
    },
  );
}
