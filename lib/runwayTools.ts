import { fundedOutcome } from "./providerFailure";
import { directErrorOutcome, serializeOutcome, silentOutcome, type ProviderOutcome } from "./providerOutcome";
import { db, ready, now, id as newId } from "./db";
import { allowanceCheck } from "./allowance";
import { invalidate, PROJECTS_KEY } from "./cache";
import { creditsApply, quotedCredits } from "./credits";
import { currentTenant, requireTenant } from "./tenant";
import { getShot } from "./shots";
import { checkCap } from "./caps";
import { checkLimits, checkQuota } from "./limits";
import { withRecoveryJob } from "./recovery";
import { withRetry } from "./providers";
import { readUploadBytes, storeVideoBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { findStoredSource, resolveStoredDuration, readStoredSourceBytes, type StoredSource } from "./mediaSource.server";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { uploadOpenableBy, type Viewer } from "./uploadAccess";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { engineEnabled } from "./engineGate";
import { isHouseWorkspace } from "./houseWorkspace";
import { RUNWAY_RATES, type RunwayModel } from "./vendorRates";
import {
  RUNWAY_IMAGE_LIMIT_BYTES, RUNWAY_RESULT_LIFETIME_MS, RUNWAY_SWITCH, RUNWAY_VIDEO_LIMIT_BYTES, RunwayError, deleteTask, fetchOutput, isRunwayModel, pollTask, runwayConfigured, submitTask,
  type RunwayRequest,
} from "./runway";

/**
 * Runway's three tools, DIRECT (lib/runway.ts), on standby: ON for the HOUSE workspace only (the owner's decision, plan § 7: standby, "house only until training-free terms". The plan read Runway's
 * standard terms page (updated 15 Sep 2026) as letting it train on inputs and outputs; dev.runwayml.com says "No training on your data". Which governs is the binding terms,
 * for the owner and counsel; this wall is not changed by either). One door (POST /api/runway { tool }) for the button, Make, a board
 * card, Atomik, a saved skill and an outside agent: the same quote, the same approval, the same price.
 *
 *   `runway_performance`  Act-Two: a performance video drives a character (an image or a clip).
 *   `runway_edit`         Aleph 2: a clip of this workspace edited from words.
 *   `runway_video`        Gen-4.5 or Gen-4 Turbo: a still of this workspace made into a clip.
 *
 * A durable workflow in the take's own row (generations.params.runway; no new table), shaped like lip-sync and FLUX.2: queued, submitted, done | failed | uncertain. A lost
 * acknowledgement is never sent again; one claim that never reached the request settles at nothing. THROTTLED at Runway is a task waiting, not a failure. A finished task's output
 * address expires in 24 to 48 hours, so it is fetched at once from an allow-listed https host and stored under the workspace's own prefix; then the vendor's copy is deleted
 * (`DELETE /v1/tasks/{id}`), retried by the cron up to CLEANUP_MAX_TRIES times and never blocking the take.
 *
 * CONSENT, FINAL (owner, 16 Oct 2026): there is NO face check and no consent record here, for any of the three tools. Particl matches no face and screens no prompt for
 * resemblance; the person generating is responsible, Runway's own filters apply and their refusals are shown as they come. Runway is HOUSE-ONLY (owner, 16 Oct item 8) until
 * counsel answers on Runway's terms.
 *
 * MONEY. Quote: whole seconds (rounded up) x the model's credits a second (RUNWAY_RATES, lib/vendorRates.ts, the plan's table, TO CONFIRM; Aleph 2's 56-credit minimum) at $0.01 a
 * credit, through the margin table (`quotedCredits`, keyed by the model); reserved at the quote; settled at the task's own `cost.credits`, the quote (marked `reconcile`) when it reports none,
 * and never billed above the quote (more reported is recorded as the meter's `overrun_usd` and marked `reconcile`). A failed task Runway did charge for settles at that cost on the ledger line,
 * unbilled; the take reads "Nothing billed" either way (no vendor credit is in anything the workspace reads); a clip lost after the task succeeded is recorded at the reported cost, else the quote. A person approves: `maxCredits` must cover the quote.
 */
export const RUNWAY_TASK = "runway_video";
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const POLL_LEASE_MS = 120_000;
const SUBMIT_GRACE_MS = 10 * 60_000;
export const RUNWAY_POLL_INTERVAL_MS = 5_000;
export const CLEANUP_MAX_TRIES = 5;
const RATIO = /^\d{3,4}:\d{3,4}$/;

export type RunwayToolId = "performance" | "edit" | "video";
export type RunwayState = "queued" | "submitted" | "done" | "failed" | "uncertain";
type Source = { kind: "upload" | "generation"; id: string };
export type RunwayParams = {
  status: RunwayState; tool: RunwayToolId; model: RunwayModel; seconds: number; reservedUsd: number; estimateCredits: number;
  inputs: { clip?: Source; character?: { id: string; media: "image" | "video" }; image?: { id: string } };
  prompt: string | null; ratio: string | null; seed: number | null; bodyControl: boolean; expressionIntensity: number;
  funded: number; claimedAt: number | null; sendingAt: number | null; taskId: string | null; submittedAt: number | null; readyAt: number | null; lastPolledAt: number | null; pollUntil: number | null;
  settled: number; cleanupDue: number; cleanupTries: number; vendorDeleted: number;
  /** What Runway's poll reported the task cost, in dollars (its credits at $0.01), once known; null when it reported none. */
  statedUsd: number | null;
  /** 1 when the figure on the ledger line is ours, not Runway's (none reported, or more than the quote): to be checked against Runway's invoice. */
  reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string; prompt: string };
type Job = { row: Row; runway: RunwayParams };

/** The adapter seams for the workflow, for tests. Public callers (the route, the cron) pass none. */
export type RunwayDeps = {
  submit?: typeof submitTask; poll?: typeof pollTask; fetchClip?: typeof fetchOutput; deleteTask?: typeof deleteTask;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>; clock?: () => number;
};
/** What the admission may be handed in a test. The public admission passes none. `houseOnly: false` lets a test run a workspace that is not the house, to prove the cap wall. */
export type RunwaySeams = { houseOnly?: boolean };

/** Is Runway on here: the engine's switch and list, and the house workspace only. */
export async function runwayOnHere(workspace: { id: string } | null | undefined = currentTenant()?.workspace, seams: RunwaySeams = {}): Promise<boolean> {
  if (!workspace) return false;
  if (seams.houseOnly !== false && !isHouseWorkspace(workspace)) return false;
  return engineEnabled(RUNWAY_SWITCH, workspace);
}

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params, prompt FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, RUNWAY_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let runway: RunwayParams | undefined;
  try { runway = (JSON.parse(row.params) as { runway?: RunwayParams }).runway; } catch { /* unreadable */ }
  return runway && isRunwayModel(runway.model) ? { row, runway } : null;
}
async function patch(genId: string, fields: Partial<RunwayParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.runway.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${entries.map(() => "?,?").join(",")}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, RUNWAY_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── The quote ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Dollars for `seconds` (rounded up to whole seconds) of `model`, to the micro-dollar rounded UP; Aleph 2's minimum applies. */
export function runwayUsd(model: RunwayModel, seconds: number): number {
  const r = RUNWAY_RATES.models[model];
  const credits = Math.max(r.minCredits, Math.ceil(seconds - 1e-9) * r.creditsPerSecond);
  return Math.ceil(credits * RUNWAY_RATES.creditUsd * 1e6 - 1e-6) / 1e6;
}

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

type Found = { source: StoredSource; seconds: number };
async function resolveClip(uploadId: unknown, genId: unknown, viewer: Viewer): Promise<Found | { error: string; status: number }> {
  const up = uploadId ? String(uploadId) : "", gen = genId ? String(genId) : "";
  if ((!up && !gen) || (up && gen)) return { error: "Pick one video original.", status: 400 };
  if ((up && !UPLOAD_ID.test(up)) || (gen && !UPLOAD_ID.test(gen))) return { error: "That source is not valid.", status: 400 };
  const source = await findStoredSource(up ? { uploadId: up } : { genId: gen });
  /* An upload is read only by a person who may open it, for an agent run (as its owner) as for a person. */
  if (!source || source.mediaKind !== "video" || (source.kind === "upload" && !(await uploadOpenableBy(source.id, viewer)))) return { error: "That video original is not in this workspace.", status: 404 };
  if (source.bytes > RUNWAY_VIDEO_LIMIT_BYTES) return { error: "Runway takes a video up to 16 MB here.", status: 400 };
  const length = await resolveStoredDuration(source);
  if (length.seconds == null) return { error: `This video has no measured length, so it cannot be priced per second${length.reason ? `: ${length.reason}` : "."}`, status: 422 };
  return { source, seconds: length.seconds };
}
type Upload = { id: string; ext: string; stored: string; mime: string; bytes: number; kind: string };
/** An upload of this workspace the person may open. */
async function openUpload(id: unknown, viewer: Viewer): Promise<Upload | null> {
  if (typeof id !== "string" || !UPLOAD_ID.test(id)) return null;
  const row = (await db().execute({ sql: "SELECT ext, mime, stored_url, bytes, kind FROM uploads WHERE id=? LIMIT 1", args: [id] })).rows[0];
  if (!row || !(await uploadOpenableBy(id, viewer))) return null;
  return { id, ext: String(row.ext), stored: String(row.stored_url), mime: String(row.mime ?? ""), bytes: Number(row.bytes), kind: String(row.kind ?? "") };
}

export const executeRunwayAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitRunway(input, got, options, {});

/** The same with the test seams. Internal: only the tests import it (tests/unit/runway.spec.ts says so by reading the source). */
export async function admitRunway(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: RunwaySeams): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not the house workspace): the tool is simply not here. */
  if (!(await runwayOnHere(undefined, seams))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const tool = body.tool;
  if (tool !== "performance" && tool !== "edit" && tool !== "video") return admissionReply({ error: "Pick performance, edit or video." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  /* The person this request acts for (the signed-in person, or an Atomik run's owner): none, and nothing is read. */
  const viewer = await actingViewer();
  if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });
  if (!runwayConfigured()) return admissionReply({ error: "This is not set up: RUNWAY_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("runway");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  const bad = (error: string, status = 400) => admissionReply({ error }, { status });
  const ratio = body.ratio == null ? null : typeof body.ratio === "string" && RATIO.test(body.ratio) ? body.ratio : undefined;
  if (ratio === undefined) return bad("Name the shape as width:height, such as 1280:720.");
  let seed: number | null = null;
  if (body.seed != null) { if (!Number.isInteger(body.seed) || (body.seed as number) < 0 || (body.seed as number) > 4294967295) return bad("A seed is a whole number."); seed = body.seed as number; }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length > 1000) return bad("Words are up to 1,000 characters.");

  let model: RunwayModel, seconds: number;
  const inputs: RunwayParams["inputs"] = {};
  let bodyControl = false, expressionIntensity = 3;
  if (tool === "video") {
    model = body.model == null ? RUNWAY_RATES.defaultVideoModel : (body.model as RunwayModel);
    if (model !== "gen4.5" && model !== "gen4_turbo") return bad("Pick gen4.5 or gen4_turbo.");
    const limits = RUNWAY_RATES.models[model];
    seconds = Number(body.duration ?? 5);
    if (!Number.isInteger(seconds) || seconds < limits.minSeconds || seconds > limits.maxSeconds) return bad(`${model} makes ${limits.minSeconds} to ${limits.maxSeconds} seconds.`);
    const image = await openUpload(body.startImageUploadId, viewer);
    if (!image || !image.mime.startsWith("image/")) return bad("Pick a start still from this workspace's image uploads.", 404);
    if (image.bytes > RUNWAY_IMAGE_LIMIT_BYTES) return bad("A start still is up to 5 MB here.");
    if (!prompt) return bad("Write what happens.");
    inputs.image = { id: image.id };
  } else if (tool === "edit") {
    model = "aleph2";
    if (!prompt) return bad("Write what to change.");
    const clip = await resolveClip(body.clipUploadId, body.clipGenId, viewer);
    if ("error" in clip) return bad(clip.error, clip.status);
    const limits = RUNWAY_RATES.models.aleph2;
    if (clip.seconds < limits.minSeconds - 1e-9 || clip.seconds > limits.maxSeconds + 1e-9) return bad(`Aleph 2 takes a clip of ${limits.minSeconds} to ${limits.maxSeconds} seconds.`);
    seconds = Math.ceil(clip.seconds - 1e-9);
    inputs.clip = { kind: clip.source.kind, id: clip.source.id };
  } else {
    model = "act_two";
    const limits = RUNWAY_RATES.models.act_two;
    const clip = await resolveClip(body.performanceClipUploadId, body.performanceClipGenId, viewer);
    if ("error" in clip) return bad(clip.error, clip.status);
    if (clip.seconds < limits.minSeconds - 1e-9 || clip.seconds > limits.maxSeconds + 1e-9) return bad(`Act-Two takes a performance of ${limits.minSeconds} to ${limits.maxSeconds} seconds.`);
    seconds = Math.ceil(clip.seconds - 1e-9);
    inputs.clip = { kind: clip.source.kind, id: clip.source.id };
    const character = await openUpload(body.characterUploadId, viewer);
    if (!character || !(character.mime.startsWith("image/") || character.mime.startsWith("video/"))) return bad("Pick the character from this workspace's image or video uploads.", 404);
    const media = character.mime.startsWith("video/") ? "video" : "image";
    if (character.bytes > (media === "image" ? RUNWAY_IMAGE_LIMIT_BYTES : RUNWAY_VIDEO_LIMIT_BYTES)) return bad(`A character ${media} is up to ${media === "image" ? 5 : 16} MB here.`);
    inputs.character = { id: character.id, media };
    if (body.bodyControl != null && typeof body.bodyControl !== "boolean") return bad("Body control is on or off.");
    bodyControl = body.bodyControl === true;
    if (body.expressionIntensity != null) { const e = body.expressionIntensity; if (!Number.isInteger(e) || (e as number) < 1 || (e as number) > 5) return bad("Expression strength is 1 to 5."); expressionIntensity = e as number; }
  }

  const usd = runwayUsd(model, seconds);
  const estimatedCredits = quotedCredits(usd, model);
  const inCredits = creditsApply(requireTenant());
  let projectId = body.projectId ? String(body.projectId) : null;
  const shotId = body.shotId ? String(body.shotId) : null;
  let shotCode: string | null = null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return bad("That shot is gone.");
    shotCode = shot.code;
    if (projectId && shot.projectId && shot.projectId !== projectId) return bad("That shot belongs to another production.");
    projectId ??= shot.projectId;
  }
  if (projectId && !(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length) return bad("That production is not in this workspace.", 404);
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "runway", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2): with a cap per shot, a member's take past it needs an admin. Refused on the quote and the press, before any face is checked and any row is written, so no failed take is left in the Library. */
  if (shotId && shotCode) {
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: model, isAdmin: shotCapAdmin(got, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool, model, seconds });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return bad("Approve the price first: the estimate is above the approved credit amount.", 409);
  const wall = await allowanceCheck("runway", usd, model);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, model);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(64 * 1024 * 1024);
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(options, body, got, "video", usd, model, { task: RUNWAY_TASK, tool, model, seconds, prompt, ratio, seed, inputs, bodyControl, expressionIntensity, projectId, shotId }, { engine: "runway" });
  if (stopped) return stopped;


  const genId = newId("gen"), ts = now();
  const runway: RunwayParams = {
    status: "queued", tool, model, seconds, reservedUsd: usd, estimateCredits: estimatedCredits, inputs, prompt: prompt || null, ratio, seed, bodyControl, expressionIntensity,
    funded: 0, claimedAt: null, sendingAt: null, taskId: null, submittedAt: null, readyAt: null, lastPolledAt: null, pollUntil: null, settled: 0, cleanupDue: 0, cleanupTries: 0, vendorDeleted: 0, statedUsd: null, reconcile: 0,
  };
  const params = { task: RUNWAY_TASK, job: tool === "video" ? "other" : "fix", runway, estUsd: usd, estCredits: 0 };
  const title = `${tool === "performance" ? "Performance" : tool === "edit" ? "Edit" : "Video"} · ${(prompt || model).slice(0, 60)}`.slice(0, 80);
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "video", model, prompt || `${tool} · ${model}`, JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "runway", "generate", title, "runway", shotId],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "video", engine: "runway", model, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was submitted. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The reservation could not be made.";
    await settleRunway(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the job runs in this request's continuation, polling for a while, and the ten-minute cron picks up whatever is still running. */
  await options.defer(() => driveRunway(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, tool, model, seconds, notices: capV.notice ? [capV.notice] : undefined });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. */
export async function settleRunway(
  genId: string, status: "done" | "failed",
  outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; said?: ProviderOutcome | null; reconcile?: boolean },
): Promise<void> {
  const job = await load(genId);
  if (!job || job.runway.settled) return;
  const { row, runway } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "runway").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  /* A finished task is charged at most the quote, whatever Runway reports: what it reports past the quote is recorded as the overrun (the platform's, marked to reconcile), never billed.
     A failure Runway charged for is recorded at that cost on the ledger line (never above the quote) and billed to nobody. */
  const cost = Math.min(Math.max(0, outcome.costUsd), runway.reservedUsd);
  const overrunUsd = outcome.costUsd > runway.reservedUsd + 1e-9 ? Math.round((outcome.costUsd - runway.reservedUsd) * 1e6) / 1e6 : null;
  const reconcile = outcome.reconcile === true || overrunUsd !== null;
  const write = ok
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, duration_s=?,
                params=json_set(params,'$.runway.status','done','$.runway.settled',1,'$.runway.cleanupDue',1,'$.runway.reconcile',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, cost, ms, runway.seconds, reconcile ? 1 : 0, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?, provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.runway.status','failed','$.runway.settled',1,'$.runway.cleanupDue',?,'$.runway.reconcile',?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The task failed.").slice(0, 600), ms, cost, said ? serializeOutcome(said) : null, runway.taskId ? 1 : 0, reconcile ? 1 : 0, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: "video", engine: "runway", model: runway.model, status: ok ? "succeeded" : "failed", engineCostUsd: cost, durationMs: ms,
    projectId: row.project_id, shotId: row.shot_id, createdBy: row.created_by,
    ...(!ok && cost > 0 ? { unbilled: true } : {}),
    ...(overrunUsd !== null ? { overrunUsd } : {}),
    ...(said ? { providerOutcome: said } : {}),
  });
  await deliverGenerationSettlement(genId);
  invalidate(PROJECTS_KEY);
}

/* ── The machine ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback).slice(0, 300);

/** Public: no seams (the cron and the continuation call this one). */
export const advanceRunwayJob = (genId: string): Promise<RunwayParams | null> => advanceRunwayJobWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceRunwayJobWith(genId: string, deps: RunwayDeps): Promise<RunwayParams | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, genId, async () => {
    let job = await load(genId);
    if (!job) return null;
    if (job.runway.settled || ["uncertain", "failed", "done"].includes(job.runway.status)) return job.runway;
    if (job.runway.status === "queued") {
      if (!job.runway.funded) return job.runway;
      const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.runway.status')='queued' AND json_extract(params,'$.runway.funded')=1 AND json_extract(params,'$.runway.claimedAt') IS NULL AND status='running'" });
      if (!claimed) {
        // Someone holds the claim. A young claim is a submission in flight; an old one with no task id is a lost acknowledgement, unless it never reached the request.
        const held = (await load(genId))?.runway;
        if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
          if (!held.sendingAt) await settleRunway(genId, "failed", { message: "Nothing was submitted: the job stopped before it was sent. Nothing was billed.", costUsd: 0 });
          else await patch(genId, { status: "uncertain" });
        }
        return (await load(genId))?.runway ?? null;
      }
      job = (await load(genId))!;
      const { runway, row } = job;
      /* The inputs are read before anything is sent: one that cannot be read submits nothing and refunds everything. */
      let request: RunwayRequest;
      try {
        const image = async (id: string) => {
          const up = (await db().execute({ sql: "SELECT ext, mime, stored_url FROM uploads WHERE id=? LIMIT 1", args: [id] })).rows[0];
          if (!up) throw new Error("An input is no longer available in this workspace.");
          return { bytes: await readUploadBytes(id, String(up.ext), String(up.stored_url), RUNWAY_VIDEO_LIMIT_BYTES), mime: String(up.mime), kind: String(up.mime).startsWith("video/") ? ("video" as const) : ("image" as const) };
        };
        const clip = async (s: Source) => {
          const found = await findStoredSource(s.kind === "upload" ? { uploadId: s.id } : { genId: s.id });
          if (!found) throw new Error("A source is no longer available in this workspace.");
          return { bytes: await readStoredSourceBytes(found, RUNWAY_VIDEO_LIMIT_BYTES), mime: found.mime || "video/mp4" };
        };
        const common = { ...(runway.ratio ? { ratio: runway.ratio } : {}), ...(runway.seed != null ? { seed: runway.seed } : {}) };
        if (runway.tool === "performance") {
          const c = await image(runway.inputs.character!.id);
          request = { tool: "performance", character: { bytes: c.bytes, mime: c.mime, kind: c.kind }, reference: await clip(runway.inputs.clip!), bodyControl: runway.bodyControl, expressionIntensity: runway.expressionIntensity, ...common };
        } else if (runway.tool === "edit") request = { tool: "edit", video: await clip(runway.inputs.clip!), prompt: row.prompt, ...common };
        else { const i = await image(runway.inputs.image!.id); request = { tool: "video", model: runway.model as "gen4.5" | "gen4_turbo", image: { bytes: i.bytes, mime: i.mime }, prompt: row.prompt, duration: runway.seconds, ...common }; }
      } catch (error) {
        await settleRunway(genId, "failed", { message: `Nothing was submitted: ${messageOf(error, "an input could not be read.")} Nothing was billed.`, costUsd: 0 });
        return (await load(genId, { any: true }))?.runway ?? null;
      }
      try {
        await patch(genId, { sendingAt: clock() });
        const sent = await (deps.submit ?? submitTask)(request);
        await patch(genId, { status: "submitted", taskId: sent.id, submittedAt: clock() });
      } catch (error) {
        if (error instanceof RunwayError && error.rejectedBeforeGeneration) {
          // Refused before the task was taken: the whole reservation comes back.
          await settleRunway(genId, "failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: directErrorOutcome("runway", error.status ?? 400, error.message) });
          return (await load(genId, { any: true }))?.runway ?? null;
        }
        // A timeout, a throttle or a dropped connection: Runway may hold a charged task under an id we never saw. Held for review, never sent again.
        await patch(genId, { status: "uncertain" });
        await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
        return (await load(genId))?.runway ?? null;
      }
      job = (await load(genId))!;
    }
    const runway = job.runway;
    if (!runway.taskId) return runway;
    // One poller at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const leased = await patch(genId, { pollUntil: until }, { sql: "json_extract(params,'$.runway.settled')=0 AND COALESCE(json_extract(params,'$.runway.pollUntil'),0)<?", args: [clock()] });
    if (!leased) return runway;
    try {
      await patch(genId, { lastPolledAt: clock() });
      /* Past the window an output address lives, a finished task's clip is lost. Runway made it, so it charged: the workspace is billed nothing, and the ledger line records Runway's reported
         cost, else the quote, unbilled and marked to reconcile when the figure is ours. */
      if (runway.readyAt && clock() - Number(runway.readyAt) > RUNWAY_RESULT_LIFETIME_MS - 3600_000) {
        await settleRunway(genId, "failed", { message: "The clip was ready but could not be saved in time. Nothing was billed.", costUsd: runway.statedUsd ?? runway.reservedUsd, reconcile: runway.statedUsd == null, said: silentOutcome("runway", "run", "not_kept", "result expired before it was saved") });
        return (await load(genId, { any: true }))?.runway ?? null;
      }
      const state = await (deps.poll ?? pollTask)(runway.taskId);
      if (state.status === "failed") {
        /* The workspace reads "Nothing billed" whatever Runway charged: no vendor credit appears in anything it reads. A failed task Runway charged for is recorded at what it reports on the
           platform ledger line only (unbilled; never above the quote, the excess as the overrun); none reported is 0, marked to reconcile. */
        const charged = state.costCredits != null && state.costCredits > 0 ? state.costCredits * RUNWAY_RATES.creditUsd : 0;
        await settleRunway(genId, "failed", { message: `${state.failure} Nothing was billed.`, costUsd: charged, reconcile: state.costCredits == null, said: silentOutcome("runway", "run", "failed", state.failure) });
        await cleanupRunwayVendor(genId, deps).catch(() => {});
        return (await load(genId, { any: true }))?.runway ?? null;
      }
      if (state.status !== "succeeded") return (await load(genId))?.runway ?? null;
      if (!runway.readyAt) await patch(genId, { readyAt: clock(), statedUsd: state.costCredits != null ? state.costCredits * RUNWAY_RATES.creditUsd : null });
      /* The moment it is done: fetched and stored, before anything else. Never fetched with our key, only from an allow-listed https address. */
      const bytes = await (deps.fetchClip ?? fetchOutput)(state.outputUrl);
      const { value: stored } = await withRetry(() => (deps.store ?? storeVideoBytes)(genId, bytes), { max: 3 });
      /* Runway's own figure (credits at $0.01; "fully refunded tasks report 0"), else the quote and marked to reconcile; never billed above the quote (settleRunway records the excess as the overrun and marks it). */
      await settleRunway(genId, "done", { costUsd: state.costCredits != null ? state.costCredits * RUNWAY_RATES.creditUsd : runway.reservedUsd, reconcile: state.costCredits == null, storedUrl: stored.url, bytes: stored.bytes });
      await cleanupRunwayVendor(genId, deps).catch(() => {});
      return (await load(genId, { any: true }))?.runway ?? null;
    } catch (error) {
      // Transport or storage: keep the id and the reservation; the next pass asks again (the output address still lives). Nothing is resubmitted.
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [messageOf(error, "The clip could not be collected yet."), now(), genId] });
      throw error;
    } finally {
      await patch(genId, { pollUntil: null }, { sql: "json_extract(params,'$.runway.pollUntil')=?", args: [until] }).catch(() => {});
    }
  });
}

/** Deletes the vendor's copy of a finished task, once the output is stored (or the task failed). A failure is retried by the cron up to CLEANUP_MAX_TRIES times and never blocks the take. */
export async function cleanupRunwayVendor(genId: string, deps: RunwayDeps = {}): Promise<void> {
  const job = await load(genId, { any: true });
  if (!job || !job.runway.cleanupDue || !job.runway.taskId) return;
  try {
    if (await (deps.deleteTask ?? deleteTask)(job.runway.taskId)) { await patch(genId, { cleanupDue: 0, vendorDeleted: 1 }); return; }
  } catch { /* retried below */ }
  const tries = job.runway.cleanupTries + 1;
  await patch(genId, tries >= CLEANUP_MAX_TRIES ? { cleanupTries: tries, cleanupDue: 0 } : { cleanupTries: tries });
  if (tries >= CLEANUP_MAX_TRIES) console.error(JSON.stringify({ level: "error", event: "runway.vendor_copy_not_deleted", generation: genId }));
}

/** Runs a job in this request's own continuation: steps and short pauses until it ends or the time is up; the cron takes over after. */
export async function driveRunway(genId: string, options: { budgetMs?: number; pauseMs?: number } = {}): Promise<void> {
  const until = Date.now() + (options.budgetMs ?? 240_000);
  for (;;) {
    const runway = await advanceRunwayJob(genId).catch(() => null);
    if (!runway || runway.settled || runway.status === "uncertain" || runway.status === "done" || runway.status === "failed" || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? RUNWAY_POLL_INTERVAL_MS));
  }
}

/** The cron's stage: queued and submitted tasks are advanced (a finished one is collected at once), and finished tasks whose vendor copy is still there are cleaned up. Uncertain and terminal rows are left alone. */
export async function recoverRunwayJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: RunwayDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.runway.status') IN ('queued','submitted') ORDER BY updated_at ASC LIMIT ?`,
    args: [RUNWAY_TASK, limit],
  })).rows.map((r) => String(r.id));
  const cleaning = (await db().execute({
    sql: `SELECT id FROM generations WHERE json_extract(params,'$.task')=? AND json_extract(params,'$.runway.cleanupDue')=1 ORDER BY updated_at ASC LIMIT ?`,
    args: [RUNWAY_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await advanceRunwayJobWith(id, deps); } catch { failed++; }
  }
  for (const id of cleaning) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await cleanupRunwayVendor(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tools ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const COMMON = { provider: "runway", kind: "engine" as const, route: "/api/runway", needs: ["RUNWAY_API_KEY", "RUNWAY_ENABLED"], who: "prepare: anyone; approve: a person" as const };
/** The three tools, declared beside their handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer. */
export const RUNWAY_TOOLS = [
  { ...COMMON, id: "runway_performance", tool: "performance" as const, models: ["act_two"], inputs: { performanceClipUploadId: "a 3 to 30 s performance video", characterUploadId: "the character, an image or a clip", maxCredits: "the approved price" }, output: "a video take" },
  { ...COMMON, id: "runway_edit", tool: "edit" as const, models: ["aleph2"], inputs: { clipUploadId: "a 2 to 30 s video", prompt: "what to change", maxCredits: "the approved price" }, output: "a video take" },
  { ...COMMON, id: "runway_video", tool: "video" as const, models: ["gen4.5", "gen4_turbo"], inputs: { startImageUploadId: "a start still", prompt: "what happens", duration: "2 to 10 seconds", model: "gen4.5 (default) or gen4_turbo", ratio: "width:height", maxCredits: "the approved price" }, output: "a video take" },
];

/** The tools present for a workspace: none unless Runway is on here (its switch, and the house workspace only). No face check gates any of them. */
export async function runwayTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof RUNWAY_TOOLS> {
  return (await runwayOnHere(workspace)) ? RUNWAY_TOOLS : [];
}
