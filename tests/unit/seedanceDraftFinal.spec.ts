import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import { pinCreditUsd } from "../helpers/creditRate";

/**
 * Seedance 2.5 draft mode (lib/draftFinal.ts): a 480p draft, then a 1080p
 * final made from it.
 *
 *  - the request builders: a draft adds `draft` and the watermark to an
 *    ordinary request; a final sends the draft's task id and only what the
 *    vendor lets a final set again;
 *  - the price: a draft is quoted as any 480p take; a final as a 1080p take on
 *    its draft's input, with or without an input video;
 *  - seven days from the draft, and one final per draft, however it is asked;
 *  - the whole path under ENGINE_MOCK, the mocked engine answering in the
 *    vendor's own task shape: each take is reserved at its quote and settled
 *    at it, once.
 *
 * Nothing leaves this process: the network is forbidden and the engine is the mock.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-draft-final-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "draft-final-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
pinCreditUsd("0.10");
process.env.ENGINE_MOCK = "1";

const SD25 = "dreamina-seedance-2-5-260628";
const SD20 = "dreamina-seedance-2-0-260128";
const DAY = 24 * 60 * 60 * 1000;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const nodeRequire = createRequire(path.resolve("package.json"));
let dispatched: { genId: string; kind: string }[] = [];
const stored: string[] = [];
test.afterAll(async () => {
  await Promise.all(stored.map((id) => unlink(path.join(process.cwd(), ".data", "generations", `${id}.mp4`)).catch(() => {})));
});

function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts"))
        : nodeRequire(name);
    },
    target, target.exports,
  );
  return target.exports as T;
}
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };
function service() {
  const queue = { enqueueRender: async (genId: string, kind: string) => { dispatched.push({ genId, kind }); return true; } };
  const gen = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", { "@/lib/inngest": queue });
  const route = load<{ POST(req: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => actor },
    "@/lib/generationAdmission": gen,
    "next/server": { NextResponse: Response, after: noInline },
  });
  return { gen, route };
}
type Service = ReturnType<typeof service>;

async function scope(name: string, fn: (s: Service) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  await grantCredits(name, 100000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the draft-mode tests"); };
  dispatched = [];
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      await fn(service());
    }, actor);
  } finally {
    globalThis.fetch = fetch;
  }
}

function post(s: Service, body: unknown, key: string) {
  return s.route.POST(new Request("http://localhost/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
  }));
}
async function quote(s: Service, body: Record<string, unknown>) {
  const result = await s.gen.prepareGeneration(body, actor);
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result.body));
  return result.value;
}
async function row(id: string) {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [id] })).rows[0];
}
async function meters() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (await platformDb().execute({ sql: "SELECT id,status,billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [requireTenant().id] })).rows
    .map((r) => ({ id: String(r.id), status: String(r.status), credits: Number(r.billed_credits) }));
}
/** A rendered draft as admission and the engine leave one, `age` ms after its request left. */
async function seedDraft(id: string, options: { age?: number; params?: Record<string, unknown>; status?: string; model?: string } = {}) {
  const { db } = await import("../../lib/db");
  const at = Date.now() - (options.age ?? 60_000);
  await db().execute({
    sql: `INSERT INTO generations(id,project_id,ark_task_id,model,prompt,params,status,stored_url,created_by,created_at,updated_at,provider,task,version)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'byteplus','generate',1)`,
    args: [id, "project", `cgt-draft-${id}`, options.model ?? SD25, "A lighthouse keeper climbs the stair at dusk",
      JSON.stringify({ ratio: "16:9", resolution: "480p", duration: 5, watermark: true, draft: true, task: "generate", references: [], hasVideoInput: false, seed: null, generateAudio: false,
        producedOutcome: { kind: "video", taskId: `cgt-draft-${id}`, queueMs: 0, submitMs: 1 }, ...options.params }),
      options.status ?? "succeeded", options.status === "succeeded" || !options.status ? `/api/media/${id}` : null, "owner", at, at],
  });
}
/** The mocked task as if `ms` had passed since it was sent: the mock's clock is the time in its id. */
async function aged(id: string, ms = 10_000) {
  const { db } = await import("../../lib/db");
  const task = String((await row(id)).ark_task_id);
  const older = task.replace(/_(\d+)$/, (_, t: string) => `_${Number(t) - ms}`);
  await db().execute({ sql: "UPDATE generations SET ark_task_id=? WHERE id=?", args: [older, id] });
  return older;
}

/* ── The requests the vendor is sent ────────────────────────────────────── */

test("a draft is an ordinary request with the draft flag and the watermark, at 480p only", async () => {
  const { buildRequestBody } = await import("../../lib/ark");
  const base = { ratio: "16:9", resolution: "480p", duration: 5, watermark: false, task: "generate" as const };
  const draft = await buildRequestBody(SD25, "A lighthouse at dusk", { ...base, draft: true });
  expect(draft).toMatchObject({ model: SD25, ratio: "16:9", resolution: "480p", duration: 5, draft: true, watermark: true });
  expect(draft.content).toEqual([{ type: "text", text: "A lighthouse at dusk" }]);
  /* Without the flag, the same request carries neither. */
  const plain = await buildRequestBody(SD25, "A lighthouse at dusk", base);
  expect(plain).not.toHaveProperty("draft");
  expect(plain.watermark).toBe(false);
  /* The vendor renders drafts at 480p only, on 2.5 only, as new takes only: anything else is refused before it is sent. */
  await expect(buildRequestBody(SD25, "x", { ...base, resolution: "720p", draft: true })).rejects.toThrow(/480p only/);
  await expect(buildRequestBody(SD20, "x", { ...base, draft: true })).rejects.toThrow(/no draft mode/);
  await expect(buildRequestBody(SD25, "Extend @Video1", { ...base, task: "extend", draft: true })).rejects.toThrow(/new take/);
});

test("a final sends only the draft's task id and what a final may set again: no words, references, length, shape, seed or audio", async () => {
  const { buildRequestBody, buildFinalRequestBody } = await import("../../lib/ark");
  const final = await buildRequestBody(SD25, "the draft's words, which must not travel", {
    ratio: "16:9", resolution: "1080p", duration: 5, watermark: false, seed: 42, generateAudio: true, task: "generate", draftTaskId: "cgt-20260927-draft",
  });
  expect(final).toEqual({
    model: SD25,
    content: [{ type: "draft_task", draft_task: { id: "cgt-20260927-draft" } }],
    resolution: "1080p",
    watermark: false,
  });
  for (const reused of ["ratio", "duration", "seed", "generate_audio", "omni_reference_task_type", "draft"]) expect(final).not.toHaveProperty(reused);
  expect(JSON.stringify(final)).not.toContain("must not travel");
  /* The container is one of the few things a final may set; drafts are for 2.5 alone. */
  expect(buildFinalRequestBody(SD25, "cgt-1", { outputFormat: "mov" })).toMatchObject({ output_format: "mov", resolution: "1080p", watermark: false });
  expect(() => buildFinalRequestBody(SD20, "cgt-1")).toThrow(/no draft mode/);
  expect(() => buildFinalRequestBody(SD25, "not a task id!")).toThrow(/cannot be read/);
});

test("the mocked engine answers drafts and finals in the vendor's task shape, and refuses one at moderation when asked", async () => {
  const { submitTask, fetchTask } = await import("../../lib/ark");
  const { estimateTokens } = await import("../../lib/models");
  const { PreflightError } = await import("../../lib/preflight");
  const base = { ratio: "16:9", duration: 5, watermark: true, task: "generate" as const };
  const older = (id: string) => id.replace(/_(\d+)$/, (_, t: string) => `_${Number(t) - 10_000}`);

  const draft = older(await submitTask(SD25, "A lighthouse", { ...base, resolution: "480p", draft: true }));
  const drafted = await fetchTask(draft);
  expect(drafted).toMatchObject({ status: "succeeded", error: null, totalTokens: estimateTokens("480p", "16:9", 5) });
  expect(drafted.videoUrl).toBeTruthy();
  expect(drafted.raw).toMatchObject({ status: "succeeded", usage: { completion_tokens: estimateTokens("480p", "16:9", 5) } });

  /* A final is metered at 1080p on its draft's input video seconds. */
  const finalParams = { ...base, resolution: "1080p", watermark: false, draftTaskId: draft, inputSeconds: 4 } as Parameters<typeof submitTask>[2];
  const final = older(await submitTask(SD25, "A lighthouse", finalParams));
  expect(await fetchTask(final)).toMatchObject({ status: "succeeded", totalTokens: estimateTokens("1080p", "16:9", 5, 4) });

  /* `[mock:final-refused]` in the draft's words refuses its final (not the draft) the way moderation does. */
  const words = "A lighthouse [mock:final-refused]";
  expect(await fetchTask(older(await submitTask(SD25, words, { ...base, resolution: "480p", draft: true })))).toMatchObject({ status: "succeeded" });
  const refused = await fetchTask(older(await submitTask(SD25, words, finalParams)));
  expect(refused).toMatchObject({ status: "failed", videoUrl: null, totalTokens: null });
  expect(refused.error).toMatch(/sensitive/);
  expect(refused.raw).toMatchObject({ error: { code: "OutputVideoSensitiveContentDetected" } });

  /* Still running a moment after it is sent. */
  expect((await fetchTask(await submitTask(SD25, "A lighthouse", { ...base, resolution: "480p", draft: true }))).status).toBe("running");
  /* A draft the vendor would refuse is refused here too, before anything is sent. */
  await expect(submitTask(SD25, "x", { ...base, resolution: "720p", draft: true })).rejects.toBeInstanceOf(PreflightError);
  await expect(submitTask(SD20, "x", { ...base, resolution: "1080p", draftTaskId: draft })).rejects.toBeInstanceOf(PreflightError);
});

/* ── The price ─────────────────────────────────────────────────────────── */

test("a draft is quoted at exactly the 480p price and a final at a 1080p take's, with and without an input video", async () =>
  scope("draft-quotes", async (s) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const { estimateCostUsd } = await import("../../lib/vendorPricing");
    const take = { model: SD25, prompt: "A lighthouse keeper climbs the stair at dusk", projectId: "project", ratio: "16:9", duration: 5 };

    const normal = await quote(s, { ...take, resolution: "480p" });
    const draft = await quote(s, { ...take, draft: true });
    expect(draft.quote.estimatedCredits).toBe(normal.quote.estimatedCredits);
    expect(draft.quote.estimatedCredits).toBe(billCredits(estimateCostUsd(SD25, "480p", "16:9", 5)!.net, SD25));
    expect(draft.compiled.params).toMatchObject({ resolution: "480p", watermark: true, draft: true });
    expect(normal.compiled.params).toMatchObject({ resolution: "480p", watermark: false });
    expect(normal.compiled.params).not.toHaveProperty("draft");

    await seedDraft("gen_draft_plain");
    const final = await quote(s, { model: SD25, finalOf: "gen_draft_plain" });
    const fullTake = await quote(s, { ...take, resolution: "1080p" });
    expect(final.quote.estimatedCredits).toBe(fullTake.quote.estimatedCredits);
    expect(final.quote.estimatedCredits).toBe(billCredits(estimateCostUsd(SD25, "1080p", "16:9", 5, 0, false)!.net, SD25));
    expect(final.quote.estimatedCredits).toBeGreaterThan(draft.quote.estimatedCredits);
    expect(final.compiled.params).toMatchObject({ resolution: "1080p", watermark: false, finalOf: "gen_draft_plain", ratio: "16:9", duration: 5, hasVideoInput: false });
    expect(final.compiled.references).toEqual([]);

    /* A draft made with an input video: its final is metered on those seconds, at the rate for input that includes video. */
    await seedDraft("gen_draft_video", { params: { hasVideoInput: true, inputSeconds: 6, references: [{ uploadId: "gone-since", role: "reference_video", kind: "video" }] } });
    const withVideo = await quote(s, { model: SD25, finalOf: "gen_draft_video" });
    expect(withVideo.quote.estimatedCredits).toBe(billCredits(estimateCostUsd(SD25, "1080p", "16:9", 5, 6, true)!.net, SD25));
    expect(withVideo.quote.estimatedCredits).not.toBe(final.quote.estimatedCredits);
    expect(withVideo.compiled.params).toMatchObject({ hasVideoInput: true, inputSeconds: 6 });
    /* Its reference is the draft's and is never read again: a reference hidden since does not stop the final. */
    expect(withVideo.compiled.params).not.toHaveProperty("references");
    /* A quote writes nothing and reserves nothing. */
    expect(await meters()).toEqual([]);
  }));

test("drafts are for 2.5, at 480p, as new takes; a final takes nothing but its draft", async () =>
  scope("draft-refusals", async (s) => {
    const take = { model: SD25, prompt: "A lighthouse", projectId: "project", ratio: "16:9", duration: 5 };
    const refused = async (body: Record<string, unknown>, status: number, error: RegExp) => {
      const result = await s.gen.prepareGeneration(body, actor);
      expect(result.ok, JSON.stringify(result)).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(status);
      expect(String(result.body.error)).toMatch(error);
    };
    await refused({ ...take, model: SD20, draft: true }, 400, /no draft mode/);
    await refused({ ...take, draft: true, resolution: "720p" }, 400, /480p/);
    await refused({ ...take, draft: true, task: "extend", sourceGenId: "gen_x" }, 400, /new take/);
    await refused({ ...take, draft: "yes" }, 400, /draft/);
    await seedDraft("gen_draft_one");
    await refused({ model: SD25, finalOf: "gen_draft_one", prompt: "new words" }, 400, /draft alone/);
    await refused({ model: SD25, finalOf: "gen_draft_one", resolution: "1080p" }, 400, /draft alone/);
    await refused({ model: SD20, finalOf: "gen_draft_one" }, 400, /draft's engine/);
    await refused({ model: SD25, finalOf: "gen_missing" }, 404, /no longer/);
    await seedDraft("gen_not_draft", { params: { draft: false } });
    await refused({ model: SD25, finalOf: "gen_not_draft" }, 400, /not a draft/);
    await seedDraft("gen_draft_running", { status: "running" });
    await refused({ model: SD25, finalOf: "gen_draft_running" }, 409, /still rendering/);
    await seedDraft("gen_draft_failed", { status: "failed" });
    await refused({ model: SD25, finalOf: "gen_draft_failed" }, 409, /did not render/);
  }));

/* ── Seven days ────────────────────────────────────────────────────────── */

test("a draft's final is available for seven days from when its request left, read short of the cutoff", async () =>
  scope("draft-expiry", async (s) => {
    const { draftExpiresAt, draftSentAt, draftExpired, draftState, DRAFT_VALID_MS, DRAFT_EXPIRY_MARGIN_MS } = await import("../../lib/draftFinal");
    const born = Date.UTC(2026, 8, 20, 12, 0, 0);
    expect(draftSentAt(born, 1500)).toBe(born + 1500);
    expect(draftSentAt(born, undefined)).toBe(born);
    expect(draftExpiresAt(born)).toBe(born + DRAFT_VALID_MS - DRAFT_EXPIRY_MARGIN_MS);
    expect(DRAFT_VALID_MS).toBe(7 * DAY);
    expect(draftExpired(draftExpiresAt(born), draftExpiresAt(born) - 1)).toBe(false);
    expect(draftExpired(draftExpiresAt(born), draftExpiresAt(born))).toBe(true);
    const draft = { status: "succeeded", params: { draft: true, draftExpiresAt: draftExpiresAt(born) }, createdAt: born };
    expect(draftState(draft, [], born + 6 * DAY)).toEqual({ state: "ready", expiresAt: draftExpiresAt(born), retry: null });
    expect(draftState(draft, [], born + 7 * DAY)).toEqual({ state: "expired", expiresAt: draftExpiresAt(born) });
    expect(draftState({ ...draft, status: "running" }, [], born)).toEqual({ state: "rendering" });
    expect(draftState({ ...draft, status: "failed" }, [], born)).toEqual({ state: "failed" });
    const final = { id: "f1", status: "queued", charged: false, createdAt: born + DAY };
    expect(draftState(draft, [final], born + 8 * DAY)).toEqual({ state: "finalising", finalId: "f1" });
    /* A final held for credits or a slot still holds its draft, and says it is waiting rather than rendering. */
    expect(draftState(draft, [{ ...final, status: "held" }], born + 2 * DAY)).toEqual({ state: "finalising", finalId: "f1", held: true });
    expect(draftState(draft, [{ ...final, status: "succeeded" }], born + 8 * DAY)).toEqual({ state: "final", finalId: "f1" });
    expect(draftState(draft, [{ ...final, status: "failed" }], born + 2 * DAY)).toEqual({ state: "ready", expiresAt: draftExpiresAt(born), retry: "f1" });
    /* A failed final whose outcome kept a charge holds the draft: its task may exist at the vendor. */
    expect(draftState(draft, [{ ...final, status: "failed", charged: true }], born + 2 * DAY)).toEqual({ state: "finalFailed", finalId: "f1" });

    expect(draftState({ ...draft, params: { ...draft.params, finalGenId: "f1" } }, [], born + 2 * DAY)).toEqual({ state: "finalising", finalId: "f1" });

    /* The browser is told the same date the server enforces. */
    const { getGeneration } = await import("../../lib/jobs");
    await seedDraft("gen_draft_week", { age: 7 * DAY });
    const expired = await getGeneration("gen_draft_week");
    expect(expired!.params.draftExpiresAt).toBe(draftExpiresAt(Number((await row("gen_draft_week")).created_at)));
    expect(expired!.params).not.toHaveProperty("producedOutcome");
    const late = await s.gen.prepareGeneration({ model: SD25, finalOf: "gen_draft_week" }, actor);
    expect(late.ok).toBe(false);
    if (!late.ok) { expect(late.status).toBe(409); expect(String(late.body.error)).toMatch(/expired on .* seven days/); }
    await seedDraft("gen_draft_six", { age: 6 * DAY });
    expect((await s.gen.prepareGeneration({ model: SD25, finalOf: "gen_draft_six" }, actor)).ok).toBe(true);
  }));

test("a held final released after its draft's seven days is let go unsent and uncharged", async () =>
  scope("draft-held-expiry", async () => {
    const { submitVideoRow } = await import("../../lib/submitVideo");
    const { db } = await import("../../lib/db");
    await seedDraft("gen_draft_held");
    await db().execute({
      sql: `INSERT INTO generations(id,project_id,model,prompt,params,status,created_by,created_at,updated_at,provider,task,version)
            VALUES('gen_final_late','project',?,?,?,'queued','owner',?,?,'byteplus','generate',2)`,
      args: [SD25, "A lighthouse keeper climbs the stair at dusk",
        JSON.stringify({ ratio: "16:9", resolution: "1080p", duration: 5, watermark: false, task: "generate", draftTaskId: "cgt-draft-gen_draft_held", finalOf: "gen_draft_held", draftExpiresAt: Date.now() - 1000 }),
        Date.now(), Date.now()],
    });
    const out = await submitVideoRow("gen_final_late");
    expect(out).toMatchObject({ ok: false, cls: "fatal" });
    const late = await row("gen_final_late");
    expect(late.status).toBe("failed");
    expect(late.ark_task_id).toBeNull();
    expect(String(late.error)).toMatch(/expired before this final could be sent/);
    expect(Number(late.cost_usd)).toBe(0);
  }));

/* ── One final per draft, and the whole path ───────────────────────────── */

test("draft → final: each reserved at its quote and settled at it, once; a replay and a second final add nothing", async () =>
  scope("draft-final-path", async (s) => {
    const { submitVideoRow } = await import("../../lib/submitVideo");
    const { getGeneration, syncGeneration } = await import("../../lib/jobs");
    const take = { model: SD25, prompt: "A lighthouse keeper climbs the stair at dusk", projectId: "project", ratio: "16:9", duration: 5, refine: false };

    /* The draft, at the 480p price, approved as any take. */
    const draftQuote = await quote(s, { ...take, draft: true });
    const sent = await post(s, { ...take, draft: true, maxCredits: draftQuote.quote.estimatedCredits }, "draft-press-1");
    const draftReply = await sent.json();
    expect(sent.status, JSON.stringify(draftReply)).toBe(202);
    const draftId = String(draftReply.id);
    expect(await meters()).toEqual([{ id: draftId, status: "running", credits: draftQuote.quote.estimatedCredits }]);
    expect(await submitVideoRow(draftId)).toMatchObject({ ok: true });
    await aged(draftId);
    const drafted = await syncGeneration((await getGeneration(draftId))!, { strict: true });
    stored.push(draftId);
    expect(drafted.status).toBe("succeeded");
    expect(drafted.params).toMatchObject({ draft: true, watermark: true, resolution: "480p" });
    expect(drafted.creditsBilled).toBe(draftQuote.quote.estimatedCredits);
    expect(await meters()).toEqual([{ id: draftId, status: "succeeded", credits: draftQuote.quote.estimatedCredits }]);

    /* The final, at a 1080p take's price, approved at exactly that price. */
    const finalQuote = await quote(s, { model: SD25, finalOf: draftId });
    const body = { model: SD25, finalOf: draftId, refine: false, maxCredits: finalQuote.quote.estimatedCredits, quoteFingerprint: finalQuote.quote.fingerprint };
    const first = await post(s, body, "final-press-1");
    const finalReply = await first.json();
    expect(first.status, JSON.stringify(finalReply)).toBe(202);
    const finalId = String(finalReply.id);
    expect(JSON.parse(String((await row(draftId)).params)).finalGenId).toBe(finalId);
    /* Filed where its draft is, with the words its draft rendered (kept, never sent) and the words as typed. */
    const draftRow = await row(draftId);
    expect(await row(finalId)).toMatchObject({ project_id: "project", prompt: draftRow.prompt, task: "generate", status: "queued" });
    expect(JSON.parse(String((await row(finalId)).params)).rawPrompt).toBe(JSON.parse(String(draftRow.params)).rawPrompt);

    /* The same press again (its reply lost) is the same final; another press, tab or key is refused and names it. */
    const replay = await post(s, body, "final-press-1");
    expect((await replay.json()).id).toBe(finalId);
    const second = await post(s, body, "final-press-2");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "This draft already has its final.", finalId });
    const requote = await s.gen.prepareGeneration({ model: SD25, finalOf: draftId }, actor);
    expect(requote.ok).toBe(false);

    /* Sent to the (mocked) engine as a final, settled at the quote. */
    expect(await submitVideoRow(finalId)).toMatchObject({ ok: true });
    await aged(finalId);
    const finished = await syncGeneration((await getGeneration(finalId))!, { strict: true });
    stored.push(finalId);
    expect(finished.status).toBe("succeeded");
    expect(finished.params).toMatchObject({ finalOf: draftId, resolution: "1080p", watermark: false });
    expect(finished.params).not.toHaveProperty("draftTaskId");
    expect(finished.creditsBilled).toBe(finalQuote.quote.estimatedCredits);
    expect(await meters()).toEqual([
      { id: draftId, status: "succeeded", credits: draftQuote.quote.estimatedCredits },
      { id: finalId, status: "succeeded", credits: finalQuote.quote.estimatedCredits },
    ]);
    /* Two paid jobs went to the queue for two presses that were meant: nothing twice. */
    expect(dispatched.map((d) => d.genId)).toEqual([draftId, finalId]);
  }));

test("a final that failed uncharged frees its draft for one more; a failure that kept its charge does not; two at once make one", async () =>
  scope("draft-final-retry", async (s) => {
    const { db } = await import("../../lib/db");
    const { submitVideoRow } = await import("../../lib/submitVideo");
    const { getGeneration, syncGeneration } = await import("../../lib/jobs");
    await seedDraft("gen_draft_retry", { params: {} });
    await db().execute("UPDATE generations SET prompt='A lighthouse keeper [mock:final-refused]' WHERE id='gen_draft_retry'");
    const priced = await quote(s, { model: SD25, finalOf: "gen_draft_retry" });
    const body = { model: SD25, finalOf: "gen_draft_retry", maxCredits: priced.quote.estimatedCredits };

    /* Refused at moderation by the (mocked) engine: failed, and the reservation released. */
    const first = String((await (await post(s, body, "retry-press-1")).json()).id);
    expect(await submitVideoRow(first)).toMatchObject({ ok: true });
    await aged(first);
    const refused = await syncGeneration((await getGeneration(first))!, { strict: true });
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/sensitive/);
    expect((await meters()).find((m) => m.id === first)).toMatchObject({ credits: 0 });

    /* So the draft may make one more, and it is the draft's final from now on. */
    const second = await post(s, body, "retry-press-2");
    const secondId = String((await second.json()).id);
    expect(second.status).toBe(202);
    expect(JSON.parse(String((await row("gen_draft_retry")).params)).finalGenId).toBe(secondId);

    /* A failure whose outcome kept its charge (a lost acknowledgement) holds the draft: its task may exist. */
    await db().execute({ sql: "UPDATE generations SET status='failed', cost_usd=1 WHERE id=?", args: [secondId] });
    const held = await post(s, body, "retry-press-3");
    expect(held.status).toBe(409);
    expect((await held.json()).finalId).toBe(secondId);

    /* A claimed final missing from a read is uncertain, never permission to submit again. */
    await seedDraft("gen_draft_missing_final", { params: { finalGenId: "gen_missing" } });
    const unknown = await post(s, { model: SD25, finalOf: "gen_draft_missing_final", maxCredits: priced.quote.estimatedCredits }, "missing-final-press");
    expect(unknown.status).toBe(409);
    expect((await unknown.json()).finalId).toBe("gen_missing");

    /* Two presses at once on a free draft: one final, one refusal, one reservation. */
    await seedDraft("gen_draft_race");
    const raceBody = { model: SD25, finalOf: "gen_draft_race", maxCredits: priced.quote.estimatedCredits };
    const before = (await meters()).length;
    const [a, b] = await Promise.all([post(s, raceBody, "race-press-a"), post(s, raceBody, "race-press-b")]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((await meters()).length).toBe(before + 1);
    const finals = (await db().execute("SELECT id FROM generations WHERE json_extract(params,'$.finalOf')='gen_draft_race'")).rows;
    expect(finals).toHaveLength(1);
  }));

test("a final cannot cross a workspace boundary or run from a changed approval", async () => {
  await scope("draft-tenant-source", async () => { await seedDraft("gen_private_draft"); });
  await scope("draft-tenant-other", async (s) => {
    const out = await s.gen.prepareGeneration({ model: SD25, finalOf: "gen_private_draft" }, actor);
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(await meters()).toEqual([]);
  });
  await scope("draft-changed-approval", async (s) => {
    const { db } = await import("../../lib/db");
    await seedDraft("gen_changed_draft");
    const priced = await quote(s, { model: SD25, finalOf: "gen_changed_draft" });
    await db().execute("UPDATE generations SET params=json_set(params,'$.generateAudio',json('true')) WHERE id='gen_changed_draft'");
    const out = await post(s, { model: SD25, finalOf: "gen_changed_draft", maxCredits: priced.quote.estimatedCredits, quoteFingerprint: priced.quote.fingerprint }, "changed-approval-press");
    expect(out.status).toBe(409);
    expect(await meters()).toEqual([]);
    expect(dispatched).toEqual([]);
  });
});

test("Takes and the Library draw a draft with its finals: one strip, and side by side in the flat grid", async () => {
  const { groupTakes } = await import("../../lib/variations");
  type T = { id: string; draft?: boolean; finalOf?: string; batchId?: string; variation?: number };
  const takes: T[] = [
    { id: "final2", finalOf: "draftA" },
    { id: "plain" },
    { id: "b2", batchId: "b_abcd", variation: 2 },
    { id: "final1", finalOf: "draftA" },
    { id: "b1", batchId: "b_abcd", variation: 1 },
    { id: "draftA", draft: true },
    { id: "orphan", finalOf: "draftGone" },
    { id: "draftB", draft: true },
  ];
  const cells = groupTakes(takes, (t) => ({ batchId: t.batchId, variation: t.variation }), (t) => (t.draft || t.finalOf ? { id: t.id, draft: Boolean(t.draft), finalOf: t.finalOf ?? null } : null));
  expect(cells.map((c) => (c.kind === "one" ? c.take.id : c.kind === "draft" ? `${c.draft.id}:${c.finals.map((f) => f.id).join("+")}` : `${c.batchId}:${c.takes.map((t) => t.id).join("+")}`)))
    .toEqual(["draftA:final2+final1", "plain", "b_abcd:b1+b2", "orphan", "draftB:"]);
});


test("draft quote keys preserve ordinary take recovery keys and only distinguish drafts", async () => {
  const { quoteKeyFor } = await import("../../lib/workspace/composer");
  const input = { billing: "workspace" as const, type: "video" as const, modelId: SD25,
    settings: { ratio: "16:9", resolution: "480p", duration: 5 }, references: [], prompt: "A lighthouse", seconds: 30, instrumental: true, voiceId: "" };
  const ordinary = quoteKeyFor(input);
  expect(ordinary).toBe(JSON.stringify(["workspace", "video", SD25, "16:9", "480p", 5, "", [], "", 30, true, ""]));
  const draft = quoteKeyFor({ ...input, settings: { ...input.settings, draft: true } });
  expect(JSON.parse(draft)).toEqual([...JSON.parse(ordinary), "draft"]);
});
