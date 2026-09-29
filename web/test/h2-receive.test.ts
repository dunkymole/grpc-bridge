import { test } from "node:test";
import assert from "node:assert/strict";
import { H2Connection } from "../src/h2/connection.js";
import { errorCodeValue } from "../src/h2/errors.js";
import { FrameDecoder, serializeFrame } from "../src/h2/frames/codec.js";
import { FrameType } from "../src/h2/frames/types.js";
import { HpackEncoder } from "../src/h2/hpack/hpack.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function session(initialWindowSize = 65_535, connectionWindowSize = 262_144) {
  let incoming!: ReadableStreamDefaultController<Uint8Array>;
  const sent: Uint8Array[] = [];
  const connection = new H2Connection(
    {
      readable: new ReadableStream<Uint8Array>({ start(controller) { incoming = controller; } }),
      writable: new WritableStream<Uint8Array>({ write(bytes) { sent.push(bytes); } }),
    },
    { settings: { enablePush: false, initialWindowSize }, connectionWindowSize },
  );
  await connection.ready;
  incoming.enqueue(serializeFrame({ type: FrameType.SETTINGS, streamId: 0, ack: false, settings: {} }));
  return { connection, incoming, sent };
}

async function openResponse(s: Awaited<ReturnType<typeof session>>, streamId: number) {
  const pending = s.connection.request({ path: "/receive-budget", authority: "local" });
  await tick();
  s.incoming.enqueue(serializeFrame({
    type: FrameType.HEADERS, streamId, headerBlockFragment: new Uint8Array([0x88]), endHeaders: true, endStream: false,
  }));
  return pending;
}

function dataFrame(streamId: number, data: Uint8Array, endStream = false): Uint8Array {
  const frame = serializeFrame({ type: FrameType.DATA, streamId, data, endStream });
  return frame;
}

function paddedDataFrame(streamId: number, payload: number[]): Uint8Array {
  const frame = new Uint8Array(9 + payload.length);
  frame[2] = payload.length;
  frame[3] = FrameType.DATA;
  frame[4] = 0x8; // PADDED
  frame[8] = streamId;
  frame.set(payload, 9);
  return frame;
}

function sentFrames(sent: Uint8Array[]): ReturnType<FrameDecoder["push"]> {
  const total = sent.reduce((sum, item) => sum + item.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const item of sent) { joined.set(item, offset); offset += item.length; }
  const preface = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
  const frames = joined.subarray(joined.length >= preface.length && preface.every((byte, i) => joined[i] === byte) ? preface.length : 0);
  return new FrameDecoder().push(frames);
}

test("stream over-credit resets only that stream and returns queued connection credit", async () => {
  const s = await session();
  const first = await openResponse(s, 1);
  for (let i = 0; i < 4; i++) {
    s.incoming.enqueue(dataFrame(1, new Uint8Array(16_384)));
    await tick();
  }
  assert.equal(s.connection.isClosed, false);
  assert.ok(sentFrames(s.sent).some((frame) => frame.type === FrameType.RST_STREAM && frame.streamId === 1 && frame.errorCode === errorCodeValue("FLOW_CONTROL_ERROR")));
  await first.body.cancel();

  const secondPromise = openResponse(s, 3);
  const second = await secondPromise;
  s.incoming.enqueue(dataFrame(3, new TextEncoder().encode("ok"), true));
  assert.equal(await second.text(), "ok");
  assert.equal(s.connection.isClosed, false);
  await s.connection.close();
  s.incoming.close();
});

test("connection over-credit is a connection FLOW_CONTROL_ERROR", async () => {
  const s = await session(131_072, 65_535);
  const response = await openResponse(s, 1);
  for (let i = 0; i < 4; i++) {
    s.incoming.enqueue(dataFrame(1, new Uint8Array(16_384)));
    await tick();
  }
  assert.equal(s.connection.isClosed, true);
  assert.ok(sentFrames(s.sent).some((frame) => frame.type === FrameType.GOAWAY && frame.errorCode === errorCodeValue("FLOW_CONTROL_ERROR")));
  await assert.rejects(response.text());
  s.incoming.close();
});

test("padded DATA returns pad-only credit immediately and application credit on read", async () => {
  const s = await session();
  const response = await openResponse(s, 1);
  const start = s.sent.length;
  s.incoming.enqueue(paddedDataFrame(1, [3, 0, 0, 0])); // pad length plus three padding bytes
  await tick();
  let updates = sentFrames(s.sent.slice(start)).filter((frame) => frame.type === FrameType.WINDOW_UPDATE);
  assert.deepEqual(updates.map((frame) => [frame.streamId, frame.windowSizeIncrement]), [[1, 4], [0, 4]]);

  const reader = response.body.getReader();
  s.incoming.enqueue(paddedDataFrame(1, [2, 42, 0, 0])); // one application byte, three flow bytes
  assert.equal((await reader.read()).value?.[0], 42);
  await tick();
  updates = sentFrames(s.sent.slice(start)).filter((frame) => frame.type === FrameType.WINDOW_UPDATE);
  assert.equal(updates.filter((frame) => frame.streamId === 1).reduce((n, f) => n + f.windowSizeIncrement, 0), 8);
  assert.equal(updates.filter((frame) => frame.streamId === 0).reduce((n, f) => n + f.windowSizeIncrement, 0), 8);
  await reader.cancel();
  await s.connection.close();
  s.incoming.close();
});

test("cancelled and retired stream DATA cannot leak connection credit", async () => {
  const s = await session();
  const response = await openResponse(s, 1);
  const start = s.sent.length;
  s.incoming.enqueue(dataFrame(1, new Uint8Array([1, 2, 3, 4])));
  await tick();
  await response.body.cancel();
  s.incoming.enqueue(dataFrame(1, new Uint8Array([5]))); // DATA after local reset
  await tick();
  const updates = sentFrames(s.sent.slice(start)).filter((frame) => frame.type === FrameType.WINDOW_UPDATE);
  assert.equal(updates.filter((frame) => frame.streamId === 0).reduce((n, f) => n + f.windowSizeIncrement, 0), 5);
  assert.equal(s.connection.isClosed, false);
  await s.connection.close();
  s.incoming.close();
});

test("DATA racing a declined promised stream is discarded without killing siblings", async () => {
  const s = await session();
  const parent = await openResponse(s, 1);
  s.incoming.enqueue(serializeFrame({
    type: FrameType.PUSH_PROMISE,
    streamId: 1,
    promisedStreamId: 4,
    headerBlockFragment: new Uint8Array([0x82, 0x84, 0x86]),
    endHeaders: true,
  }));
  await tick();
  const start = s.sent.length;
  s.incoming.enqueue(dataFrame(2, new Uint8Array([7])));
  await tick();
  const updates = sentFrames(s.sent.slice(start)).filter((frame) => frame.type === FrameType.WINDOW_UPDATE);
  assert.equal(updates.filter((frame) => frame.streamId === 0).reduce((n, f) => n + f.windowSizeIncrement, 0), 1);
  assert.equal(s.connection.isClosed, false);

  const sibling = await openResponse(s, 3);
  assert.equal(sibling.status, 200);
  await parent.body.cancel();
  await s.connection.close();
  s.incoming.close();
});

test("zero and small configured stream windows are enforced", async () => {
  const s = await session(1);
  const response = await openResponse(s, 1);
  s.incoming.enqueue(dataFrame(1, new Uint8Array([1, 2])));
  await tick();
  assert.equal(s.connection.isClosed, false);
  assert.ok(sentFrames(s.sent).some((frame) => frame.type === FrameType.RST_STREAM && frame.streamId === 1 && frame.errorCode === errorCodeValue("FLOW_CONTROL_ERROR")));
  await response.body.cancel();
  await s.connection.close();
  s.incoming.close();

  const zero = await session(0);
  const zeroResponse = await openResponse(zero, 1);
  zero.incoming.enqueue(dataFrame(1, new Uint8Array([1])));
  await tick();
  assert.equal(zero.connection.isClosed, false);
  assert.ok(sentFrames(zero.sent).some((frame) => frame.type === FrameType.RST_STREAM && frame.streamId === 1 && frame.errorCode === errorCodeValue("FLOW_CONTROL_ERROR")));
  await zeroResponse.body.cancel();
  await zero.connection.close();
  zero.incoming.close();
});

test("repeated indexed fields across CONTINUATION are bounded and isolate sibling streams", async () => {
  const s = await session();
  const pending = s.connection.request({ path: "/receive-budget", authority: "local" });
  const failed = pending.then(() => undefined, (error) => error);
  await tick();
  const block = new Uint8Array(5 + 256 + 5);
  block.set([0x40, 0x01, 0x78, 0x01, 0x61]); // add x: a to the dynamic table
  block.fill(0xbe, 5, 261); // 256 references to dynamic index 62, crossing the field-count budget
  block.set([0x40, 0x01, 0x79, 0x01, 0x62], 261); // add y: b after rejection; decoder must still update its table
  s.incoming.enqueue(serializeFrame({ type: FrameType.HEADERS, streamId: 1, headerBlockFragment: block.subarray(0, 100), endHeaders: false, endStream: false }));
  s.incoming.enqueue(serializeFrame({ type: FrameType.CONTINUATION, streamId: 1, headerBlockFragment: block.subarray(100, 200), endHeaders: false }));
  s.incoming.enqueue(serializeFrame({ type: FrameType.CONTINUATION, streamId: 1, headerBlockFragment: block.subarray(200), endHeaders: true }));
  await tick();
  const error = await failed;
  assert.equal(error?.code, "ENHANCE_YOUR_CALM");
  assert.equal(s.connection.isClosed, false);

  const siblingPending = s.connection.request({ path: "/sibling", authority: "local" });
  await tick();
  s.incoming.enqueue(serializeFrame({ type: FrameType.HEADERS, streamId: 3, headerBlockFragment: new Uint8Array([0xbe, 0x88]), endHeaders: true, endStream: false }));
  const sibling = await siblingPending;
  assert.equal(sibling.status, 200);
  assert.equal(sibling.rawHeaders[0]?.name, "y");
  assert.equal(sibling.rawHeaders[0]?.value, "b");
  assert.equal(s.connection.isClosed, false);
  await s.connection.close();
  s.incoming.close();
});

test("decoded header byte budget is enforced across CONTINUATION", async () => {
  const s = await session();
  const pending = s.connection.request({ path: "/large-headers", authority: "local" });
  const failed = pending.then(() => undefined, (error) => error);
  await tick();
  const block = new HpackEncoder().encode([{ name: "x-large", value: "a".repeat(65_536) }]);
  for (let offset = 0; offset < block.length; offset += 16_000) {
    const fragment = block.subarray(offset, Math.min(offset + 16_000, block.length));
    if (offset === 0) {
      s.incoming.enqueue(serializeFrame({
        type: FrameType.HEADERS, streamId: 1, headerBlockFragment: fragment,
        endHeaders: fragment.length === block.length, endStream: false,
      }));
    } else {
      s.incoming.enqueue(serializeFrame({
        type: FrameType.CONTINUATION, streamId: 1, headerBlockFragment: fragment,
        endHeaders: offset + fragment.length === block.length,
      }));
    }
  }
  await tick();
  const error = await failed;
  assert.equal(error?.code, "ENHANCE_YOUR_CALM");
  assert.equal(s.connection.isClosed, false);
  await s.connection.close();
  s.incoming.close();
});
