import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, browser }, testInfo) => {
  testInfo.annotations.push({
    type: "browser-engine",
    description: `${testInfo.project.name} ${browser.version()}`,
  });
  await page.addInitScript(() => {
    const NativeWebSocket = globalThis.WebSocket;
    const sockets: WebSocket[] = [];
    Object.defineProperty(window, "__bridgeTestSockets", {
      configurable: false,
      value: sockets,
    });
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
  await page.goto("/");
  const token = process.env.TUNNEL_TOKEN ?? "";
  if (token) await page.locator("#token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Connected", {
    timeout: 20_000,
  });
});

test("real browser interop covers four RPC shapes and transport edges", async ({ page }) => {
  await page.getByRole("button", { name: "Run interoperability checks" }).click();
  const output = page.locator("#check-output");
  await expect(output).toContainText("ALL CHECKS PASSED", { timeout: 60_000 });
  for (const result of [
    "PASS unary protobuf + trailers",
    "PASS server streaming",
    "PASS client streaming + half-close",
    "PASS live bidi: replies arrive before request half-close",
    "PASS 16 concurrent RPCs on the same connection",
    "PASS 180 KB message across HTTP/2 flow-control windows",
    "PASS native error status",
    "PASS deadline",
    "PASS cancellation keeps sibling RPCs working",
  ]) {
    await expect(output).toContainText(result);
  }
});

test("connection loss fails the active stream and later calls recover without replay", async ({ page }) => {
  await page.getByRole("button", { name: "Start counting" }).click();
  const count = page.locator("#count-output");
  await expect(count).toContainText("← tick 1", { timeout: 10_000 });
  await page.evaluate(() => {
    (window as typeof window & { __bridgeTestSockets: WebSocket[] })
      .__bridgeTestSockets[0]!
      .close();
  });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __bridgeTestSockets: WebSocket[] })
      .__bridgeTestSockets.length,
  ), { timeout: 20_000 }).toBeGreaterThan(1);
  await expect(count).toContainText("unavailable", { timeout: 10_000 });

  await page.locator("#echo-input").fill("fresh after recovery");
  await page.getByRole("button", { name: "Echo" }).click();
  await expect(page.locator("#echo-output")).toContainText(
    "fresh after recovery",
    { timeout: 15_000 },
  );
});
