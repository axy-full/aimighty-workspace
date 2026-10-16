import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * Recraft (lib/recraft.ts, lib/recraftImage.ts, lib/recraftMcp.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seam
 * `advanceRecraftJobWith`, which the public route and the cron do not offer), a fake `fetch` for the adapter itself, or the in-process fixture under ENGINE_MOCK=1; no request leaves this process
 * and no provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-recraft-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.RECRAFT_ENABLED; delete process.env.RECRAFT_BASE_URL; process.env.ENGINE_MOCK = "1"; });

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

/** A real PNG upload of this workspace (sources are measured), of the given size. */
async function image(label: string, width = 512, height = 512): Promise<{ id: string; bytes: Buffer }> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  const sharp = (await import("sharp")).default;
  await ready();
  const id = uid(label);
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#808080" } }).png().toBuffer();
  await storeUpload(id, "png", bytes, "image/png");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", bytes.length, "x", width, height, `uploads/${id}.png`, Date.now(), "image"] });
  return { id, bytes };
}
async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
async function meterRows() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute("SELECT id,workspace_id,status,engine_cost_usd,overrun_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='recraft' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT status,kind,stored_url,bytes,cost_usd,error,provider_outcome,json_extract(params,'$.recraft') AS recraft FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { status: r.status, kind: r.kind, stored_url: r.stored_url, bytes: r.bytes, cost_usd: r.cost_usd, error: r.error, provider_outcome: r.provider_outcome, recraft: JSON.parse(String(r.recraft)) as import("../../lib/recraftImage").RecraftParams };
}
async function admit(input: Record<string, unknown>) {
  const { executeRecraftAdmission } = await import("../../lib/recraftImage");
  return executeRecraftAdmission(input, OWNER, options());
}
const approved = { maxCredits: 100000 };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

type Fake = { error?: Error; bytes?: Buffer; stated?: number | null; storeError?: Error };
function fakeRecraft(over: Fake = {}) {
  const calls: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const reply = async (name: string, input: Record<string, unknown>) => {
    calls.push(name); sent.push(input);
    if (over.error) throw over.error;
    return { bytes: over.bytes ?? PNG, units: over.stated == null ? null : Math.round(over.stated * 1000), statedUsd: over.stated ?? null };
  };
  const deps = {
    generate: (input: never) => reply("generate", input),
    removeBackground: (input: never) => reply("removeBackground", input),
    vectorize: (input: never) => reply("vectorize", input),
    store: async (genId: string, bytes: Buffer) => { if (over.storeError) throw over.storeError; calls.push("store"); return { url: `stored/${genId}.png`, bytes: bytes.length }; },
  };
  return { deps, calls, sent };
}
async function run(genId: string, deps: ReturnType<typeof fakeRecraft>["deps"] & { clock?: () => number }, times = 2) {
  const { advanceRecraftJobWith } = await import("../../lib/recraftImage");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceRecraftJobWith(genId, deps as never);
  return last;
}

test("the prices are Recraft's published ones, verified 16 Oct 2026; the quote is the model's or the tool's rate, to the micro-dollar, and goes through the margin table", async () => {
  const { RECRAFT_RATES } = await import("../../lib/vendorRates");
  const { recraftQuoteUsd, recraftModelOf } = await import("../../lib/recraftImage");
  expect(RECRAFT_RATES.confirmed).toBe(true);
  expect(RECRAFT_RATES.styleCreationUsd).toBe(0.005);
  expect(RECRAFT_RATES.unitUsd).toBe(0.001);
  expect(recraftQuoteUsd("image", "recraftv4_1")).toBeCloseTo(0.035, 6);
  expect(recraftQuoteUsd("image", "recraftv4_1_pro")).toBeCloseTo(0.21, 6);
  expect(recraftQuoteUsd("image", "recraftv4_1_vector")).toBeCloseTo(0.08, 6);
  expect(recraftQuoteUsd("image", "recraftv4_1_pro_vector")).toBeCloseTo(0.3, 6);
  expect(recraftQuoteUsd("vectorize", "recraftv4_1")).toBeCloseTo(0.01, 6);
  expect(recraftQuoteUsd("remove_background", "recraftv4_1")).toBeCloseTo(0.01, 6);
  expect(recraftModelOf("image", "recraftv4_1_pro")).toBe("recraftv4_1_pro");
  expect(recraftModelOf("remove_background", "recraftv4_1")).toBe("recraft_remove_background");
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/Verified against Recraft's pricing\s+\* page, 16 Oct 2026[\s\S]{0,1400}export const RECRAFT_RATES/);
});

test("the adapter: Recraft's own host by default; a base address must be an https recraft.ai host; the key goes only in the header; no redirect is followed; a failure is one request, never repeated", async () => {
  const rc = await import("../../lib/recraft");
  delete process.env.ENGINE_MOCK;
  const calls: { url: string; headers: Record<string, string>; body: unknown; redirect?: string }[] = [];
  const reply = (status: number, json: unknown) => (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body, redirect: init?.redirect });
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as never;
  const before = process.env.RECRAFT_API_KEY;
  try {
    process.env.RECRAFT_API_KEY = "test-recraft-key-not-real";
    delete process.env.RECRAFT_BASE_URL;
    expect(rc.RECRAFT_DEFAULT_BASE).toBe("https://external.api.recraft.ai/v1");
    expect(rc.recraftBase()).toBe("https://external.api.recraft.ai/v1");
    for (const bad of ["http://external.api.recraft.ai/v1", "https://evil.example/v1", "https://recraft.ai.evil.example/v1", "https://user:pw@external.api.recraft.ai/v1", "https://external.api.recraft.ai:8443/v1", "https://external.api.recraft.ai/v1?x=1"]) {
      process.env.RECRAFT_BASE_URL = bad;
      expect(() => rc.recraftBase(), bad).toThrow(/https address on recraft\.ai/);
    }
    process.env.RECRAFT_BASE_URL = "https://eu.api.recraft.ai/v2/";
    expect(rc.recraftBase()).toBe("https://eu.api.recraft.ai/v2");
    delete process.env.RECRAFT_BASE_URL;
    expect(rc.recraftHostUrl("https://external.api.recraft.ai/x")?.hostname).toBe("external.api.recraft.ai");
    expect(rc.recraftHostUrl("https://notrecraft.ai/x")).toBeNull();
    expect(rc.recraftHostUrl("ftp://recraft.ai/x")).toBeNull();

    /* A still: one JSON request, the key as a Bearer header only, the image read from b64_json, the stated units turned into dollars. */
    const out = await rc.generateImage({ model: "recraftv4_1", prompt: "a heron", size: "1024x1024", style: "digital_illustration" }, { fetch: reply(200, { data: [{ b64_json: PNG.toString("base64") }], credits: 35 }) });
    expect(out.bytes.equals(PNG)).toBe(true);
    expect(out).toMatchObject({ units: 35 });
    expect(out.statedUsd).toBeCloseTo(0.035, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://external.api.recraft.ai/v1/images/generations");
    expect(calls[0].redirect).toBe("error");
    expect(calls[0].headers.authorization).toBe("Bearer test-recraft-key-not-real");
    expect(String(calls[0].body)).not.toContain("test-recraft-key-not-real");
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ model: "recraftv4_1", prompt: "a heron", size: "1024x1024", n: 1, response_format: "b64_json", image_format: "png", style: "digital_illustration" });
    /* No stated units: nothing is invented. */
    expect(await rc.generateImage({ model: "recraftv4_1", prompt: "a", size: "1024x1024" }, { fetch: reply(200, { data: [{ b64_json: PNG.toString("base64") }] }) })).toMatchObject({ units: null, statedUsd: null });
    /* The tools take the source as a file upload and ask for b64_json. */
    calls.length = 0;
    await rc.removeBackground({ bytes: PNG, filename: "a.png", mime: "image/png" }, { fetch: reply(200, { image: { b64_json: PNG.toString("base64") } }) });
    expect(calls[0].url).toBe("https://external.api.recraft.ai/v1/images/removeBackground");
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect((calls[0].body as FormData).get("response_format")).toBe("b64_json");
    expect(calls[0].headers["content-type"]).toBeUndefined();
    /* A reply without an image, a refusal (4xx: before work), a timeout or a server error (5xx: may have worked) are each one request, never repeated. */
    for (const [status, json, before_] of [[200, {}, false], [422, { message: "bad size" }, true], [429, "{}", true], [408, "{}", false], [500, "{}", false], [503, { error: "busy" }, false]] as const) {
      calls.length = 0;
      const err = await rc.generateImage({ model: "recraftv4_1", prompt: "a", size: "1024x1024" }, { fetch: reply(status, json) }).catch((e) => e);
      expect(err, String(status)).toBeInstanceOf(rc.RecraftError);
      expect(err.rejectedBeforeGeneration, String(status)).toBe(status === 200 ? false : before_);
      expect(calls, String(status)).toHaveLength(1);
      expect(String(err.message)).not.toContain("test-recraft-key-not-real");
    }
    const dropped = await rc.generateImage({ model: "recraftv4_1", prompt: "a", size: "1024x1024" }, { fetch: (async () => { throw new TypeError("redirect mode is set to error"); }) as never }).catch((e) => e);
    expect(dropped).toBeInstanceOf(rc.RecraftError);
    expect(dropped.rejectedBeforeGeneration).toBe(false);
    /* A reply is bounded before it is decoded. The longest base64 text is 64 MB of image times 4/3; a declared length over the reply cap is refused without reading a byte. */
    expect(rc.RECRAFT_B64_LIMIT).toBe(Math.ceil((64 * 1024 * 1024 * 4) / 3));
    const asked = { model: "recraftv4_1" as const, prompt: "a", size: "1024x1024" };
    let pulls = 0, cancelled = false;
    const streamed = (headers: Record<string, string>, chunks: number) => (async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (pulls++ >= chunks) c.close(); else c.enqueue(new Uint8Array(16 * 1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers })) as never;
    const declared = await rc.generateImage(asked, { fetch: streamed({ "content-length": String(rc.RECRAFT_B64_LIMIT + 64 * 1024 + 1) }, 100) }).catch((e) => e);
    expect(declared).toBeInstanceOf(rc.RecraftError);
    expect(declared.unusableReply).toBe(true);
    expect(declared.rejectedBeforeGeneration).toBe(false);
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
    /* No declared length: the stream is counted and cancelled the moment it passes the cap, not read to its end. */
    pulls = 0; cancelled = false;
    const counted = await rc.generateImage(asked, { fetch: streamed({}, 100) }).catch((e) => e);
    expect(counted.unusableReply).toBe(true);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
    /* A base64 text longer than the limit is refused before it is decoded. */
    const spy = Buffer.from.bind(Buffer);
    let decoded = 0;
    (Buffer as unknown as { from: unknown }).from = (...a: unknown[]) => { if (a[1] === "base64") decoded++; return (spy as (...x: unknown[]) => Buffer)(...a); };
    try {
      const huge = JSON.stringify({ data: [{ b64_json: "A".repeat(rc.RECRAFT_B64_LIMIT + 1) }] });
      const big = await rc.generateImage(asked, { fetch: (async () => new Response(huge, { status: 200 })) as never }).catch((e) => e);
      expect(big.unusableReply).toBe(true);
      expect(String(big.message)).toMatch(/too large/);
      expect(decoded).toBe(0);
    } finally { (Buffer as unknown as { from: unknown }).from = spy; }
    /* A 200 with no image, an empty one or text that is not JSON is the same: unusable, never uncertain. An error status stays what it was. */
    for (const body of ["{}", '{"data":[{"b64_json":""}]}', "<html>oops</html>"]) {
      const bad = await rc.generateImage(asked, { fetch: reply(200, body) }).catch((e) => e);
      expect(bad.unusableReply, body).toBe(true);
    }
    for (const status of [422, 500]) expect((await rc.generateImage(asked, { fetch: reply(status, "{}") }).catch((e) => e)).unusableReply, String(status)).toBe(false);
    delete process.env.RECRAFT_API_KEY;
    await expect(rc.generateImage({ model: "recraftv4_1", prompt: "a", size: "1024x1024" }, { fetch: reply(200, {}) })).rejects.toThrow(/RECRAFT_API_KEY/);
  } finally { if (before === undefined) delete process.env.RECRAFT_API_KEY; else process.env.RECRAFT_API_KEY = before; }
});

test("off: with the switch off, or a workspace not on the list, there is no tool and nothing is metered; a listed customer is offered the still and the background tool, never the SVG one", async () => {
  const { recraftTools } = await import("../../lib/recraftImage");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    delete process.env.RECRAFT_ENABLED;
    expect(await recraftTools()).toEqual([]);
    expect(await admit({ tool: "image", prompt: "a tree", ...approved })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    expect(await admit({ tool: "vectorize", sourceUploadId: "x", ...approved })).toMatchObject({ status: 404 });
    process.env.RECRAFT_ENABLED = "1";
    const on = await recraftTools();
    expect(on.map((t) => t.id)).toEqual(["recraft_image", "recraft_remove_background", "recraft_vectorize"]);
    expect(on.every((t) => t.provider === "recraft" && t.route === "/api/recraft")).toBe(true);
    expect(on.filter((t) => t.unavailable).map((t) => t.id)).toEqual(["recraft_vectorize"]);
    expect((await meterRows()).length).toBe(before);
  });
  process.env.RECRAFT_ENABLED = "1";
  await asTenant(tenant("ws_recraft_unlisted"), async () => {
    expect(await recraftTools()).toEqual([]);
    expect(await admit({ tool: "image", prompt: "a tree", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote, and every input refused in words before anything is reserved; a quote writes nothing; SVG output is refused in words, before anything is written or reserved", async () => {
  process.env.RECRAFT_ENABLED = "1";
  const { db } = await import("../../lib/db");
  const { SVG_REFUSAL } = await import("../../lib/recraftImage");
  await asTenant(house(), async () => {
    const src = await image("src");
    const before = (await meterRows()).length;
    const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const gens = await rows();
    const q = await admit({ tool: "image", prompt: "a tree in rain", quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { tool: "image", model: "recraftv4_1", size: "1024x1024", unit: "usd" } });
    expect(Number(q.body.price)).toBeCloseTo(0.035, 6);
    const pro = await admit({ tool: "image", prompt: "a tree", model: "recraftv4_1_pro", quoteOnly: true });
    expect(Number(pro.body.price)).toBeCloseTo(0.21, 6);
    const cut = await admit({ tool: "remove_background", sourceUploadId: src.id, quoteOnly: true });
    expect(cut).toMatchObject({ status: 200, body: { tool: "remove_background", model: "recraft_remove_background", size: "512x512" } });
    expect(Number(cut.body.price)).toBeCloseTo(0.01, 6);
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ tool: "video" }, /Pick image, remove_background or vectorize/],
      [{ tool: "image", prompt: "" }, /Write what to make/],
      [{ tool: "image", prompt: "x".repeat(1001) }, /1,000 characters/],
      [{ tool: "image", prompt: "a", model: "recraftv9" }, /Pick recraftv4_1/],
      [{ tool: "image", prompt: "a", size: "3x3" }, /Pick a size/],
      [{ tool: "image", prompt: "a", style: "Bad Style!" }, /name of lower-case letters/],
      [{ tool: "image", prompt: "a", references: [{ uploadId: "u" }] }, /not offered yet/],
      [{ tool: "remove_background" }, /Pick one still/],
      [{ tool: "remove_background", sourceUploadId: src.id, sourceGenId: "g" }, /Pick one still/],
      [{ tool: "remove_background", sourceUploadId: "../x" }, /not valid/],
      [{ tool: "remove_background", sourceUploadId: "up_not_here" }, /not in this workspace/],
    ];
    for (const [input, words] of refused) {
      const reply = await admit({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    const small = await image("small", 128, 128);
    expect(await admit({ tool: "remove_background", sourceUploadId: small.id, quoteOnly: true })).toMatchObject({ status: 400 });
    /* An SVG request is refused for every route to one, quote or approval, with the stated reason, before a row, a hold or a handoff. */
    const handedOff = deferred.length;
    for (const input of [{ tool: "vectorize", sourceUploadId: src.id }, { tool: "image", prompt: "a", model: "recraftv4_1_vector" }, { tool: "image", prompt: "a", model: "recraftv4_1_pro_vector" }]) {
      for (const extra of [{ quoteOnly: true }, approved]) {
        const reply = await admit({ ...input, ...extra });
        expect(reply, JSON.stringify(input)).toMatchObject({ status: 422, body: { code: "svg-sanitiser-missing", error: SVG_REFUSAL } });
      }
    }
    expect((await meterRows()).length).toBe(before);
    expect(await rows()).toBe(gens);
    expect(deferred.length).toBe(handedOff);
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs and writes nothing", async () => {
  process.env.RECRAFT_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    for (const bad of [{}, { maxCredits: 0 }, { maxCredits: "5" }, { maxCredits: 1.5 }, { maxCredits: -1 }]) expect((await admit({ tool: "image", prompt: "a tree", ...bad })).status, JSON.stringify(bad)).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
  });
});

test("a still from words: one request, the image stored under the workspace, settled at the quote; the reply's own units when it states them, never above the quote", async () => {
  process.env.RECRAFT_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const handedOff = deferred.length;
    const reply = await admit({ tool: "image", prompt: "a heron at dusk", style: "digital_illustration", ...approved });
    expect(reply.status).toBe(200);
    expect(deferred.length).toBe(handedOff + 1);
    const genId = String(reply.body.id);
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(0.035, 6);
    const vendor = fakeRecraft();
    const out = await run(genId, vendor.deps, 3);
    expect(out).toMatchObject({ status: "done", settled: 1 });
    /* One request however many passes. */
    expect(vendor.calls).toEqual(["generate", "store"]);
    expect(vendor.sent[0]).toMatchObject({ model: "recraftv4_1", prompt: "a heron at dusk", size: "1024x1024", style: "digital_illustration" });
    const take = await gen(genId);
    expect(take).toMatchObject({ status: "succeeded", kind: "image", stored_url: `stored/${genId}.png` });
    expect(Number(take.cost_usd)).toBeCloseTo(0.035, 6);
    const settled = (await meterRows()).slice(before);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo(0.035, 6);
    /* No figure stated: settled at the quote and marked to reconcile. */
    expect(take.recraft.reconcile).toBe(1);
    const again = fakeRecraft();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
    /* A stated figure: lower is the cost (nothing to reconcile); higher is billed at the quote, the excess recorded as the overrun and marked to reconcile. */
    for (const [stated, expected, over, reconcile] of [[0.02, 0.02, null, 0], [0.5, 0.035, 0.465, 1]] as const) {
      const id = String((await admit({ tool: "image", prompt: "a heron", ...approved })).body.id);
      await run(id, fakeRecraft({ stated }).deps, 2);
      const done = await gen(id);
      expect(Number(done.cost_usd), String(stated)).toBeCloseTo(expected, 6);
      expect(done.recraft.reconcile, String(stated)).toBe(reconcile);
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd), String(stated)).toBeCloseTo(expected, 6);
      if (over === null) expect(line.overrun_usd ?? null).toBeNull(); else expect(Number(line.overrun_usd)).toBeCloseTo(over, 6);
    }
  });
});

test("a failure bills nothing: a refusal before work says 'Nothing billed'; an image Recraft made but Particl could not keep is recorded at what it charged, billed to nobody", async () => {
  const { RecraftError } = await import("../../lib/recraft");
  const { MOCK_RECRAFT_SVG } = await import("../../lib/recraft");
  process.env.RECRAFT_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const failedBy = async (over: Fake) => {
      const id = String((await admit({ tool: "image", prompt: "a heron", ...approved })).body.id);
      const vendor = fakeRecraft(over);
      await run(id, vendor.deps, 2);
      return { id, vendor, take: await gen(id) };
    };
    const refused = await failedBy({ error: new RecraftError("Recraft refused the request: nope", 422, true) });
    expect(refused.take.status).toBe("failed");
    expect(String(refused.take.error)).toMatch(/Nothing was billed/);
    expect(Number(refused.take.cost_usd)).toBe(0);
    expect(refused.vendor.calls).toEqual(["generate"]);
    expect(JSON.parse(String(refused.take.provider_outcome))).toMatchObject({ provider: "recraft" });
    expect((await meterRows()).find((r) => r.id === refused.id)).toMatchObject({ status: "failed" });
    expect(Number((await meterRows()).find((r) => r.id === refused.id)!.engine_cost_usd)).toBe(0);
    /* A reply that is not a picture we keep (an SVG is never stored): charged by Recraft, recorded at the quote, billed to nobody, marked to reconcile. */
    const svg = await failedBy({ bytes: Buffer.from(MOCK_RECRAFT_SVG) });
    expect(svg.take.status).toBe("failed");
    expect(svg.take.stored_url ?? null).toBeNull();
    expect(svg.vendor.calls).toEqual(["generate"]);
    expect(Number(svg.take.cost_usd)).toBeCloseTo(0.035, 6);
    expect(svg.take.recraft.reconcile).toBe(1);
    /* A 200 whose reply held no image we can keep (none, too large, unreadable) is the same, not "uncertain": the answer came, so it is charged, recorded at the quote, billed to nobody, marked to reconcile, and never sent again. */
    const noImage = await failedBy({ error: Object.assign(new RecraftError("Recraft's reply held no image.", 200, false, true)) });
    expect(noImage.take.status).toBe("failed");
    expect(noImage.take.recraft.status).toBe("failed");
    expect(String(noImage.take.error)).toMatch(/Nothing was billed/);
    expect(noImage.take.recraft.reconcile).toBe(1);
    expect(Number(noImage.take.cost_usd)).toBeCloseTo(0.035, 6);
    const noImageLine = (await meterRows()).find((r) => r.id === noImage.id)!;
    expect(noImageLine).toMatchObject({ status: "failed" });
    expect(Number(noImageLine.engine_cost_usd)).toBeCloseTo(0.035, 6);
    expect(Number(noImageLine.billed_credits ?? 0)).toBe(0);
    expect(noImage.vendor.calls).toEqual(["generate"]);
    /* A store that keeps failing after Recraft answered: the same, at the stated figure when there is one. */
    const lost = await failedBy({ storeError: new Error("storage is busy"), stated: 0.03 });
    expect(lost.take.status).toBe("failed");
    expect(String(lost.take.error)).toMatch(/could not be saved\. Nothing was billed/);
    expect(Number(lost.take.cost_usd)).toBeCloseTo(0.03, 6);
    expect(lost.take.recraft.reconcile).toBe(0);
    const line = (await meterRows()).find((r) => r.id === lost.id)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(0.03, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    expect((await meterRows()).slice(before).every((r) => Number(r.billed_credits ?? 0) === 0)).toBe(true);
  });
});

test("the shot cap is judged at the press, as the fal path judges it: a member past the shot's cap is refused 403 with no row and no hold; an admin is not", async () => {
  process.env.RECRAFT_ENABLED = "1";
  const { setSetting } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  await asTenant(house(), async () => {
    await ready();
    await project("p_recraft_cap");
    const shotId = uid("shot");
    await db().execute({ sql: "INSERT INTO shots(id,project_id,code,created_at,updated_at) VALUES(?,?,'SH020',1,1)", args: [shotId, "p_recraft_cap"] });
    const member: AdmissionActor = { user: { ...OWNER.user, id: "member_1", role: "member", owner: false } as AdmissionActor["user"] };
    const { runInTenant } = await import("../../lib/tenant");
    const { executeRecraftAdmission: admitRecraft } = await import("../../lib/recraftImage");
    const asMember = (fn: () => Promise<void>) => runInTenant(house(), fn, member as never);
    try {
      await setSetting("approvalRule", "cap", "admin");
      await setSetting("shotCapCredits", "1", "admin");
      const before = (await meterRows()).length;
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const input = { tool: "image", prompt: "a heron", model: "recraftv4_1_pro", shotId, ...approved };
      await asMember(async () => {
        const refused = await admitRecraft(input, member, options());
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body).toMatchObject({ needsAdmin: true });
        expect(String(refused.body.error)).toMatch(/SH020/);
        expect((await admitRecraft({ ...input, quoteOnly: true }, member, options())).status).toBe(403);
      });
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
      expect((await meterRows()).length).toBe(before);
      expect(deferred.length).toBe(handedOff);
      /* An admin is a PERSON here: an admin's token, an agent identity and an Atomik Auto run do not skip the cap (the same test as the job line's). */
      const admin = OWNER.user;
      const nonPeople: [string, AdmissionActor, AdmissionExecution][] = [
        ["token", { user: admin, token: { id: "tok_cap", name: "cap", scope: "render", capUsd: null } }, options()],
        ["agent", { user: { ...admin, id: "agent:atomik" } as AdmissionActor["user"] }, options()],
        ["auto", OWNER, { ...options(), run: { auto: true } as never }],
      ];
      for (const [name, actor, opts] of nonPeople) {
        await runInTenant(house(), async () => {
          const refused = await admitRecraft(input, actor, opts);
          expect(refused.status, `${name}: ${JSON.stringify(refused.body)}`).toBe(403);
          expect(refused.body, name).toMatchObject({ needsAdmin: true });
        }, actor as never);
      }
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
      expect((await meterRows()).length).toBe(before);
      expect((await admitRecraft(input, OWNER, options())).status).toBe(200);
      await setSetting("shotCapCredits", "100000", "admin");
      await asMember(async () => { expect((await admitRecraft(input, member, options())).status).toBe(200); });
    } finally { await setSetting("approvalRule", "anyone", "admin"); }
  });
});

test("a lost reply is never sent again, and a job that never got to its request settles at nothing; two workers at once send once", async () => {
  const { RecraftError } = await import("../../lib/recraft");
  const { recoverRecraftJobs, advanceRecraftJobWith } = await import("../../lib/recraftImage");
  const { db } = await import("../../lib/db");
  process.env.RECRAFT_ENABLED = "1";
  await asTenant(house(), async () => {
    const id = String((await admit({ tool: "image", prompt: "a lost heron", ...approved })).body.id);
    const lost = fakeRecraft({ error: new RecraftError("Recraft did not answer.") });
    expect(await run(id, lost.deps, 1)).toMatchObject({ status: "uncertain", settled: 0 });
    expect(String((await gen(id)).error)).toMatch(/will not be sent again/);
    expect((await meterRows()).find((r) => r.id === id)).toMatchObject({ status: "running" });
    const again = fakeRecraft();
    await run(id, again.deps, 3);
    await recoverRecraftJobs({ limit: 50 }, again.deps as never);
    /* Other queued jobs of this shared test database may be sent by the cron pass; this one never is. */
    expect(again.sent.filter((x) => x.prompt === "a lost heron")).toEqual([]);
    for (const [sendingAt, want] of [[null, "failed"], [1, "uncertain"]] as const) {
      const id2 = String((await admit({ tool: "image", prompt: "a heron", ...approved })).body.id);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.recraft.claimedAt',1,'$.recraft.sendingAt',?) WHERE id=?", args: [sendingAt, id2] });
      const vendor = fakeRecraft();
      expect(await advanceRecraftJobWith(id2, { ...vendor.deps, clock: () => Date.now() + 3_600_000 } as never), String(sendingAt)).toMatchObject({ status: want });
      expect(vendor.calls).toEqual([]);
      expect((await meterRows()).find((r) => r.id === id2)).toMatchObject({ status: want === "failed" ? "failed" : "running" });
    }
    const id3 = String((await admit({ tool: "image", prompt: "a heron", ...approved })).body.id);
    const vendor = fakeRecraft();
    await Promise.allSettled([advanceRecraftJobWith(id3, vendor.deps as never), advanceRecraftJobWith(id3, vendor.deps as never)]);
    await run(id3, vendor.deps, 2);
    expect(vendor.calls.filter((c) => c === "generate")).toHaveLength(1);
    expect((await gen(id3)).status).toBe("succeeded");
    /* The cron sends a funded job whose request never went out, once. */
    const id4 = String((await admit({ tool: "image", prompt: "a heron", ...approved })).body.id);
    const cron = fakeRecraft();
    await recoverRecraftJobs({ limit: 50 }, cron.deps as never);
    await recoverRecraftJobs({ limit: 50 }, cron.deps as never);
    expect(cron.calls.filter((c) => c === "generate").length).toBeGreaterThanOrEqual(1);
    expect((await gen(id4)).status).toBe("succeeded");
  });
});

test("remove background: the still is read from this workspace and sent as data; no face or consent check is made (the owner took matching out); the take is linked to its original", async () => {
  process.env.RECRAFT_ENABLED = "1";
  const { db } = await import("../../lib/db");
  await asTenant(house(), async () => {
    const src = await image("person");
    /* No face check, in any state of the switch, and a caller's cast fields are not read. */
    process.env.REKOGNITION_ENABLED = "1";
    const ok = await admit({ tool: "remove_background", sourceUploadId: src.id, castMemberId: "cast_a", use: "production", ...approved });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const id = String(ok.body.id);
    const vendor = fakeRecraft();
    await run(id, vendor.deps, 2);
    expect(vendor.calls).toEqual(["removeBackground", "store"]);
    expect((vendor.sent[0] as { bytes: Buffer }).bytes.equals(src.bytes)).toBe(true);
    const take = await gen(id);
    expect(take).toMatchObject({ status: "succeeded", kind: "image" });
    expect(take.recraft).toMatchObject({ tool: "remove_background", model: "recraft_remove_background" });
    expect(take.recraft).not.toHaveProperty("consentId");
    expect(take.recraft).not.toHaveProperty("castMemberId");
    expect(Number(take.cost_usd)).toBeCloseTo(0.01, 6);
    const lineage = (await db().execute({ sql: "SELECT source_gen_id, json_extract(params,'$.sourceUploadId') AS up FROM generations WHERE id=?", args: [id] })).rows[0];
    expect(lineage.up).toBe(src.id);
    /* A source that cannot be read at send time sends nothing and settles at nothing. */
    const plain = await admit({ tool: "remove_background", sourceUploadId: src.id, ...approved });
    expect(plain.status).toBe(200);
    await db().execute({ sql: "DELETE FROM uploads WHERE id=?", args: [src.id] });
    const gone = fakeRecraft();
    await run(String(plain.body.id), gone.deps, 2);
    expect(gone.calls).toEqual([]);
    expect((await gen(String(plain.body.id))).status).toBe("failed");
    expect(String((await gen(String(plain.body.id))).error)).toMatch(/Nothing was sent[\s\S]*Nothing was billed/);
  });
});

test("a listed customer workspace pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db, ready } = await import("../../lib/db");
  const { RecraftError } = await import("../../lib/recraft");
  await platformReady();
  const listed = "ws_recraft_listed", capped = "ws_recraft_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.RECRAFT_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const expected = billCredits(0.035, "recraftv4_1");
      expect(await admit({ tool: "image", prompt: "a heron", quoteOnly: true })).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ tool: "image", prompt: "a heron", maxCredits: expected - 1 })).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      const id = String((await admit({ tool: "image", prompt: "a heron", maxCredits: expected })).body.id);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      await run(id, fakeRecraft().deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      const bad = String((await admit({ tool: "image", prompt: "a heron", maxCredits: expected })).body.id);
      await run(bad, fakeRecraft({ error: new RecraftError("Recraft refused the request: no", 422, true) }).deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const reply = await admit({ tool: "image", prompt: "a heron", ...approved });
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

test("over MCP: recraft_image and recraft_remove_background are listed only where the engine is on, the SVG tool never; they are never a draft, so Ask and Auto both prepare and start nothing; the caller cannot approve", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const spend = async (value: string | null) => { if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin"); invalidateSettings(); };
  const calls: Record<string, unknown>[] = [];
  const call = async (p: string, init: { body?: unknown } = {}) => { const body = init.body as Record<string, unknown>; calls.push(body); if (p === "/api/prepared-jobs") return { job: { id: "prep_r1" } }; return body.quoteOnly === true ? { estimatedCredits: 1, price: 0.035, unit: "usd" } : { id: "gen_r1" }; };
  await asTenant(house(), async () => {
    await ready();
    delete process.env.RECRAFT_ENABLED;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("recraft_image");
    await expect(runDirectEngineTool("recraft_image", { prompt: "a tree" }, call)).rejects.toThrow("There is no such tool here.");
    process.env.RECRAFT_ENABLED = "1";
    const names = (await directEngineMcpTools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["recraft_image", "recraft_remove_background"]));
    expect(names).not.toContain("recraft_vectorize");
    await expect(runDirectEngineTool("recraft_vectorize", { source_upload_id: "u" }, call)).resolves.toBeNull();
    try {
      for (const mode of [null, "ask", "auto"]) {
        await spend(mode); calls.length = 0;
        const text = await runDirectEngineTool("recraft_image", { prompt: "a tree", size: "1024x1024" }, call);
        expect(text, String(mode)).toMatch(/^Priced and prepared, not started\.\n\nprice: \$0\.04\nprepared: recraftv4_1 still, 1024x1024\nprepared job: prep_r1/);
        expect(calls.map((c) => [c.quoteOnly === true, c.maxCredits ?? null])).toEqual([[true, null], [false, null]]);
        expect(calls[0]).toMatchObject({ tool: "image", quoteOnly: true });
        calls.length = 0;
        const cut = await runDirectEngineTool("recraft_remove_background", { source_upload_id: "u1" }, call);
        expect(cut, String(mode)).toMatch(/not started[\s\S]*prepared: background removal of u1[\s\S]*needs a person's approval/);
        expect(calls.some((c) => c.maxCredits !== undefined)).toBe(false);
      }
      for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) await expect(runDirectEngineTool("recraft_image", { prompt: "a tree", ...bad }, call)).rejects.toThrow(/only a person approves/);
    } finally { await spend(null); }
  });
});

test("what a person reads of a Recraft take is its status, tool, model, size and style: never the source, the consent and cast ids, the units or the dollars", async () => {
  const { publicDirectParams } = await import("../../lib/directEnginePublic");
  const recraft = { status: "done", tool: "remove_background", model: "recraft_remove_background", size: "512x512", style: null, source: { kind: "upload", id: "up_a" }, consentId: "c", castMemberId: "m", reservedUsd: 0.01, statedUsd: 0.01, estimateCredits: 1, funded: 1, claimedAt: 1, sendingAt: 1, settled: 1, reconcile: 1 };
  const out = publicDirectParams({ task: "recraft_image", estUsd: 0.01, recraft });
  expect(out.recraft).toEqual({ status: "done", tool: "remove_background", model: "recraft_remove_background", size: "512x512", style: null });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter answers in process, with the network forbidden; a still, then its background removed", async () => {
  const { advanceRecraftJob } = await import("../../lib/recraftImage");
  process.env.RECRAFT_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const id = String((await admit({ tool: "image", prompt: "a heron at dusk", ...approved })).body.id);
      await advanceRecraftJob(id);
      expect(await gen(id)).toMatchObject({ status: "succeeded", kind: "image" });
      made.push(path.join(process.cwd(), ".data", "generations", `${id}.png`));
      /* A finished take of this workspace is a source for the next step (the fixture's own 1 px picture is under Recraft's minimum, so a real one stands in). */
      const { storeImageBytes } = await import("../../lib/storage");
      const { db } = await import("../../lib/db");
      const sharp = (await import("sharp")).default;
      const real = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#204060" } }).png().toBuffer();
      const srcGen = uid("gen_src");
      const stored = await storeImageBytes(srcGen, real);
      made.push(path.join(process.cwd(), ".data", "generations", `${srcGen}.png`));
      await db().execute({ sql: "INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, stored_url, bytes, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)", args: [srcGen, null, null, "image", "recraftv4_1", "a source", "{}", "succeeded", "owner", Date.now(), Date.now(), stored.url, stored.bytes] });
      const cutReply = await admit({ tool: "remove_background", sourceGenId: srcGen, ...approved });
      expect(cutReply.status, JSON.stringify(cutReply.body)).toBe(200);
      const cutId = String(cutReply.body.id);
      await advanceRecraftJob(cutId);
      expect(await gen(cutId)).toMatchObject({ status: "succeeded" });
      made.push(path.join(process.cwd(), ".data", "generations", `${cutId}.png`));
      const refused = String((await admit({ tool: "image", prompt: "[[mock-refuse]] a heron", ...approved })).body.id);
      await advanceRecraftJob(refused);
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

test("structure: the seams stay internal, the route is the one door, the SVG refusal comes before anything is written, the approval and the reservation come before the request, the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\bexecuteRecraftAdmission\b/)).toEqual(["app/api/recraft/route.ts", "lib/recraftImage.ts"]);
  expect(reachers(/\badvanceRecraftJobWith\b/)).toEqual(["lib/recraftImage.ts"]);
  expect(reachers(/@\/lib\/recraftImage["']/)).toEqual(["app/api/recraft/route.ts"]);
  const flow = readFileSync("lib/recraftImage.ts", "utf8");
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("export async function executeRecraftAdmission(");
  expect(at("SVG_REFUSAL, code")).toBeGreaterThan(0);
  expect(at('tool === "vectorize") return admissionReply({ error: SVG_REFUSAL')).toBeLessThan(at("INSERT INTO generations"));
  expect(at("isVectorModel(model)")).toBeLessThan(at("INSERT INTO generations"));
  expect(at("Approve the price first")).toBeLessThan(at("INSERT INTO generations"));
  /* No face matching anywhere (owner, 16 Oct 2026). */
  expect(flow.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/consentMatch|requireConsentMatch|faceCheck|rekognition/i);
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.generate ?? generateImage)("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.removeBackground ?? removeBackground)("));
  expect(at("(deps.generate ?? generateImage)(")).toBeLessThan(at("(deps.store ?? storeImageBytes)("));
  expect(at("isRasterImage(reply.bytes)")).toBeLessThan(at("(deps.store ?? storeImageBytes)("));
  expect(at("(deps.store ?? storeImageBytes)(")).toBeLessThan(at('await settleRecraft(genId, "done"'));
  expect(flow).toContain("Math.min(outcome.costUsd, r.reservedUsd)");
  expect(flow).toContain("quotedCredits(usd, marginKey)");
  /* No SVG is ever stored or served from here, and no vendor link is kept or fetched. */
  expect(flow.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/image\/svg|\.svg|fetch\(/i);
  const adapter = readFileSync("lib/recraft.ts", "utf8");
  const names = new Set([...adapter.matchAll(/process\.env\.(RECRAFT_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["RECRAFT_API_KEY", "RECRAFT_BASE_URL"]);
  expect(adapter).toContain('export const RECRAFT_SWITCH = "RECRAFT_ENABLED";');
  expect(adapter).toContain('redirect: "error"');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  expect(flow).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
});
