import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { writeFile } from "node:fs/promises";
const results = [];
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://package-consumer:8081");
    await page.waitForFunction(
      () => typeof window.runPackageChecks === "function",
    );
    const checks = await page.evaluate(
      ({ url, token }) => window.runPackageChecks(url, token),
      { url: "ws://bridge:8080/tunnel", token: process.env.TUNNEL_TOKEN },
    );
    assert.equal(checks.length, 8);
    assert.deepEqual(errors, []);
    results.push({ name, version: browser.version(), checks, status: "PASS" });
    console.log(`${name}: installed-artifact checks passed`);
  } finally {
    await browser.close();
  }
}
await writeFile(
  "/results/consumer-browsers.json",
  JSON.stringify({ status: "PASS", results }, null, 2),
);
