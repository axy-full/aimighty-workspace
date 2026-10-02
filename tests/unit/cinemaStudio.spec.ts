import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, PreparedAdmission, PrepareAdmissionResult } from "../../lib/admissionTypes";
import type { Reference, VideoParams } from "../../lib/ark";
import type { VideoJob } from "../../lib/submitVideo";
import type { VideoRenderRequest, RenderHandle } from "../../lib/engines/types";
import { CINEMA_STUDIO_MODEL_ID } from "../../lib/cinemaStudioTypes";

const dir = mkdtempSync(path.join(tmpdir(), "particl-cinema-studio-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
const originalFetch = globalThis.fetch;
const requestId = "5c1d4e1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const cancelUrl = `https://api.higgsfield.ai/requests/${requestId}/cancel`;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    return name.startsWith("@/") ? nodeRequire(path.resolve(`${name.slice(2)}.ts`))
      : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), `${name}.ts`)) : nodeRequire(name);
  }, target, target.exports);
  return target.exports as T;
}
/** The deploy-time kill switch; unset, the engine is on. */
function switchedOff(off: boolean) {
  if (off) process.env.HF_CINEMA_STUDIO_ENABLED = "0";
  else delete process.env.HF_CINEMA_STUDIO_ENABLED;
}
test.beforeEach(() => {
  switchedOff(false);
  process.env.ENGINE_MOCK = "1";
  process.env.HF_CREDENTIALS = "fixture:key";
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
});
test.afterEach(() => { globalThis.fetch = originalFetch; switchedOff(false); process.env.ENGINE_MOCK = "1"; });
/** USD for a token count at the engine's own published tier (per million tokens). */
async function tokenUsd(tokens: number, withVideo = false) {
  const { VENDOR_RATES } = await import("../../lib/vendorRates");
  const tier = VENDOR_RATES[CINEMA_STUDIO_MODEL_ID].tiers![0];
  return (tokens / 1_000_000) * (withVideo ? tier.withVideo : tier.withoutVideo);
}

function workspace(name: string): TenantWorkspace {
  return { id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 20, rendersPerHour: 200, storageQuotaBytes: null, deletedAt: null };
}
const settings = (patch: Partial<VideoParams> = {}): VideoParams =>
  ({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, generateAudio: true, hasVideoInput: false, ...patch });

test("Cinema Studio is on for every workspace, priced from its published rates, and a deploy-time switch turns it off", async () => {
  const { getModel } = await import("../../lib/models");
  const { cinemaStudioEnabled, VENDOR_RATES } = await import("../../lib/vendorRates");
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  const { workbenchGenerationModels } = await import("../../lib/workbench/media-quote");
  const model = getModel(CINEMA_STUDIO_MODEL_ID);
  expect(model).toMatchObject({ provider: "higgsfield", kind: "video", billing: "token", cinemaStudio: true });
  expect(model.hidden).toBeFalsy();
  expect(cinemaStudioEnabled()).toBe(true);
  expect(VENDOR_RATES[CINEMA_STUDIO_MODEL_ID].tiers).toHaveLength(1);
  expect(cinemaStudioQuoteUsd(settings())).toBeGreaterThan(0);
  expect(workbenchGenerationModels().map(m => m.id)).toContain(CINEMA_STUDIO_MODEL_ID);
  for (const value of ["1", "true", ""]) {
    process.env.HF_CINEMA_STUDIO_ENABLED = value;
    expect(cinemaStudioEnabled(), value).toBe(true);
  }
  switchedOff(true);
  expect(cinemaStudioEnabled()).toBe(false);
  expect(workbenchGenerationModels().map(m => m.id)).not.toContain(CINEMA_STUDIO_MODEL_ID);
});

test("the approximate quote is the published token formula on the metered frame, at the with-video rate once a clip is sent", async () => {
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  // (0 + 5 s) × 1280 × 720 × 24 / 1024
  expect(cinemaStudioQuoteUsd(settings())).toBeCloseTo(await tokenUsd(108_000), 10);
  // 480p 16:9 is metered on its 16-pixel grid: 854 → 864 wide.
  expect(cinemaStudioQuoteUsd(settings({ resolution: "480p" }))).toBeCloseTo(await tokenUsd((864 * 480 * 24 * 5) / 1024), 10);
  // Portrait names the short side: 9:16 at 720p is 720 × 1280.
  expect(cinemaStudioQuoteUsd(settings({ ratio: "9:16" }))).toBeCloseTo(await tokenUsd(108_000), 10);
  // Reference clips bill their seconds with the output, at the with-video rate.
  expect(cinemaStudioQuoteUsd(settings({ hasVideoInput: true, inputSeconds: 3.5 }))).toBeCloseTo(await tokenUsd((1280 * 720 * 24 * 8.5) / 1024, true), 10);
  expect(cinemaStudioQuoteUsd(settings({ duration: 30, hasVideoInput: true, inputSeconds: 30 }))).toBeCloseTo(await tokenUsd((1280 * 720 * 24 * 60) / 1024, true), 10);
  for (const patch of [
    { duration: 3 }, { duration: 31 }, { duration: 5.5 }, { resolution: "1080p" }, { ratio: "adaptive" }, { ratio: "2:3" },
    { hasVideoInput: true }, { hasVideoInput: true, inputSeconds: 0 }, { hasVideoInput: true, inputSeconds: 30.5 },
    { hasVideoInput: true, inputSeconds: Number.NaN },
  ] as Partial<VideoParams>[])
    expect(cinemaStudioQuoteUsd(settings(patch)), JSON.stringify(patch)).toBeNull();
});

test("the request cites attached media in the provider's token form and sends only authorized originals", async () => {
  const { cinemaStudioInput, cinemaStudioPrompt } = await import("../../lib/cinemaStudio");
  const refs: Reference[] = [
    { id: "still", kind: "image", mime: "image/png", ext: "png", storedUrl: "/api/uploads/still", deliveryUrl: "https://wrong.example/derivative", role: "reference_image" },
    { id: "clip", kind: "video", mime: "video/mp4", ext: "mp4", storedUrl: "/api/uploads/clip", role: "reference_video" },
    { id: "made", kind: "image", mime: "image/png", ext: "png", storedUrl: "/api/media/made", role: "reference_image", fromGeneration: true },
  ];
  const body = await cinemaStudioInput("@Image1 walks past @Video1; @image2 watches; @Image3 and @Video2 are not attached.", settings({ hasVideoInput: true, inputSeconds: 4 }), refs);
  expect(body).toEqual({
    prompt: "<<<image_1>>> walks past <<<video_1>>>; <<<image_2>>> watches; @Image3 and @Video2 are not attached.",
    duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true,
    image_urls: [expect.stringMatching(/uploads\/still\.png$/), expect.stringMatching(/generations\/made\.png$/)],
    video_urls: [expect.stringMatching(/uploads\/clip\.mp4$/)],
  });
  expect(JSON.stringify(body)).not.toContain("derivative");
  const textOnly = await cinemaStudioInput("A harbour at dawn", settings({ generateAudio: false, ratio: "21:9", resolution: "480p", duration: 30 }), []);
  expect(textOnly).toEqual({ prompt: "A harbour at dawn", duration: 30, resolution: "480p", aspect_ratio: "21:9", generate_audio: false });
  expect(cinemaStudioPrompt("@Image10 then @Image1", 9, 0)).toBe("@Image10 then <<<image_1>>>");
  const still = refs[0];
  for (const [prompt, params, references] of [
    ["   ", settings(), []],
    ["x", settings({ duration: 3 }), []],
    ["x", settings({ resolution: "1080p" }), []],
    ["x", settings(), [{ ...still, role: "first_frame" }]],
    ["x", settings(), [{ ...still, role: "last_frame" }]],
    ["x", settings(), Array.from({ length: 31 }, (_, i) => ({ ...still, id: `still${i}` }))],
    ["x", settings(), Array.from({ length: 11 }, (_, i) => ({ ...refs[1], id: `clip${i}` }))],
    ["x", settings(), [{ ...still, id: "../escape" }]],
  ] as [string, VideoParams, Reference[]][])
    await expect(cinemaStudioInput(prompt, params, references)).rejects.toMatchObject({ status: 422 });
  process.env.ENGINE_MOCK = "0";
  await expect(cinemaStudioInput("x", settings(), [still])).rejects.toThrow(/private media storage/);
});

async function job(id: string, usd?: number): Promise<VideoJob> {
  const { db, ready, now } = await import("../../lib/db"), { getModel } = await import("../../lib/models"), { getTask } = await import("../../lib/tasks");
  const { meter } = await import("../../lib/meter"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  await ready();
  const model = getModel(CINEMA_STUDIO_MODEL_ID);
  usd ??= (await import("../../lib/cinemaStudio")).cinemaStudioQuoteUsd(settings())!;
  const params = { ...settings(), higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: usd };
  await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_by,created_at,updated_at) VALUES(?,'video',?,'A harbour at dawn',?,'queued','higgsfield','generate','owner',?,?)", args: [id, model.id, JSON.stringify(params), now(), now()] });
  await meter({ id, kind: "video", engine: "higgsfield", model: model.id, status: "running", engineCostUsd: usd });
  return { genId: id, model, task: getTask("generate"), prompt: "A harbour at dawn", params, source: null, references: [], ts: now() };
}

test("dispatch re-prices before the sole paid POST, and refuses when the kept quote, switch or connection changed", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant({ ...workspace("cinema_transport"), usesPlatformKeys: true }, async () => {
    const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
    const value = await job("gen_cinema_transport", cinemaStudioQuoteUsd(settings())!);
    process.env.ENGINE_MOCK = "0";
    const { higgsfield } = await import("../../lib/engines/higgsfield"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
    // Admitted on the live connection this dispatch will use.
    value.params.higgsfieldCredentialFingerprint = higgsfieldCredentialFingerprint();
    const req: VideoRenderRequest = { kind: "video", ...value };
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") });
      expect(init?.redirect).toBe("error");
      return Response.json({ request_id: requestId, status: "queued", status_url: statusUrl, cancel_url: cancelUrl });
    };
    expect(higgsfield.estimate(req)).toBe(value.params.higgsfieldVendorCostUsd);
    const out = await higgsfield.render(req);
    expect(calls).toEqual([{ url: "https://api.higgsfield.ai/higgsfield/cinema-studio/4.0", auth: "Key fixture:key",
      body: { prompt: "A harbour at dawn", duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true } }]);
    // The answer carried no correlation id of its own: the one sent with the POST is kept beside the request id.
    const { higgsfieldCorrelationId } = await import("../../lib/higgsfield");
    expect(out).toEqual({ handle: { provider: "higgsfield", model: CINEMA_STUDIO_MODEL_ID, ref: requestId, endpoint: statusUrl, cancelUrl, credentialFingerprint: value.params.higgsfieldCredentialFingerprint,
      correlationId: higgsfieldCorrelationId(req.genId, "submit") } });
    calls.length = 0;
    // A kept quote the settings no longer price the same (rates changed since), the kill switch,
    // rotated credentials, or a take whose clip basis no longer matches its quote: nothing is sent.
    await expect(higgsfield.render({ ...req, params: { ...req.params, higgsfieldVendorCostUsd: req.params.higgsfieldVendorCostUsd! * 1.1 } })).rejects.toThrow(/Nothing was submitted/);
    switchedOff(true);
    await expect(higgsfield.render(req)).rejects.toThrow(/Nothing was submitted/);
    switchedOff(false);
    process.env.HF_CREDENTIALS = "rotated:secret";
    await expect(higgsfield.render(req)).rejects.toThrow(/Nothing was submitted/);
    process.env.HF_CREDENTIALS = "fixture:key";
    await expect(higgsfield.render({ ...req, params: { ...req.params, hasVideoInput: true, inputSeconds: 4 } })).rejects.toThrow(/Nothing was submitted/);
    await expect(higgsfield.render({ ...req, params: { ...req.params, duration: 6 } })).rejects.toThrow(/Nothing was submitted/);
    await expect(higgsfield.render({ ...req, params: { ...req.params, higgsfieldVendorCostUsd: 0 } })).rejects.toThrow(/Nothing was submitted/);
    expect(calls).toEqual([]);
    const accepted = "handle" in out ? out.handle : ({} as RenderHandle);
    for (const status of ["failed", "nsfw", "canceled", "in_progress", "queued"]) {
      globalThis.fetch = async () => Response.json({ request_id: requestId, status });
      expect((await higgsfield.poll!(accepted)).status).toBe(({ failed: "failed", nsfw: "failed", canceled: "cancelled", in_progress: "running", queued: "queued" } as Record<string, string>)[status]);
    }
    globalThis.fetch = async () => Response.json({ request_id: requestId, status: "completed", video: { url: "https://cdn.example/cinema.mp4" } });
    expect((await higgsfield.poll!(accepted)).videoUrl).toBe("https://cdn.example/cinema.mp4");
    globalThis.fetch = async () => Response.json({ request_id: requestId, status: "completed", images: [{ url: "https://cdn.example/still.png" }] });
    await expect(higgsfield.poll!(accepted)).rejects.toThrow(/recognized original/);
    globalThis.fetch = async () => { throw new Error("must not receive credentials"); };
    await expect(higgsfield.poll!({ ...accepted, endpoint: "https://evil.example/status" })).rejects.toThrow(/unexpected status/);
    await expect(higgsfield.cancel!({ ...accepted, cancelUrl: "https://evil.example/cancel" })).rejects.toThrow(/verified cancellation URL/);
    globalThis.fetch = async (url, init) => { expect(String(url)).toBe(cancelUrl); expect(init?.method).toBe("POST"); return new Response(null, { status: 202 }); };
    await higgsfield.cancel!(accepted);
  }, actor);
});

test("an accepted request recovers a lost tenant handle from its receipt, collects once, settles on the delivered output and keeps its aspect", async () => {
  const { runInTenant } = await import("../../lib/tenant"), { engineFor } = await import("../../lib/engines"), { submitVideoJob, submitVideoRow } = await import("../../lib/submitVideo");
  const { db } = await import("../../lib/db"), { platformDb } = await import("../../lib/platform"), { reconcileGenjutsuVideo } = await import("../../lib/genjutsuVideo");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs"), { readVideoBytes } = await import("../../lib/storage"), { fixtureUrl } = await import("../../lib/mock");
  const engine = engineFor("higgsfield"), render = engine.render, poll = engine.poll;
  let submissions = 0, polls = 0;
  engine.render = async req => { submissions++; return { handle: { provider: "higgsfield", model: req.kind === "video" ? req.model.id : "", ref: requestId, endpoint: statusUrl, cancelUrl, credentialFingerprint: req.kind === "video" ? req.params.higgsfieldCredentialFingerprint : undefined } }; };
  engine.poll = async () => { polls++; return { status: "succeeded", videoUrl: fixtureUrl("clip.mp4"), totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {} }; };
  const id = "gen_cinema_recovered";
  try {
    await runInTenant(workspace("cinema_recovery"), async () => {
      const value = await job(id), client = db(), execute = client.execute.bind(client);
      client.execute = async (...args: Parameters<typeof client.execute>) => {
        const statement = args[0] as unknown as string | { sql: string };
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql.includes("'$.producedOutcome'")) throw new Error("Tenant write unavailable");
        return execute(...args);
      };
      try { expect((await submitVideoJob(value)).ok).toBe(false); } finally { client.execute = execute; }
      expect((await platformDb().execute({ sql: "SELECT id FROM higgsfield_generation_receipts WHERE id=?", args: [id] })).rows).toHaveLength(1);
      expect((await submitVideoRow(id)).ok).toBe(true);
      expect(submissions).toBe(1);
      // The ordinary status refresh routes this engine to the video collector.
      await syncGeneration((await getGeneration(id))!);
      expect((await getGeneration(id))?.status).toBe("succeeded");
      expect(polls).toBe(1);
      await reconcileGenjutsuVideo(id);
      expect(polls).toBe(1);
      expect(submissions).toBe(1);
      const gen = (await getGeneration(id))!;
      expect(gen.status).toBe("succeeded");
      // The fixture delivers 10 s at 640 × 360: the published formula on that output, within the
      // sane band of the 5 s 720p quote, is what settles.
      const { cinemaStudioDeliveredUsd, cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
      const delivered = cinemaStudioDeliveredUsd({ resolution: "720p", width: 640, height: 360, seconds: 10 })!;
      expect(delivered).toBeCloseTo(await tokenUsd(Math.ceil((10 * 640 * 360 * 24) / 1024)), 10);
      expect(delivered).not.toBe(cinemaStudioQuoteUsd(settings()));
      expect(gen.costUsd).toBe(delivered);
      expect(gen.params).toMatchObject({ ratio: "16:9", duration: 5 });
      expect(gen.params).not.toHaveProperty("higgsfieldVideoHandle");
      expect(JSON.stringify(gen)).not.toContain("credentialFingerprint");
      expect(await readVideoBytes(id)).toEqual(readFileSync("public/fixtures/clip.mp4"));
      const meter = (await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [id] })).rows[0];
      expect(meter).toMatchObject({ status: "succeeded", engine_cost_usd: delivered });
      expect(Number((await platformDb().execute({ sql: "SELECT settled_at FROM higgsfield_generation_receipts WHERE id=?", args: [id] })).rows[0].settled_at)).toBeGreaterThan(0);
    }, actor);
  } finally { engine.render = render; engine.poll = poll; await unlink(path.resolve(".data/generations", `${id}.mp4`)).catch(() => {}); }
});

test("an ambiguous paid POST is never resent or refunded; a definitive refusal releases its reservation; provider failure settles at zero", async () => {
  const quoted = (await import("../../lib/cinemaStudio")).cinemaStudioQuoteUsd(settings())!;
  const { runInTenant } = await import("../../lib/tenant"), { engineFor } = await import("../../lib/engines"), { submitVideoJob } = await import("../../lib/submitVideo");
  const { HiggsfieldHttpError } = await import("../../lib/higgsfield"), { platformDb } = await import("../../lib/platform"), { reconcileGenjutsuVideo } = await import("../../lib/genjutsuVideo"), { getGeneration } = await import("../../lib/jobs");
  const engine = engineFor("higgsfield"), render = engine.render, poll = engine.poll;
  const cost = async (id: string) => (await platformDb().execute({ sql: "SELECT engine_cost_usd FROM meter_events WHERE id=?", args: [id] })).rows[0].engine_cost_usd;
  try {
    for (const uncertain of [true, false]) {
      let calls = 0;
      engine.render = async () => { calls++; throw uncertain ? new Error("lost acknowledgement") : new HiggsfieldHttpError(422, "Nothing submitted"); };
      await runInTenant(workspace(`cinema_reject_${uncertain}`), async () => {
        const value = await job(`gen_cinema_reject_${uncertain}`);
        expect((await submitVideoJob(value)).ok).toBe(false);
        expect((await submitVideoJob(value)).ok).toBe(false);
        expect(calls).toBe(1);
        expect(await cost(value.genId)).toBe(uncertain ? quoted : 0);
      }, actor);
    }
    engine.render = async req => ({ handle: { provider: "higgsfield", model: req.kind === "video" ? req.model.id : "", ref: requestId, endpoint: statusUrl, credentialFingerprint: req.kind === "video" ? req.params.higgsfieldCredentialFingerprint : undefined } });
    engine.poll = async () => ({ status: "failed", videoUrl: null, totalTokens: null, error: "The connected account could not complete this generation.", vendorStartedAt: null, vendorEndedAt: null, raw: {} });
    await runInTenant(workspace("cinema_provider_failed"), async () => {
      const value = await job("gen_cinema_failed");
      expect((await submitVideoJob(value)).ok).toBe(true);
      await reconcileGenjutsuVideo(value.genId);
      expect((await getGeneration(value.genId))?.status).toBe("failed");
      expect(await cost(value.genId)).toBe(0);
    }, actor);
  } finally { engine.render = render; engine.poll = poll; }
});

/* ── Admission, through the real /api/generate route ─────────────────── */
async function fixture(name: string, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, `${name}.db`)}`],
  });
  await grantCredits(name, 100000, "Cinema Studio test", actor.user.id, "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  await runInTenant(ws, async () => run(await setup(name)), actor);
}
async function setup(name: string) {
  const database = await import("../../lib/db");
  const higgsfield = await import("../../lib/higgsfield");
  await database.ready();
  await database.db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Saved production',0)");
  await database.db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0)");
  const dispatches: string[] = [];
  const admission = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (id: string) => { dispatches.push(id); return true; } },
    "@/lib/higgsfield": { ...higgsfield, higgsfieldCredentialFingerprint: () => "c".repeat(64) },
  });
  const handler = load<{ POST(request: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireRender: async () => actor },
    "@/lib/generationAdmission": admission,
    "next/server": { after: () => { throw new Error("The acknowledged test queue must not run a provider worker."); } },
  });
  async function upload(id: string, kind: "image" | "video", seconds: number | null = null) {
    await database.db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,128,'fixture-sha',?,?,?,0)",
      args: [id, id, kind === "image" ? "image/png" : "video/mp4", kind === "image" ? "png" : "mp4", `/api/uploads/${id}`, kind, seconds],
    });
    return { uploadId: id, role: kind === "image" ? "reference_image" : "reference_video" };
  }
  const body = (patch: Record<string, unknown> = {}) => ({ model: CINEMA_STUDIO_MODEL_ID, prompt: "@Image1 crosses the harbour", ratio: "16:9", resolution: "720p", duration: 5, generateAudio: true, projectId: "project", refine: false, ...patch });
  const post = (value: Record<string, unknown>, key: string) => handler.POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value) }));
  const rows = async () => (await database.db().execute({ sql: "SELECT * FROM generations WHERE model=?", args: [CINEMA_STUDIO_MODEL_ID] })).rows;
  return { admission, upload, body, post, rows, dispatches, name };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

test("admission refuses a switched-off engine, first or last frames, and any take without a reviewed credit price", async () => fixture("cinema_admission_rules", async f => {
  const still = await f.upload("still", "image");
  switchedOff(true);
  const disabled = await f.post({ ...f.body({ references: [still] }), maxCredits: 1000 }, "cinema-disabled");
  expect(disabled.status, await disabled.text()).toBe(503);
  expect(await f.admission.prepareGeneration(f.body({ references: [still] }), actor)).toMatchObject({ ok: false, status: 503 });
  switchedOff(false);
  expect(await f.admission.prepareGeneration(f.body({ references: [{ ...still, role: "first_frame" }] }), actor)).toMatchObject({ ok: false, status: 400 });
  const quote = prepared(await f.admission.prepareGeneration(f.body({ references: [still] }), actor));
  // The figure is approximate, and the quote says so.
  expect(quote.quote.approximate).toBe(true);
  const unapproved = await f.post(f.body({ references: [still] }), "cinema-unapproved");
  expect(unapproved.status, await unapproved.text()).toBe(400);
  const underApproved = await f.post({ ...f.body({ references: [still] }), maxCredits: quote.quote.estimatedCredits - 1 }, "cinema-under");
  expect(underApproved.status, await underApproved.text()).toBe(409);
  expect(await f.rows()).toEqual([]);
  expect(f.dispatches).toEqual([]);
}));

test("admission keeps the formula quote with its clip seconds and dispatches once within the reviewed price", async () => fixture("cinema_admission", async f => {
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  const still = await f.upload("still", "image"), clip = await f.upload("clip", "video", 3.5);
  const body = f.body({ prompt: "@Image1 crosses the harbour as in @Video1", references: [still, clip] });
  const quote = prepared(await f.admission.prepareGeneration(body, actor));
  const usd = cinemaStudioQuoteUsd(settings({ hasVideoInput: true, inputSeconds: 3.5 }))!;
  expect(quote.compiled.params).toMatchObject({ resolution: "720p", ratio: "16:9", duration: 5, generateAudio: true, hasVideoInput: true, inputSeconds: 3.5, higgsfieldVendorCostUsd: usd, higgsfieldCredentialFingerprint: "c".repeat(64) });
  expect((quote.compiled.references as Reference[]).map(ref => [ref.id, ref.kind, ref.role])).toEqual([["still", "image", "reference_image"], ["clip", "video", "reference_video"]]);
  // Past the provider's 30 s reference budget there is no price, so no take.
  const long = await f.upload("long", "video", 30.5);
  expect(await f.admission.prepareGeneration(f.body({ references: [long] }), actor)).toMatchObject({ ok: false, status: 400 });
  const approved = { ...body, maxCredits: quote.quote.estimatedCredits, quoteFingerprint: quote.quote.fingerprint };
  const accepted = await f.post(approved, "cinema-approved-once");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  const replay = await f.post(approved, "cinema-approved-once");
  expect((await replay.json()).id).toBe(result.id);
  expect(f.dispatches).toEqual([result.id]);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ provider: "higgsfield", model: CINEMA_STUDIO_MODEL_ID, status: "queued" });
  expect(JSON.parse(String(rows[0].params))).toMatchObject({ higgsfieldVendorCostUsd: usd, hasVideoInput: true, inputSeconds: 3.5,
    references: [{ uploadId: "still", kind: "image", role: "reference_image" }, { uploadId: "clip", kind: "video", role: "reference_video" }] });
  const { platformDb } = await import("../../lib/platform");
  const meter = (await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [result.id] })).rows[0];
  expect(meter).toMatchObject({ status: "running", engine_cost_usd: usd });
}));

test("settlement uses the provider's own charge or the delivered-output figure only within a sane band of the quote", async () => {
  const { cinemaStudioSettlementUsd, cinemaStudioDeliveredUsd } = await import("../../lib/cinemaStudio");
  expect(cinemaStudioSettlementUsd(1, 0.9)).toBe(0.9);
  expect(cinemaStudioSettlementUsd(1, 2.5)).toBe(2.5);
  expect(cinemaStudioSettlementUsd(1, 0.5)).toBe(0.5);
  expect(cinemaStudioSettlementUsd(1, 3)).toBe(3);
  // A reported per-job charge wins when it is sane; otherwise the delivered figure or the quote.
  expect(cinemaStudioSettlementUsd(1, 0.9, 1.2)).toBe(1.2);
  expect(cinemaStudioSettlementUsd(1, 0.9, 40)).toBe(0.9);
  // Outside half to three times the quote, a measurement or unit mistake is assumed: the quote stands.
  for (const wrong of [0.49, 3.01, 1e6, 0, -1, Number.NaN, Infinity, null])
    expect(cinemaStudioSettlementUsd(1, wrong as number | null), String(wrong)).toBe(1);
  for (const bad of [{ width: 0 }, { height: Number.NaN }, { seconds: -1 }, { hasVideoInput: true, inputSeconds: Number.NaN }])
    expect(cinemaStudioDeliveredUsd({ resolution: "720p", width: 1280, height: 720, seconds: 5, ...bad }), JSON.stringify(bad)).toBeNull();
  // Reference seconds are billed with the output, at the with-video rate.
  expect(cinemaStudioDeliveredUsd({ resolution: "720p", width: 1280, height: 720, seconds: 5, hasVideoInput: true, inputSeconds: 3.5 }))
    .toBeCloseTo(await tokenUsd(Math.ceil((8.5 * 1280 * 720 * 24) / 1024), true), 10);
});

test("the pricing watch checks Cinema Studio's published text on its own route, beside the quote's own figure", async () => {
  // The watch itself is covered in higgsfieldPricingWatch.spec.ts.
  const { CINEMA_STUDIO_PRICING_WATCH, cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  expect(CINEMA_STUDIO_PRICING_WATCH).toMatchObject({ model: CINEMA_STUDIO_MODEL_ID, path: "higgsfield/cinema-studio/4.0", body: { duration: 5, resolution: "720p" } });
  expect(CINEMA_STUDIO_PRICING_WATCH.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(CINEMA_STUDIO_PRICING_WATCH.formulaUsd!()).toBe(cinemaStudioQuoteUsd({ resolution: "720p", ratio: "16:9", duration: 5 }));
});
