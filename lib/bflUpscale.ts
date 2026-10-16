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
import { readOriginalBytesLimited, readUploadBytes, storeVideoBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { findStoredSource } from "./mediaSource.server";
import { inspectOriginalVideo } from "./videoMetadata.server";
import type { Reference } from "./ark";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { uploadOpenableBy } from "./uploadAccess";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { engineEnabled } from "./engineGate";
import { BFL_UPSCALE_RATES, type BflUpscaleMode } from "./vendorRates";
import { BFL_SWITCH, BFL_VIDEO_RESULT_LIFETIME_MS, BflError, bflConfigured, fetchVideoResult, pollImage, submitUpscale } from "./bfl";

/**
 * FLUX Video Upscale through BFL (lib/bfl.ts `submitUpscale`): a clip of this workspace in, the same take made larger out. **Video only**: BFL's public API has no image upscale, so a still is
 * Topaz's job. Two modes, chosen by the person and never by us: **Precise** (the default; keeps the source and sharpens it) and **Creative** (restores and invents detail more aggressively), which is
 * offered only as an explicit `mode: "creative"` and always carries the sentence in `CREATIVE_NOTE`. One door (POST /api/bfl { tool: "upscale" }, beside FLUX.2's two) for the button, Make, a board card,
 * Atomik, a saved skill and an outside agent: the same quote, the same approval, the same price. An ASYNCHRONOUS vendor job kept as a durable workflow in the take's own row
 * (generations.params.bflUpscale; no new table), shaped like FLUX.2 (lib/bflImage.ts) and Topaz's clip (lib/topazUpscale.ts):
 *
 *   queued     admitted and funded (the reservation is the whole price)
 *   submitted  the job is with BFL (an id and the polling address BFL named)
 *   done       the clip is fetched THE MOMENT it is Ready (its signed address lives about an hour), STORED under the workspace's own prefix, the take settled
 *   failed     refused before work (settled at NOTHING, "Nothing billed"); moderated or failed after submission, or its clip lost past the window: the workspace is billed nothing and the ledger line
 *              records what BFL charged
 *   uncertain  the submission's acknowledgement was lost. Nothing here ever submits a second time: a lost reply may still be a charged job
 *
 * MONEY. Quote: the output megapixels of one frame (the source's size times the factor, capped at BFL's 13.75 MP, rounded up to 0.01) times the clip's seconds, times the mode's rate per megapixel-second
 * (BFL_UPSCALE_RATES in lib/vendorRates.ts; TO CONFIRM against BFL's pricing page and the first invoice), scaled up when the source runs faster than BFL's standard 24 fps (never under), through the margin
 * table keyed by the mode's model (`quotedCredits`); reserved at the quote on the meter; settled at the cost BFL states when it states one, else at the quote (marked `reconcile`), and NEVER billed above the
 * quote (a stated figure above it settles at the quote, the excess is recorded as the meter's `overrun_usd` and marked `reconcile`). A failure BFL charged for is recorded on the ledger line at its cost, unbilled.
 * A person approves: `maxCredits` must cover the quote, and an upscale is a finishing step, so it is always asked.
 *
 * PRIVACY. The clip is read from this workspace (an upload only by a person who may open it: the signed-in person, or an Atomik run's owner; a take of the workspace) and sent as data, never as a link of ours.
 * BFL's privacy policy allows training on inputs and outputs unless the account has opted out (the owner has done the opt-out in BFL's dashboard; counsel before any customer switch). No face is checked
 * (owner, 16 Oct 2026): Precise is the default and Creative carries its note, because Creative "can drift on faces and products".
 */
export const BFL_UPSCALE_TASK = "bfl_upscale";
export const BFL_UPSCALE_TOOL_ID = "flux_upscale";
/** Shown wherever Creative is chosen or priced: on the quote, on the admission's notices, and in the tool's own words. */
export const CREATIVE_NOTE = "Faces and products may change.";
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STEER = 1000;
const MIN_SIDE = 64;
const POLL_LEASE_MS = 120_000;
const SUBMIT_GRACE_MS = 10 * 60_000;
export const BFL_UPSCALE_POLL_INTERVAL_MS = 5_000;

export const bflUpscaleModel = (mode: BflUpscaleMode): string => `bfl/flux-upscale/${mode}`;
export const isUpscaleMode = (v: unknown): v is BflUpscaleMode => typeof v === "string" && Object.hasOwn(BFL_UPSCALE_RATES.modes, v);

export type BflUpscaleState = "queued" | "submitted" | "done" | "failed" | "uncertain";
export type BflUpscaleParams = {
  status: BflUpscaleState; mode: BflUpscaleMode; model: string; factor: number; steer: string | null;
  source: { kind: "upload" | "generation"; id: string };
  inputWidth: number; inputHeight: number; outputWidth: number; outputHeight: number; outputMegapixels: number; seconds: number; sourceFps: number; megapixelSeconds: number;
  reservedUsd: number; estimateCredits: number;
  funded: number; claimedAt: number | null; sendingAt: number | null; bflId: string | null; pollingUrl: string | null; statedUsd: number | null;
  submittedAt: number | null; readyAt: number | null; lastPolledAt: number | null; pollUntil: number | null; settled: number;
  /** 1 when the figure on the ledger line is ours, not BFL's (none stated, or BFL stated more than the quote): to be checked against BFL's invoice. */
  reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string };
type Job = { row: Row; up: BflUpscaleParams };

/** The adapter seams for the workflow, for tests. Public callers (the route, the cron) pass none. */
export type BflUpscaleDeps = {
  submit?: typeof submitUpscale; poll?: typeof pollImage; fetchVideo?: typeof fetchVideoResult;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>; clock?: () => number;
};

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, BFL_UPSCALE_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let up: BflUpscaleParams | undefined;
  try { up = (JSON.parse(row.params) as { bflUpscale?: BflUpscaleParams }).bflUpscale; } catch { /* unreadable */ }
  return up && isUpscaleMode(up.mode) ? { row, up } : null;
}
async function patch(genId: string, fields: Partial<BflUpscaleParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.bflUpscale.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${entries.map(() => "?,?").join(",")}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, BFL_UPSCALE_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── The quote ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/**
 * The price in dollars of upscaling a clip, or a refusal in words. Pure. `fps` is the source's: BFL's rate is at 24 fps and "higher frame rates scale charges proportionally", so a faster source is quoted
 * proportionally higher (never under; what BFL then states at submission is what is settled).
 */
export function bflUpscaleQuote(input: { width: number; height: number; seconds: number; fps: number; factor: number; mode: BflUpscaleMode }):
  { usd: number; outputWidth: number; outputHeight: number; outputMegapixels: number; megapixelSeconds: number } | { error: string } {
  const r = BFL_UPSCALE_RATES;
  const { width, height, seconds, fps, factor, mode } = input;
  if (!(factor >= r.factor.min && factor <= r.factor.max)) return { error: `Pick a scale from ${r.factor.min} to ${r.factor.max}.` };
  if (![width, height, seconds, fps].every((n) => Number.isFinite(n) && n > 0)) return { error: "The clip's size, length or frame rate is not known, so it cannot be priced." };
  let w = width * factor, h = height * factor;
  const rawMp = (w * h) / r.pixelsPerMp;
  if (rawMp > r.maxOutputMp) { const shrink = Math.sqrt(r.maxOutputMp / rawMp); w *= shrink; h *= shrink; }
  const outputMegapixels = Math.min(r.maxOutputMp, Math.ceil(Math.min(rawMp, r.maxOutputMp) * 100 - 1e-9) / 100);
  const secondsUp = Math.ceil(seconds * 1000 - 1e-6) / 1000;
  const megapixelSeconds = outputMegapixels * secondsUp * Math.max(1, fps / r.standardFps);
  /* Rounded UP to the micro-dollar, so a quote is never under. */
  return { usd: Math.ceil(megapixelSeconds * r.modes[mode].usdPerMpSecond * 1e6 - 1e-6) / 1e6, outputWidth: even(w), outputHeight: even(h), outputMegapixels, megapixelSeconds: Math.round(megapixelSeconds * 1e4) / 1e4 };
}

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const executeBflUpscaleAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitBflUpscale(input, got, options);

/** The admission. Internal: only the tests and the door import it. */
export async function admitBflUpscale(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(BFL_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  if (body.tool !== "upscale") return admissionReply({ error: "Pick upscale." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!bflConfigured()) return admissionReply({ error: "This is not set up: BFL_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("bfl");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  /* Precise unless the person said Creative: BFL's own default is Creative, ours is not. */
  if (body.mode != null && !isUpscaleMode(body.mode)) return admissionReply({ error: "Pick precise or creative." }, { status: 400 });
  const mode: BflUpscaleMode = isUpscaleMode(body.mode) ? body.mode : BFL_UPSCALE_RATES.defaultMode;
  const factor = body.factor == null ? BFL_UPSCALE_RATES.factor.default : Number(body.factor);
  if (typeof body.factor === "boolean" || !Number.isFinite(factor) || factor < BFL_UPSCALE_RATES.factor.min || factor > BFL_UPSCALE_RATES.factor.max)
    return admissionReply({ error: `Pick a scale from ${BFL_UPSCALE_RATES.factor.min} to ${BFL_UPSCALE_RATES.factor.max}.` }, { status: 400 });
  const steer = body.prompt == null ? null : typeof body.prompt === "string" ? body.prompt.trim() : undefined;
  if (steer === undefined || (steer !== null && steer.length > MAX_STEER)) return admissionReply({ error: `Describe the clip in up to ${MAX_STEER} characters, or leave it empty.` }, { status: 400 });

  /* The source: one clip of this workspace. An upload is read only for the person this request acts for (the signed-in person, or an Atomik run's owner): none, and nothing is read. */
  const up = body.sourceUploadId ? String(body.sourceUploadId) : "", gen = body.sourceGenId ? String(body.sourceGenId) : "";
  if ((!up && !gen) || (up && gen)) return admissionReply({ error: "Pick one clip to upscale." }, { status: 400 });
  if ((up && !SOURCE_ID.test(up)) || (gen && !SOURCE_ID.test(gen))) return admissionReply({ error: "That source is not valid." }, { status: 400 });
  if (up) {
    const viewer = await actingViewer();
    if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });
    if (!(await uploadOpenableBy(up, viewer))) return admissionReply({ error: "That clip is not in this workspace." }, { status: 404 });
  }
  const found = await findStoredSource(up ? { uploadId: up } : { genId: gen });
  if (!found || found.mediaKind !== "video") return admissionReply({ error: "That clip is not in this workspace." }, { status: 404 });
  if (found.demo) return admissionReply({ error: "A starter clip is a sample, not a stored original: upscale a clip of your own." }, { status: 400 });
  if (!/^(mp4|m4v)$/.test(String(found.ext).toLowerCase())) return admissionReply({ error: "FLUX Upscale takes MP4 clips." }, { status: 400 });
  const R = BFL_UPSCALE_RATES;
  if (!(found.bytes > 0) || found.bytes > R.maxSourceBytes) return admissionReply({ error: `FLUX Upscale takes clips up to ${R.maxSourceBytes / 1024 / 1024} MB.` }, { status: 400 });
  const ref: Reference = { id: found.id, mime: found.mime || "video/mp4", ext: found.ext || "mp4", storedUrl: String(found.storedUrl ?? ""), role: "reference_video", kind: "video", fromGeneration: found.kind === "generation" };
  let meta: Awaited<ReturnType<typeof inspectOriginalVideo>>;
  try { meta = await inspectOriginalVideo(ref, found.bytes, true, { maxSeconds: R.maxSeconds }); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
  const [long, short] = meta.width >= meta.height ? [meta.width, meta.height] : [meta.height, meta.width];
  if (long > R.maxInputWidth || short > R.maxInputHeight || meta.width * meta.height > R.maxInputWidth * R.maxInputHeight)
    return admissionReply({ error: `FLUX Upscale takes clips up to ${R.maxInputWidth} by ${R.maxInputHeight}; this one is ${meta.width} by ${meta.height}.` }, { status: 400 });
  if (short < MIN_SIDE || long > short * 4) return admissionReply({ error: "FLUX Upscale takes clips at least 64 pixels across and no wider than 4 to 1." }, { status: 400 });
  const fps = meta.fps && meta.fps > 0 ? meta.fps : 30;
  const priced = bflUpscaleQuote({ width: meta.width, height: meta.height, seconds: meta.seconds, fps, factor, mode });
  if ("error" in priced) return admissionReply({ error: priced.error }, { status: 400 });
  const usd = priced.usd;
  const model = bflUpscaleModel(mode);
  const notices: string[] = mode === "creative" ? [CREATIVE_NOTE] : [];

  let projectId = body.projectId ? String(body.projectId) : null;
  const shotId = body.shotId ? String(body.shotId) : null;
  let shotCode: string | null = null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return admissionReply({ error: "That shot is gone." }, { status: 400 });
    shotCode = shot.code;
    if (projectId && shot.projectId && shot.projectId !== projectId) return admissionReply({ error: "That shot belongs to another production." }, { status: 400 });
    projectId ??= shot.projectId;
  }
  if (projectId && !(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length) return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });
  /* The approval unit, through the margin table keyed by the mode's model. No number of ours here. */
  const estimatedCredits = quotedCredits(usd, model);
  const inCredits = creditsApply(requireTenant());
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "bfl", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2): with a cap per shot, a member's take past it needs an admin. Refused on the quote and the press, before any row is written, so no failed take is left in the Library. */
  if (shotId && shotCode) {
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: model, isAdmin: shotCapAdmin(got, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly)
    return admissionReply({
      estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool: "upscale", model, mode, factor,
      outputWidth: priced.outputWidth, outputHeight: priced.outputHeight, seconds: Math.round(meta.seconds * 1000) / 1000, megapixels: priced.outputMegapixels,
      ...(notices.length ? { notices } : {}),
    });
  const wall = await allowanceCheck("bfl", usd, model);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, model);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(Math.min(512 * 1024 * 1024, found.bytes * 8));
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(options, body, got, "video", usd, model, { task: BFL_UPSCALE_TASK, tool: "upscale", model, mode, factor, source: { kind: found.kind, id: found.id }, outputWidth: priced.outputWidth, outputHeight: priced.outputHeight, seconds: meta.seconds, projectId, shotId }, { engine: "bfl" });
  if (stopped) return stopped;
  /* The approval comes after the checkpoint: preparing a quote ends at the checkpoint, and only the admission that follows it carries the approved amount. */
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });

  const genId = newId("gen"), ts = now();
  const params0: BflUpscaleParams = {
    status: "queued", mode, model, factor, steer, source: { kind: found.kind, id: found.id },
    inputWidth: meta.width, inputHeight: meta.height, outputWidth: priced.outputWidth, outputHeight: priced.outputHeight, outputMegapixels: priced.outputMegapixels,
    seconds: Math.round(meta.seconds * 1000) / 1000, sourceFps: fps, megapixelSeconds: priced.megapixelSeconds, reservedUsd: usd, estimateCredits: estimatedCredits,
    funded: 0, claimedAt: null, sendingAt: null, bflId: null, pollingUrl: null, statedUsd: null, submittedAt: null, readyAt: null, lastPolledAt: null, pollUntil: null, settled: 0, reconcile: 0,
  };
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(priced.outputWidth, priced.outputHeight);
  const lineage = found.kind === "generation" ? { sourceGenId: found.id } : { sourceUploadId: found.id };
  const params = {
    task: BFL_UPSCALE_TASK, job: "fix", bflUpscale: params0, ...lineage, estUsd: usd, estCredits: 0, ratio: `${priced.outputWidth / g}:${priced.outputHeight / g}`, size: `${priced.outputWidth}x${priced.outputHeight}`,
    resolution: priced.outputHeight > 1080 ? "4k" : "1080p", duration: Math.round(meta.seconds),
  };
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id, source_gen_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "video", model, `Upscale · ${found.name}`.slice(0, 5000), JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "bfl", "upscale", `${found.name.replace(/\.[A-Za-z0-9]{1,8}$/, "")} · upscaled`.slice(0, 80), "bfl", shotId, found.kind === "generation" ? found.id : null],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "video", engine: "bfl", model, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was submitted. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The reservation could not be made.";
    await settleBflUpscale(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the job runs in this request's continuation, polling every few seconds, and the ten-minute cron picks up whatever is still running. */
  await options.defer(() => driveBflUpscale(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, model, mode, notices: [...notices, ...(capV.notice ? [capV.notice] : [])] });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing. */
export async function settleBflUpscale(genId: string, status: "done" | "failed", outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; said?: ProviderOutcome | null; reconcile?: boolean }): Promise<void> {
  const job = await load(genId);
  if (!job || job.up.settled) return;
  const { row, up } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "bfl").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  /* A finished job is charged at most the quote, whatever BFL states: what it states past the quote is recorded as the overrun (the platform's, flagged to reconcile), never billed.
     A failure BFL charged for (costUsd above nothing) is recorded at that cost on the ledger line and billed to nobody. */
  const cost = Math.min(Math.max(0, outcome.costUsd), up.reservedUsd);
  const overrunUsd = outcome.costUsd > up.reservedUsd + 1e-9 ? Math.round((outcome.costUsd - up.reservedUsd) * 1e6) / 1e6 : null;
  const reconcile = outcome.reconcile === true || overrunUsd !== null;
  const write = ok
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, duration_s=COALESCE(?,duration_s),
                params=json_set(params,'$.bflUpscale.status','done','$.bflUpscale.settled',1,'$.bflUpscale.reconcile',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, cost, ms, up.seconds, reconcile ? 1 : 0, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?, provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.bflUpscale.status','failed','$.bflUpscale.settled',1,'$.bflUpscale.reconcile',?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The upscale failed.").slice(0, 600), ms, cost, said ? serializeOutcome(said) : null, reconcile ? 1 : 0, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: "video", engine: "bfl", model: up.model, status: ok ? "succeeded" : "failed", engineCostUsd: cost, durationMs: ms,
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

/** The clip's bytes, from the workspace's own storage, by the id the row recorded at admission (who may open it was decided there). */
async function readSource(source: { kind: "upload" | "generation"; id: string }): Promise<Buffer> {
  const max = BFL_UPSCALE_RATES.maxSourceBytes;
  if (source.kind === "upload") {
    const row = (await db().execute({ sql: "SELECT ext, stored_url FROM uploads WHERE id=? LIMIT 1", args: [source.id] })).rows[0];
    if (!row) throw new Error("The clip is no longer available in this workspace.");
    return readUploadBytes(source.id, String(row.ext), String(row.stored_url), max);
  }
  const bytes = await readOriginalBytesLimited("video", source.id, max);
  if (!bytes) throw new Error("The clip is no longer available in this workspace.");
  return bytes;
}

/** One step, safe to call from anywhere at any time. Public: no seams (the cron and the continuation call this one). */
export const advanceBflUpscaleJob = (genId: string): Promise<BflUpscaleParams | null> => advanceBflUpscaleWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceBflUpscaleWith(genId: string, deps: BflUpscaleDeps): Promise<BflUpscaleParams | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, genId, async () => {
    let job = await load(genId);
    if (!job) return null;
    if (job.up.settled || job.up.status === "uncertain" || job.up.status === "failed" || job.up.status === "done") return job.up;
    if (job.up.status === "queued") {
      if (!job.up.funded) return job.up;
      const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.bflUpscale.status')='queued' AND json_extract(params,'$.bflUpscale.funded')=1 AND json_extract(params,'$.bflUpscale.claimedAt') IS NULL AND status='running'" });
      if (!claimed) {
        // Someone holds the claim. A young claim is a submission in flight; an old one with no job id is a lost acknowledgement.
        const held = (await load(genId))?.up;
        if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
          /* `sendingAt` is written the instant before the one request goes out. A claim that never reached it never sent anything: settled at nothing. Only one that did, and has no job id, is a lost acknowledgement. */
          if (!held.sendingAt) await settleBflUpscale(genId, "failed", { message: "Nothing was submitted: the job stopped before it was sent. Nothing was billed.", costUsd: 0 });
          else await patch(genId, { status: "uncertain" });
        }
        return (await load(genId))?.up ?? null;
      }
      job = (await load(genId))!;
      const { up } = job;
      /* The clip is read before anything is sent: one that cannot be read submits nothing and refunds everything. */
      let video: Buffer;
      try { video = await readSource(up.source); }
      catch (error) {
        await settleBflUpscale(genId, "failed", { message: `Nothing was submitted: ${messageOf(error, "the clip could not be read.")} Nothing was billed.`, costUsd: 0 });
        return (await load(genId, { any: true }))?.up ?? null;
      }
      try {
        await patch(genId, { sendingAt: clock() });
        const sent = await (deps.submit ?? submitUpscale)({ video, mode: up.mode, factor: up.factor, ...(up.steer ? { prompt: up.steer } : {}) });
        await patch(genId, { status: "submitted", bflId: sent.id, pollingUrl: sent.pollingUrl, statedUsd: sent.statedUsd, submittedAt: clock() });
      } catch (error) {
        if (error instanceof BflError && error.rejectedBeforeGeneration) {
          // Refused before work (BFL does not charge a rejected clip): the whole reservation comes back.
          await settleBflUpscale(genId, "failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: directErrorOutcome("bfl", error.status ?? 400, error.message) });
          return (await load(genId, { any: true }))?.up ?? null;
        }
        // A timeout or a dropped connection: BFL may hold a charged job under an id we never saw. Held for review, never sent again.
        await patch(genId, { status: "uncertain" });
        await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
        return (await load(genId))?.up ?? null;
      }
      job = (await load(genId))!;
    }
    const up = job.up;
    if (!up.bflId || !up.pollingUrl) return up;
    // One poller at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const leased = await patch(genId, { pollUntil: until }, { sql: "json_extract(params,'$.bflUpscale.settled')=0 AND COALESCE(json_extract(params,'$.bflUpscale.pollUntil'),0)<?", args: [clock()] });
    if (!leased) return up;
    try {
      await patch(genId, { lastPolledAt: clock() });
      /* Past the window a Ready clip's address is dead: it is a failure to collect, settled at nothing (the platform absorbs it). */
      if (up.readyAt && clock() - Number(up.readyAt) > BFL_VIDEO_RESULT_LIFETIME_MS - 60_000) {
        /* BFL made it (it said Ready), so BFL charged for it: recorded at its stated cost, else the quote, billed to nobody, and marked to reconcile when the figure is ours. */
        await settleBflUpscale(genId, "failed", { message: "The upscale was ready but could not be saved in time. Nothing was billed.", costUsd: up.statedUsd ?? up.reservedUsd, reconcile: up.statedUsd == null, said: silentOutcome("bfl", "run", "not_kept", "result expired before it was saved") });
        return (await load(genId, { any: true }))?.up ?? null;
      }
      const state = await (deps.poll ?? pollImage)({ id: up.bflId, pollingUrl: up.pollingUrl }, {}, "video");
      if (state.status === "failed") {
        /* BFL's pages say nothing about billing a failed or moderated job. When its reply stated a cost for the job, that is what it is recorded at (billed to nobody); when it stated none it is recorded as nothing and marked to reconcile against BFL's invoice. */
        await settleBflUpscale(genId, "failed", { message: `${state.failure ?? "BFL could not make this video."} Nothing was billed.`, costUsd: up.statedUsd ?? 0, reconcile: up.statedUsd == null, said: silentOutcome("bfl", "run", "failed", state.failure) });
        return (await load(genId, { any: true }))?.up ?? null;
      }
      if (state.status !== "ready" || !state.resultUrl) return (await load(genId))?.up ?? null;
      if (!up.readyAt) await patch(genId, { readyAt: clock() });
      /* The moment it is Ready: fetched and stored, before anything else. Never fetched with our key, only from the bfl.ai address in the poll. */
      const bytes = await (deps.fetchVideo ?? fetchVideoResult)(state.resultUrl);
      const { value: stored } = await withRetry(() => (deps.store ?? storeVideoBytes)(genId, bytes), { max: 3 });
      /* BFL's own figure when it states one, else the quote and marked to reconcile; never billed above the quote (settleBflUpscale records the excess as the overrun and marks it). */
      await settleBflUpscale(genId, "done", { costUsd: up.statedUsd ?? up.reservedUsd, reconcile: up.statedUsd == null, storedUrl: stored.url, bytes: stored.bytes });
      return (await load(genId, { any: true }))?.up ?? null;
    } catch (error) {
      // Transport or storage: keep the id and the reservation; the next pass asks again (the window still runs). Nothing is resubmitted.
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [messageOf(error, "The upscale could not be collected yet."), now(), genId] });
      throw error;
    } finally {
      await patch(genId, { pollUntil: null }, { sql: "json_extract(params,'$.bflUpscale.pollUntil')=?", args: [until] }).catch(() => {});
    }
  });
}

/** Runs a job in this request's own continuation: steps and short pauses until it ends or the time is up; the cron takes over after. */
export async function driveBflUpscale(genId: string, options: { budgetMs?: number; pauseMs?: number } = {}): Promise<void> {
  const until = Date.now() + (options.budgetMs ?? 240_000);
  for (;;) {
    const up = await advanceBflUpscaleJob(genId).catch(() => null);
    if (!up || up.settled || up.status === "uncertain" || up.status === "done" || up.status === "failed" || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? BFL_UPSCALE_POLL_INTERVAL_MS));
  }
}

/** The cron's stage: queued and submitted jobs are advanced (a Ready clip is collected at once). Uncertain and terminal rows are left alone. */
export async function recoverBflUpscaleJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: BflUpscaleDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.bflUpscale.status') IN ('queued','submitted')
          ORDER BY updated_at ASC LIMIT ?`,
    args: [BFL_UPSCALE_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await advanceBflUpscaleWith(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tool ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

const COMMON = { provider: "bfl", kind: "engine" as const, route: "/api/bfl", needs: ["BFL_API_KEY", "BFL_ENABLED"], who: "prepare: anyone; approve: a person" as const };
/**
 * The tool, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer; an upscale is a finishing step, so it is always asked, never run
 * on its own. `mode` is the engine's own choice and defaults to precise; creative is explicit and carries `CREATIVE_NOTE`.
 */
export const BFL_UPSCALE_TOOLS = [
  {
    ...COMMON, id: BFL_UPSCALE_TOOL_ID, tool: "upscale" as const, models: Object.keys(BFL_UPSCALE_RATES.modes).map((m) => bflUpscaleModel(m as BflUpscaleMode)),
    inputs: { sourceUploadId: "an MP4 clip of this workspace (or sourceGenId: one of its takes)", mode: `precise (default) or creative. ${CREATIVE_NOTE}`, factor: "1.5 to 3 (default 2)", prompt: "optional: what the clip shows", projectId: "optional", maxCredits: "the approved price" },
    output: "a video take, linked to its original",
  },
];

/** The tool present for a workspace: none unless the engine is on for it (the house, or a workspace on the engine list). */
export async function bflUpscaleTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof BFL_UPSCALE_TOOLS> {
  return (await engineEnabled(BFL_SWITCH, workspace)) ? BFL_UPSCALE_TOOLS : [];
}
