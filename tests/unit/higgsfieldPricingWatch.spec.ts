import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "particl-pricing-watch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  process.env.ENGINE_MOCK = "1";
  process.env.HF_CREDENTIALS = "fixture:key";
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

test("the pricing watch reads only the free estimate, at most once per interval, and flags a changed published text to the platform log", async () => {
  const { checkHiggsfieldPricing, pricingDescriptionSha256 } = await import("../../lib/higgsfieldPricingWatch");
  const { platformDb } = await import("../../lib/platform");
  const published = "Token-metered pricing. A fixture of the published text.";
  const watch = { model: "pricing-watch-fixture", path: "fixture/route", body: { prompt: "p" }, expectedSha256: pricingDescriptionSha256(published), formulaUsd: () => 0.5 };
  const calls: { url: string; method?: string; body: unknown }[] = [];
  let reply: () => Response = () => Response.json({ type: "description", pricing_description: `  ${published.replace(" A ", "   A ")}\n` });
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return reply();
  }) as typeof fetch;
  const row = async () => (await platformDb().execute({ sql: "SELECT * FROM higgsfield_pricing_watch WHERE model=?", args: [watch.model] })).rows[0];
  const due = () => platformDb().execute({ sql: "UPDATE higgsfield_pricing_watch SET next_at=0 WHERE model=?", args: [watch.model] });
  // Development and mock mode never call it.
  expect(await checkHiggsfieldPricing(watch, { fetch: fetcher })).toBe("skipped");
  expect(calls).toEqual([]);
  // Whitespace does not count as a change.
  expect(await checkHiggsfieldPricing(watch, { fetch: fetcher, force: true })).toBe("unchanged");
  expect(calls).toEqual([{ url: "https://api.higgsfield.ai/estimate/fixture/route", method: "POST", body: { prompt: "p" } }]);
  // Once per interval across the platform.
  expect(await checkHiggsfieldPricing(watch, { fetch: fetcher, force: true })).toBe("busy");
  expect(calls).toHaveLength(1);
  const warnings: string[] = [], warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    await due();
    reply = () => Response.json({ type: "description", pricing_description: "Token-metered pricing. A changed text." });
    expect(await checkHiggsfieldPricing(watch, { fetch: fetcher, force: true })).toBe("changed");
    expect(await row()).toMatchObject({ status: "changed", detail: "Token-metered pricing. A changed text." });
    // The provider starts returning a figure: it is set beside Particl's own, for an admin to compare.
    await due();
    reply = () => Response.json({ type: "estimate", credits: "9", usd: "0.61" });
    expect(await checkHiggsfieldPricing(watch, { fetch: fetcher, force: true })).toBe("priced");
    expect(JSON.parse(String((await row()).detail))).toEqual({ usd: 0.61, formulaUsd: 0.5 });
  } finally { console.warn = warn; }
  expect(warnings.map(w => JSON.parse(w))).toEqual([
    expect.objectContaining({ event: "higgsfield.pricing_watch", model: watch.model, result: "changed" }),
    expect.objectContaining({ event: "higgsfield.pricing_watch", model: watch.model, result: "priced" }),
  ]);
  // A failed read is retried sooner and never throws into the quote.
  await due();
  reply = () => new Response("provider detail", { status: 503 });
  expect(await checkHiggsfieldPricing(watch, { fetch: fetcher, force: true })).toBe("unavailable");
  const retry = Number((await row()).next_at) - Date.now();
  expect(retry).toBeGreaterThan(30 * 60_000);
  expect(retry).toBeLessThan(2 * 60 * 60_000);
  expect(calls.every(call => call.url.startsWith("https://api.higgsfield.ai/estimate/") && call.method === "POST")).toBe(true);
});

test("scheduling a check never waits on it or throws into the caller, inside or outside a request", async () => {
  const { scheduleHiggsfieldPricingCheck } = await import("../../lib/higgsfieldPricingWatch");
  let reads = 0;
  globalThis.fetch = async () => { reads++; throw new Error("never read outside production"); };
  expect(() => scheduleHiggsfieldPricingCheck({ model: "pricing-watch-schedule", path: "fixture/route", body: {}, expectedSha256: "0".repeat(64) })).not.toThrow();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(reads).toBe(0);
});
