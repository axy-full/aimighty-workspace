import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanEngines, mergeLayer, DEFAULT_ENGINES, LAYER_KEYS, PROVIDER_IDS, enginePausedMessage, enginePausedSentence, enginePausedFrom, ENGINE_PAUSED } from "../../lib/platformLayer";
import { PROVIDERS } from "../../lib/providers";

/**
 * The engine kill switch (SOW v2 §9): one switch per provider in the platform
 * layer, every provider on by default, and one refusal sentence read where
 * money starts — the meter — so a switched-off engine starts nothing anywhere.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-switch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";

test("every registered provider has a switch, on by default", () => {
  expect(PROVIDER_IDS).toEqual(PROVIDERS.map((p) => p.id));
  for (const id of PROVIDER_IDS) expect(DEFAULT_ENGINES[id]).toEqual({ on: true, reason: null, by: null, at: null });
  expect(LAYER_KEYS).toContain("engines");
  expect(mergeLayer({}).engines).toEqual(DEFAULT_ENGINES);
});

test("the cleaner keeps only a real provider's off state, with its reason, who and when", () => {
  const cleaned = cleanEngines({
    fal: { on: false, reason: "  429s all morning  ", by: "owner", at: 1_700_000_000_000.4 },
    byteplus: { on: true, reason: "ignored", by: "x", at: 5 },
    google: { on: false },
    vercel: "junk",
    nonsense: { on: false, reason: "no such vendor" },
  });
  expect(cleaned.fal).toEqual({ on: false, reason: "429s all morning", by: "owner", at: 1_700_000_000_000 });
  expect(cleaned.byteplus).toEqual({ on: true, reason: null, by: null, at: null });
  expect(cleaned.google).toEqual({ on: false, reason: null, by: null, at: null });
  expect(cleaned.vercel.on).toBe(true);
  expect(cleaned.elevenlabs.on).toBe(true);
  expect(Object.keys(cleaned).sort()).toEqual([...PROVIDER_IDS].sort());
  expect(cleanEngines(null)).toEqual(DEFAULT_ENGINES);
  expect(cleanEngines([1, 2])).toEqual(DEFAULT_ENGINES);
  expect(mergeLayer({ engines: { fal: { on: false, reason: "paused" } } }).engines.fal).toMatchObject({ on: false, reason: "paused" });
});

test("the refusal is one sentence, with the reason when there is one", () => {
  expect(enginePausedSentence("fal", null)).toBe("fal is paused by the platform. Pick another engine or try again later.");
  expect(enginePausedSentence("BytePlus ModelArk", "vendor incident. ")).toBe("BytePlus ModelArk is paused by the platform, vendor incident. Pick another engine or try again later.");
  expect(enginePausedMessage("fal", "429s")).toBe("ENGINE_PAUSED:fal is paused by the platform, 429s. Pick another engine or try again later.");
  expect(enginePausedMessage("fal", "429s").startsWith(ENGINE_PAUSED)).toBe(true);
  expect(enginePausedFrom(new Error(enginePausedMessage("fal", null)))).toBe("fal is paused by the platform. Pick another engine or try again later.");
  expect(enginePausedFrom(new Error("The platform could not record this job"))).toBeNull();
  expect(enginePausedFrom("nope")).toBeNull();
});

test("the meter refuses to start a job on a switched-off provider and lets a running one finish", async () => {
  const { meter, creditsUsed, switchProviderOf } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  const { setEngineSwitch, engineOff, engineSwitches, platformDb } = await import("../../lib/platform");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = { id: "ws_sw", slug: "sw", name: "Switch", legacy: false, dbUrl: process.env.TURSO_DATABASE_URL, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u", createdAt: 0 } as any;
  const KLING = "fal-ai/kling-video/v3/standard";
  /* Keyed by the model's vendor, not the ledger's engine: a Google still billed to the gateway is still Google's switch. */
  expect(switchProviderOf(KLING, "byteplus")).toBe("fal");
  expect(switchProviderOf("gemini-3-pro-image", "vercel")).toBe("google");
  expect(switchProviderOf("eleven_v3", "elevenlabs")).toBe("elevenlabs");

  await runInTenant(ws, () => meter({ id: "gen_before", kind: "video", engine: "fal", model: KLING, status: "running", engineCostUsd: 0.42 }));
  const off = await setEngineSwitch("fal", false, "vendor incident", "owner");
  expect(off.fal).toMatchObject({ on: false, reason: "vendor incident", by: "owner" });
  expect(off.fal.at).toBeGreaterThan(0);
  expect(await engineOff("fal")).toEqual({ off: true, reason: "vendor incident" });
  expect(await engineOff("byteplus")).toEqual({ off: false, reason: null });
  /* Stored through the layer's own row, so the desk's per-key PATCH and this agree. */
  const row = await platformDb().execute({ sql: `SELECT value FROM platform_layer WHERE key = ?`, args: ["engines"] });
  expect(JSON.parse(String((row.rows[0] as unknown as { value: string }).value)).fal.on).toBe(false);

  await expect(runInTenant(ws, () => meter({ id: "gen_refused", kind: "video", engine: "fal", model: KLING, status: "running", engineCostUsd: 0.42 })))
    .rejects.toThrow(`ENGINE_PAUSED:${PROVIDERS.find((p) => p.id === "fal")!.label} is paused by the platform, vendor incident. Pick another engine or try again later.`);
  const refused = await platformDb().execute({ sql: `SELECT COUNT(*) AS n FROM meter_events WHERE id = ?`, args: ["gen_refused"] });
  expect(Number((refused.rows[0] as unknown as { n: number }).n)).toBe(0);
  /* A job already running ends normally, and is billed. */
  await runInTenant(ws, () => meter({ id: "gen_before", kind: "video", engine: "fal", model: KLING, status: "succeeded", engineCostUsd: 0.42 }));
  expect(await creditsUsed("ws_sw")).toBe(7);
  /* Another vendor is untouched. */
  await runInTenant(ws, () => meter({ id: "gen_other", kind: "video", engine: "byteplus", model: "dreamina-seedance-2-5-260628", status: "running", engineCostUsd: 1 }));

  const on = await setEngineSwitch("fal", true, null, "owner");
  expect(on.fal).toEqual({ on: true, reason: null, by: null, at: null });
  expect((await engineSwitches()).fal.on).toBe(true);
  await runInTenant(ws, () => meter({ id: "gen_after", kind: "video", engine: "fal", model: KLING, status: "running", engineCostUsd: 0.42 }));
});

/**
 * Text spend is metered only after the gateway has answered, so the meter's
 * gate never sees it; the switch for Vercel AI Gateway is read at the
 * callers' doors (the writer, the planner turn, and the adapter the draft
 * routes use), before the mock and before any fetch — lib/gateway.ts itself
 * is in the browser bundle and reads nothing of the platform. This proves
 * the adapter's door under ENGINE_MOCK, which is also what production runs.
 */
test("a paused Vercel AI Gateway refuses at the adapter's door: run and chat throw the sentence before the mock or the fetch", async () => {
  const { vercel } = await import("../../lib/engines/vercel");
  const run = (body: string, opts: { mock: "prompt" }) => vercel.run!({ body, mock: opts.mock } as Parameters<NonNullable<typeof vercel.run>>[0]);
  const { setEngineSwitch, engineOff } = await import("../../lib/platform");
  const label = PROVIDERS.find((p) => p.id === "vercel")!.label;
  const off = await setEngineSwitch("vercel", false, "gateway incident", "owner");
  expect(off.vercel).toMatchObject({ on: false, reason: "gateway incident", by: "owner" });
  try {
    await expect(run("{}", { mock: "prompt" })).rejects.toThrow(/^ENGINE_PAUSED:/);
    await expect(run("{}", { mock: "prompt" })).rejects.toThrow(enginePausedMessage(label, "gateway incident"));
    /* The routes strip the prefix: what a person reads is the sentence alone. */
    const err = await run("{}", { mock: "prompt" }).then(() => null, (e: unknown) => e);
    expect(enginePausedFrom(err)).toBe(enginePausedSentence(label, "gateway incident"));
    /* The draft routes' money starts at chat, not run: the same sentence, before the mock. */
    await expect(vercel.chat!({ model: "anthropic/claude-sonnet-5", system: "", user: "", mock: "idea" } as Parameters<NonNullable<typeof vercel.chat>>[0])).rejects.toThrow(enginePausedMessage(label, "gateway incident"));
  } finally {
    await setEngineSwitch("vercel", true, null, "owner");
  }
  expect(await engineOff("vercel")).toEqual({ off: false, reason: null });
});
