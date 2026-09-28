import { Code, ConnectError } from "@connectrpc/connect";
export const MAX_MESSAGE = 1024 * 1024;
export function frame(data: Uint8Array): Uint8Array {
  if (data.length > MAX_MESSAGE)
    throw new ConnectError("Message exceeds 1 MiB", Code.ResourceExhausted);
  const result = new Uint8Array(5 + data.length);
  new DataView(result.buffer).setUint32(1, data.length);
  result.set(data, 5);
  return result;
}

/** Incremental records: headers and messages can cross any DATA/frame boundary. */
export async function* unframe(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let current = new Uint8Array(5),
    offset = 0,
    readingHeader = true;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let position = 0;
      while (position < value.length) {
        const n = Math.min(current.length - offset, value.length - position);
        current.set(value.subarray(position, position + n), offset);
        offset += n;
        position += n;
        if (offset !== current.length) continue;
        if (readingHeader) {
          if (current[0] !== 0)
            throw new ConnectError(
              "Compressed messages are unsupported",
              Code.Unimplemented,
            );
          const length = new DataView(current.buffer).getUint32(1);
          if (length > MAX_MESSAGE)
            throw new ConnectError(
              "Message exceeds 1 MiB",
              Code.ResourceExhausted,
            );
          current = new Uint8Array(length);
          offset = 0;
          readingHeader = false;
          if (length !== 0) continue;
        }
        yield current;
        current = new Uint8Array(5);
        offset = 0;
        readingHeader = true;
      }
    }
    if (offset !== 0 || !readingHeader)
      throw new ConnectError("Truncated gRPC record", Code.DataLoss);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function validateStatus(
  headers: Record<string, string>,
  trailers: Record<string, string> | undefined,
): void {
  const raw = trailers?.["grpc-status"] ?? headers["grpc-status"];
  if (raw === undefined)
    throw new ConnectError("Missing grpc-status", Code.Unknown);
  if (!/^(?:[0-9]|1[0-6])$/.test(raw))
    throw new ConnectError("Invalid grpc-status", Code.Unknown);
  if (raw !== "0") {
    const encoded =
      trailers?.["grpc-message"] ?? headers["grpc-message"] ?? "RPC failed";
    let message = encoded;
    try {
      message = decodeURIComponent(encoded);
    } catch {}
    throw new ConnectError(message, Number(raw), { ...headers, ...trailers });
  }
}
