import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * Sarvam's tools (lib/sarvamTools.ts, lib/sarvam.ts): speech, transcription and translation, direct. Mocked: every adapter call is a function this file hands
 * the admission (the internal seam `admitSarvam`, which the public route does not offer), or the in-process fixture under ENGINE_MOCK=1; no request leaves this
 * process and no provider is paid. Local temporary databases only. SARVAM_USD_PER_INR is set to a SAMPLE rate here; the owner's own is in the deployment.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-sarvam-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const FX = 0.012; // a sample dollars-per-rupee, for these tests only
test.beforeAll(async () => { await alignLedgerUnit(); });
test.beforeEach(() => { process.env.SARVAM_USD_PER_INR = String(FX); });
test.afterEach(() => { delete process.env.SARVAM_ENABLED; delete process.env.SARVAM_USD_PER_INR; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const options = (): AdmissionExecution => ({ defer: async () => {} });

async function upload(label: string, mediaKind: "video" | "audio", seconds: number | null): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const ext = mediaKind === "video" ? "mp4" : "mp3";
  const mime = mediaKind === "video" ? "video/mp4" : "audio/mpeg";
  const bytes = Buffer.from(`sample-${mediaKind}-${id}`);
  await storeUpload(id, ext, bytes, mime);
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.${ext}`, mime, ext, bytes.length, "x", `uploads/${id}.${ext}`, Date.now(), mediaKind, seconds] });
  return id;
}
async function meterRows() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute("SELECT id,workspace_id,status,kind,engine_cost_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='sarvam' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql: "SELECT status,stored_url,bytes,cost_usd,error,provider_outcome,duration_s,kind,model,json_extract(params,'$.task') AS task FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
}
async function ask(input: Record<string, unknown>, seams: import("../../lib/sarvamTools").SarvamSeams = {}) {
  const { admitSarvam } = await import("../../lib/sarvamTools");
  return admitSarvam(input, OWNER, options(), seams);
}
const approved = (credits = 100000) => ({ maxCredits: credits });

test("the rupee rate is the owner's, in the environment: with none, or a bad one, nothing is priced; the rates are the plan's recorded ones, in rupees", async () => {
  const { usdPerInr, sarvamUsd } = await import("../../lib/sarvamTools");
  const { SARVAM_RATES } = await import("../../lib/vendorRates");
  expect(SARVAM_RATES.speechInrPer10kChars).toEqual({ "bulbul:v3": 30, "bulbul:v4-flash": 20 });
  /* The plan records ₹29.40 an hour and Sarvam's docs table says ₹30: the higher is used so a quote is never under. */
  expect(SARVAM_RATES.transcribeInrPerHour).toBe(30);
  expect(SARVAM_RATES.translateInrPer10kChars).toEqual({ "sarvam-translate:v1": 20, "mayura:v1": 20 });
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/TO CONFIRM[\s\S]{0,700}SARVAM_USD_PER_INR/);
  expect(usdPerInr()).toBe(FX);
  for (const bad of [undefined, "", "  ", "abc", "0", "-1", "1", "Infinity", "85"]) {
    if (bad === undefined) delete process.env.SARVAM_USD_PER_INR; else process.env.SARVAM_USD_PER_INR = bad;
    expect(usdPerInr(), String(bad)).toBeNull();
    expect(sarvamUsd("speech", { chars: 100 }, "bulbul:v3"), String(bad)).toBeNull();
  }
  process.env.SARVAM_USD_PER_INR = String(FX);
  /* 10,000 characters of Bulbul v3 is ₹30; v4-flash ₹20; an hour of speech to text ₹300; 10,000 characters translated ₹20. */
  expect(sarvamUsd("speech", { chars: 10_000 }, "bulbul:v3")).toBeCloseTo(30 * FX, 6);
  expect(sarvamUsd("speech", { chars: 10_000 }, "bulbul:v4-flash")).toBeCloseTo(20 * FX, 6);
  expect(sarvamUsd("transcribe", { seconds: 3600 }, "saaras:v4")).toBeCloseTo(30 * FX, 6);
  expect(sarvamUsd("transcribe", { seconds: 10 }, "saaras:v4")).toBeCloseTo((10 / 3600) * 30 * FX, 6);
  expect(sarvamUsd("translate", { chars: 2000 }, "sarvam-translate:v1")).toBeCloseTo(4 * FX, 6);
  expect(sarvamUsd("speech", { chars: 100 }, "bulbul:v9")).toBeNull();
  expect(sarvamUsd("speech", { chars: 0 }, "bulbul:v3")).toBeNull();
});

test("off: with the engine's switch off, or a workspace that is not on the list, there is no tool and nothing is metered; on but with no rupee rate, the tools are listed unavailable and cannot run", async () => {
  const { sarvamTools } = await import("../../lib/sarvamTools");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    delete process.env.SARVAM_ENABLED;
    expect(await sarvamTools()).toEqual([]);
    expect(await ask({ tool: "translate", text: "Hello", source: "en-IN", target: "ta-IN", ...approved() })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    process.env.SARVAM_ENABLED = "1";
    const on = await sarvamTools();
    expect(on.map((t) => t.id)).toEqual(["sarvam_speech", "sarvam_transcribe", "sarvam_translate"]);
    expect(on.every((t) => t.provider === "sarvam" && t.route === "/api/sarvam" && !("unavailable" in t))).toBe(true);
    delete process.env.SARVAM_USD_PER_INR;
    expect((await sarvamTools()).every((t) => /SARVAM_USD_PER_INR/.test(t.unavailable ?? ""))).toBe(true);
    expect(await ask({ tool: "translate", text: "Hello", source: "en-IN", target: "ta-IN", quoteOnly: true })).toMatchObject({ status: 503, body: { error: expect.stringContaining("SARVAM_USD_PER_INR") } });
    expect((await meterRows()).length).toBe(before);
  });
  process.env.SARVAM_ENABLED = "1";
  await asTenant(tenant("ws_sarvam_unlisted"), async () => {
    expect(await sarvamTools()).toEqual([]);
    expect(await ask({ tool: "translate", text: "Hello", source: "en-IN", target: "ta-IN", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote: each tool in rupees through the owner's rate and the price path; a quote reserves and writes nothing; every input is checked in words", async () => {
  process.env.SARVAM_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const text = "a".repeat(5000 / 2);
    const speech = await ask({ tool: "speech", text, language: "hi-IN", quoteOnly: true });
    expect(speech).toMatchObject({ status: 200, body: { tool: "speech", model: "bulbul:v3", chars: 2500, unit: "usd" } });
    expect(Number(speech.body.price)).toBeCloseTo((2500 / 10_000) * 30 * FX, 6);
    const flash = await ask({ tool: "speech", text, language: "ta-IN", model: "bulbul:v4-flash", quoteOnly: true });
    expect(Number(flash.body.price)).toBeCloseTo((2500 / 10_000) * 20 * FX, 6);
    const clip = await upload("clip", "audio", 12);
    const tr = await ask({ tool: "transcribe", sourceUploadId: clip, quoteOnly: true });
    expect(tr).toMatchObject({ status: 200, body: { tool: "transcribe", seconds: 12 } });
    expect(Number(tr.body.price)).toBeCloseTo((12 / 3600) * 30 * FX, 6);
    const tl = await ask({ tool: "translate", text: "Hello there", source: "en-IN", target: "ta-IN", quoteOnly: true });
    expect(tl).toMatchObject({ status: 200, body: { tool: "translate", model: "sarvam-translate:v1", chars: 11 } });
    expect(Number(tl.body.price)).toBeCloseTo((11 / 10_000) * 20 * FX, 6);
    expect((await meterRows()).length).toBe(before);
    /* Every input is refused in words, before anything is reserved. */
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ tool: "dub" }, /Pick speech/],
      [{ tool: "speech", text: "", language: "hi-IN" }, /Write what to say/],
      [{ tool: "speech", text: "x".repeat(2501), language: "hi-IN" }, /up to 2,500 characters/],
      [{ tool: "speech", text: "hello", language: "xx-XX" }, /eleven languages/],
      [{ tool: "speech", text: "hello", language: "hi-IN", model: "bulbul:v9" }, /bulbul:v3 or bulbul:v4-flash/],
      [{ tool: "speech", text: "hello", language: "hi-IN", voice: "../clone" }, /stock voice/],
      [{ tool: "speech", text: "hello", language: "hi-IN", pace: 9 }, /Pace/],
      [{ tool: "translate", text: "x".repeat(2001), source: "en-IN", target: "ta-IN" }, /up to 2,000/],
      [{ tool: "translate", text: "x".repeat(1001), source: "en-IN", target: "ta-IN", model: "mayura:v1" }, /up to 1,000/],
      [{ tool: "translate", text: "hello", source: "en-IN", target: "en-IN" }, /two different languages/],
      [{ tool: "translate", text: "hello", source: "english", target: "ta-IN" }, /two different languages/],
      [{ tool: "transcribe", sourceUploadId: "../x" }, /Pick one audio original/],
      [{ tool: "transcribe", sourceUploadId: "up_not_here" }, /not in this workspace/],
      [{ tool: "transcribe", sourceUploadId: await upload("long", "audio", 31) }, /under 30 seconds/],
      [{ tool: "transcribe", sourceUploadId: await upload("film", "video", 5) }, /not in this workspace/],
    ];
    for (const [input, words] of refused) {
      const reply = await ask({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    expect((await meterRows()).length).toBe(before);
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs nothing", async () => {
  process.env.SARVAM_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    let calls = 0;
    const seams = { translate: async () => { calls++; return { text: "x" }; } };
    const input = { tool: "translate", text: "Hello there", source: "en-IN", target: "ta-IN" };
    expect((await ask(input, seams)).status).toBe(409);
    expect((await ask({ ...input, maxCredits: 0 }, seams)).status).toBe(409);
    expect((await ask({ ...input, maxCredits: "5" }, seams)).status).toBe(409);
    expect(calls).toBe(0);
    expect((await meterRows()).length).toBe(before);
  });
});

test("translate and transcribe: one request, reserved first, settled at the real cost; the answer is returned and written nowhere; a failure is 'Nothing billed'", async () => {
  process.env.SARVAM_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const before = (await meterRows()).length;
    const generations = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const order: string[] = [];
    const translate = async (input: { text: string; source: string; target: string; model: string }) => {
      order.push(`translate:${input.model}`);
      expect((await meterRows()).slice(before).at(-1)).toMatchObject({ status: "running" });
      return { text: `[${input.target}] ${input.text}` };
    };
    const ok = await ask({ tool: "translate", text: "Hello there", source: "en-IN", target: "ta-IN", ...approved() }, { translate });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, text: "[ta-IN] Hello there", source: "en-IN", target: "ta-IN" } });
    expect(order).toEqual(["translate:sarvam-translate:v1"]);
    const rows = (await meterRows()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", kind: "text", workspace_id: "ws_legacy" });
    expect(Number(rows[0].engine_cost_usd)).toBeCloseTo((11 / 10_000) * 20 * FX, 6);
    expect(Number(rows[0].billed_credits ?? 0)).toBe(0);
    const clip = await upload("clip", "audio", 10);
    const heard = await ask({ tool: "transcribe", sourceUploadId: clip, language: "hi-IN", ...approved() }, { transcribe: async (i) => { expect(i.model).toBe("saaras:v4"); expect(i.language).toBe("hi-IN"); expect(i.bytes.length).toBeGreaterThan(0); return { transcript: "namaste", language: "hi-IN" }; } });
    expect(heard).toMatchObject({ status: 200, body: { ok: true, transcript: "namaste", language: "hi-IN", seconds: 10 } });
    const rows2 = (await meterRows()).slice(before);
    expect(rows2[1]).toMatchObject({ status: "succeeded", kind: "audio" });
    expect(Number(rows2[1].engine_cost_usd)).toBeCloseTo((10 / 3600) * 30 * FX, 6);
    /* Neither wrote a take: the text and the transcript are the caller's, returned and kept nowhere here. */
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(generations);
    /* A failure: refused before work, and a dropped connection: both are nothing billed, on the ledger as a zero. */
    const { SarvamError } = await import("../../lib/sarvam");
    for (const error of [new SarvamError("Sarvam refused the request: language not supported", 422, true), new SarvamError("Sarvam did not answer.")]) {
      const failed = await ask({ tool: "translate", text: "Hello there", source: "en-IN", target: "ta-IN", ...approved() }, { translate: async () => { throw error; } });
      expect(failed.status).toBe(error.rejectedBeforeWork ? 422 : 502);
      expect(failed.body).toMatchObject({ charged: 0 });
      expect(String(failed.body.error)).toMatch(/Nothing was billed/);
    }
    const all = (await meterRows()).slice(before);
    for (const r of all.slice(2)) { expect(r.status).toBe("failed"); expect(Number(r.engine_cost_usd)).toBe(0); expect(Number(r.billed_credits ?? 0)).toBe(0); }
    expect(all.filter((r) => r.status === "running")).toEqual([]);
  });
});

test("speech: an audio take, stored under the workspace, at the real cost on its row and its ledger line; a failure settles at nothing and says so", async () => {
  process.env.SARVAM_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const text = "Namaste, welcome to the studio.";
    const calls: string[] = [];
    const reply = await ask({ tool: "speech", text, language: "hi-IN", voice: "stock-one", pace: 1.1, ...approved() }, { speak: async (i) => { calls.push(`${i.model}:${i.language}:${i.voice}:${i.pace}`); return Buffer.from("fake-mp3-bytes"); } });
    expect(reply.status).toBe(200);
    expect(calls).toEqual(["bulbul:v3:hi-IN:stock-one:1.1"]);
    const id = String(reply.body.id);
    const take = await gen(id);
    expect(take).toMatchObject({ status: "succeeded", kind: "audio", model: "bulbul:v3", task: "sarvam_speech" });
    expect(String(take.stored_url)).toContain(id);
    expect(Number(take.cost_usd)).toBeCloseTo((chars(text) / 10_000) * 30 * FX, 6);
    const rows = (await meterRows()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, status: "succeeded", kind: "audio" });
    expect(Number(rows[0].engine_cost_usd)).toBeCloseTo((chars(text) / 10_000) * 30 * FX, 6);
    expect(Number(rows[0].billed_credits ?? 0)).toBe(0);
    made.push(path.join(process.cwd(), ".data", "generations", `${id}.mp3`));
    /* A refusal before work: the take fails, "Nothing billed", the provider's words and a zero ledger line. */
    const { SarvamError } = await import("../../lib/sarvam");
    const failed = await ask({ tool: "speech", text, language: "ta-IN", ...approved() }, { speak: async () => { throw new SarvamError("Sarvam refused the request: voice not found", 422, true); } });
    expect(failed.status).toBe(422);
    expect(String(failed.body.error)).toMatch(/Nothing was billed/);
    const last = (await meterRows()).slice(before).at(-1)!;
    expect(last).toMatchObject({ status: "failed" });
    expect(Number(last.engine_cost_usd)).toBe(0);
    const row = await gen(String(last.id));
    expect(row).toMatchObject({ status: "failed" });
    expect(Number(row.cost_usd)).toBe(0);
    expect(JSON.parse(String(row.provider_outcome))).toMatchObject({ provider: "sarvam", stage: "submit", code: "http_422", billing: { state: "unknown" } });
  });
});
const chars = (s: string) => [...s].length;

test("a customer workspace on the list pays in credits at the margin path, exactly the quote, once; the house pays none", async () => {
  const { platformReady, platformDb, grantCredits } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { marginKeyOf, billCredits } = await import("../../lib/creditTerms");
  await platformReady();
  const ws = "ws_sarvam_listed";
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)", args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`] });
  await grantCredits(ws, 500, "Test", "owner", "manual");
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const setSite = (v: unknown) => platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify(v)] });
  try {
    await setSite({ enginesOnWorkspaces: [ws] });
    process.env.SARVAM_ENABLED = "1";
    const { getWorkspace } = await import("../../lib/platform");
    const row = (await getWorkspace(ws))!;
    await asTenant(row, async () => {
      const text = "a".repeat(2500);
      const usd = (2500 / 10_000) * 30 * FX;
      const expected = billCredits(usd, marginKeyOf("audio", "bulbul:v3"));
      const quote = await ask({ tool: "speech", text, language: "hi-IN", quoteOnly: true });
      expect(quote.body).toMatchObject({ unit: "cr", estimatedCredits: expected });
      const before = (await creditState())!.balance;
      /* An approval below the quote runs nothing; at the quote it runs once and charges the quote. */
      expect((await ask({ tool: "speech", text, language: "hi-IN", maxCredits: expected - 1 }, { speak: async () => Buffer.from("x") })).status).toBe(409);
      expect((await creditState())!.balance).toBe(before);
      const ok = await ask({ tool: "speech", text, language: "hi-IN", maxCredits: expected }, { speak: async () => Buffer.from("fake-mp3") });
      expect(ok.status).toBe(200);
      expect((await creditState())!.balance).toBeCloseTo(before - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === ws);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      /* A failure refunds it: nothing billed. */
      const { SarvamError } = await import("../../lib/sarvam");
      const failed = await ask({ tool: "speech", text, language: "hi-IN", maxCredits: expected }, { speak: async () => { throw new SarvamError("Sarvam did not answer."); } });
      expect(failed.status).toBe(502);
      expect((await creditState())!.balance).toBeCloseTo(before - expected, 6);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("a call the process never finished is settled at nothing by the cron stage, which frees its hold and never sends it again", async () => {
  process.env.SARVAM_ENABLED = "1";
  await asTenant(house(), async () => {
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { recoverSarvamJobs, SARVAM_STALE_MS } = await import("../../lib/sarvamTools");
    const { db, ready } = await import("../../lib/db");
    await ready();
    /* A speech take and a bare reservation, both left running. */
    const speechId = uid("gen_sarvam"), bareId = uid("sarvam_bare");
    await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,task,billed_to) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [speechId, "audio", "sarvam", "bulbul:v3", "hi", JSON.stringify({ task: "sarvam_speech", job: "voice" }), "running", Date.now(), Date.now(), "generate", "sarvam"] });
    await reserveGenerationSpend({ id: speechId, kind: "audio", engine: "sarvam", model: "bulbul:v3", status: "running", engineCostUsd: 0.01, createdBy: "owner" });
    await reserveGenerationSpend({ id: bareId, kind: "text", engine: "sarvam", model: "sarvam-translate:v1", status: "running", engineCostUsd: 0.01, createdBy: "owner" });
    expect((await meterRows()).filter((r) => [speechId, bareId].includes(String(r.id))).map((r) => r.status)).toEqual(["running", "running"]);
    /* Young ones are left alone. */
    expect((await recoverSarvamJobs({ limit: 50 })).attempted).toBe(0);
    const later = () => Date.now() + SARVAM_STALE_MS + 60_000;
    const done = await recoverSarvamJobs({ limit: 50 }, later);
    expect(done).toMatchObject({ failed: 0 });
    expect(done.attempted).toBeGreaterThanOrEqual(2);
    const rows = (await meterRows()).filter((r) => [speechId, bareId].includes(String(r.id)));
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    for (const r of rows) expect(Number(r.engine_cost_usd)).toBe(0);
    expect(await gen(speechId)).toMatchObject({ status: "failed" });
    expect(String((await gen(speechId)).error)).toMatch(/Nothing was billed/);
  });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter answers in process for all three tools, with the network forbidden", async () => {
  process.env.SARVAM_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const speech = await ask({ tool: "speech", text: "Hello", language: "en-IN", ...approved() });
      expect(speech.status).toBe(200);
      made.push(path.join(process.cwd(), ".data", "generations", `${String(speech.body.id)}.mp3`));
      expect(await ask({ tool: "translate", text: "Hello", source: "en-IN", target: "hi-IN", ...approved() })).toMatchObject({ status: 200, body: { text: "[hi-IN] Hello" } });
      expect(await ask({ tool: "transcribe", sourceUploadId: await upload("clip", "audio", 5), ...approved() })).toMatchObject({ status: 200, body: { transcript: "mock transcript" } });
      expect(await ask({ tool: "translate", text: "[[mock-fail]] x", source: "en-IN", target: "hi-IN", ...approved() })).toMatchObject({ status: 422 });
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

test("the adapter: the requests it makes, what it reads back, the base address it accepts, and what it refuses", async () => {
  const sarvam = await import("../../lib/sarvam");
  delete process.env.ENGINE_MOCK;
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const reply = (status: number, json: unknown) => (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as never;
  const before = { key: process.env.SARVAM_API_KEY, base: process.env.SARVAM_BASE_URL };
  try {
    process.env.SARVAM_API_KEY = "test-sarvam-key-not-real";
    delete process.env.SARVAM_BASE_URL;
    const audio = Buffer.from("audio-bytes").toString("base64");
    const spoken = await sarvam.speak({ text: "namaste", language: "hi-IN", model: "bulbul:v3", voice: "stock-one", pace: 1 }, { fetch: reply(200, { audios: [audio] }) });
    expect(spoken.toString()).toBe("audio-bytes");
    expect(calls[0].url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(calls[0].headers["api-subscription-key"]).toBe("test-sarvam-key-not-real");
    expect(JSON.parse(String(calls[0].body))).toEqual({ text: "namaste", target_language_code: "hi-IN", model: "bulbul:v3", output_audio_codec: "mp3", speaker: "stock-one", pace: 1 });
    /* No voice cloning is offered: nothing in the request names a reference voice. */
    expect(JSON.stringify(calls[0].body)).not.toMatch(/clone|reference|sample/i);
    const heard = await sarvam.transcribe({ bytes: Buffer.from("wav"), filename: "clip.wav", mime: "audio/wav", model: "saaras:v4", language: "hi-IN" }, { fetch: reply(200, { transcript: "namaste", language_code: "hi-IN" }) });
    expect(heard).toEqual({ transcript: "namaste", language: "hi-IN" });
    expect(calls[1].url).toBe("https://api.sarvam.ai/speech-to-text");
    expect(calls[1].body).toBeInstanceOf(FormData);
    expect([...(calls[1].body as FormData).keys()].sort()).toEqual(["file", "language_code", "model"]);
    const translated = await sarvam.translate({ text: "hello", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: reply(200, { translated_text: "vanakkam" }) });
    expect(translated).toEqual({ text: "vanakkam" });
    expect(JSON.parse(String(calls[2].body))).toEqual({ input: "hello", source_language_code: "en-IN", target_language_code: "ta-IN", model: "sarvam-translate:v1" });
    /* A reply that is not what is expected is a failure, never a guess. */
    for (const bad of [{}, { audios: [] }, { audios: [""] }, { audios: [7] }]) expect(await sarvam.speak({ text: "x", language: "hi-IN", model: "bulbul:v3" }, { fetch: reply(200, bad) }).then(() => null, (e) => e), JSON.stringify(bad)).toBeInstanceOf(sarvam.SarvamError);
    expect(await sarvam.translate({ text: "x", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: reply(200, { translated_text: 5 }) }).then(() => null, (e) => e)).toBeInstanceOf(sarvam.SarvamError);
    /* A refusal before work is a 4xx (not 408/429); a 5xx, a timeout and a throttle are not. */
    for (const [status, early] of [[400, true], [403, true], [422, true], [408, false], [429, false], [500, false], [503, false]] as const) {
      const failed = await sarvam.translate({ text: "x", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: reply(status, { message: "nope" }) }).then(() => null, (e) => e);
      expect(failed, String(status)).toBeInstanceOf(sarvam.SarvamError);
      expect(failed.rejectedBeforeWork, String(status)).toBe(early);
    }
    expect(await sarvam.translate({ text: "x", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ rejectedBeforeWork: false });
    /* Limits are refused before any request. */
    const sent = calls.length;
    for (const run of [
      () => sarvam.speak({ text: "x".repeat(2501), language: "hi-IN", model: "bulbul:v3" }, { fetch: reply(200, {}) }),
      () => sarvam.speak({ text: " ", language: "hi-IN", model: "bulbul:v3" }, { fetch: reply(200, {}) }),
      () => sarvam.translate({ text: "x".repeat(1001), source: "en-IN", target: "ta-IN", model: "mayura:v1" }, { fetch: reply(200, {}) }),
      () => sarvam.transcribe({ bytes: Buffer.alloc(0), filename: "a.wav", mime: "audio/wav", model: "saaras:v4" }, { fetch: reply(200, {}) }),
    ]) expect(await run().then(() => null, (e) => e)).toBeInstanceOf(sarvam.SarvamError);
    expect(calls.length).toBe(sent);
    /* The base address: https, or a local stand-in for a test; anything else is refused before a request. */
    process.env.SARVAM_BASE_URL = "http://127.0.0.1:9999";
    await sarvam.translate({ text: "x", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: reply(200, { translated_text: "y" }) });
    expect(calls.at(-1)!.url).toBe("http://127.0.0.1:9999/translate");
    const count = calls.length;
    for (const bad of ["http://evil.example.com", "ftp://api.sarvam.ai", "https://user@api.sarvam.ai", "https://api.sarvam.ai/../x"]) {
      process.env.SARVAM_BASE_URL = bad;
      expect(await sarvam.translate({ text: "x", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: reply(200, {}) }).then(() => null, (e) => e), bad).toBeInstanceOf(sarvam.SarvamError);
    }
    expect(calls.length).toBe(count);
    delete process.env.SARVAM_API_KEY; delete process.env.SARVAM_BASE_URL;
    const none = await sarvam.translate({ text: "x", source: "en-IN", target: "ta-IN", model: "sarvam-translate:v1" }, { fetch: reply(200, {}) }).then(() => null, (e) => e);
    expect(String(none.message)).toContain("SARVAM_API_KEY");
    expect(calls.length).toBe(count);
  } finally {
    if (before.key === undefined) delete process.env.SARVAM_API_KEY; else process.env.SARVAM_API_KEY = before.key;
    if (before.base === undefined) delete process.env.SARVAM_BASE_URL; else process.env.SARVAM_BASE_URL = before.base;
  }
});

test("engine on, a workspace at its own $0 cap: refused 429 in the cap's words, with nothing held, written, reserved or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  await platformReady();
  const ws = "ws_sarvam_cap0";
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,0)", args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`] });
  await grantCredits(ws, 500, "Test", "owner", "manual");
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const setSite = (v: unknown) => platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify(v)] });
  try {
    await setSite({ enginesOnWorkspaces: [ws] });
    process.env.SARVAM_ENABLED = "1";
    const row = (await getWorkspace(ws))!;
    expect(row.allowanceUsd).toBe(0);
    await asTenant(row, async () => {
      await (await import("../../lib/db")).ready();
      const generations = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      let calls = 0;
      const seams = { speak: async () => { calls++; return Buffer.from("x"); }, translate: async () => { calls++; return { text: "x" }; } };
      for (const input of [{ tool: "speech", text: "Hello there", language: "hi-IN" }, { tool: "translate", text: "Hello there", source: "en-IN", target: "ta-IN" }]) {
        const reply = await ask({ ...input, ...approved() }, seams);
        expect(reply.status, JSON.stringify(reply.body)).toBe(429);
        expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
        expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      }
      expect(calls).toBe(0);
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(generations);
      expect((await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [ws] })).rows).toEqual([]);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("no transcript or translation text lands in the idempotency claim: the first caller gets the text, a replay answers 'done, not kept', and the claim row holds none of it", async () => {
  const { createRequire } = await import("node:module");
  const ts = (await import("typescript")).default;
  const { recordedSarvamReply } = await import("../../lib/sarvamTools");
  /* The reply that is kept: the text and the transcript are cut; everything else stays. */
  expect(JSON.parse(recordedSarvamReply(JSON.stringify({ ok: true, tool: "translate", text: "secret words", source: "en-IN", target: "ta-IN", estimatedCredits: 1 })))).toEqual({ ok: true, tool: "translate", source: "en-IN", target: "ta-IN", estimatedCredits: 1, kept: false, note: "Done. The text is not kept: run it again to get it." });
  expect(recordedSarvamReply(JSON.stringify({ ok: true, transcript: "secret speech", language: "hi-IN" }))).not.toContain("secret speech");
  expect(JSON.parse(recordedSarvamReply(JSON.stringify({ id: "gen_1", status: "succeeded" })))).toEqual({ id: "gen_1", status: "succeeded" });
  expect(recordedSarvamReply("not json")).toBe("not json");
  /* The real route, with its session and `after` replaced and everything else real. */
  const nodeRequire = createRequire(path.resolve("package.json"));
  const resolveSource = (from: string, name: string) => {
    const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (readdirSync(path.dirname(candidate)).includes(path.basename(candidate))) return candidate;
    return base;
  };
  const file = "app/api/sarvam/route.ts";
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} as { POST: (req: Request, ctx?: unknown) => Promise<Response> } };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name === "@/lib/auth") return { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: (h: unknown) => h, requireRender: async () => OWNER };
    if (name === "next/server") return { NextResponse: Response, after: () => {} };
    return name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolveSource(file, name)) : nodeRequire(name);
  }, target, target.exports);
  process.env.SARVAM_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const { requireTenant } = await import("../../lib/tenant");
    const press = async (body: Record<string, unknown>, key: string) => {
      const res = await target.exports.POST(new Request("http://localhost/api/sarvam", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-Workbench-Scope": `particl-active-${requireTenant().id}-owner` }, body: JSON.stringify(body),
      }));
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown>, replayed: res.headers.get("Idempotency-Replayed") === "true" };
    };
    const clip = await upload("clip", "audio", 5);
    const cases: [Record<string, unknown>, string, string][] = [
      [{ tool: "translate", text: "A very private sentence", source: "en-IN", target: "hi-IN", ...approved() }, "translate", "[hi-IN] A very private sentence"],
      [{ tool: "transcribe", sourceUploadId: clip, ...approved() }, "transcribe", "mock transcript"],
    ];
    for (const [body, label, secret] of cases) {
      const key = `idem-${label}-${Date.now().toString(36)}`;
      const first = await press(body, key);
      expect(first.status, label).toBe(200);
      expect(JSON.stringify(first.body), label).toContain(secret);
      const stored = String((await db().execute({ sql: "SELECT response_json FROM generation_requests WHERE request_key=?", args: [key] })).rows[0].response_json);
      expect(stored, label).not.toContain(secret);
      expect(stored, label).not.toMatch(/private sentence|mock transcript/);
      const again = await press(body, key);
      expect(again.replayed, label).toBe(true);
      expect(JSON.stringify(again.body), label).not.toContain(secret);
      expect(again.body, label).toMatchObject({ ok: true, kept: false, note: "Done. The text is not kept: run it again to get it." });
    }
    /* A speech take's reply holds no text and is kept as it was. */
    const spoken = await press({ tool: "speech", text: "Hello", language: "en-IN", ...approved() }, `idem-speech-${Date.now().toString(36)}`);
    expect(spoken.status).toBe(200);
    expect(spoken.body.id).toBeTruthy();
    made.push(path.join(process.cwd(), ".data", "generations", `${String(spoken.body.id)}.mp3`));
  });
});

test("over MCP: the three tools are listed only where the engine is on and priced; a call asks the route for the price and the caller cannot approve", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const calls: { body: Record<string, unknown> }[] = [];
  const call = async (_p: string, init: { body?: unknown } = {}) => {
    const body = init.body as Record<string, unknown>;
    calls.push({ body });
    return body.quoteOnly === true ? { estimatedCredits: 2, price: 0.02, unit: "usd" } : body.tool === "translate" ? { ok: true, text: "[ta-IN] Hello" } : { id: "gen_s1" };
  };
  await asTenant(house(), async () => {
    delete process.env.SARVAM_ENABLED;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("sarvam_speech");
    await expect(runDirectEngineTool("sarvam_translate", { text: "Hello", source: "en-IN", target: "ta-IN" }, call)).rejects.toThrow("There is no such tool here.");
    process.env.SARVAM_ENABLED = "1";
    expect((await directEngineMcpTools()).map((t) => t.name)).toEqual(expect.arrayContaining(["sarvam_speech", "sarvam_transcribe", "sarvam_translate"]));
    expect(await runDirectEngineTool("sarvam_translate", { text: "Hello", source: "en-IN", target: "ta-IN" }, call)).toBe("[ta-IN] Hello");
    expect(calls.map((c) => [c.body.quoteOnly === true, c.body.maxCredits ?? null])).toEqual([[true, null], [false, 2]]);
    expect(await runDirectEngineTool("sarvam_speech", { text: "Hello", language: "en-IN" }, call)).toMatch(/^Speech made\.\n\nid: gen_s1/);
    await expect(runDirectEngineTool("sarvam_speech", { text: "Hello", language: "en-IN", maxCredits: 1 }, call)).rejects.toThrow(/not yours to approve/);
    /* No rupee rate: the tools are not offered (they cannot be priced), and a call says so. */
    delete process.env.SARVAM_USD_PER_INR;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("sarvam_translate");
    await expect(runDirectEngineTool("sarvam_translate", { text: "Hello", source: "en-IN", target: "ta-IN" }, call)).rejects.toThrow("There is no such tool here.");
  });
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: the seam stays internal, the route is the one door, the reservation comes first, no voice cloning, the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitSarvam\b/)).toEqual(["lib/sarvamTools.ts"]);
  expect(reachers(/@\/lib\/sarvamTools["']/)).toEqual(["app/api/sarvam/route.ts"]);
  const flow = readFileSync("lib/sarvamTools.ts", "utf8");
  expect(flow).toContain("admitSarvam(input, got, options, {})");
  const at = (needle: string) => flow.indexOf(needle);
  expect(at("async function reserveCall(")).toBeLessThan(at("export async function admitSarvam("));
  /* Approval, the wall, the caps and the checkpoint all come before the call is reserved; the reservation before each vendor call. */
  expect(at("Approve the price first")).toBeLessThan(at("const reserved = await reserveCall("));
  expect(at("const reserved = await reserveCall(")).toBeLessThan(at("await (seams.translate ?? translate)("));
  expect(at("const reserved = await reserveCall(")).toBeLessThan(at("await (seams.transcribe ?? transcribe)("));
  expect(at("await reserveCall(")).toBeLessThan(at("await (seams.speak ?? speak)("));
  /* Price: the owner's rate and the rate table; no rupee or dollar literal in the workflow. */
  expect(flow).toContain("quotedCredits(usd, marginKey)");
  expect(flow).not.toMatch(/\b(?:29\.4|0\.0\d+|0\.1\d+)\b/);
  /* No voice cloning anywhere in Sarvam's adapter or tools. */
  for (const file of ["lib/sarvam.ts", "lib/sarvamTools.ts"]) expect(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replaceAll("structuredClone", "")).not.toMatch(/clon|speaker_wav|reference_audio/i);
  const adapter = readFileSync("lib/sarvam.ts", "utf8");
  const names = new Set([...adapter.matchAll(/process\.env\.(SARVAM_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["SARVAM_API_KEY", "SARVAM_BASE_URL"]);
  expect(readFileSync("lib/sarvamTools.ts", "utf8")).toContain("process.env.SARVAM_USD_PER_INR");
  expect(adapter).toContain('export const SARVAM_SWITCH = "SARVAM_ENABLED";');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
});
