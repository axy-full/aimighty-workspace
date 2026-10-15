import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * FLUX.2 through BFL (lib/bfl.ts, lib/bflImage.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seams `admitBfl` and
 * `advanceBflJobWith`, which the public route and the cron do not offer), or the in-process fixture under ENGINE_MOCK=1; no request leaves this process and no
 * provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-bfl-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.BFL_ENABLED; delete process.env.REKOGNITION_ENABLED; delete process.env.BFL_BASE_URL; process.env.ENGINE_MOCK = "1"; });

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

/** An image upload of this workspace, with a measured size. */
async function image(label: string, width = 1024, height = 1024): Promise<{ id: string; bytes: Buffer }> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const bytes = Buffer.from(`sample-image-${id}`);
  await storeUpload(id, "png", bytes, "image/png");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", bytes.length, "x", width, height, `uploads/${id}.png`, Date.now(), "image"] });
  return { id, bytes };
}
async function consent(projectId: string, subjectKey: string): Promise<string> {
  const { db } = await import("../../lib/db");
  const { consentsReady } = await import("../../lib/security/consent");
  await consentsReady();
  const id = uid("consent");
  await db().execute({
    sql: `INSERT INTO identity_consents (id, project_id, subject_key, subject_label, person_name, covers_face, covers_voice, uses_json, other_use, until_at, recording_id, attested, recorded_by, recorded_at, revoked_at)
          VALUES (?,?,?,?,?,1,0,?,'',?,?,1,'u_test',?,NULL)`,
    args: [id, projectId, subjectKey, "", "Sample Person", JSON.stringify(["production", "ads"]), Date.now() + 86_400_000, "rec_1", Date.now()],
  });
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
  const r = (await db().execute({ sql: "SELECT status,stored_url,bytes,cost_usd,error,provider_outcome,json_extract(params,'$.bfl') AS bfl FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { status: r.status, stored_url: r.stored_url, bytes: r.bytes, cost_usd: r.cost_usd, error: r.error, provider_outcome: r.provider_outcome, bfl: JSON.parse(String(r.bfl)) as import("../../lib/bflImage").BflParams };
}
const passing = (consentId: string) => async (_cast: string, face: Buffer) => ({ consentId, similarity: 99, matched: true as const, checkedAt: Date.now(), faceSha256: `sha_${face.length}` });
type Seams = { consent?: ReturnType<typeof passing> };
async function admit(input: Record<string, unknown>, seams: Seams = {}) {
  const { admitBfl } = await import("../../lib/bflImage");
  return admitBfl(input, OWNER, options(), seams);
}
const approved = { maxCredits: 100000 };

function fakeBfl(over: { readyAt?: number; fail?: string; submitError?: Error; fetchErrors?: number; storeError?: Error; stated?: number | null } = {}) {
  const calls: string[] = [];
  const sent: { references: Buffer[]; prompt: string; model: string; width: number; height: number; seed?: number }[] = [];
  let polls = 0, fetchErrors = over.fetchErrors ?? 0;
  const deps = {
    submit: async (input: { references: Buffer[]; prompt: string; model: string; width: number; height: number; seed?: number }) => {
      calls.push(`submit:${input.model}`); sent.push(input);
      if (over.submitError) throw over.submitError;
      return { id: "bfl_job_1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=bfl_job_1", statedUsd: over.stated ?? null };
    },
    poll: async () => { polls++; calls.push("poll"); if (over.fail) return { status: "failed" as const, failure: over.fail }; return polls < (over.readyAt ?? 2) ? { status: "pending" as const } : { status: "ready" as const, resultUrl: "https://delivery-eu.bfl.ai/out.png" }; },
    fetchImage: async () => { calls.push("fetch"); if (fetchErrors > 0) { fetchErrors--; throw new Error("the signed address did not answer"); } return Buffer.from("flux-image"); },
    store: async (genId: string, bytes: Buffer) => { if (over.storeError) { const e = over.storeError; over.storeError = undefined; throw e; } calls.push("store"); return { url: `stored/${genId}.png`, bytes: bytes.length }; },
  };
  return { deps, calls, sent };
}
async function run(genId: string, deps: ReturnType<typeof fakeBfl>["deps"] & { clock?: () => number }, times = 4) {
  const { advanceBflJobWith } = await import("../../lib/bflImage");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceBflJobWith(genId, deps);
  return last;
}

test("the prices are BFL's published ones, verified 16 Oct 2026, all three models by the megapixel with references counted; megapixels round up; nothing past 4 MP or 8 references", async () => {
  const { BFL_RATES } = await import("../../lib/vendorRates");
  const { bflQuote, megapixels } = await import("../../lib/bflImage");
  expect(BFL_RATES.creditUsd).toBe(0.01);
  expect(BFL_RATES.models["flux-2-pro"]).toEqual({ firstMp: 0.03, extraMp: 0.015, refMp: 0.015, maxMp: 4, maxRefs: 8 });
  expect(BFL_RATES.models["flux-2-flex"]).toEqual({ firstMp: 0.05, extraMp: 0.05, refMp: 0.05, maxMp: 4, maxRefs: 8 });
  expect(BFL_RATES.models["flux-2-max"]).toEqual({ firstMp: 0.07, extraMp: 0.03, refMp: 0.03, maxMp: 4, maxRefs: 8 });
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/Verified against BFL's published\s+\* pricing data, 16 Oct 2026; confirm against the first invoice[\s\S]{0,1400}export const BFL_RATES/);
  /* The plan's rows (docs/plans/provider-adapters.md § 6). */
  const usd = (model: "flux-2-pro" | "flux-2-flex" | "flux-2-max", out: number, refs: number[] = []) => { const q = bflQuote(model, out, refs); return "usd" in q ? q.usd : q.error; };
  expect(usd("flux-2-pro", 1)).toBeCloseTo(0.03, 6);
  expect(usd("flux-2-pro", 4)).toBeCloseTo(0.075, 6);
  expect(usd("flux-2-pro", 1, [1])).toBeCloseTo(0.045, 6);
  expect(usd("flux-2-pro", 1, [1, 1, 1, 1])).toBeCloseTo(0.09, 6);
  expect(usd("flux-2-pro", 1, [1, 1, 1, 1, 1, 1, 1, 1])).toBeCloseTo(0.15, 6);
  expect(usd("flux-2-flex", 1)).toBeCloseTo(0.05, 6);
  expect(usd("flux-2-flex", 4)).toBeCloseTo(0.05 + 3 * 0.05, 6);
  expect(usd("flux-2-flex", 1, [1])).toBeCloseTo(0.1, 6);
  expect(usd("flux-2-flex", 1, Array(8).fill(1))).toBeCloseTo(0.05 + 8 * 0.05, 6);
  expect(usd("flux-2-max", 1)).toBeCloseTo(0.07, 6);
  expect(usd("flux-2-max", 4)).toBeCloseTo(0.07 + 3 * 0.03, 6);
  expect(usd("flux-2-max", 2, [2, 1])).toBeCloseTo(0.07 + 0.03 + 3 * 0.03, 6);
  expect(usd("flux-2-max", 1, Array(8).fill(1))).toBeCloseTo(0.07 + 8 * 0.03, 6);
  /* Past the limits, every model refuses in words. */
  for (const model of ["flux-2-pro", "flux-2-flex", "flux-2-max"] as const) {
    expect(String(usd(model, 5)), model).toMatch(/up to 4/);
    expect(String(usd(model, 1, Array(9).fill(1))), model).toMatch(/up to 8/);
  }
  /* Megapixels round up, and a sub-megapixel is one. */
  expect([megapixels(1024, 1024), megapixels(1024, 960), megapixels(2048, 2048), megapixels(64, 64)]).toEqual([2, 1, 5, 1]);
});

test("the endpoint is the EU one by default, never the global address; a base address must be an https bfl.ai host; only bfl.ai addresses are ever followed; the key goes only to them", async () => {
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
    delete process.env.BFL_BASE_URL;
    expect(bfl.BFL_DEFAULT_BASE).toBe("https://api.eu.bfl.ai");
    expect(bfl.bflBase()).toBe("https://api.eu.bfl.ai");
    expect(bfl.bflBase()).not.toBe("https://api.bfl.ai");
    const refA = Buffer.from("reference-a"), refB = Buffer.from("reference-b");
    const sent = await bfl.submitImage({ model: "flux-2-pro", prompt: "a tree", width: 1024, height: 1024, seed: 7, references: [refA, refB] }, { fetch: reply(200, { id: "j1", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=j1", cost: 4.5 }) });
    expect(sent).toEqual({ id: "j1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=j1", statedUsd: 0.045 });
    /* The region that served the call: EU. */
    expect(new URL(calls[0].url).hostname).toBe("api.eu.bfl.ai");
    expect(calls[0]).toMatchObject({ url: "https://api.eu.bfl.ai/v1/flux-2-pro", method: "POST" });
    expect(calls[0].headers["x-key"]).toBe("test-bfl-key-not-real");
    expect(JSON.parse(calls[0].body)).toEqual({ prompt: "a tree", width: 1024, height: 1024, output_format: "png", seed: 7, input_image: refA.toString("base64"), input_image_2: refB.toString("base64") });
    /* A reply naming no job, or a polling address that is not bfl.ai, is a failure, never followed. */
    for (const bad of [{}, { id: "j", polling_url: "https://evil.example.com/poll" }, { id: "j", polling_url: "http://api.eu.bfl.ai/x" }, { id: "j", polling_url: "https://api.eu.bfl.ai.evil.com/x" }, { id: "j", polling_url: "https://user@api.eu.bfl.ai/x" }, { id: "j", polling_url: "https://api.eu.bfl.ai:8443/x" }])
      expect(await bfl.submitImage({ model: "flux-2-pro", prompt: "x", width: 64, height: 64, references: [] }, { fetch: reply(200, bad) }).then(() => null, (e) => e), JSON.stringify(bad)).toBeInstanceOf(bfl.BflError);
    /* Polling: only the address BFL named, only on bfl.ai; the key is sent there and nowhere else. */
    const count = calls.length;
    expect(await bfl.pollImage({ id: "j1", pollingUrl: "https://evil.example.com/poll" }, { fetch: reply(200, { status: "Ready" }) }).then(() => null, (e) => e)).toBeInstanceOf(bfl.BflError);
    expect(calls.length).toBe(count);
    for (const [word, want] of [["Pending", "pending"], ["Queued", "pending"], ["Task not found", "failed"], ["Error", "failed"], ["Failed", "failed"], ["Request Moderated", "failed"], ["Content Moderated", "failed"], ["Something New", "pending"]] as const)
      expect((await bfl.pollImage({ id: "j1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=j1" }, { fetch: reply(200, { status: word }) })).status, word).toBe(want);
    expect(await bfl.pollImage({ id: "j1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=j1" }, { fetch: reply(200, { status: "Ready", result: { sample: "https://delivery-eu.bfl.ai/o.png?sig=abc" } }) })).toEqual({ status: "ready", resultUrl: "https://delivery-eu.bfl.ai/o.png?sig=abc" });
    expect((await bfl.pollImage({ id: "j1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=j1" }, { fetch: reply(200, { status: "Ready", result: { sample: "https://evil.example.com/o.png" } }) })).status).toBe("failed");
    /* The result is fetched from a bfl.ai address, without our key. */
    const results = calls.length;
    expect((await bfl.fetchResult("https://delivery-eu.bfl.ai/o.png", { fetch: reply(200, "png-bytes") })).toString()).toBe("png-bytes");
    expect(calls.at(-1)!.headers["x-key"]).toBeUndefined();
    expect((await bfl.fetchResult("https://delivery-eu1.bfl.ai/o.png", { fetch: reply(200, "png-bytes") })).toString()).toBe("png-bytes");
    for (const bad of ["https://evil.example.com/o.png", "https://delivery-eu.bfl.ai.evil.com/o.png", "https://bfl.ai.evil.com/o.png", "http://delivery-eu.bfl.ai/o.png", "https://user@delivery-eu.bfl.ai/o.png"])
      expect(await bfl.fetchResult(bad, { fetch: reply(200, "x") }).then(() => null, (e) => e), bad).toBeInstanceOf(bfl.BflError);
    expect(calls.length).toBe(results + 2);
    /* No request follows a redirect (the key is a header, and undici forwards custom headers to another origin): each is sent with redirect "error", and a redirecting server's answer is a failure. */
    const seen: (string | undefined)[] = [];
    const redirecting = (async (_url: unknown, init?: RequestInit) => { seen.push(init?.redirect); if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect"); return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }); }) as never;
    expect(await bfl.submitImage({ model: "flux-2-pro", prompt: "x", width: 64, height: 64, references: [] }, { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(bfl.BflError);
    expect(await bfl.pollImage({ id: "j1", pollingUrl: "https://api.eu.bfl.ai/v1/get_result?id=j1" }, { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(bfl.BflError);
    expect(await bfl.fetchResult("https://delivery-eu.bfl.ai/o.png", { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(bfl.BflError);
    expect(seen).toEqual(["error", "error", "error"]);
    /* A refusal is a clear 4xx (a throttle included); a 408 and a 5xx may have taken the job. */
    for (const [status, early] of [[400, true], [402, true], [422, true], [429, true], [408, false], [500, false], [503, false]] as const) {
      const failed = await bfl.submitImage({ model: "flux-2-pro", prompt: "x", width: 64, height: 64, references: [] }, { fetch: reply(status, { detail: "nope" }) }).then(() => null, (e) => e);
      expect(failed.rejectedBeforeGeneration, String(status)).toBe(early);
    }
    expect(await bfl.submitImage({ model: "flux-2-pro", prompt: "x", width: 64, height: 64, references: [] }, { fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ rejectedBeforeGeneration: false });
    /* The base address, if set: an https bfl.ai host and nothing more. */
    process.env.BFL_BASE_URL = "https://api.us.bfl.ai";
    expect(bfl.bflBase()).toBe("https://api.us.bfl.ai");
    for (const bad of ["https://api.bfl.ai.evil.com", "http://api.bfl.ai", "https://evil.example.com", "http://127.0.0.1:9999", "https://api.bfl.ai/v1", "https://user@api.bfl.ai", "ftp://api.bfl.ai"]) {
      process.env.BFL_BASE_URL = bad;
      expect(() => bfl.bflBase(), bad).toThrow(/bfl\.ai/);
    }
    delete process.env.BFL_BASE_URL; delete process.env.BFL_API_KEY;
    const none = await bfl.submitImage({ model: "flux-2-pro", prompt: "x", width: 64, height: 64, references: [] }, { fetch: reply(200, {}) }).then(() => null, (e) => e);
    expect(String(none.message)).toContain("BFL_API_KEY");
  } finally { if (before === undefined) delete process.env.BFL_API_KEY; else process.env.BFL_API_KEY = before; }
});

test("off: with the switch off, or a workspace not on the list, there is no tool and nothing is metered; a listed customer is offered the still, and the edit only where its face gate can run", async () => {
  const { bflTools } = await import("../../lib/bflImage");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    delete process.env.BFL_ENABLED;
    expect(await bflTools()).toEqual([]);
    expect(await admit({ tool: "image", prompt: "a tree", ...approved })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    process.env.BFL_ENABLED = "1";
    expect((await bflTools()).map((t) => t.id)).toEqual(["flux2_image", "flux3_image"]);
    process.env.REKOGNITION_ENABLED = "1";
    const on = await bflTools();
    expect(on.map((t) => t.id)).toEqual(["flux2_image", "flux3_image", "flux2_edit"]);
    expect(on.every((t) => t.provider === "bfl" && t.route === "/api/bfl")).toBe(true);
    expect(on.filter((t) => t.id !== "flux3_image").every((t) => t.models.join() === "flux-2-pro,flux-2-flex,flux-2-max")).toBe(true);
    expect(on.find((t) => t.id === "flux3_image")!.models.join()).toBe("flux-3-image,flux-3-image-klein");
    expect((await meterRows()).length).toBe(before);
  });
  process.env.BFL_ENABLED = "1";
  await asTenant(tenant("ws_bfl_unlisted"), async () => {
    expect(await bflTools()).toEqual([]);
    expect(await admit({ tool: "image", prompt: "a tree", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote, and every input refused in words before anything is reserved; a quote writes nothing", async () => {
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const q = await admit({ tool: "image", prompt: "a tree in rain", quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { tool: "image", model: "flux-2-pro", width: 1024, height: 1024, megapixels: 2, references: 0, unit: "usd", estimatedCredits: 1 } });
    /* 1024 x 1024 is 1.05 MP: two megapixels at the whole-megapixel rule, $0.045 for [pro]. */
    expect(Number(q.body.price)).toBeCloseTo(0.045, 6);
    expect(await admit({ tool: "image", prompt: "a tree", width: 1024, height: 960, quoteOnly: true })).toMatchObject({ status: 200, body: { megapixels: 1 } });
    /* [flex] and [max] go to 4 MP like [pro]. */
    const max = await admit({ tool: "image", prompt: "a tree", model: "flux-2-max", width: 2000, height: 2000, quoteOnly: true });
    expect(max).toMatchObject({ status: 200, body: { megapixels: 4 } });
    expect(Number(max.body.price)).toBeCloseTo(0.07 + 3 * 0.03, 6);
    const flex = await admit({ tool: "image", prompt: "a tree", model: "flux-2-flex", width: 1024, height: 1024, quoteOnly: true });
    expect(Number(flex.body.price)).toBeCloseTo(0.05 + 0.05, 6);
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ tool: "video" }, /Pick image, edit or identity/],
      [{ tool: "image", prompt: "" }, /Write what to make/],
      [{ tool: "image", prompt: "x".repeat(5001) }, /5,000 characters/],
      [{ tool: "image", prompt: "a", model: "flux-3" }, /flux-2-pro, flux-2-flex, flux-2-max, flux-3-image or flux-3-image-klein/],
      [{ tool: "image", prompt: "a", width: 1000, height: 1024 }, /steps of 16/],
      [{ tool: "image", prompt: "a", width: 32, height: 1024 }, /from 64/],
      [{ tool: "image", prompt: "a", width: 2560, height: 2560 }, /up to 4 megapixels/],
      [{ tool: "image", prompt: "a", model: "flux-2-flex", width: 2560, height: 2560 }, /up to 4 megapixels/],
      [{ tool: "edit", prompt: "a", model: "flux-2-max", references: Array.from({ length: 9 }, (_, i) => ({ uploadId: `u${i}`, castMemberId: "c" })) }, /up to 8/],
      [{ tool: "image", prompt: "a", seed: -1 }, /seed/],
      [{ tool: "image", prompt: "a", references: [{ uploadId: "x", castMemberId: "c" }] }, /takes no references/],
      [{ tool: "edit", prompt: "a" }, /one to eight reference/],
      [{ tool: "edit", prompt: "a", references: Array.from({ length: 9 }, (_, i) => ({ uploadId: `u${i}`, castMemberId: "c" })) }, /up to 8/],
      [{ tool: "edit", prompt: "a", references: [{ uploadId: "../x", castMemberId: "c" }] }, /not valid/],
      [{ tool: "edit", prompt: "a", references: [{ uploadId: "up_not_here", castMemberId: "c" }] }, /image uploads/],
    ];
    for (const [input, words] of refused) {
      const reply = await admit({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    const ref = await image("ref");
    expect(await admit({ tool: "edit", prompt: "a", references: [{ uploadId: ref.id }], quoteOnly: true })).toMatchObject({ status: 400, body: { code: "bad-input" } });
    const ok = await admit({ tool: "edit", prompt: "a", references: [{ uploadId: ref.id, castMemberId: "cast_a" }], quoteOnly: true });
    expect(ok).toMatchObject({ status: 200, body: { tool: "edit", references: 1 } });
    /* 1 reference of 1024 x 1024: two megapixels of it, plus two of output. */
    expect(Number(ok.body.price)).toBeCloseTo(0.03 + 0.015 + 2 * 0.015, 6);
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(deferred.length);
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs and writes nothing", async () => {
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    for (const bad of [{}, { maxCredits: 0 }, { maxCredits: "5" }, { maxCredits: 1.5 }]) expect((await admit({ tool: "image", prompt: "a tree", ...bad })).status, JSON.stringify(bad)).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
  });
});

test("a still from words: submit, poll, fetch the moment it is Ready, store under the workspace, settle at the quote; the vendor's own figure when it states one, never above the quote", async () => {
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const handedOff = deferred.length;
    const reply = await admit({ tool: "image", prompt: "a crane at dawn", model: "flux-2-pro", seed: 11, projectId: undefined, ...approved });
    expect(reply.status).toBe(200);
    expect(deferred.length).toBe(handedOff + 1);
    const genId = String(reply.body.id);
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(0.045, 6);
    const vendor = fakeBfl();
    const bfl = await run(genId, vendor.deps, 4);
    expect(bfl).toMatchObject({ status: "done", settled: 1 });
    expect(vendor.calls).toEqual(["submit:flux-2-pro", "poll", "poll", "fetch", "store"]);
    expect(vendor.sent[0]).toMatchObject({ prompt: "a crane at dawn", width: 1024, height: 1024, seed: 11, references: [] });
    const take = await gen(genId);
    expect(take).toMatchObject({ status: "succeeded", stored_url: `stored/${genId}.png` });
    expect(Number(take.cost_usd)).toBeCloseTo(0.045, 6);
    const settled = (await meterRows()).slice(before);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo(0.045, 6);
    expect(Number(settled[0].billed_credits ?? 0)).toBe(0);
    /* No figure from BFL: settled at the quote and marked to reconcile. */
    expect(take.bfl.reconcile).toBe(1);
    /* Another step on a finished job does nothing. */
    const again = fakeBfl();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
    /* BFL states a figure: lower is the cost (nothing to reconcile); higher is billed at the quote, the excess recorded as the overrun and marked to reconcile. */
    for (const [stated, expected, over, reconcile] of [[0.03, 0.03, null, 0], [0.5, 0.045, 0.455, 1]] as const) {
      const id = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
      await run(id, fakeBfl({ stated }).deps, 4);
      const done = await gen(id);
      expect(Number(done.cost_usd), String(stated)).toBeCloseTo(expected, 6);
      expect(done.bfl.reconcile, String(stated)).toBe(reconcile);
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd), String(stated)).toBeCloseTo(expected, 6);
      if (over === null) expect(line.overrun_usd ?? null).toBeNull(); else expect(Number(line.overrun_usd)).toBeCloseTo(over, 6);
      expect(Number(line.billed_credits ?? 0)).toBe(0);
    }
  });
});

test("a failure bills nothing: an Error or a moderated job, a refusal before work (a throttle too), the person is told 'Nothing billed'; the ledger line records what BFL stated, or nothing marked to reconcile", async () => {
  const { BflError } = await import("../../lib/bfl");
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const failedBy = async (over: Parameters<typeof fakeBfl>[0]) => {
      const id = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
      const vendor = fakeBfl(over);
      await run(id, vendor.deps, 3);
      return { id, vendor, take: await gen(id) };
    };
    const moderated = await failedBy({ fail: "BFL's moderation stopped this." });
    expect(moderated.take.status).toBe("failed");
    expect(String(moderated.take.error)).toMatch(/Nothing was billed/);
    expect(Number(moderated.take.cost_usd)).toBe(0);
    expect(moderated.take.bfl.reconcile).toBe(1);
    expect(JSON.parse(String(moderated.take.provider_outcome))).toMatchObject({ provider: "bfl", stage: "run", billing: { state: "unknown" } });
    expect(moderated.vendor.calls).not.toContain("fetch");
    const throttled = await failedBy({ submitError: new BflError("BFL refused the request: too many active tasks", 429, true) });
    expect(throttled.take.status).toBe("failed");
    expect(JSON.parse(String(throttled.take.provider_outcome))).toMatchObject({ provider: "bfl", stage: "submit", code: "http_429" });
    const rows = (await meterRows()).slice(before);
    expect(rows.every((r) => r.status === "failed" && Number(r.engine_cost_usd) === 0 && Number(r.billed_credits ?? 0) === 0)).toBe(true);
    /* BFL stated a cost for the job and then failed or moderated it: recorded at that cost on the ledger line, billed to nobody, nothing to reconcile. */
    const charged = await failedBy({ fail: "BFL's moderation stopped this.", stated: 0.03 });
    expect(charged.take.status).toBe("failed");
    expect(String(charged.take.error)).toMatch(/Nothing was billed/);
    expect(Number(charged.take.cost_usd)).toBeCloseTo(0.03, 6);
    expect(charged.take.bfl.reconcile).toBe(0);
    const line = (await meterRows()).find((r) => r.id === charged.id)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(0.03, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* Never above the quote on a failure either: a stated cost past it is recorded at the quote, the excess as the overrun, and marked to reconcile. */
    const over = await failedBy({ fail: "BFL's moderation stopped this.", stated: 0.5 });
    const overLine = (await meterRows()).find((r) => r.id === over.id)!;
    expect(Number(overLine.engine_cost_usd)).toBeCloseTo(0.045, 6);
    expect(Number(overLine.overrun_usd)).toBeCloseTo(0.455, 6);
    expect(over.take.bfl.reconcile).toBe(1);
  });
});

test("a lost acknowledgement is never sent again, and a job that never got to its submit settles at nothing", async () => {
  const { BflError } = await import("../../lib/bfl");
  const { recoverBflJobs, advanceBflJobWith } = await import("../../lib/bflImage");
  const { db } = await import("../../lib/db");
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const id = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
    const lost = fakeBfl({ submitError: new BflError("BFL did not answer.") });
    expect(await run(id, lost.deps, 1)).toMatchObject({ status: "uncertain", settled: 0 });
    expect(String((await gen(id)).error)).toMatch(/will not be sent again/);
    expect((await meterRows()).find((r) => r.id === id)).toMatchObject({ status: "running" });
    const again = fakeBfl();
    await run(id, again.deps, 3);
    await recoverBflJobs({ limit: 50 }, again.deps);
    expect(again.calls).toEqual([]);
    /* A claim older than the grace with no job id: if it never reached the instant before the request it never sent anything, and settles at nothing; if it did, it is a lost acknowledgement, held. */
    for (const [sendingAt, want] of [[null, "failed"], [1, "uncertain"]] as const) {
      const id2 = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.bfl.claimedAt',1,'$.bfl.sendingAt',?) WHERE id=?", args: [sendingAt, id2] });
      const vendor = fakeBfl();
      expect(await advanceBflJobWith(id2, { ...vendor.deps, clock: () => Date.now() + 3_600_000 }), String(sendingAt)).toMatchObject({ status: want });
      expect(vendor.calls).toEqual([]);
      expect((await meterRows()).find((r) => r.id === id2)).toMatchObject({ status: want === "failed" ? "failed" : "running" });
    }
  });
});

test("the ten minutes: an image that is Ready is fetched at once; a fetch that fails is retried while its address lives; past the window it is lost, recorded at what BFL charged, billed to nobody, and said so", async () => {
  const { BFL_RESULT_LIFETIME_MS } = await import("../../lib/bfl");
  expect(BFL_RESULT_LIFETIME_MS).toBe(10 * 60_000);
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    /* The first fetch fails, the next pass finds it Ready again and fetches: still in time. */
    const a = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
    const flaky = fakeBfl({ readyAt: 1, fetchErrors: 1 });
    const { advanceBflJobWith } = await import("../../lib/bflImage");
    await expect(advanceBflJobWith(a, flaky.deps)).rejects.toThrow();
    expect((await gen(a)).status).toBe("running");
    expect((await gen(a)).bfl.readyAt).not.toBeNull();
    await run(a, flaky.deps, 2);
    expect((await gen(a)).status).toBe("succeeded");
    /* Never fetched in time: the clock moves past the ten minutes since Ready. */
    const b = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
    const dead = fakeBfl({ readyAt: 1, fetchErrors: 99 });
    await expect(advanceBflJobWith(b, dead.deps)).rejects.toThrow();
    const late = await advanceBflJobWith(b, { ...dead.deps, clock: () => Date.now() + BFL_RESULT_LIFETIME_MS });
    expect(late).toMatchObject({ status: "failed", settled: 1 });
    const lost = await gen(b);
    expect(lost.status).toBe("failed");
    expect(String(lost.error)).toMatch(/could not be saved in time\. Nothing was billed/);
    /* BFL made it (Ready), so it charged: recorded at the quote (it stated none), billed to nobody, marked to reconcile. */
    expect(Number(lost.cost_usd)).toBeCloseTo(0.045, 6);
    expect(lost.bfl.reconcile).toBe(1);
    expect((await meterRows()).find((r) => r.id === b)).toMatchObject({ status: "failed" });
    expect(Number((await meterRows()).find((r) => r.id === b)!.engine_cost_usd)).toBeCloseTo(0.045, 6);
    expect(Number((await meterRows()).find((r) => r.id === b)!.billed_credits ?? 0)).toBe(0);
    /* When BFL stated the cost it is that figure, with nothing to reconcile. */
    const c = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
    const statedDead = fakeBfl({ readyAt: 1, fetchErrors: 99, stated: 0.03 });
    await expect(advanceBflJobWith(c, statedDead.deps)).rejects.toThrow();
    await advanceBflJobWith(c, { ...statedDead.deps, clock: () => Date.now() + BFL_RESULT_LIFETIME_MS });
    expect(Number((await meterRows()).find((r) => r.id === c)!.engine_cost_usd)).toBeCloseTo(0.03, 6);
    expect((await gen(c)).bfl.reconcile).toBe(0);
  });
});

test("two workers at once submit once; a storage failure keeps the job and the next pass finishes it", async () => {
  const { advanceBflJobWith } = await import("../../lib/bflImage");
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const id = String((await admit({ tool: "image", prompt: "a crane", ...approved })).body.id);
    const vendor = fakeBfl({ readyAt: 1, storeError: new Error("storage is busy") });
    await Promise.allSettled([advanceBflJobWith(id, vendor.deps), advanceBflJobWith(id, vendor.deps)]);
    expect(vendor.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
    await run(id, vendor.deps, 3);
    expect((await gen(id)).status).toBe("succeeded");
    expect(vendor.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
  });
});

test("an edit: every reference passes the consent gate before a row or a cent; the references go up as data; the take's record names them by id and by their hash only", async () => {
  const { db } = await import("../../lib/db");
  const { rowToGeneration } = await import("../../lib/jobs");
  process.env.BFL_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await project(projectId);
    const consentId = await consent(projectId, cast);
    const a = await image("ref_a"), b = await image("ref_b", 2000, 1000);
    const input = { tool: "edit", prompt: "put this product on her", references: [{ uploadId: a.id, castMemberId: cast }, { uploadId: b.id, castMemberId: cast }], projectId, use: "production", ...approved };
    /* The real gate refuses today (no consent record holds a face reference): nothing is created or reserved. */
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const real = await admit(input);
    expect(real).toMatchObject({ status: 409, body: { code: "no-reference" } });
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
    /* A missing production or use is refused before the gate. */
    let faceCalls = 0;
    const seams = { consent: async (...x: Parameters<ReturnType<typeof passing>>) => { faceCalls++; return passing(consentId)(...x); } };
    expect((await admit({ ...input, use: undefined }, seams)).status).toBe(400);
    expect((await admit({ ...input, projectId: undefined }, seams)).status).toBe(400);
    expect(faceCalls).toBe(0);
    /* Passing the gate (a seam): both references were checked, then the job runs and sends them as data. */
    const reply = await admit(input, seams);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(faceCalls).toBe(2);
    const genId = String(reply.body.id);
    const vendor = fakeBfl();
    await run(genId, vendor.deps, 4);
    expect(vendor.sent[0].references.map((r) => r.toString())).toEqual([a.bytes.toString(), b.bytes.toString()]);
    const take = await gen(genId);
    expect(take.status).toBe("succeeded");
    /* Quoted: 2 MP out ((1024x1024 rounds up to 2) + the references at 2 MP and 2 MP: (1024x1024 -> 2, 2000x1000 -> 2)). */
    expect(Number(take.cost_usd)).toBeCloseTo(0.03 + 0.015 + (2 + 2) * 0.015, 6);
    expect(take.bfl.references.map((r) => [r.uploadId, r.castMemberId, r.consentId])).toEqual([[a.id, cast, consentId], [b.id, cast, consentId]]);
    expect(JSON.stringify(take.bfl)).not.toMatch(/base64|sample-image/);
    /* A person reads none of that. */
    const raw = (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [genId] })).rows[0];
    const read = rowToGeneration({ ...raw, project_name: null }) as unknown as { params: Record<string, unknown> };
    expect(read.params.bfl).toEqual({ status: "done", tool: "edit", model: "flux-2-pro", width: 1024, height: 1024, outputMegapixels: 2 });
    expect(JSON.stringify(read.params.bfl)).not.toMatch(/bfl_job_1|polling|consent|faceSha|cast_|up_|ref_a|usd|statedUsd|seed|references/i);
    /* Consent withdrawn while the job waited: nothing is sent, nothing is billed. */
    const second = String((await admit(input, seams)).body.id);
    await db().execute({ sql: "UPDATE identity_consents SET revoked_at=? WHERE id=?", args: [Date.now(), consentId] });
    const idle = fakeBfl();
    await run(second, idle.deps, 2);
    expect(idle.calls).toEqual([]);
    expect(await gen(second)).toMatchObject({ status: "failed" });
    expect(String((await gen(second)).error)).toMatch(/consent no longer holds/);
    expect(Number((await gen(second)).cost_usd)).toBe(0);
  });
  /* A customer workspace on the list is offered the still, and an edit there is refused at the gate (the face check is the house's only). */
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  await platformReady();
  const ws = "ws_bfl_edit_listed";
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)", args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`] });
  await grantCredits(ws, 500, "Test", "owner", "manual");
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [ws] })] });
    await asTenant((await getWorkspace(ws))!, async () => {
      const projectId = uid("prod");
      await project(projectId);
      const ref = await image("ref_c");
      const refused = await admit({ tool: "edit", prompt: "a", references: [{ uploadId: ref.id, castMemberId: "cast_x" }], projectId, use: "production", ...approved });
      expect(refused).toMatchObject({ status: 403, body: { code: "off" } });
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("a listed customer workspace pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db, ready } = await import("../../lib/db");
  const { BflError } = await import("../../lib/bfl");
  await platformReady();
  const listed = "ws_bfl_listed", capped = "ws_bfl_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.BFL_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const expected = billCredits(0.045, "flux-2-pro");
      expect(await admit({ tool: "image", prompt: "a crane", quoteOnly: true })).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ tool: "image", prompt: "a crane", maxCredits: expected - 1 })).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      const id = String((await admit({ tool: "image", prompt: "a crane", maxCredits: expected })).body.id);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      await run(id, fakeBfl().deps, 4);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      /* A failure refunds it. */
      const bad = String((await admit({ tool: "image", prompt: "a crane", maxCredits: expected })).body.id);
      await run(bad, fakeBfl({ submitError: new BflError("BFL refused the request: no", 422, true) }).deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const reply = await admit({ tool: "image", prompt: "a crane", ...approved });
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

test("over MCP: flux2_image is listed only where the engine is on, flux2_edit only where its face gate can run; Ask prepares and starts nothing, Auto starts only at or under the per-job line, the caller cannot approve", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const { jobApprovalLineCredits } = await import("../../lib/approvalRule");
  const { creditUsd } = await import("../../lib/creditTerms");
  const line = jobApprovalLineCredits(creditUsd());
  const spend = async (value: string | null) => { if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin"); invalidateSettings(); };
  let credits = 1;
  const calls: Record<string, unknown>[] = [];
  const call = async (_p: string, init: { body?: unknown } = {}) => { const body = init.body as Record<string, unknown>; calls.push(body); if (_p === "/api/prepared-jobs") return { job: { id: "prep_f1" } }; return body.quoteOnly === true ? { estimatedCredits: credits, price: credits / 100, unit: "usd" } : { id: "gen_f1" }; };
  await asTenant(house(), async () => {
    await ready();
    delete process.env.BFL_ENABLED;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("flux2_image");
    await expect(runDirectEngineTool("flux2_image", { prompt: "a tree" }, call)).rejects.toThrow("There is no such tool here.");
    process.env.BFL_ENABLED = "1";
    expect((await directEngineMcpTools()).map((t) => t.name)).toEqual(expect.arrayContaining(["flux2_image"]));
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("flux2_edit");
    try {
      /* Ask (the default, and anything but an exact "auto"): priced and prepared, nothing sent. */
      for (const mode of [null, "ask", "AUTO"]) {
        await spend(mode); calls.length = 0;
        const text = await runDirectEngineTool("flux2_image", { prompt: "a tree", width: 512, height: 512 }, call);
        expect(text, String(mode)).toMatch(/^Priced and prepared, not started\.\n\nprice: \$0\.01\nprepared: flux-2-pro still, 512 by 512\nprepared job: prep_f1\n\nThis needs a person's approval: nothing was started or spent/);
        /* Filed for a person through the prepared-jobs door, and its id returned. */
        expect(text, String(mode)).toContain("prepared job: prep_f1");
        expect(calls.map((c) => [c.quoteOnly === true, c.maxCredits ?? null])).toEqual([[true, null], [false, null]]);
        expect(calls[1]).toMatchObject({ engine: "flux2_image", args: { tool: "image", width: 512, height: 512 } });
        expect(JSON.stringify(calls[1])).not.toMatch(/maxCredits|quoteOnly/i);
      }
      /* Auto: at or under the line it starts at the server's price; above it (guardrail 4) it asks a person. */
      await spend("auto");
      /* Auto runs only a draft (flux-2-pro); flex and max are full quality and always ask. */
      for (const model of ["flux-2-flex", "flux-2-max"]) {
        credits = 1; calls.length = 0;
        expect(await runDirectEngineTool("flux2_image", { prompt: "a tree", model }, call), model).toMatch(/not started[\s\S]*prepared job: prep_f1[\s\S]*needs a person's approval/);
        expect(calls.some((c) => c.maxCredits !== undefined)).toBe(false);
      }
      for (const c of [1, line]) {
        credits = c; calls.length = 0;
        expect(await runDirectEngineTool("flux2_image", { prompt: "a tree", width: 512, height: 512 }, call), String(c)).toMatch(/^Image started\.\n\nid: gen_f1/);
        expect(calls.map((x) => [x.quoteOnly === true, x.maxCredits ?? null, x.tool])).toEqual([[true, null, "image"], [false, c, "image"]]);
      }
      for (const c of [line + 1, 900]) {
        credits = c; calls.length = 0;
        expect(await runDirectEngineTool("flux2_image", { prompt: "a tree" }, call), String(c)).toMatch(/not started[\s\S]*needs a person's approval/);
        expect(calls).toHaveLength(2);
      }
      credits = 1;
      for (const mode of ["ask", "auto"]) {
        await spend(mode); calls.length = 0;
        for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) await expect(runDirectEngineTool("flux2_image", { prompt: "a tree", ...bad }, call)).rejects.toThrow(/only a person approves/);
        expect(calls).toEqual([]);
      }
      await spend(null);
      process.env.REKOGNITION_ENABLED = "1";
      expect((await directEngineMcpTools()).map((t) => t.name)).toContain("flux2_edit");
      calls.length = 0;
      const prepared = await runDirectEngineTool("flux2_edit", { prompt: "swap", reference_upload_ids: "u1, u2", cast_member_ids: "c1,c2", project_id: "p", use: "production" }, call);
      expect(calls[0]).toMatchObject({ tool: "edit", references: [{ uploadId: "u1", castMemberId: "c1" }, { uploadId: "u2", castMemberId: "c2" }], quoteOnly: true });
      expect(prepared).toMatch(/prepared: flux-2-pro edit of 2 reference\(s\) for production p/);
      /* The references (ids only) are kept in the filed job: nested lists are taken by the prepared-jobs door. */
      expect(prepared).toContain("prepared job: prep_f1");
      expect(calls.find((c) => c.engine === "flux2_edit")).toMatchObject({ args: { tool: "edit", references: [{ uploadId: "u1", castMemberId: "c1" }, { uploadId: "u2", castMemberId: "c2" }] } });
      /* When the door will not take it, the answer says plainly that nothing was filed. */
      const refusing = async (_p: string, init: { body?: unknown } = {}) => { if (_p === "/api/prepared-jobs") throw new Error("Inside a list or group an argument is an id, not text or a file."); return (await call(_p, init)) as Record<string, unknown>; };
      const unfiled = await runDirectEngineTool("flux2_edit", { prompt: "swap", reference_upload_ids: "u1", cast_member_ids: "c1", project_id: "p", use: "production" }, refusing);
      expect(unfiled).toMatch(/^Priced, not started\.[\s\S]*Nothing was filed: Inside a list or group an argument is an id[\s\S]*A person can make this themselves in Particl/);
      expect(unfiled).not.toMatch(/prepared job:|waits in Particl/);
      await expect(runDirectEngineTool("flux2_edit", { prompt: "swap", reference_upload_ids: "u1,u2", cast_member_ids: "c1", project_id: "p", use: "production" }, call)).rejects.toThrow(/one cast member for each reference/);
    } finally { await spend(null); }
  });
});

test("FLUX 3 Image and Klein: priced per image by size tier (BFL's table, verified 16 Oct 2026), the longest side rounded up to the next tier, a stills-from-words engine with no references, refused past 4096", async () => {
  const { BFL_RATES } = await import("../../lib/vendorRates");
  const { flux3Quote } = await import("../../lib/bflImage");
  const rows = (m: "flux-3-image" | "flux-3-image-klein") => BFL_RATES.tiered[m].tiers.map((t) => [t.upTo, t.usd]);
  expect(rows("flux-3-image")).toEqual([[768, 0.041], [1024, 0.048], [1536, 0.07], [2048, 0.1], [4096, 0.607]]);
  expect(rows("flux-3-image-klein")).toEqual([[768, 0.008], [1024, 0.009], [1536, 0.011], [2048, 0.014], [4096, 0.036]]);
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/erified against\s+\* BFL's published pricing data \(docs\.bfl\.ai\/quick_start\/pricing\), 16 Oct 2026; confirm against the first invoice[\s\S]{0,1800}tiered:/);
  const usd = (m: "flux-3-image" | "flux-3-image-klein", w: number, h: number) => { const q = flux3Quote(m, w, h); return "usd" in q ? q.usd : q.error; };
  /* The longest side decides, rounded UP to the next tier: one pixel over a tier is the next tier's price. */
  for (const [side, tier] of [[64, 0], [768, 0], [769, 1], [1024, 1], [1025, 2], [1536, 2], [1537, 3], [2048, 3], [2049, 4], [4096, 4]] as const) {
    expect(usd("flux-3-image", side, 64), `${side}`).toBeCloseTo(BFL_RATES.tiered["flux-3-image"].tiers[tier].usd, 9);
    expect(usd("flux-3-image-klein", 64, side), `${side}`).toBeCloseTo(BFL_RATES.tiered["flux-3-image-klein"].tiers[tier].usd, 9);
  }
  expect(usd("flux-3-image", 1920, 1080)).toBeCloseTo(0.1, 9);
  expect(String(usd("flux-3-image", 4112, 1024))).toMatch(/up to 4096 pixels on a side/);
  expect(usd("flux-3-image-klein", 1024, 1024)).toBeLessThan(usd("flux-3-image", 1024, 1024) as number);
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const q = await admit({ tool: "image", prompt: "a tree", model: "flux-3-image", width: 1024, height: 1024, quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { tool: "image", model: "flux-3-image", unit: "usd", references: 0 } });
    expect(Number(q.body.price)).toBeCloseTo(0.048, 9);
    const klein = await admit({ tool: "image", prompt: "a tree", model: "flux-3-image-klein", width: 2048, height: 1152, quoteOnly: true });
    expect(Number(klein.body.price)).toBeCloseTo(0.014, 9);
    expect(Number((await admit({ tool: "image", prompt: "a tree", model: "flux-3-image", width: 4096, height: 2304, quoteOnly: true })).body.price)).toBeCloseTo(0.607, 9);
    /* No megapixel rule for FLUX 3 (the size is the tier), and nothing past 4096 a side. */
    for (const [input, words] of [
      [{ tool: "image", prompt: "a", model: "flux-3-image", width: 4112, height: 1024 }, /up to 4096 pixels on a side/],
      [{ tool: "edit", prompt: "a", model: "flux-3-image", references: [{ uploadId: "u1", castMemberId: "c" }] }, /use FLUX\.2 for an edit or an identity/],
      [{ tool: "identity", prompt: "a", model: "flux-3-image-klein", identityId: "idn", castMemberId: "c" }, /no such tool|use FLUX\.2/],
      [{ tool: "image", prompt: "a", model: "flux-3-image", references: [{ uploadId: "u1", castMemberId: "c" }] }, /takes no references/],
    ] as [Record<string, unknown>, RegExp][]) {
      const reply = await admit({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    expect((await meterRows()).length).toBe(before);
    /* The whole job: reserved at the tier price, submitted at /v1/flux-3-image, settled at it; the reservation is the quote. */
    const reply = await admit({ tool: "image", prompt: "a crane at dawn", model: "flux-3-image-klein", width: 1024, height: 1024, ...approved });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const held = (await meterRows()).slice(before);
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(0.009, 9);
    const vendor = fakeBfl();
    await run(String(reply.body.id), vendor.deps, 4);
    expect(vendor.calls[0]).toBe("submit:flux-3-image-klein");
    expect(Number((await gen(String(reply.body.id))).cost_usd)).toBeCloseTo(0.009, 9);
  });
  /* The path: the adapter posts to /v1/<model>. */
  const bfl = await import("../../lib/bfl");
  delete process.env.ENGINE_MOCK;
  const before = process.env.BFL_API_KEY;
  try {
    process.env.BFL_API_KEY = "test-bfl-key-not-real";
    const seen: string[] = [];
    const f = (async (url: unknown) => { seen.push(String(url)); return new Response(JSON.stringify({ id: "j", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=j" }), { status: 200 }); }) as never;
    for (const model of ["flux-3-image", "flux-3-image-klein"] as const) await bfl.submitImage({ model, prompt: "x", width: 1024, height: 1024, references: [] }, { fetch: f });
    expect(seen).toEqual(["https://api.eu.bfl.ai/v1/flux-3-image", "https://api.eu.bfl.ai/v1/flux-3-image-klein"]);
  } finally { process.env.ENGINE_MOCK = "1"; if (before === undefined) delete process.env.BFL_API_KEY; else process.env.BFL_API_KEY = before; }
});

/** An identity of this workspace: a row with its photos (uploads of known size), as the legacy identity trainer keeps them. */
async function identityWith(photoCount: number, over: { noPhotos?: boolean } = {}) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const photos: { id: string; bytes: Buffer }[] = [];
  for (let i = 0; i < photoCount; i++) photos.push(await image(`photo_${i}`));
  const id = uid("idn");
  await db().execute({ sql: "INSERT INTO identities (id, name, photos, status, provider, created_by, created_at, updated_at) VALUES (?,?,?,'draft','fal','u_test',?,?)", args: [id, `Sample ${id}`, JSON.stringify(over.noPhotos ? [] : photos.map((p) => p.id)), Date.now(), Date.now()] });
  return { id, photos };
}

test("FLUX.2 identity: an identity's own photos are the references, every one through the consent gate, behind a switch of its own; the fal LoRA path is not touched", async () => {
  const { db } = await import("../../lib/db");
  const { bflTools } = await import("../../lib/bflImage");
  const { rowToGeneration } = await import("../../lib/jobs");
  process.env.BFL_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await project(projectId);
    const consentId = await consent(projectId, cast);
    const idn = await identityWith(3);
    const input = { tool: "identity", prompt: "her on a train platform at dusk", identityId: idn.id, castMemberId: cast, projectId, use: "production", ...approved };
    /* Its own switch: off, the tool is not here and not listed, whatever BFL_ENABLED says. */
    delete process.env.BFL_IDENTITY_ENABLED;
    expect(await admit(input)).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    expect((await bflTools()).map((t) => t.id)).not.toContain("flux2_identity");
    for (const value of ["0", "true", "yes", ""]) { process.env.BFL_IDENTITY_ENABLED = value; expect((await admit(input)).status, value).toBe(404); }
    process.env.BFL_IDENTITY_ENABLED = "1";
    expect((await bflTools()).map((t) => t.id)).toContain("flux2_identity");
    delete process.env.REKOGNITION_ENABLED;
    expect((await bflTools()).map((t) => t.id)).not.toContain("flux2_identity");
    process.env.REKOGNITION_ENABLED = "1";
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    /* The real gate refuses today (no consent record holds a face reference): nothing is created or reserved. */
    expect(await admit(input)).toMatchObject({ status: 409, body: { code: "no-reference" } });
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
    /* Words first: no identity, no cast member, no production or use, a hand-supplied reference list, an unknown or empty identity. */
    let faceCalls = 0;
    const seen: string[] = [];
    const seams = { consent: async (c: string, face: Buffer) => { faceCalls++; seen.push(c); return passing(consentId)(c, face); } };
    for (const bad of [{ identityId: undefined }, { identityId: "../x" }, { castMemberId: undefined }, { use: undefined }, { projectId: undefined }, { references: [{ uploadId: idn.photos[0].id, castMemberId: cast }] }]) {
      expect((await admit({ ...input, ...bad }, seams)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await admit({ ...input, identityId: "idn_not_here" }, seams)).toMatchObject({ status: 404 });
    const empty = await identityWith(0, { noPhotos: true });
    expect(await admit({ ...input, identityId: empty.id }, seams)).toMatchObject({ status: 404 });
    expect(faceCalls).toBe(0);
    /* The quote is an edit's: the identity's photos are the references. */
    const quote = await admit({ ...input, quoteOnly: true });
    expect(quote).toMatchObject({ status: 200, body: { tool: "identity", references: 3, needs: ["castMemberId", "projectId", "use"] } });
    expect(Number(quote.body.price)).toBeCloseTo(0.03 + 0.015 + 3 * 2 * 0.015, 6);
    expect((await meterRows()).length).toBe(before);
    /* Passing the gate: EVERY photo was checked, for the cast member named, then the photos go up as data in the identity's order. */
    const reply = await admit(input, seams);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(faceCalls).toBe(3);
    expect(seen).toEqual([cast, cast, cast]);
    const genId = String(reply.body.id);
    const vendor = fakeBfl();
    await run(genId, vendor.deps, 4);
    expect(vendor.sent[0].references.map((r) => r.toString())).toEqual(idn.photos.map((p) => p.bytes.toString()));
    const take = await gen(genId);
    expect(take.status).toBe("succeeded");
    expect(take.bfl).toMatchObject({ tool: "edit", identityId: idn.id });
    expect(take.bfl.references.map((r) => [r.uploadId, r.castMemberId, r.consentId])).toEqual(idn.photos.map((p) => [p.id, cast, consentId]));
    /* A person reads none of it: not the identity, the photos, the cast or the consent. */
    const raw = (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [genId] })).rows[0];
    const read = rowToGeneration({ ...raw, project_name: null }) as unknown as { params: Record<string, unknown> };
    expect(read.params.bfl).toEqual({ status: "done", tool: "edit", model: "flux-2-pro", width: 1024, height: 1024, outputMegapixels: 2 });
    expect(JSON.stringify(read.params.bfl)).not.toMatch(/idn_|identityId|up_|photo_|cast_|consent/i);
    /* At most eight photos are used, cover first. */
    const big = await identityWith(11);
    faceCalls = 0;
    const eight = await admit({ ...input, identityId: big.id }, seams);
    expect(eight.status, JSON.stringify(eight.body)).toBe(200);
    expect(faceCalls).toBe(8);
    const v2 = fakeBfl();
    await run(String(eight.body.id), v2.deps, 4);
    expect(v2.sent[0].references.map((r) => r.toString())).toEqual(big.photos.slice(0, 8).map((p) => p.bytes.toString()));
    /* A photo the gate refuses stops everything: no row, no reservation. */
    const { ConsentMatchError } = await import("../../lib/consentMatch");
    const rowsNow = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const meterNow = (await meterRows()).length;
    let n = 0;
    const second = { consent: async (c: string, face: Buffer) => { if (++n === 2) throw new ConsentMatchError("no-match", "This face doesn't look like the person who gave consent. A person needs to look at it.", 409); return passing(consentId)(c, face); } };
    expect(await admit(input, second)).toMatchObject({ status: 409, body: { code: "no-match" } });
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(rowsNow);
    expect((await meterRows()).length).toBe(meterNow);
  });
  /* The fal LoRA identity path is untouched: this PR adds no reference to it. */
  const flow = readFileSync("lib/bflImage.ts", "utf8");
  expect(flow).not.toMatch(/from "\.\/identities"|from "\.\/fal"|flux-lora|loraUrl/);
  expect(flow).toContain('"SELECT photos FROM identities WHERE id=? LIMIT 1"');
});

test("over MCP: flux3_image (Klein is the draft, flux-3-image always asks) and flux2_identity (listed only on its own switch, with the face gate)", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const spend = async (value: string | null) => { if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin"); invalidateSettings(); };
  const calls: Record<string, unknown>[] = [];
  const call = async (_p: string, init: { body?: unknown } = {}) => { const body = init.body as Record<string, unknown>; calls.push(body); if (_p === "/api/prepared-jobs") return { job: { id: "prep_f3" } }; return body.quoteOnly === true ? { estimatedCredits: 1, price: 0.01, unit: "usd" } : { id: "gen_f3" }; };
  process.env.BFL_ENABLED = "1";
  await asTenant(house(), async () => {
    await ready();
    const names = async () => (await directEngineMcpTools()).map((t) => t.name);
    delete process.env.REKOGNITION_ENABLED; delete process.env.BFL_IDENTITY_ENABLED;
    expect(await names()).toEqual(expect.arrayContaining(["flux2_image", "flux3_image"]));
    expect(await names()).not.toContain("flux2_identity");
    process.env.REKOGNITION_ENABLED = "1";
    expect(await names()).not.toContain("flux2_identity");
    process.env.BFL_IDENTITY_ENABLED = "1";
    expect(await names()).toContain("flux2_identity");
    try {
      await spend("auto");
      calls.length = 0;
      expect(await runDirectEngineTool("flux3_image", { prompt: "a tree", model: "flux-3-image" }, call)).toMatch(/not started[\s\S]*prepared job: prep_f3/);
      expect(calls.some((c) => c.maxCredits !== undefined)).toBe(false);
      calls.length = 0;
      expect(await runDirectEngineTool("flux3_image", { prompt: "a tree", model: "flux-3-image-klein" }, call)).toMatch(/^Image started/);
      expect(calls.map((c) => [c.quoteOnly === true, c.maxCredits ?? null, c.tool, c.model])).toEqual([[true, null, "image", "flux-3-image-klein"], [false, 1, "image", "flux-3-image-klein"]]);
      calls.length = 0;
      expect(await runDirectEngineTool("flux3_image", { prompt: "a tree" }, call)).toMatch(/not started/);
      expect(calls[0]).toMatchObject({ model: "flux-3-image" });
      await spend("ask");
      calls.length = 0;
      const text = await runDirectEngineTool("flux2_identity", { prompt: "her at dusk", identity_id: "idn_1", cast_member_id: "c1", project_id: "p", use: "production" }, call);
      expect(text).toMatch(/prepared: flux-2-pro still of identity idn_1 for production p[\s\S]*prepared job: prep_f3/);
      expect(calls[0]).toMatchObject({ tool: "identity", identityId: "idn_1", castMemberId: "c1", projectId: "p", use: "production", quoteOnly: true });
      expect(calls.some((c) => c.maxCredits !== undefined)).toBe(false);
    } finally { await spend(null); }
  });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter submits, polls and fetches in process, with the network forbidden", async () => {
  const { driveBfl } = await import("../../lib/bflImage");
  process.env.BFL_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const id = String((await admit({ tool: "image", prompt: "a crane at dawn", ...approved })).body.id);
      await driveBfl(id, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(id)).toMatchObject({ status: "succeeded" });
      made.push(path.join(process.cwd(), ".data", "generations", `${id}.png`));
      const refused = String((await admit({ tool: "image", prompt: "[[mock-refuse]] a crane", ...approved })).body.id);
      await driveBfl(refused, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(refused)).toMatchObject({ status: "failed" });
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: the seams stay internal, the route is the one door, consent and the reservation come before the row and the submit, the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitBfl\b/)).toEqual(["lib/bflImage.ts"]);
  expect(reachers(/\badvanceBflJobWith\b/)).toEqual(["lib/bflImage.ts"]);
  expect(reachers(/@\/lib\/bflImage["']/)).toEqual(["app/api/bfl/route.ts"]);
  const flow = readFileSync("lib/bflImage.ts", "utf8");
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("admitBfl(input, got, options, {})");
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeGreaterThan(0);
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeLessThan(at("INSERT INTO generations"));
  expect(at("Approve the price first")).toBeLessThan(at("(seams.consent ?? requireConsentMatch)("));
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.submit ?? submitImage)("));
  /* The image is fetched, stored and settled in that order; settled never above the quote. */
  expect(at("(deps.fetchImage ?? fetchResult)(")).toBeLessThan(at("(deps.store ?? storeImageBytes)("));
  expect(at("(deps.store ?? storeImageBytes)(")).toBeLessThan(at('await settleBfl(genId, "done"'));
  expect(flow).toContain("Math.min(Math.max(0, outcome.costUsd), bfl.reservedUsd)");
  /* Prices come from the rate table and the margin path. */
  expect(flow).toContain("quotedCredits(usd, model)");
  expect(flow).not.toMatch(/0\.0\d+|0\.1\d+/);
  const adapter = readFileSync("lib/bfl.ts", "utf8");
  const names = new Set([...adapter.matchAll(/process\.env\.(BFL_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["BFL_API_KEY", "BFL_BASE_URL"]);
  expect(adapter).toContain('export const BFL_SWITCH = "BFL_ENABLED";');
  expect(adapter).toContain('export const BFL_DEFAULT_BASE = "https://api.eu.bfl.ai";');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  expect(adapter.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toContain("api.bfl.ai");
  /* No new table: the job lives in the take's own row. */
  expect(flow).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
});
