import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

process.env.ENGINE_MOCK = "1";
const dir = mkdtempSync(path.join(tmpdir(), "particl-ws-shot-cost-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "local-ws-shot-unit-keyring-local-ws-shot";

const SD25 = "dreamina-seedance-2-5-260628", SD20 = "dreamina-seedance-2-0-260128", KLING = "fal-ai/kling-video/v3/standard";

function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: "cost", name: "Cost", legacy: false, dbUrl: "file:" + path.join(dir, id + ".db"), dbToken: null, keys: {}, usesPlatformKeys: true,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
function load<T>(file: string, deps: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename), mod = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function("require", "module", "exports", compiled)((id: string) => (Object.hasOwn(deps, id) ? deps[id] : require(id)), mod, mod.exports);
  return mod.exports as T;
}

/** A fetch that answers through the real GET /api/workbench/engines handler, inside a tenant. */
async function serverFetch() {
  const tenant = await import("../../lib/tenant");
  const ws = workspace();
  const route = load<typeof import("../../app/api/workbench/engines/route")>("app/api/workbench/engines/route.ts", {
    "@/lib/auth": { withTenant: (handler: (req: Request) => Promise<Response>) => (req: Request) => tenant.runInTenant(ws, () => handler(req)),
      requireUser: async () => ({ user: { id: "owner" } }) },
    "@/lib/providers": await import("../../lib/providers"),
    "@/lib/workbench/media-quote": await import("../../lib/workbench/media-quote"),
    "@/lib/soulIdentities": await import("../../lib/soulIdentities"),
  });
  const calls: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    calls.push(String(input));
    return (route.GET as unknown as (req: Request) => Promise<Response>)(new Request(new URL(String(input), "https://studio.test"), init));
  }) as typeof fetch;
  return { fetcher, calls };
}

test("tokens use the server's own formula (billedFrame), and credits equal the server quote — 5s 720p 16:9 on 2.5", async () => {
  const { shotTokens, fetchShotEstimate, ShotEstimator } = await import("../../lib/workspace/cost");
  const { MODELS, estimateTokens, billedFrame, costUsd } = await import("../../lib/models");
  const { estimateCostUsd, listRate } = await import("../../lib/vendorPricing");
  const { quoteWorkbenchMedia } = await import("../../lib/workbench/media-quote");
  const settings = { engine: SD25, durationS: 5, ratio: "16:9", resolution: "720p" };

  // The token count the server metered: it prices exactly costUsd(tokens, rate).
  const tokens = shotTokens(settings)!;
  expect(tokens).toBe(estimateTokens("720p", "16:9", 5));
  const frame = billedFrame("720p", "16:9")!;
  expect(tokens).toBe(Math.round((frame.w * frame.h * 24 * 5) / 1024));
  expect(tokens).toBe(108_000);
  expect(costUsd(tokens, listRate(SD25, "720p")!)).toBe(estimateCostUsd(SD25, "720p", "16:9", 5)!.net);
  // Where the frame rounds (1080 → 1088) the simplified prototype formula would be wrong; ours is not.
  const hd = shotTokens({ ...settings, resolution: "1080p" })!;
  expect(hd).toBe(Math.round((1920 * 1088 * 24 * 5) / 1024));
  expect(costUsd(hd, listRate(SD25, "1080p")!)).toBe(estimateCostUsd(SD25, "1080p", "16:9", 5)!.net);
  // Portrait uses the short side, as the server does.
  expect(shotTokens({ ...settings, ratio: "9:16" })).toBe(estimateTokens("720p", "9:16", 5));
  // Per-second engines have no token count.
  expect(shotTokens({ engine: KLING, durationS: 5, ratio: "16:9", resolution: "1080p" })).toBeUndefined();

  const { fetcher, calls } = await serverFetch();
  const server = quoteWorkbenchMedia(MODELS.find((m) => m.id === SD25)!, { resolution: "720p", ratio: "16:9", duration: 5 },
    { images: 0, videos: 0, inputSeconds: 0, hasVideoInput: false });
  const estimate = await fetchShotEstimate(settings, { fetch: fetcher });
  expect(estimate).toEqual({ credits: server.credits, tokens, state: "ready", reason: null });
  expect(estimate.credits).toBe(18); // CLAUDE.md rate card: 2.5, 5s 720p sells at 18 cr
  expect(calls[0]).toBe(`/api/workbench/engines?model=${encodeURIComponent(SD25)}&resolution=720p&ratio=16%3A9&duration=5`);

  // Through the estimator the hook subscribes to: same figure.
  const estimator = new ShotEstimator({ fetch: fetcher, debounceMs: 5 });
  const viaHook = await new Promise((resolve) => estimator.request(settings, resolve));
  expect(viaHook).toEqual(estimate);
  // Unsupported settings come back unavailable with the server's reason.
  const bad = await fetchShotEstimate({ engine: SD20, durationS: 5, ratio: "16:9", resolution: "2k" }, { fetch: fetcher });
  expect(bad).toMatchObject({ credits: null, state: "unavailable" });
  expect(bad.reason).toMatch(/size, aspect and duration/);
});

test("the estimator debounces, caches by key, shares and aborts in-flight requests", async () => {
  const { ShotEstimator } = await import("../../lib/workspace/cost");
  const seen: string[] = [];
  const aborted: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ credits: Number(new URL(url, "https://x").searchParams.get("duration")) * 3 })), 30);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); aborted.push(url); reject(new DOMException("aborted", "AbortError")); });
    });
  }) as typeof fetch;
  let clock = 0;
  const estimator = new ShotEstimator({ fetch: fetcher, debounceMs: 40, ttlMs: 1000, now: () => clock });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const input = (durationS: number) => ({ engine: SD25, durationS, ratio: "16:9", resolution: "720p" });

  // Rapid changes: each cancelled inside the debounce never leaves.
  const results: unknown[] = [];
  for (const d of [5, 6, 7]) { const cancel = estimator.request(input(d), (e) => results.push(e)); if (d !== 7) cancel(); }
  expect(estimator.peek(input(7))).toMatchObject({ state: "loading", credits: null, tokens: 108_000 * 7 / 5 });
  await wait(120);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("duration=7");
  expect(results).toEqual([{ credits: 21, tokens: 151_200, state: "ready", reason: null }]);

  // Cached: answered synchronously, no request.
  let sync: unknown = null;
  estimator.request(input(7), (e) => { sync = e; });
  expect(sync).toMatchObject({ credits: 21, state: "ready" });
  expect(seen).toHaveLength(1);
  // Expired: asks again.
  clock = 2000;
  expect(estimator.peek(input(7)).state).toBe("loading");

  // Two subscribers to one key share a fetch; it aborts only when both leave.
  const a = estimator.request(input(9), () => {}), b = estimator.request(input(9), () => {});
  await wait(55);
  expect(seen.filter((u) => u.includes("duration=9"))).toHaveLength(1);
  a();
  await wait(1);
  expect(aborted).toHaveLength(0);
  b();
  await wait(1);
  expect(aborted).toHaveLength(1);
  expect(aborted[0]).toContain("duration=9");

  // Unknown engines never fetch.
  const none = await new Promise((resolve) => estimator.request({ engine: "retired" }, resolve));
  expect(none).toMatchObject({ state: "unavailable", credits: null });
  // Server errors and unpriceable replies are unavailable with a reason, and are not cached.
  const failing = new ShotEstimator({ debounceMs: 1, fetch: (async () => Response.json({ error: "Sign in to estimate." }, { status: 401 })) as typeof fetch });
  expect(await new Promise((r) => failing.request(input(5), r))).toEqual({ credits: null, tokens: 108_000, state: "unavailable", reason: "Sign in to estimate." });
  expect(failing.peek(input(5)).state).toBe("loading");
  const offline = new ShotEstimator({ debounceMs: 1, fetch: (async () => { throw new TypeError("network"); }) as typeof fetch });
  expect(await new Promise((r) => offline.request(input(5), r))).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/could not be reached/) });
});

test("formatters group the Western way even when the default locale does not", async () => {
  const { formatCredits, formatTokens } = await import("../../lib/workspace/cost");
  const original = Number.prototype.toLocaleString;
  // Simulate a viewer whose default locale groups in lakhs.
  Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return original.call(this, locales ?? "en-IN", options);
  };
  try {
    expect((1_296_000).toLocaleString()).toBe("12,96,000");
    expect(formatTokens(1_296_000)).toBe("1,296,000 tokens");
    expect(formatCredits(129_600)).toBe("129,600 cr");
    expect(formatCredits(18)).toBe("18 cr");
    expect(formatTokens(1)).toBe("1 token");
  } finally {
    Number.prototype.toLocaleString = original;
  }
});
