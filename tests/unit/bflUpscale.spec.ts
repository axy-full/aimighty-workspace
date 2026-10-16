import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * FLUX Video Upscale through BFL (lib/bfl.ts `submitUpscale`, lib/bflUpscale.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seams
 * `admitBflUpscale` and `advanceBflUpscaleWith`, which the public route and the cron do not offer), a stubbed `fetch`, or the in-process fixture under ENGINE_MOCK=1; no request leaves
 * this process and no provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-bfl-upscale-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.BFL_ENABLED; delete process.env.BFL_BASE_URL; process.env.ENGINE_MOCK = "1"; });

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
const deferred: (() => Promise<unknown>)[] = [];
const options = (): AdmissionExecution => ({ defer: async (work) => { deferred.push(work); } });

/** The clips of public/fixtures and tests/fixtures, with what they measure: 854 x 480 at 24 fps for 5 s; 640 x 360 at 30 fps for 6.03 s; 720 x 1280 at 24 fps for 1.5 s. */
const SWAP = { file: "public/fixtures/swap-5s-854x480.mp4", width: 854, height: 480, seconds: 4.99967 };
const CLIP30 = { file: "public/fixtures/clip-6s.mp4", width: 640, height: 360, seconds: 6.0333 };
const TALL = { file: "tests/fixtures/astra-source.mp4", width: 720, height: 1280, seconds: 1.5 };

/** A clip upload of this workspace. */
async function clip(label: string, source = SWAP, uploader: string | null = null, ext = "mp4"): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const bytes = readFileSync(source.file);
  const stored = await storeUpload(id, ext, bytes, "video/mp4");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,duration_s,uploader_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.${ext}`, "video/mp4", ext, bytes.length, "x", source.width, source.height, stored.url, Date.now(), "video", source.seconds, uploader] });
  return id;
}
/** A finished video take of this workspace, its original stored. */
async function take(label: string): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeVideoBytes } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const stored = await storeVideoBytes(id, readFileSync(SWAP.file));
  made.push(path.join(process.cwd(), ".data", "generations", `${id}.mp4`));
  await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,stored_url,bytes,billed_to) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [id, "video", "byteplus", "m", "A harbour at dawn", "{}", "succeeded", "owner", Date.now(), Date.now(), stored.url, stored.bytes, "byteplus"] });
  return id;
}
async function image(label: string): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const id = uid(label);
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", 10, "x", 64, 64, `uploads/${id}.png`, Date.now(), "image"] });
  return id;
}
async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
async function meterRows() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute("SELECT id,workspace_id,status,engine_cost_usd,overrun_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='bfl' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT kind,model,provider,status,stored_url,bytes,cost_usd,error,source_gen_id,duration_s,provider_outcome,json_extract(params,'$.bflUpscale') AS up, json_extract(params,'$.sourceUploadId') AS source_upload FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { ...r, up: JSON.parse(String(r.up)) as import("../../lib/bflUpscale").BflUpscaleParams } as { kind: string; model: string; provider: string; status: string; stored_url: string | null; bytes: number | null; cost_usd: number | null; error: string | null; source_gen_id: string | null; source_upload: string | null; duration_s: number | null; provider_outcome: string | null; up: import("../../lib/bflUpscale").BflUpscaleParams };
}
async function admit(input: Record<string, unknown>) {
  const { admitBflUpscale } = await import("../../lib/bflUpscale");
  return admitBflUpscale({ tool: "upscale", ...input }, OWNER, options());
}
const approved = { maxCredits: 100000 };
/** The sample clip at 2x, Precise: 854 x 480 doubled is 1.57 MP a frame (rounded up), for 5 s at the 24 fps rate. */
const SWAP_PRECISE = 1.57 * 5 * 0.07, SWAP_CREATIVE = 1.57 * 5 * 0.10;

function fakeBfl(over: { readyAt?: number; fail?: string; submitError?: Error; fetchErrors?: number; storeError?: Error; stated?: number | null; pollError?: Error } = {}) {
  const calls: string[] = [];
  const sent: { video: Buffer; mode: string; factor: number; prompt?: string }[] = [];
  let polls = 0, fetchErrors = over.fetchErrors ?? 0;
  const deps = {
    submit: async (input: { video: Buffer; mode: string; factor: number; prompt?: string }) => {
      calls.push(`submit:${input.mode}`); sent.push(input);
      if (over.submitError) throw over.submitError;
      return { id: "bfl_up_job_1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=bfl_up_job_1", statedUsd: over.stated ?? null };
    },
    poll: async () => {
      polls++; calls.push("poll");
      if (over.pollError) throw over.pollError;
      if (over.fail) return { status: "failed" as const, failure: over.fail };
      return polls < (over.readyAt ?? 2) ? { status: "pending" as const } : { status: "ready" as const, resultUrl: "https://delivery-eu.bfl.ai/out.mp4" };
    },
    fetchVideo: async () => { calls.push("fetch"); if (fetchErrors > 0) { fetchErrors--; throw new Error("the signed address did not answer"); } return Buffer.from("flux-upscaled-video"); },
    store: async (genId: string, bytes: Buffer) => { if (over.storeError) { const e = over.storeError; over.storeError = undefined; throw e; } calls.push("store"); return { url: `stored/${genId}.mp4`, bytes: bytes.length }; },
  };
  return { deps, calls, sent };
}
async function run(genId: string, deps: ReturnType<typeof fakeBfl>["deps"] & { clock?: () => number }, times = 4) {
  const { advanceBflUpscaleWith } = await import("../../lib/bflUpscale");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceBflUpscaleWith(genId, deps as never);
  return last;
}

test("the prices are BFL's published ones: Precise 7 and Creative 10 credits ($0.07 and $0.10) a megapixel-second of output, at 24 fps; the quote is exact, rounds up, scales with a faster source and stops at BFL's 13.75 MP", async () => {
  const { BFL_UPSCALE_RATES } = await import("../../lib/vendorRates");
  const { bflUpscaleQuote } = await import("../../lib/bflUpscale");
  expect(BFL_UPSCALE_RATES.creditUsd).toBe(0.01);
  expect(BFL_UPSCALE_RATES.modes).toEqual({ precise: { usdPerMpSecond: 0.07, creativity: 0 }, creative: { usdPerMpSecond: 0.10, creativity: 1 } });
  expect(BFL_UPSCALE_RATES.defaultMode).toBe("precise");
  expect(BFL_UPSCALE_RATES).toMatchObject({ pixelsPerMp: 1048576, standardFps: 24, maxSeconds: 20, maxInputWidth: 2560, maxInputHeight: 1440, maxOutputMp: 13.75, factor: { min: 1.5, max: 3, default: 2 } });
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/FLUX Video Upscale[\s\S]{0,2200}TO CONFIRM[\s\S]{0,1800}export const BFL_UPSCALE_RATES/);
  const usd = (over: Partial<Parameters<typeof bflUpscaleQuote>[0]> = {}) => { const q = bflUpscaleQuote({ width: 1920, height: 1080, seconds: 5, fps: 24, factor: 2, mode: "precise", ...over }); return "usd" in q ? q.usd : q.error; };
  /* 1080p doubled is 3840 x 2160: 7.92 MP a frame (7.91 rounded up), 39.6 MP-seconds for 5 s. */
  const full = bflUpscaleQuote({ width: 1920, height: 1080, seconds: 5, fps: 24, factor: 2, mode: "precise" });
  expect(full).toMatchObject({ outputWidth: 3840, outputHeight: 2160, outputMegapixels: 7.92, megapixelSeconds: 39.6 });
  expect(usd()).toBeCloseTo(2.772, 6);
  expect(usd({ mode: "creative" })).toBeCloseTo(3.96, 6);
  /* 720p doubled is 2560 x 1440; tripled is the same 4K as 1080p doubled. */
  expect(bflUpscaleQuote({ width: 1280, height: 720, seconds: 5, fps: 24, factor: 2, mode: "precise" })).toMatchObject({ outputWidth: 2560, outputHeight: 1440, outputMegapixels: 3.52 });
  expect(usd({ width: 1280, height: 720 })).toBeCloseTo(3.52 * 5 * 0.07, 6);
  expect(usd({ width: 1280, height: 720, mode: "creative" })).toBeCloseTo(3.52 * 5 * 0.10, 6);
  expect(usd({ width: 1280, height: 720, factor: 3 })).toBeCloseTo(2.772, 6);
  /* A source faster than the 24 fps rate is quoted proportionally higher (never under); a slower one is not quoted lower. */
  expect(usd({ fps: 30 })).toBeCloseTo(2.772 * 1.25, 5);
  expect(usd({ fps: 12 })).toBeCloseTo(2.772, 6);
  /* The seconds are taken to the millisecond, rounded up (4.9991 s is 5 s). */
  expect(usd({ seconds: 4.999 })).toBeCloseTo(7.92 * 4.999 * 0.07, 5);
  expect(usd({ seconds: 4.9991 })).toBeCloseTo(7.92 * 5 * 0.07, 5);
  /* BFL caps a frame at 13.75 MP: a 2560 x 1440 source tripled is quoted at the cap, and its size shrinks to fit. */
  const capped = bflUpscaleQuote({ width: 2560, height: 1440, seconds: 5, fps: 24, factor: 3, mode: "precise" });
  expect(capped).toMatchObject({ outputMegapixels: 13.75 });
  expect(usd({ width: 2560, height: 1440, factor: 3 })).toBeCloseTo(13.75 * 5 * 0.07, 6);
  if ("outputWidth" in capped) expect((capped.outputWidth * capped.outputHeight) / 1048576).toBeLessThan(13.8);
  /* The scale is 1.5 to 3. */
  for (const factor of [1.49, 3.01, 0, -2]) expect(String(usd({ factor })), String(factor)).toMatch(/1\.5 to 3/);
  expect(String(usd({ fps: 0 }))).toMatch(/cannot be priced/);
});

test("the request: the EU endpoint, the one upscale path, creativity always sent (BFL's own default is Creative, ours is Precise), nothing else; replies read defensively; the key goes only to bfl.ai", async () => {
  const bfl = await import("../../lib/bfl");
  delete process.env.ENGINE_MOCK;
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const reply = (status: number, json: unknown) => (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? init.body : "" });
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as never;
  const before = process.env.BFL_API_KEY;
  try {
    process.env.BFL_API_KEY = "test-bfl-key-not-real";
    const video = Buffer.from("sample-clip-bytes");
    const sent = await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: reply(200, { id: "u1", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=u1", cost: 55.4, input_mp: 0.39, output_mp: 1.57 }) });
    expect(sent).toEqual({ id: "u1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=u1", statedUsd: 0.554 });
    expect(calls[0]).toMatchObject({ url: "https://api.eu.bfl.ai/v1/flux-tools/video-upscale-v1", method: "POST" });
    expect(new URL(calls[0].url).hostname).toBe("api.eu.bfl.ai");
    expect(calls[0].headers["x-key"]).toBe("test-bfl-key-not-real");
    /* Precise is creativity 0, sent explicitly; no prompt unless given; no safety_tolerance and no webhook. */
    expect(JSON.parse(calls[0].body)).toEqual({ input_video: video.toString("base64"), creativity: 0, upscale_factor: 2 });
    await bfl.submitUpscale({ video, mode: "creative", factor: 1.5, prompt: "a harbour" }, { fetch: reply(200, { id: "u2", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=u2" }) });
    expect(JSON.parse(calls[1].body)).toEqual({ input_video: video.toString("base64"), creativity: 1, upscale_factor: 1.5, prompt: "a harbour" });
    /* No cost in the reply: null (the caller then settles at the quote and marks it to reconcile). */
    expect((await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: reply(200, { id: "u3", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=u3" }) })).statedUsd).toBeNull();
    /* A reply naming no job, or a polling address that is not bfl.ai, is a failure, never followed. */
    for (const bad of [{}, { id: "j", polling_url: "https://evil.example.com/poll" }, { id: "j", polling_url: "http://api.eu.bfl.ai/x" }, { id: "j", polling_url: "https://api.eu.bfl.ai.evil.com/x" }])
      expect(await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: reply(200, bad) }).then(() => null, (e) => e), JSON.stringify(bad)).toBeInstanceOf(bfl.BflError);
    /* A refusal is a clear 4xx (a rejected clip, a 402 balance, a throttle); a 408 and a 5xx may have taken the job; an unanswered request is not a refusal. */
    for (const [status, early] of [[400, true], [402, true], [403, true], [422, true], [429, true], [408, false], [500, false], [503, false]] as const) {
      const failed = await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: reply(status, { detail: "nope" }) }).then(() => null, (e) => e);
      expect(failed.rejectedBeforeGeneration, String(status)).toBe(early);
    }
    expect(await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ rejectedBeforeGeneration: false });
    /* The redirect is never followed. */
    const seen: (string | undefined)[] = [];
    const redirecting = (async (_url: unknown, init?: RequestInit) => { seen.push(init?.redirect); throw new TypeError("fetch failed: unexpected redirect"); }) as never;
    expect(await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(bfl.BflError);
    expect(seen).toEqual(["error"]);
    /* Polling: BFL's words for a video job; the statuses it names are the same as a still's. */
    for (const [word, want] of [["Pending", "pending"], ["Error", "failed"], ["Request Moderated", "failed"], ["Content Moderated", "failed"], ["Something New", "pending"]] as const)
      expect((await bfl.pollImage({ id: "u1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=u1" }, { fetch: reply(200, { status: word }) }, "video")).status, word).toBe(want);
    const ready = await bfl.pollImage({ id: "u1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=u1" }, { fetch: reply(200, { status: "Ready", result: { sample: "https://delivery-eu.bfl.ai/o.mp4?sig=abc" } }) }, "video");
    expect(ready).toEqual({ status: "ready", resultUrl: "https://delivery-eu.bfl.ai/o.mp4?sig=abc" });
    expect(await bfl.pollImage({ id: "u1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=u1" }, { fetch: reply(200, { status: "Error" }) }, "video")).toEqual({ status: "failed", failure: "BFL could not make this video." });
    expect(await bfl.pollImage({ id: "u1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=u1" }, { fetch: reply(200, { status: "Ready", result: { sample: "https://evil.example.com/o.mp4" } }) }, "video")).toEqual({ status: "failed", failure: "BFL's result named no video we can fetch." });
    /* The finished video comes from a bfl.ai address, without our key, capped. */
    const count = calls.length;
    expect((await bfl.fetchVideoResult("https://delivery-eu.bfl.ai/o.mp4", { fetch: reply(200, "mp4-bytes") })).toString()).toBe("mp4-bytes");
    expect(calls.at(-1)!.headers["x-key"]).toBeUndefined();
    for (const bad of ["https://evil.example.com/o.mp4", "https://delivery-eu.bfl.ai.evil.com/o.mp4", "http://delivery-eu.bfl.ai/o.mp4"])
      expect(await bfl.fetchVideoResult(bad, { fetch: reply(200, "x") }).then(() => null, (e) => e), bad).toBeInstanceOf(bfl.BflError);
    expect(calls.length).toBe(count + 1);
    expect(await bfl.fetchVideoResult("https://delivery-eu.bfl.ai/o.mp4", { fetch: reply(200, "") }).then(() => null, (e) => e)).toBeInstanceOf(bfl.BflError);
    expect(bfl.BFL_VIDEO_RESULT_LIFETIME_MS).toBe(60 * 60_000);
    /* No key: not set up, and nothing sent. */
    delete process.env.BFL_API_KEY;
    const none = await bfl.submitUpscale({ video, mode: "precise", factor: 2 }, { fetch: reply(200, {}) }).then(() => null, (e) => e);
    expect(String(none.message)).toContain("BFL_API_KEY");
  } finally { if (before === undefined) delete process.env.BFL_API_KEY; else process.env.BFL_API_KEY = before; }
});

test("off: with the switch off, or a workspace not on the list, there is no tool and nothing is metered; the house and a listed workspace are offered it, behind the same BFL_ENABLED switch as FLUX.2", async () => {
  const { bflUpscaleTools } = await import("../../lib/bflUpscale");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const source = await clip("off");
    delete process.env.BFL_ENABLED;
    expect(await bflUpscaleTools()).toEqual([]);
    expect(await admit({ sourceUploadId: source, ...approved })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    process.env.BFL_ENABLED = "1";
    const on = await bflUpscaleTools();
    expect(on.map((t) => t.id)).toEqual(["flux_upscale"]);
    expect(on.every((t) => t.provider === "bfl" && t.route === "/api/bfl" && t.needs.join() === "BFL_API_KEY,BFL_ENABLED" && t.models.join() === "bfl/flux-upscale/precise,bfl/flux-upscale/creative")).toBe(true);
    expect((await meterRows()).length).toBe(before);
  });
  process.env.BFL_ENABLED = "1";
  await asTenant(tenant("ws_bfl_up_unlisted"), async () => {
    expect(await bflUpscaleTools()).toEqual([]);
    expect(await admit({ sourceUploadId: "up_x", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote: Precise unless the person says Creative, which carries its note; every input refused in words before anything is reserved; a quote writes nothing", async () => {
  process.env.BFL_ENABLED = "1";
  const { CREATIVE_NOTE } = await import("../../lib/bflUpscale");
  expect(CREATIVE_NOTE).toBe("Faces and products may change.");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const { db } = await import("../../lib/db");
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const source = await clip("q");
    const q = await admit({ sourceUploadId: source, quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { tool: "upscale", model: "bfl/flux-upscale/precise", mode: "precise", factor: 2, outputWidth: 1708, outputHeight: 960, megapixels: 1.57, unit: "usd" } });
    expect(Number(q.body.price)).toBeCloseTo(SWAP_PRECISE, 2);
    expect(q.body.notices).toBeUndefined();
    expect(q.body.estimatedCredits).toBeGreaterThanOrEqual(1);
    /* Creative is an explicit choice, dearer, and carries the note. */
    const c = await admit({ sourceUploadId: source, mode: "creative", quoteOnly: true });
    expect(c).toMatchObject({ status: 200, body: { mode: "creative", model: "bfl/flux-upscale/creative", notices: ["Faces and products may change."] } });
    expect(Number(c.body.price)).toBeCloseTo(SWAP_CREATIVE, 2);
    expect(Number(c.body.price) / Number(q.body.price)).toBeCloseTo(10 / 7, 3);
    /* Nothing else turns Creative on: not a prompt, not a factor, not a missing mode. */
    for (const input of [{}, { prompt: "a harbour" }, { factor: 3 }, { mode: null }]) expect((await admit({ sourceUploadId: source, ...input, quoteOnly: true })).body, JSON.stringify(input)).toMatchObject({ mode: "precise" });
    const three = await admit({ sourceUploadId: source, factor: 3, quoteOnly: true });
    expect(three.body).toMatchObject({ factor: 3, outputWidth: 2562, outputHeight: 1440 });
    /* The 30 fps clip is quoted at 1.25 times the 24 fps rate. */
    const fast = await admit({ sourceUploadId: await clip("q30", CLIP30), quoteOnly: true });
    const { bflUpscaleQuote } = await import("../../lib/bflUpscale");
    const expected = bflUpscaleQuote({ width: 640, height: 360, seconds: 6.0333, fps: 30, factor: 2, mode: "precise" });
    expect(Number(fast.body.price)).toBeCloseTo("usd" in expected ? expected.usd : 0, 2);
    /* A take of this workspace is a source too. */
    expect((await admit({ sourceGenId: await take("qt"), quoteOnly: true })).status).toBe(200);
    const refused: [Record<string, unknown>, number, RegExp][] = [
      [{ tool: "image" }, 400, /Pick upscale/],
      [{ sourceUploadId: source, mode: "wild" }, 400, /precise or creative/],
      [{ sourceUploadId: source, mode: 1 }, 400, /precise or creative/],
      [{ sourceUploadId: source, factor: 1.2 }, 400, /1\.5 to 3/],
      [{ sourceUploadId: source, factor: 4 }, 400, /1\.5 to 3/],
      [{ sourceUploadId: source, factor: "big" }, 400, /1\.5 to 3/],
      [{ sourceUploadId: source, factor: true }, 400, /1\.5 to 3/],
      [{ sourceUploadId: source, prompt: "x".repeat(1001) }, 400, /1000 characters/],
      [{ sourceUploadId: source, prompt: 7 }, 400, /1000 characters/],
      [{}, 400, /one clip/],
      [{ sourceUploadId: source, sourceGenId: "g1" }, 400, /one clip/],
      [{ sourceUploadId: "../x" }, 400, /not valid/],
      [{ sourceUploadId: "up_not_here" }, 404, /not in this workspace/],
      [{ sourceGenId: "gen_not_here" }, 404, /not in this workspace/],
      [{ sourceUploadId: await image("still") }, 404, /not in this workspace/],
      [{ sourceUploadId: source, projectId: "prod_missing" }, 404, /not in this workspace/],
      [{ sourceUploadId: await clip("mov", SWAP, null, "mov") }, 400, /MP4/],
    ];
    for (const [input, status, words] of refused) {
      const reply = await admit({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBe(status);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    /* A starter clip is a sample, not a stored original. */
    await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,stored_url,bytes,billed_to) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", args: ["gen_demo_clip", "video", "byteplus", "m", "Demo", '{"demo":true}', "succeeded", "owner", 1, 1, "/fixtures/clip.mp4", 100, "byteplus"] });
    expect(await admit({ sourceGenId: "gen_demo_clip", quoteOnly: true })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/starter clip/) } });
    /* Nothing was written or metered by any of it. */
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBeLessThanOrEqual(gens + 2);
    expect((await db().execute("SELECT id FROM generations WHERE json_extract(params,'$.task')='bfl_upscale'")).rows).toEqual([]);
  });
});

test("limits: a clip over 20 seconds, over 2560 x 1440 or over 50 MB is refused in words with nothing written; a 1440 x 2560 portrait clip is within BFL's limit", async () => {
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const { BFL_UPSCALE_RATES } = await import("../../lib/vendorRates");
    const before = (await meterRows()).length;
    const source = await clip("lim");
    await db().execute({ sql: "UPDATE uploads SET bytes=? WHERE id=?", args: [BFL_UPSCALE_RATES.maxSourceBytes + 1, source] });
    expect(await admit({ sourceUploadId: source, quoteOnly: true })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/up to 50 MB/) } });
    expect(readFileSync("lib/bflUpscale.ts", "utf8")).toContain("{ maxSeconds: R.maxSeconds }");
    expect(BFL_UPSCALE_RATES.maxSeconds).toBe(20);
    await db().execute({ sql: "UPDATE uploads SET bytes=0 WHERE id=?", args: [source] });
    expect((await admit({ sourceUploadId: source, quoteOnly: true })).status).toBe(400);
    expect((await meterRows()).length).toBe(before);
    /* The longest a clip may be is the limit the admission passes the inspector (20 seconds): a clip over a limit is refused in the limit's own words. */
    const { inspectOriginalVideo } = await import("../../lib/videoMetadata.server");
    const long = await clip("long");
    const row = (await db().execute({ sql: "SELECT ext, stored_url, bytes FROM uploads WHERE id=?", args: [long] })).rows[0];
    await expect(inspectOriginalVideo({ id: long, mime: "video/mp4", ext: String(row.ext), storedUrl: String(row.stored_url), role: "reference_video", kind: "video", fromGeneration: false }, Number(row.bytes), true, { maxSeconds: 4 })).rejects.toThrow(/up to 4 seconds/);
    /* The size limit is on the measured frame: a portrait 1440 x 2560 clip is the same area as 2560 x 1440 and is taken. */
    const tall = await clip("tall", TALL);
    await db().execute({ sql: "UPDATE uploads SET width=1440,height=2560 WHERE id=?", args: [tall] });
    expect((await admit({ sourceUploadId: tall, quoteOnly: true })).status).toBe(200);
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs and writes nothing", async () => {
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const source = await clip("appr");
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    for (const bad of [{}, { maxCredits: 0 }, { maxCredits: "5" }, { maxCredits: 1.5 }]) expect((await admit({ sourceUploadId: source, ...bad })).status, JSON.stringify(bad)).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
  });
});

test("a clip upscaled: submit with the mode's creativity, poll, fetch the moment it is Ready, store under the workspace, settle at the quote; BFL's own figure when it states one, never above the quote", async () => {
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const source = await clip("ok");
    const before = (await meterRows()).length;
    const handedOff = deferred.length;
    const reply = await admit({ sourceUploadId: source, ...approved });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(deferred.length).toBe(handedOff + 1);
    const genId = String(reply.body.id);
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(SWAP_PRECISE, 2);
    const vendor = fakeBfl();
    const up = await run(genId, vendor.deps, 4);
    expect(up).toMatchObject({ status: "done", settled: 1, mode: "precise" });
    expect(vendor.calls).toEqual(["submit:precise", "poll", "poll", "fetch", "store"]);
    expect(vendor.sent[0]).toMatchObject({ mode: "precise", factor: 2 });
    expect(vendor.sent[0].video.equals(readFileSync(SWAP.file))).toBe(true);
    expect(vendor.sent[0].prompt).toBeUndefined();
    const t = await gen(genId);
    expect(t).toMatchObject({ kind: "video", model: "bfl/flux-upscale/precise", provider: "bfl", status: "succeeded", stored_url: `stored/${genId}.mp4`, source_upload: source });
    expect(Number(t.duration_s)).toBeCloseTo(SWAP.seconds, 2);
    expect(Number(t.cost_usd)).toBeCloseTo(SWAP_PRECISE, 2);
    const settled = (await meterRows()).slice(before);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo(SWAP_PRECISE, 2);
    expect(Number(settled[0].billed_credits ?? 0)).toBe(0);
    /* No figure from BFL: settled at the quote and marked to reconcile. */
    expect(t.up.reconcile).toBe(1);
    /* Another step on a finished job does nothing. */
    const again = fakeBfl();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
    /* Creative, with a prompt: creativity 1 reaches the adapter, the prompt too, and the take is the creative model. */
    const c = await admit({ sourceUploadId: source, mode: "creative", prompt: "a harbour at dawn", factor: 2.5, ...approved });
    expect(c.body.notices).toEqual(["Faces and products may change."]);
    const cv = fakeBfl();
    await run(String(c.body.id), cv.deps, 4);
    expect(cv.sent[0]).toMatchObject({ mode: "creative", factor: 2.5, prompt: "a harbour at dawn" });
    expect(await gen(String(c.body.id))).toMatchObject({ model: "bfl/flux-upscale/creative", status: "succeeded" });
    /* From a take of the workspace: linked to it. */
    const src = await take("okt");
    const fromTake = String((await admit({ sourceGenId: src, ...approved })).body.id);
    await run(fromTake, fakeBfl().deps, 4);
    expect(await gen(fromTake)).toMatchObject({ status: "succeeded", source_gen_id: src });
    /* BFL states a figure: lower is the cost (nothing to reconcile); higher is billed at the quote, the excess recorded as the overrun and marked to reconcile. */
    for (const [stated, expected, over, reconcile] of [[0.3, 0.3, null, 0], [50, SWAP_PRECISE, 50 - SWAP_PRECISE, 1]] as const) {
      const id = String((await admit({ sourceUploadId: source, ...approved })).body.id);
      await run(id, fakeBfl({ stated }).deps, 4);
      const done = await gen(id);
      expect(Number(done.cost_usd), String(stated)).toBeCloseTo(expected, 2);
      expect(done.up.reconcile, String(stated)).toBe(reconcile);
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd), String(stated)).toBeCloseTo(expected, 2);
      if (over === null) expect(line.overrun_usd ?? null).toBeNull(); else expect(Number(line.overrun_usd)).toBeCloseTo(over, 2);
      expect(Number(line.billed_credits ?? 0)).toBe(0);
    }
  });
});

test("a failure bills nothing: an Error or a moderated job, a clip BFL rejects (free), a provider error; the person is told 'Nothing billed'; the ledger line records what BFL stated, or nothing marked to reconcile", async () => {
  const { BflError } = await import("../../lib/bfl");
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const source = await clip("fail");
    const before = (await meterRows()).length;
    const failedBy = async (over: Parameters<typeof fakeBfl>[0]) => {
      const id = String((await admit({ sourceUploadId: source, ...approved })).body.id);
      const vendor = fakeBfl(over);
      await run(id, vendor.deps, 3);
      return { id, vendor, take: await gen(id) };
    };
    const moderated = await failedBy({ fail: "BFL's moderation stopped this." });
    expect(moderated.take.status).toBe("failed");
    expect(String(moderated.take.error)).toMatch(/Nothing was billed/);
    expect(Number(moderated.take.cost_usd)).toBe(0);
    expect(moderated.take.up.reconcile).toBe(1);
    expect(JSON.parse(String(moderated.take.provider_outcome))).toMatchObject({ provider: "bfl", stage: "run", billing: { state: "unknown" } });
    expect(moderated.vendor.calls).not.toContain("fetch");
    /* A refusal before work (a rejected clip is not charged by BFL; a 429 throttle too): settled at nothing, with BFL's own words. */
    for (const [status, text] of [[422, "BFL refused the request: the clip is longer than 20 seconds"], [429, "BFL refused the request: too many active tasks"]] as const) {
      const refused = await failedBy({ submitError: new BflError(text, status, true) });
      expect(refused.take.status).toBe("failed");
      expect(String(refused.take.error)).toContain(text);
      expect(String(refused.take.error)).toMatch(/Nothing was billed/);
      expect(JSON.parse(String(refused.take.provider_outcome))).toMatchObject({ provider: "bfl", stage: "submit", code: `http_${status}` });
    }
    const rows = (await meterRows()).slice(before);
    expect(rows.every((r) => r.status === "failed" && Number(r.engine_cost_usd) === 0 && Number(r.billed_credits ?? 0) === 0)).toBe(true);
    /* BFL stated a cost for the job and then failed or moderated it: recorded at that cost on the ledger line, billed to nobody, nothing to reconcile. */
    const charged = await failedBy({ fail: "BFL's moderation stopped this.", stated: 0.3 });
    expect(charged.take.status).toBe("failed");
    expect(Number(charged.take.cost_usd)).toBeCloseTo(0.3, 6);
    expect(charged.take.up.reconcile).toBe(0);
    const line = (await meterRows()).find((r) => r.id === charged.id)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(0.3, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* Never above the quote on a failure either. */
    const over = await failedBy({ fail: "BFL's moderation stopped this.", stated: 50 });
    const overLine = (await meterRows()).find((r) => r.id === over.id)!;
    expect(Number(overLine.engine_cost_usd)).toBeCloseTo(SWAP_PRECISE, 2);
    expect(Number(overLine.overrun_usd)).toBeCloseTo(50 - SWAP_PRECISE, 2);
    expect(over.take.up.reconcile).toBe(1);
    /* The clip itself gone before it is sent: nothing is sent, nothing is billed. */
    const gone = await clip("gone");
    const id = String((await admit({ sourceUploadId: gone, ...approved })).body.id);
    const { db } = await import("../../lib/db");
    await db().execute({ sql: "DELETE FROM uploads WHERE id=?", args: [gone] });
    const none = fakeBfl();
    await run(id, none.deps, 2);
    expect(none.calls).toEqual([]);
    expect(await gen(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/Nothing was submitted[\s\S]*Nothing was billed/) });
  });
});

test("no answer: a lost acknowledgement is held and never sent again, and a job that never got to its submit settles at nothing; a poll that does not answer keeps the job for the next pass", async () => {
  const { BflError } = await import("../../lib/bfl");
  const { recoverBflUpscaleJobs, advanceBflUpscaleWith } = await import("../../lib/bflUpscale");
  const { db } = await import("../../lib/db");
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const source = await clip("lost");
    const id = String((await admit({ sourceUploadId: source, ...approved })).body.id);
    const lost = fakeBfl({ submitError: new BflError("BFL did not answer.") });
    expect(await run(id, lost.deps, 1)).toMatchObject({ status: "uncertain", settled: 0 });
    expect(String((await gen(id)).error)).toMatch(/will not be sent again/);
    expect((await meterRows()).find((r) => r.id === id)).toMatchObject({ status: "running" });
    const again = fakeBfl();
    await run(id, again.deps, 3);
    await recoverBflUpscaleJobs({ limit: 50 }, again.deps as never);
    expect(again.calls).toEqual([]);
    /* A claim older than the grace with no job id: if it never reached the instant before the request it sent nothing and settles at nothing; if it did, it is held. */
    for (const [sendingAt, want] of [[null, "failed"], [1, "uncertain"]] as const) {
      const id2 = String((await admit({ sourceUploadId: source, ...approved })).body.id);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.bflUpscale.claimedAt',1,'$.bflUpscale.sendingAt',?) WHERE id=?", args: [sendingAt, id2] });
      const vendor = fakeBfl();
      expect(await advanceBflUpscaleWith(id2, { ...vendor.deps, clock: () => Date.now() + 3_600_000 } as never), String(sendingAt)).toMatchObject({ status: want });
      expect(vendor.calls).toEqual([]);
      expect((await meterRows()).find((r) => r.id === id2)).toMatchObject({ status: want === "failed" ? "failed" : "running" });
    }
    /* A poll that times out: the job and its hold stay, nothing is sent again, and the next pass collects it. */
    const id3 = String((await admit({ sourceUploadId: source, ...approved })).body.id);
    const flaky = fakeBfl({ pollError: new BflError("BFL did not answer.") });
    await expect(advanceBflUpscaleWith(id3, flaky.deps as never)).rejects.toThrow();
    expect((await gen(id3)).status).toBe("running");
    expect((await meterRows()).find((r) => r.id === id3)).toMatchObject({ status: "running" });
    const ok = fakeBfl();
    await run(id3, ok.deps, 3);
    expect(ok.calls.some((c) => c.startsWith("submit"))).toBe(false);
    expect((await gen(id3)).status).toBe("succeeded");
  });
});

test("the hour: a clip that is Ready is fetched at once; a fetch that fails is retried while its address lives; past the window it is lost, recorded at what BFL charged, billed to nobody, and said so", async () => {
  const { BFL_VIDEO_RESULT_LIFETIME_MS } = await import("../../lib/bfl");
  const { advanceBflUpscaleWith } = await import("../../lib/bflUpscale");
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const source = await clip("hour");
    const a = String((await admit({ sourceUploadId: source, ...approved })).body.id);
    const flaky = fakeBfl({ readyAt: 1, fetchErrors: 1 });
    await expect(advanceBflUpscaleWith(a, flaky.deps as never)).rejects.toThrow();
    expect((await gen(a)).status).toBe("running");
    expect((await gen(a)).up.readyAt).not.toBeNull();
    await run(a, flaky.deps, 2);
    expect((await gen(a)).status).toBe("succeeded");
    const b = String((await admit({ sourceUploadId: source, ...approved })).body.id);
    const dead = fakeBfl({ readyAt: 1, fetchErrors: 99 });
    await expect(advanceBflUpscaleWith(b, dead.deps as never)).rejects.toThrow();
    const late = await advanceBflUpscaleWith(b, { ...dead.deps, clock: () => Date.now() + BFL_VIDEO_RESULT_LIFETIME_MS } as never);
    expect(late).toMatchObject({ status: "failed", settled: 1 });
    const lost = await gen(b);
    expect(String(lost.error)).toMatch(/could not be saved in time\. Nothing was billed/);
    /* BFL made it (Ready), so it charged: recorded at the quote (it stated none), billed to nobody, marked to reconcile. */
    expect(Number(lost.cost_usd)).toBeCloseTo(SWAP_PRECISE, 2);
    expect(lost.up.reconcile).toBe(1);
    const line = (await meterRows()).find((r) => r.id === b)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* Two workers at once submit once; a storage failure keeps the job and the next pass finishes it. */
    const c = String((await admit({ sourceUploadId: source, ...approved })).body.id);
    const vendor = fakeBfl({ readyAt: 1, storeError: new Error("storage is busy") });
    await Promise.allSettled([advanceBflUpscaleWith(c, vendor.deps as never), advanceBflUpscaleWith(c, vendor.deps as never)]);
    expect(vendor.calls.filter((x) => x.startsWith("submit")).length).toBe(1);
    await run(c, vendor.deps, 3);
    expect((await gen(c)).status).toBe("succeeded");
    expect(vendor.calls.filter((x) => x.startsWith("submit")).length).toBe(1);
  });
});

test("the shot cap is judged at the quote and the press, before any row is written: a member past it is refused 403 (needs an admin) with no take left; a token, an agent and an Auto step are never the admin; an admin, no shot and a rule that is not 'cap' go through", async () => {
  const { admitBflUpscale } = await import("../../lib/bflUpscale");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const { runInTenant } = await import("../../lib/tenant");
  process.env.BFL_ENABLED = "1";
  const MEMBER: AdmissionActor = { user: { ...OWNER.user, id: "member_1", role: "member", owner: false } as AdmissionActor["user"] };
  await runInTenant(house(), async () => {
    await ready();
    const setRule = async (rule: string | null, cap?: number) => {
      for (const [key, value] of [["approvalRule", rule], ["shotCapCredits", cap == null ? null : String(cap)]] as const) {
        if (value === null) await db().execute({ sql: "DELETE FROM settings WHERE key=?", args: [key] }); else await setSetting(key, value, "admin");
      }
      invalidateSettings();
    };
    const projectId = uid("prod"), shotId = uid("shot");
    await project(projectId);
    await db().execute({ sql: "INSERT INTO shots (id, project_id, code, title, created_at, updated_at) VALUES (?,?,?,?,0,0)", args: [shotId, projectId, "S01", "A shot"] });
    /* The shot already holds a take (a dollar of an image, ten credits), so even a one-credit line takes it past a cap of one. */
    await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,shot_id,cost_usd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,0)", args: [uid("gen_prior"), "image", "gemini-3.1-flash-image", "A prior still", "{}", "succeeded", shotId, 1] });
    const source = await clip("shotcap");
    const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const press = (actor: AdmissionActor, extra: Record<string, unknown> = {}) => admitBflUpscale({ tool: "upscale", sourceUploadId: source, projectId, shotId, ...approved, ...extra }, actor, options());
    try {
      await setRule("cap", 1);
      const before = { rows: await rows(), meter: (await meterRows()).length, handed: deferred.length };
      for (const extra of [{ quoteOnly: true }, {}]) {
        const refused = await press(MEMBER, extra);
        expect(refused, JSON.stringify(extra)).toMatchObject({ status: 403, body: { needsAdmin: true } });
        expect(String(refused.body.error)).toMatch(/S01/);
      }
      expect(await rows()).toBe(before.rows);
      expect((await meterRows()).length).toBe(before.meter);
      expect(deferred.length).toBe(before.handed);
      await runInTenant(house(), async () => { expect((await press(OWNER, { quoteOnly: true })).status).toBe(200); }, OWNER as never);
      /* An admin who is not a person at the press (a token, an agent, a step Atomik's Auto approved) never skips the cap. */
      const TOKEN = { id: "tok_admin", name: "Assistant", scope: "render" as const, capUsd: null };
      const ADMIN_TOKEN: AdmissionActor = { ...OWNER, token: TOKEN };
      const AGENT: AdmissionActor = { user: { ...OWNER.user, id: "agent:run_up_1" } as AdmissionActor["user"] };
      const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
      await rigAgentReady();
      await db().execute({ sql: "INSERT OR IGNORE INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_up_1", "prod_x", "draft_x", "u_runner", "req_up_cap", "goal", "auto", "finished"] });
      await runInTenant(house(), async () => {
        for (const extra of [{ quoteOnly: true }, {}]) expect(await press(ADMIN_TOKEN, extra), `token ${JSON.stringify(extra)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
      }, { user: ADMIN_TOKEN.user, token: TOKEN } as never);
      await runInTenant(house(), async () => {
        for (const extra of [{ quoteOnly: true }, {}]) expect(await press(AGENT, extra), `agent ${JSON.stringify(extra)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
      }, AGENT as never);
      await runInTenant(house(), async () => {
        for (const quoteOnly of [true, undefined]) expect(await admitBflUpscale({ tool: "upscale", sourceUploadId: source, shotId, ...approved, quoteOnly }, OWNER, { ...options(), run: { auto: true } as never }), `auto ${String(quoteOnly)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
      }, OWNER as never);
      expect(await rows()).toBe(before.rows);
      /* No shot, a rule that is not 'cap', or a cap above the price: through. */
      expect((await press(MEMBER, { quoteOnly: true, shotId: undefined, projectId: undefined })).status).toBe(200);
      await setRule("ask");
      expect((await press(MEMBER, { quoteOnly: true })).status).toBe(200);
      await setRule("cap", 100000);
      expect((await press(MEMBER, { quoteOnly: true })).status).toBe(200);
      const made = await press(MEMBER);
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      expect(await rows()).toBe(before.rows + 1);
      /* (The job is run to the end, so the cron in a later test finds nothing of ours waiting.) */
      await run(String(made.body.id), fakeBfl().deps, 4);
      /* The shot must belong to the production named, and exist. */
      await project("p_up_other");
      expect(await press(MEMBER, { quoteOnly: true, projectId: "p_up_other" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/another production/) } });
      expect(await press(MEMBER, { quoteOnly: true, shotId: "s_gone" })).toMatchObject({ status: 400, body: { error: "That shot is gone." } });
    } finally { await setRule(null); }
  }, MEMBER as never);
});

test("a clip is read only by a person who may open it: an Atomik run acts as its owner, another person's private upload is not there, and with no person behind the request nothing is read", async () => {
  const { admitBflUpscale } = await import("../../lib/bflUpscale");
  const { runInTenant } = await import("../../lib/tenant");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { db, ready } = await import("../../lib/db");
  process.env.BFL_ENABLED = "1";
  const agentUser = (runId: string) => ({ ...OWNER.user, id: `agent:${runId}`, role: "member", owner: false }) as AdmissionActor["user"];
  await runInTenant(house(), async () => {
    await ready(); await rigAgentReady();
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_up_owned", "prod_x", "draft_x", "u_runner", "req_up", "goal", "auto", "finished"] });
    const mine = await clip("clip_mine", SWAP, "u_runner"), theirs = await clip("clip_theirs", SWAP, "u_other");
    const ask = (actor: AdmissionActor, id: string) => admitBflUpscale({ tool: "upscale", sourceUploadId: id, quoteOnly: true }, actor, options());
    await runInTenant(house(), async () => {
      expect((await ask({ user: agentUser("run_up_owned") }, mine)).status).toBe(200);
      expect(await ask({ user: agentUser("run_up_owned") }, theirs)).toMatchObject({ status: 404, body: { error: expect.stringMatching(/not in this workspace/) } });
    }, { user: agentUser("run_up_owned") } as never);
    await runInTenant(house(), async () => {
      expect(await ask({ user: agentUser("run_none") }, mine)).toMatchObject({ status: 403, body: { error: "A person must be behind this request to use their uploads." } });
    }, { user: agentUser("run_none") } as never);
    const person: AdmissionActor = { user: { ...OWNER.user, id: "u_runner", role: "member", owner: false } as AdmissionActor["user"] };
    await runInTenant(house(), async () => {
      expect((await ask(person, mine)).status).toBe(200);
      expect((await ask(person, theirs)).status).toBe(404);
    }, { user: person.user } as never);
  }, OWNER as never);
});

test("a listed customer workspace pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db, ready } = await import("../../lib/db");
  const { BflError } = await import("../../lib/bfl");
  await platformReady();
  const listed = "ws_bflup_listed", capped = "ws_bflup_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.BFL_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const source = await clip("credits");
      const { bflUpscaleQuote } = await import("../../lib/bflUpscale");
      const priced = bflUpscaleQuote({ width: 854, height: 480, seconds: 4.99967, fps: 24.0015, factor: 2, mode: "precise" });
      const expected = billCredits("usd" in priced ? priced.usd : 0, "bfl/flux-upscale/precise");
      const q = await admit({ sourceUploadId: source, quoteOnly: true });
      expect(q).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ sourceUploadId: source, maxCredits: expected - 1 })).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      const id = String((await admit({ sourceUploadId: source, maxCredits: expected })).body.id);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      await run(id, fakeBfl().deps, 4);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      /* Creative is dearer by its own rate, through the same path. */
      const dear = await admit({ sourceUploadId: source, mode: "creative", quoteOnly: true });
      expect(Number(dear.body.estimatedCredits)).toBeGreaterThan(expected);
      /* A failure refunds it. */
      const bad = String((await admit({ sourceUploadId: source, maxCredits: expected })).body.id);
      await run(bad, fakeBfl({ submitError: new BflError("BFL refused the request: no", 422, true) }).deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const source = await clip("credits_cap");
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const reply = await admit({ sourceUploadId: source, ...approved });
      expect(reply.status, JSON.stringify(reply.body)).toBe(429);
      expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
      expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
      expect((await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [capped] })).rows).toEqual([]);
      expect(deferred.length).toBe(handedOff);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("rule 11, the agent runs it: flux_upscale is listed over MCP only where the engine is on; a call is priced by the real door and prepared for a person in Ask and in Auto alike, never started by the caller; the caller cannot approve; a person's approval runs the very same job", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { admitBflUpscale } = await import("../../lib/bflUpscale");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const spend = async (value: string | null) => { if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin"); invalidateSettings(); };
  await asTenant(house(), async () => {
    await ready();
    const source = await clip("mcp");
    /* The agent's call goes to the real admission (the route's own function), as the caller; the prepared-jobs door is a stub that files and returns an id. */
    const seen: { path: string; body: Record<string, unknown> }[] = [];
    const call = async (p: string, init: { body?: unknown } = {}) => {
      const body = (init.body ?? {}) as Record<string, unknown>;
      seen.push({ path: p, body });
      if (p === "/api/prepared-jobs") return { job: { id: "prep_up1" } };
      const reply = await admitBflUpscale(body, OWNER, options());
      if (reply.status >= 400) throw new Error(String(reply.body.error));
      return reply.body;
    };
    delete process.env.BFL_ENABLED;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("flux_upscale");
    await expect(runDirectEngineTool("flux_upscale", { source_upload_id: source }, call)).rejects.toThrow("There is no such tool here.");
    process.env.BFL_ENABLED = "1";
    const listed = (await directEngineMcpTools()).find((t) => t.name === "flux_upscale")!;
    expect(listed).toBeTruthy();
    expect(listed.description).toContain("Faces and products may change.");
    expect(listed.description).toMatch(/Precise \(the default\)/);
    expect((listed.inputSchema as { required: string[] }).required).toEqual([]);
    try {
      for (const mode of [null, "ask", "auto"]) {
        await spend(mode); seen.length = 0;
        const handedOff = deferred.length;
        const text = await runDirectEngineTool("flux_upscale", { source_upload_id: source, factor: 2 }, call);
        expect(text, String(mode)).toMatch(/^Priced and prepared, not started\.\n\nprice: \$\d+\.\d\d\nprepared: FLUX Upscale \(precise, 2x\) of [\w-]+\nprepared job: prep_up1\n\nThis needs a person's approval: nothing was started or spent/);
        /* The quote, then the filing: no approval was ever sent, and nothing was queued. */
        expect(seen.map((s) => s.path)).toEqual(["/api/bfl", "/api/prepared-jobs"]);
        expect(seen[0].body).toMatchObject({ tool: "upscale", quoteOnly: true, sourceUploadId: source });
        expect(JSON.stringify(seen)).not.toMatch(/maxCredits/);
        expect(deferred.length).toBe(handedOff);
        expect(seen[1].body).toMatchObject({ engine: "flux_upscale", args: { tool: "upscale", sourceUploadId: source } });
      }
      /* Creative is asked for by name and the prepared line says so. */
      await spend("auto"); seen.length = 0;
      const creative = await runDirectEngineTool("flux_upscale", { source_upload_id: source, mode: "creative" }, call);
      expect(creative).toMatch(/prepared: FLUX Upscale \(creative, 2x\)/);
      expect(seen[0].body).toMatchObject({ mode: "creative" });
      for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) await expect(runDirectEngineTool("flux_upscale", { source_upload_id: source, ...bad }, call)).rejects.toThrow(/only a person approves/);
      /* A person approves it in Particl: the same body, at the price just quoted, and the job is the one the tool prepared. */
      await spend(null);
      const quote = await admitBflUpscale({ tool: "upscale", sourceUploadId: source, quoteOnly: true }, OWNER, options());
      const started = await admitBflUpscale({ tool: "upscale", sourceUploadId: source, maxCredits: Number(quote.body.estimatedCredits) }, OWNER, options());
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      await run(String(started.body.id), fakeBfl().deps, 4);
      expect(await gen(String(started.body.id))).toMatchObject({ status: "succeeded", model: "bfl/flux-upscale/precise" });
    } finally { await spend(null); }
  });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter submits, polls and fetches in process, with the network forbidden; the mock refuses on request", async () => {
  const { driveBflUpscale } = await import("../../lib/bflUpscale");
  process.env.BFL_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const source = await clip("mock");
      const id = String((await admit({ sourceUploadId: source, ...approved })).body.id);
      await driveBflUpscale(id, { budgetMs: 20_000, pauseMs: 0 });
      const done = await gen(id);
      expect(done).toMatchObject({ status: "succeeded", kind: "video" });
      made.push(path.join(process.cwd(), ".data", "generations", `${id}.mp4`));
      const refused = String((await admit({ sourceUploadId: source, prompt: "[[mock-refuse]] a harbour", ...approved })).body.id);
      await driveBflUpscale(refused, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(refused)).toMatchObject({ status: "failed" });
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

test("a take's public record keeps only its own words: no BFL job, polling address, figure, source id or prompt reaches a browser, a token or an export", async () => {
  const { publicDirectParams } = await import("../../lib/directEnginePublic");
  const params = {
    task: "bfl_upscale", job: "fix", sourceUploadId: "up_1", estUsd: 1.5, estCredits: 0,
    bflUpscale: { status: "done", mode: "creative", model: "bfl/flux-upscale/creative", factor: 2, steer: "a private prompt", source: { kind: "upload", id: "up_1" }, outputWidth: 3840, outputHeight: 2160, seconds: 5, reservedUsd: 1.5, statedUsd: 1.2, bflId: "vendor-job", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=vendor-job", reconcile: 1 },
  };
  expect(publicDirectParams(params).bflUpscale).toEqual({ status: "done", mode: "creative", model: "bfl/flux-upscale/creative", factor: 2, outputWidth: 3840, outputHeight: 2160, seconds: 5 });
  expect(JSON.stringify(publicDirectParams(params))).not.toMatch(/vendor-job|private prompt|1\.2|reservedUsd|pollingUrl/);
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: one door (/api/bfl) shared with FLUX.2 and behind the same sample-workspace wall, the seams stay internal, the reservation comes before the row and the submit, no new switch, no consent code, no hand-set price", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitBflUpscale\b/)).toEqual(["lib/bflUpscale.ts"]);
  expect(reachers(/\badvanceBflUpscaleWith\b/)).toEqual(["lib/bflUpscale.ts"]);
  expect(reachers(/@\/lib\/bflUpscale["']/)).toEqual(["app/api/bfl/route.ts"]);
  /* The door: FLUX Upscale is dispatched inside the existing route, after the same checks, so it is covered by the same sample-workspace wall and the same guard entries. */
  const route = readFileSync("app/api/bfl/route.ts", "utf8");
  expect(route.indexOf("sampleWorkspaceOff()")).toBeGreaterThan(route.indexOf("const admit ="));
  expect(route.indexOf("sampleWorkspaceOff()")).toBeLessThan(route.indexOf("withGenerationRequest(req"));
  expect(route.match(/export const POST/g)).toHaveLength(1);
  expect(readdirSync("app/api/bfl")).toEqual(["route.ts"]);
  const flow = readFileSync("lib/bflUpscale.ts", "utf8");
  const code = flow.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("admitBflUpscale(input, got, options)");
  expect(code).not.toMatch(/consent|rekognition|faceSha|castMember|faceCheck/i);
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.submit ?? submitUpscale)("));
  expect(at("(deps.fetchVideo ?? fetchVideoResult)(")).toBeLessThan(at("(deps.store ?? storeVideoBytes)("));
  expect(at("(deps.store ?? storeVideoBytes)(")).toBeLessThan(at('await settleBflUpscale(genId, "done"'));
  expect(flow).toContain("Math.min(Math.max(0, outcome.costUsd), up.reservedUsd)");
  /* The approver of a person's actor is the door's: an actor's role is asked only through the job line. */
  expect(flow).toContain("jobLineNow({ credits: estimatedCredits, usd, key: \"bfl\", actor: got, auto: options.run?.auto === true })");
  /* Prices come from the rate table and the margin path; none is written here. */
  expect(flow).toContain("quotedCredits(usd, model)");
  expect(code).not.toMatch(/0\.0\d+|0\.1\d+/);
  /* No new setting: BFL's key, base address and the one kill switch. */
  const adapter = readFileSync("lib/bfl.ts", "utf8");
  const names = new Set([...adapter.matchAll(/process\.env\.(BFL_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["BFL_API_KEY", "BFL_BASE_URL"]);
  expect(code).not.toMatch(/process\.env/);
  expect([...new Set(code.match(/"BFL_[A-Z_]+"/g))].sort()).toEqual(['"BFL_API_KEY"', '"BFL_ENABLED"']);
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  expect(adapter.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toContain("api.bfl.ai");
  expect(flow).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
  /* The Precise default and the Creative note live in one place each. */
  expect(flow).toContain('defaultMode');
  expect(flow).toContain('export const CREATIVE_NOTE = "Faces and products may change.";');
});
