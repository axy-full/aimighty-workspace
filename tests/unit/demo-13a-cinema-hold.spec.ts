import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor, PreparedAdmission, PrepareAdmissionResult } from "../../lib/admissionTypes";
import type { TenantToken } from "../../lib/tenant";
import type { VideoJob } from "../../lib/submitVideo";
import { CINEMA_STUDIO_MODEL_ID as CINEMA } from "../../lib/cinemaStudioTypes";

/**
 * Cinema Studio's hold (owner's decision, 5 October 2026): a person approves
 * "about N cr, at most 3N cr"; approving holds 3N on the take's meter row; the
 * balance check is at 3N, and short of it the take waits, held, with Top up.
 * The take settles at its actual cost and the rest is released at once; with
 * no cost figure it is charged N. Past the hold it is kept and shown, charged
 * the hold, never into debt, and marked; the platform absorbs the rest and its
 * admin desk counts it. Only a person approves: an API token (an MCP client)
 * and an Atomik run's own id are refused. Engines are mocked; nothing leaves
 * the process.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cinema-hold-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
const SEEDANCE = "dreamina-seedance-2-5-260628";
const originalFetch = globalThis.fetch;
const OWNER: AdmissionActor = {
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

test.beforeEach(() => {
  delete process.env.HF_CINEMA_STUDIO_ENABLED;
  process.env.ENGINE_MOCK = "1";
  process.env.HF_CREDENTIALS = "fixture:key";
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

/* ── A workspace on the platform's key, its generate route and its ledger ── */
async function fixture(name: string, credits: number, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, as: AdmissionActor = OWNER) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, `${name}.db`)}`],
  });
  if (credits > 0) await grantCredits(name, credits, "Cinema hold test", OWNER.user.id, "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  await runInTenant(ws, async () => run(await setup(name, as)), { user: as.user, ...(as.token ? { token: as.token } : {}) });
}
async function setup(name: string, as: AdmissionActor) {
  const database = await import("../../lib/db");
  const higgsfield = await import("../../lib/higgsfield");
  const { platformDb, grantCredits } = await import("../../lib/platform");
  const { billingStateFor } = await import("../../lib/billingLedger");
  await database.ready();
  await database.db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Saved production',0)");
  await database.db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0)");
  const dispatches: string[] = [];
  const admission = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (id: string) => { dispatches.push(id); return true; } },
    "@/lib/higgsfield": { ...higgsfield, higgsfieldCredentialFingerprint: () => "c".repeat(64) },
  });
  const handler = load<{ POST(request: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireRender: async () => as },
    "@/lib/generationAdmission": admission,
    "next/server": { after: () => { throw new Error("The acknowledged test queue must not run a provider worker."); } },
  });
  const body = (patch: Record<string, unknown> = {}) => ({ model: CINEMA, prompt: "A harbour at dawn", ratio: "16:9", resolution: "720p", duration: 5, projectId: "project", refine: false, ...patch });
  const post = (value: Record<string, unknown>, key: string) => handler.POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value) }));
  const rows = async () => (await database.db().execute({ sql: "SELECT * FROM generations WHERE model=?", args: [CINEMA] })).rows;
  const meterRow = async (id: string) => (await platformDb().execute({ sql: "SELECT status,billed_credits,hold_band,engine_cost_usd,overrun_usd FROM meter_events WHERE id=?", args: [id] })).rows[0];
  const balance = async () => (await billingStateFor(name)).credits.balance;
  const grant = (credits: number) => grantCredits(name, credits, "Cinema hold top-up", OWNER.user.id, "manual");
  return { admission, body, post, rows, meterRow, balance, grant, dispatches, name };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

test("one wording and one band: about N cr, at most 3N cr, for Cinema Studio alone", async () => {
  const { cinemaPriceWords, cinemaPriceParts, heldCredits, holdBandOf, overHoldMark, OVER_HOLD_MARK } = await import("../../lib/cinemaHold");
  const { STATED_CHARGE_BAND } = await import("../../lib/runLimit");
  expect(STATED_CHARGE_BAND).toBe(3);
  expect(holdBandOf(CINEMA)).toBe(3);
  for (const other of [SEEDANCE, "", null, undefined]) expect(holdBandOf(other), String(other)).toBe(1);
  expect(heldCredits(31, CINEMA)).toBe(93);
  expect(heldCredits(31, SEEDANCE)).toBe(31);
  expect(cinemaPriceWords(31)).toBe("about 31 cr, at most 93 cr");
  expect(cinemaPriceWords(1234)).toBe("about 1,234 cr, at most 3,702 cr");
  expect(cinemaPriceParts(31)).toEqual(["about 31 cr,", "at most 93 cr"]);
  /* A total that mixes held takes with others (a plan's) says its own ceiling. */
  expect(cinemaPriceWords(93, 120)).toBe("about 93 cr, at most 120 cr");
  expect(OVER_HOLD_MARK).toBe("The engine charged more than you approved; nothing above that was charged.");
  expect(overHoldMark({ overHold: true })).toBe(OVER_HOLD_MARK);
  expect(overHoldMark({})).toBeNull();
  /* The composers' button says the same, for a take and a batch. */
  const { composerButtonLabel } = await import("../../lib/workspace/composer");
  const quote = { key: "k", credits: 31, state: "ready" as const, reason: null, approximate: true };
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, verb: "Make" })).toBe("Make · about 31 cr, at most 93 cr");
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, verb: "Make", count: 3 })).toBe("Make 3 takes · about 93 cr, at most 279 cr");
});

test("the settlement rule: actual cost up to the hold, the hold past it, the quote with no figure, and a hold never moved while it runs", async () => {
  const { heldSettlement } = await import("../../lib/meter");
  const { cinemaStudioSettlement } = await import("../../lib/cinemaStudio");
  const running = { status: "running", engine_cost_usd: 2, hold_band: 3 };
  expect(heldSettlement(running, "succeeded", 2.5)).toEqual({ cost: 2.5, overrunUsd: null });
  expect(heldSettlement(running, "succeeded", 6)).toEqual({ cost: 6, overrunUsd: null });
  expect(heldSettlement(running, "succeeded", 9)).toEqual({ cost: 6, overrunUsd: 3 });
  expect(heldSettlement(running, "failed", null)).toEqual({ cost: 2, overrunUsd: null });
  expect(heldSettlement(running, "failed", 0)).toEqual({ cost: 0, overrunUsd: null });
  expect(heldSettlement(running, "running", 2)).toEqual({ cost: null, overrunUsd: null });
  /* Once settled, a later figure may lower the charge, never raise it. */
  const settled = { status: "succeeded", engine_cost_usd: 2.5, hold_band: 3 };
  expect(heldSettlement(settled, "succeeded", 5)).toEqual({ cost: 2.5, overrunUsd: null });
  expect(heldSettlement(settled, "succeeded", 2)).toEqual({ cost: 2, overrunUsd: null });
  expect(heldSettlement(settled, "succeeded", null)).toEqual({ cost: null, overrunUsd: null });
  /* Any other job is charged at its figure, as before. */
  expect(heldSettlement({ status: "running", engine_cost_usd: 2, hold_band: null }, "succeeded", 9)).toEqual({ cost: 9, overrunUsd: null });
  expect(heldSettlement(undefined, "succeeded", 9)).toEqual({ cost: 9, overrunUsd: null });
  /* Cinema Studio's own figure: the provider's charge, else the delivered output, else the quote. */
  expect(cinemaStudioSettlement(2, 2.4, null)).toEqual({ usd: 2.4, overrunUsd: null });
  expect(cinemaStudioSettlement(2, 2.4, 3)).toEqual({ usd: 3, overrunUsd: null });
  expect(cinemaStudioSettlement(2, null, 10)).toEqual({ usd: 6, overrunUsd: 4 });
  expect(cinemaStudioSettlement(2, null, null)).toEqual({ usd: 2, overrunUsd: null });
  expect(cinemaStudioSettlement(2, 0.5, null)).toEqual({ usd: 2, overrunUsd: null });
});

test("Make approves the hold: the quote states it, an approval of N is refused, and 3N is reserved and recorded on the take's row", async () => fixture("hold_admit", 100_000, async (f) => {
  const quote = prepared(await f.admission.prepareGeneration(f.body(), OWNER));
  const n = quote.quote.estimatedCredits;
  expect(n).toBeGreaterThan(0);
  expect(quote.quote).toMatchObject({ approximate: true, ceilingCredits: 3 * n });
  /* A prepared approval (an Atomik run, a plan) carries the hold, never the estimate. */
  expect(quote.request.maxCredits).toBe(3 * n);
  const before = await f.balance();
  const estimate = await f.post({ ...f.body(), maxCredits: n, quoteFingerprint: quote.quote.fingerprint }, "hold-approve-n");
  expect(estimate.status, await estimate.clone().text()).toBe(409);
  expect(await f.rows()).toEqual([]);
  const accepted = await f.post({ ...f.body(), maxCredits: 3 * n, quoteFingerprint: quote.quote.fingerprint }, "hold-approve-3n");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  expect(f.dispatches).toEqual([result.id]);
  expect(await f.meterRow(result.id)).toMatchObject({ status: "running", billed_credits: 3 * n, hold_band: 3 });
  expect(before - await f.balance()).toBe(3 * n);
  /* Any other engine holds its estimate, as before. */
  const seedance = prepared(await f.admission.prepareGeneration(f.body({ model: SEEDANCE, resolution: "480p" }), OWNER));
  expect(seedance.quote).not.toHaveProperty("ceilingCredits");
  expect(seedance.request.maxCredits).toBe(seedance.quote.estimatedCredits);
}));

test("the balance must cover the hold: short of 3N the take waits, held, with Top up; its Release approves 3N and reserves it", async () => fixture("hold_short", 0, async (f) => {
  const quote = prepared(await f.admission.prepareGeneration(f.body(), OWNER));
  const n = quote.quote.estimatedCredits;
  await f.grant(2 * n);
  const reply = await f.post({ ...f.body(), maxCredits: 3 * n, quoteFingerprint: quote.quote.fingerprint }, "hold-short");
  const held = await reply.json();
  expect(reply.status, JSON.stringify(held)).toBe(202);
  expect(held).toMatchObject({ status: "held", held: true, needs: 3 * n });
  expect(held.notices).toEqual([`Held: this needs ${3 * n} credits and ${2 * n} are left. Top up to release it — nothing is lost.`]);
  expect(await f.meterRow(held.id)).toBeUndefined();
  expect(f.dispatches).toEqual([]);
  /* What a person sees on the take, and what its Release charges: the hold. */
  const { getGeneration } = await import("../../lib/jobs");
  expect((await getGeneration(held.id))?.params.held).toMatchObject({ needs: 3 * n });
  const { releaseHeldJobs } = await import("../../lib/held");
  const quiet = async () => {};
  const estimate = await releaseHeldJobs({ only: held.id, approved: n, defer: quiet });
  expect(estimate.released).toEqual([]);
  expect(estimate.refused).toMatchObject({ status: 409, needs: 3 * n });
  const short = await releaseHeldJobs({ only: held.id, approved: 3 * n, defer: quiet });
  expect(short.refused).toMatchObject({ status: 402, needs: 3 * n });
  await f.grant(n);
  const released = await releaseHeldJobs({ only: held.id, approved: 3 * n, defer: quiet });
  expect(released.released).toEqual([held.id]);
  expect(await f.meterRow(held.id)).toMatchObject({ status: "running", billed_credits: 3 * n, hold_band: 3 });
  expect(await f.balance()).toBe(0);
}));

test("a take settles at its actual cost and the rest of the hold comes back at once; with no figure it is charged N; a failure, nothing", async () => fixture("hold_settle", 1_000, async (f) => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { meter } = await import("../../lib/meter");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const terms = currentBillingTerms("video", CINEMA);
  const quoteUsd = 2;
  const n = creditsAtTerms(quoteUsd, terms);
  const take = async (id: string) => {
    const before = await f.balance();
    await reserveGenerationSpend({ id, kind: "video", engine: "higgsfield", model: CINEMA, status: "running", engineCostUsd: quoteUsd }, { holdBand: 3 });
    expect(before - await f.balance(), id).toBe(3 * n);
    return before;
  };
  const end = (id: string, status: "succeeded" | "failed", engineCostUsd: number | null) =>
    meter({ id, kind: "video", engine: "higgsfield", model: CINEMA, status, engineCostUsd });
  let before = await take("hold_actual");
  await end("hold_actual", "succeeded", 2.5);
  expect(before - await f.balance()).toBe(creditsAtTerms(2.5, terms));
  expect(await f.meterRow("hold_actual")).toMatchObject({ status: "succeeded", billed_credits: creditsAtTerms(2.5, terms), engine_cost_usd: 2.5, overrun_usd: null });
  before = await take("hold_unknown");
  await end("hold_unknown", "failed", null);
  expect(before - await f.balance()).toBe(n);
  expect(await f.meterRow("hold_unknown")).toMatchObject({ status: "failed", billed_credits: n });
  before = await take("hold_failed");
  await end("hold_failed", "failed", 0);
  expect(await f.balance()).toBe(before);
  /* While it runs, nothing moves the hold. */
  before = await take("hold_running");
  await meter({ id: "hold_running", kind: "video", engine: "higgsfield", model: CINEMA, status: "running", engineCostUsd: quoteUsd });
  expect(before - await f.balance()).toBe(3 * n);
}));

test("past the hold: charged the hold and no more, never into debt, and the over is the platform's", async () => fixture("hold_over", 0, async (f) => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { meter } = await import("../../lib/meter");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const terms = currentBillingTerms("video", CINEMA);
  const n = creditsAtTerms(2, terms);
  await f.grant(3 * n);
  await reserveGenerationSpend({ id: "hold_past", kind: "video", engine: "higgsfield", model: CINEMA, status: "running", engineCostUsd: 2 }, { holdBand: 3 });
  expect(await f.balance()).toBe(0);
  await meter({ id: "hold_past", kind: "video", engine: "higgsfield", model: CINEMA, status: "succeeded", engineCostUsd: 20 });
  const row = await f.meterRow("hold_past");
  expect(row).toMatchObject({ status: "succeeded", engine_cost_usd: 6, overrun_usd: 14 });
  expect(Number(row.billed_credits)).toBeLessThanOrEqual(3 * n);
  expect(await f.balance()).toBeGreaterThanOrEqual(0);
}));

test("an overrun end to end: the finished take is shown, charged the hold, marked in words alone, and counted on the admin desk", async () => fixture("hold_e2e", 10_000, async () => {
  const { db, now } = await import("../../lib/db");
  const { getModel } = await import("../../lib/models");
  const { getTask } = await import("../../lib/tasks");
  const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { engineFor } = await import("../../lib/engines");
  const { submitVideoJob } = await import("../../lib/submitVideo");
  const { reconcileGenjutsuVideo } = await import("../../lib/genjutsuVideo");
  const { getGeneration } = await import("../../lib/jobs");
  const { fixtureUrl } = await import("../../lib/mock");
  const { platformDb } = await import("../../lib/platform");
  const { holdOverrunsSince } = await import("../../lib/meter");
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const { overHoldMark, OVER_HOLD_MARK } = await import("../../lib/cinemaHold");
  const { engineTrayJob } = await import("../../lib/jobsTray");
  const id = "gen_hold_over";
  const settings = { ratio: "16:9", resolution: "720p", duration: 5, watermark: false, generateAudio: false, hasVideoInput: false };
  const usd = cinemaStudioQuoteUsd(settings)!;
  const params = { ...settings, higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: usd };
  await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_by,created_at,updated_at) VALUES(?,'video',?,'A harbour at dawn',?,'queued','higgsfield','generate','owner',?,?)",
    args: [id, CINEMA, JSON.stringify(params), now(), now()] });
  await reserveGenerationSpend({ id, kind: "video", engine: "higgsfield", model: CINEMA, status: "running", engineCostUsd: usd }, { holdBand: 3 });
  const engine = engineFor("higgsfield"), render = engine.render, poll = engine.poll;
  const requestId = "5c1d4e1a-2b3c-4d5e-8f90-a1b2c3d4e5f7";
  engine.render = async (req) => ({ handle: { provider: "higgsfield", model: req.kind === "video" ? req.model.id : "", ref: requestId, endpoint: `https://api.higgsfield.ai/requests/${requestId}/status`, credentialFingerprint: req.kind === "video" ? req.params.higgsfieldCredentialFingerprint : undefined } });
  /* The engine says it charged five times the quote: past the 3N hold. */
  engine.poll = async () => ({ status: "succeeded", videoUrl: fixtureUrl("clip.mp4"), totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {}, costUsd: usd * 5 });
  try {
    const job: VideoJob = { genId: id, model: getModel(CINEMA), task: getTask("generate"), prompt: "A harbour at dawn", params, source: null, references: [], ts: now() };
    expect((await submitVideoJob(job)).ok).toBe(true);
    await reconcileGenjutsuVideo(id);
    const gen = (await getGeneration(id))!;
    /* Shown: the take is kept, finished, and charged the hold, never the engine's figure. */
    expect(gen.status).toBe("succeeded");
    expect(gen.storedUrl).toBeTruthy();
    const terms = currentBillingTerms("video", CINEMA);
    expect(gen.creditsBilled).toBe(creditsAtTerms(usd * 3, terms));
    expect(gen.creditsBilled!).toBeLessThanOrEqual(3 * creditsAtTerms(usd, terms));
    expect(overHoldMark(gen.params)).toBe(OVER_HOLD_MARK);
    /* Words alone reach the workspace: no vendor dollar, no overrun figure. */
    expect(gen.costUsd).toBeNull();
    expect(JSON.stringify(gen)).not.toMatch(/overrun/i);
    expect(engineTrayJob({ ...gen, settledAt: gen.settledAt ?? null }, { unit: "cr", reserved: null, charged: gen.creditsBilled, needs: null })).toMatchObject({ stage: "complete", reason: OVER_HOLD_MARK });
    const row = (await platformDb().execute({ sql: "SELECT engine_cost_usd,overrun_usd FROM meter_events WHERE id=?", args: [id] })).rows[0];
    expect(Number(row.engine_cost_usd)).toBeCloseTo(usd * 3, 10);
    expect(Number(row.overrun_usd)).toBeCloseTo(usd * 2, 10);
    const desk = (await holdOverrunsSince(Date.now() - 30 * 86_400_000)).find((r) => r.engine === "higgsfield" && r.model === CINEMA);
    expect(desk?.takes).toBeGreaterThanOrEqual(1);
    expect(desk!.absorbedUsd).toBeGreaterThanOrEqual(usd * 2 - 1e-9);
  } finally { engine.render = render; engine.poll = poll; await unlink(path.resolve(".data/generations", `${id}.mp4`)).catch(() => {}); }
}));

test("only a person approves the hold: an API token (an MCP client) or an Atomik run's own id may price it, never approve it", async () => {
  const { HOLD_NEEDS_A_PERSON } = await import("../../lib/cinemaHold");
  const token: TenantToken = { id: "tok_mcp", name: "MCP client", scope: "render", capUsd: null, capCredits: null };
  const agent: AdmissionActor = { user: { ...OWNER.user, id: "agent:run_1", role: "member", owner: false } };
  for (const [name, as] of [["hold_token", { ...OWNER, token }], ["hold_agent", agent]] as const)
    await fixture(name, 100_000, async (f) => {
      const quote = prepared(await f.admission.prepareGeneration(f.body(), as));
      expect(quote.quote.ceilingCredits, name).toBe(3 * quote.quote.estimatedCredits);
      const reply = await f.post({ ...f.body(), maxCredits: quote.quote.ceilingCredits, quoteFingerprint: quote.quote.fingerprint }, `${name}-approve`);
      expect(reply.status, name).toBe(403);
      expect(await reply.json(), name).toEqual({ error: HOLD_NEEDS_A_PERSON });
      expect(await f.rows(), name).toEqual([]);
      expect(f.dispatches, name).toEqual([]);
    }, as);
  /* The MCP render tool names Seedance only: Cinema Studio is never on its menu, however it is asked. */
  const { runTool } = await import("../../lib/mcp");
  const sent: Record<string, unknown>[] = [];
  const call = async (pathname: string, init: { body?: unknown } = {}) => {
    if (init.body) sent.push(init.body as Record<string, unknown>);
    return pathname.endsWith("/quote") ? { estimatedCredits: 5, price: 5, unit: "cr", fingerprint: "f".repeat(64) } : { id: "gen_mcp" };
  };
  await runTool("render_shot", { prompt: "A harbour at dawn", model: "Cinema Studio 4.0", resolution: "720p" }, call as never, "https://example.invalid", { credits: true });
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) expect(body.model).not.toBe(CINEMA);
});

test("the admin desk counts takes past their hold and the dollars absorbed, per engine, over 30 days, for the platform owner alone", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { holdOverrunsSince } = await import("../../lib/meter");
  await platformReady();
  const at = Date.now();
  const insert = (id: string, model: string, overrun: number | null, updatedAt: number) => platformDb().execute({
    sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at,hold_band,overrun_usd)
          VALUES(?,'ws_desk','video','desk-engine',?,'succeeded',1,30,1,?,?,3,?)`,
    args: [id, model, updatedAt, updatedAt, overrun],
  });
  await insert("desk_a", "desk-model", 1.5, at - 1_000);
  await insert("desk_b", "desk-model", 2.5, at - 86_400_000);
  await insert("desk_old", "desk-model", 9, at - 31 * 86_400_000);
  await insert("desk_none", "desk-model", null, at - 1_000);
  await insert("desk_c", "desk-other", 0.25, at - 1_000);
  const rows = (await holdOverrunsSince(at - 30 * 86_400_000)).filter((r) => r.engine === "desk-engine");
  expect(rows).toEqual([
    { engine: "desk-engine", model: "desk-model", takes: 2, absorbedUsd: 4 },
    { engine: "desk-engine", model: "desk-other", takes: 1, absorbedUsd: 0.25 },
  ]);
  const route = (requireSuperAdmin: () => Promise<unknown>) => load<{ GET(): Promise<Response> }>("app/api/admin/engines/route.ts", {
    "@/lib/recovery": { recoveryRoute: (h: unknown) => h },
    "@/lib/auth": { requireSuperAdmin },
  });
  const refused = await route(async () => ({ response: Response.json({ error: "Not found" }, { status: 404 }) })).GET();
  expect(refused.status).toBe(404);
  const desk = await route(async () => ({ user: { id: "platform-owner" } })).GET();
  expect(desk.status).toBe(200);
  const json = await desk.json() as { overruns: { engine: string; model: string; takes: number; absorbedUsd: number }[] };
  expect(json.overruns.filter((r) => r.engine === "desk-engine")).toEqual(rows);
});
