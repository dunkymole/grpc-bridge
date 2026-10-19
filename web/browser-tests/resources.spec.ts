import { readFile, mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, test } from "@playwright/test";

test("record Chromium process memory and CPU across repeated mixed RPCs", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium" || process.platform !== "linux",
    "Linux /proc and Chromium CDP are required; no invented metrics for other engines",
  );
  const browserSession = await browser.newBrowserCDPSession();
  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send("Performance.enable");
  const samples: object[] = [];
  async function sample(stage: string) {
    const { processInfo } = await browserSession.send(
      "SystemInfo.getProcessInfo",
    );
    const { metrics } = await pageSession.send("Performance.getMetrics");
    const processes = await Promise.all(
      processInfo.map(async (entry) => {
        // CDP supplies actual OS PIDs. Never substitute the Node test-driver RSS.
        const status = await readFile(`/proc/${entry.id}/status`, "utf8");
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        if (!rss)
          throw new Error(`RSS unavailable for browser PID ${entry.id}`);
        return { ...entry, rssBytes: Number(rss[1]) * 1024 };
      }),
    );
    const heap = metrics.find(
      (entry) => entry.name === "JSHeapUsedSize",
    )?.value;
    expect(heap).toBeGreaterThan(0);
    expect(processes.some((entry) => entry.type === "browser")).toBe(true);
    samples.push({
      stage,
      elapsedMs: performance.now(),
      processes,
      jsHeapUsedBytes: heap,
    });
  }
  await page.goto("/");
  const token = process.env.TUNNEL_TOKEN ?? "";
  if (token) await page.locator("#token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Connected");
  await sample("baseline-connected");
  for (let iteration = 0; iteration < 5; iteration++) {
    await page
      .getByRole("button", { name: "Run interoperability checks" })
      .click();
    await expect(page.locator("#check-output")).toContainText(
      "ALL CHECKS PASSED",
      { timeout: 60_000 },
    );
    await sample(`mixed-rpc-iteration-${iteration + 1}`);
  }
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.waitForTimeout(1_000);
  await sample("recovery-disconnected");
  const result = {
    browser: browser.version(),
    platform: process.platform,
    workload:
      "five iterations of demo interoperability suite: four RPC shapes, 16 concurrent calls, large message, cancellation, deadlines",
    units:
      "cpuTime is cumulative process CPU seconds; RSS bytes includes shared mappings and must not be interpreted as unique resident memory",
    limitations:
      "Chromium/Linux only, bounded duration, normal GC not forced; not a leak or enterprise capacity guarantee",
    samples,
  };
  await mkdir("test-results/load", { recursive: true });
  await writeFile(
    "test-results/load/browser-resources.json",
    JSON.stringify(result, null, 2),
  );
  await testInfo.attach("browser-process-resources", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
});
