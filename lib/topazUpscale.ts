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
import { readImageBytes, readUploadBytes, storeImageBytes, storeVideoBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { findStoredSource, readStoredSourceBytes, type StoredSource } from "./mediaSource.server";
import { inspectOriginalVideo, VIDEO_INSPECTION_LIMIT, VIDEO_TOOL_MAX_SECONDS } from "./videoMetadata.server";
import { inspectTopazImage } from "./topazImage.server";
import type { Reference } from "./ark";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow } from "./shotCap";
import { currentViewer, uploadOpenableBy } from "./uploadAccess";
import { engineEnabled } from "./engineGate";
import { ASTRA_MODEL, astraSettings, type AstraSettings } from "./astra";
import { TOPAZ_IMAGE_MODEL, topazImageSettings, type TopazImageSettings } from "./topaz";
import {
  TOPAZ_SWITCH, TopazError, acceptVideo, cancelVideo, completeVideoUpload, createVideoRequest, deleteVideoMedia, downloadImage, downloadVideo, imageStatus, submitImageUpscale,
  topazConfigured, topazCreditsUsd, topazImageCredits, topazVideoCredits, topazVideoOutput, topazVideoTierOf, uploadVideoParts, videoStatus, type TopazVideoProcess,
} from "./topazDirect";

/**
 * Topaz upscale, DIRECT (lib/topazDirect.ts): a still (the Gigapixel presets of lib/topaz.ts) or a clip (Astra 2, lib/astra.ts) of this workspace in, the same take made larger out.
 * One door (POST /api/topaz { tool: "image" | "video" }, and the generate route when the engine is on: lib/generationAdmission.ts hands the two Topaz models here) for the button, Make, a board card,
 * Atomik, a saved skill and an outside agent: the same quote, the same approval, the same price. An ASYNCHRONOUS vendor job kept as a durable workflow in the take's own row
 * (generations.params.topaz; no new table), shaped like FLUX.2 (lib/bflImage.ts) and lip-sync (lib/lipSync.ts):
 *
 *   queued      admitted and funded (the reservation is the whole price)
 *   submitted   the job is with Topaz (a still: its process id; a clip: its request id, the upload complete)
 *   done        the output is fetched, STORED under the workspace's own prefix, the take settled, and a clip's vendor copy deleted
 *   failed      refused or failed before work, or Topaz said it failed: the workspace is billed nothing; what Topaz charged for a failure is recorded on the ledger line, unbilled
 *   uncertain   the one request that starts paid work (a still's submit; a clip's completed upload) lost its acknowledgement. Nothing here ever sends it a second time
 *
 * MONEY. Quote: Topaz credits at TOPAZ_RATES (lib/vendorRates.ts: Developer plan, $0.10 a credit, the dearer reading everywhere, OWNER TO CONFIRM) by the output size of the still or the output
 * frames of the clip, through the margin table keyed by the model (`quotedCredits`), so the price path is the fal route's own; reserved at the quote; settled at the credits Topaz reports
 * when it reports them (else the quote, marked `reconcile`), and NEVER billed above the quote (a reported figure above it settles at the quote and the excess is recorded as the meter's
 * `overrun_usd`, marked `reconcile`). A clip's request carries Topaz's own estimate: if its high figure is above the approved quote nothing is uploaded and the job ends "Nothing billed".
 * A failure Topaz charged for is recorded at its reported cost, unbilled; none reported: recorded as nothing and marked `reconcile` against the invoice. A person approves: `maxCredits` must cover the quote.
 *
 * PRIVACY. The original's bytes are read on the server and sent as data (our storage links never leave Particl). A clip's vendor copy is deleted once the output is stored (`DELETE /video/{id}/media`;
 * a failure is retried by the cron up to CLEANUP_MAX_TRIES times and never blocks the take). **Topaz's image API names no delete endpoint**, so a still's copy is Topaz's to expire (the row says so).
 * Only ids and figures are written to the row. TO CONFIRM in the first qualification run: that a clip's request and upload are free until its upload is complete.
 */
export const TOPAZ_TASK = "topaz_upscale";
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_SOURCE_LIMIT = 30 * 1024 * 1024;
const SUBMIT_GRACE_MS = 10 * 60_000;
const POLL_LEASE_MS = 120_000;
const READY_GRACE_MS = 30 * 60_000;
export const TOPAZ_IMAGE_POLL_INTERVAL_MS = 3_000;
export const TOPAZ_VIDEO_POLL_INTERVAL_MS = 15_000;
export const CLEANUP_MAX_TRIES = 5;

export type TopazState = "queued" | "submitted" | "done" | "failed" | "uncertain";
export type TopazParams = {
  status: TopazState; tool: "image" | "video"; model: string;
  source: { kind: "upload" | "generation"; id: string };
  settings: TopazImageSettings | AstraSettings;
  inputWidth: number; inputHeight: number; outputWidth: number; outputHeight: number; outputMegapixels: number;
  seconds: number; fps: number; sourceFps: number; container: "mp4" | "mov"; sourceBytes: number;
  quoteCredits: number; reservedUsd: number; estimateCredits: number;
  funded: number; claimedAt: number | null; sendingAt: number | null; vendorId: string | null; statedCredits: number | null; estimatedHigh: number | null;
  submittedAt: number | null; readyAt: number | null; lastPolledAt: number | null; pollUntil: number | null; settled: number;
  cleanupDue: number; cleanupCancel: number; cleanupTries: number; vendorDeleted: number; reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string };
type Job = { row: Row; t: TopazParams };

/** The adapter seams for the workflow, for tests. Public callers (the route, the cron) pass none. */
export type TopazDeps = {
  submitImage?: typeof submitImageUpscale; imageStatus?: typeof imageStatus; downloadImage?: typeof downloadImage;
  createVideo?: typeof createVideoRequest; accept?: typeof acceptVideo; uploadParts?: typeof uploadVideoParts; complete?: typeof completeVideoUpload;
  videoStatus?: typeof videoStatus; downloadVideo?: typeof downloadVideo; deleteMedia?: typeof deleteVideoMedia; cancel?: typeof cancelVideo;
  store?: (genId: string, bytes: Buffer, kind: "image" | "video") => Promise<{ url: string; bytes: number }>; clock?: () => number;
};

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, TOPAZ_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let t: TopazParams | undefined;
  try { t = (JSON.parse(row.params) as { topaz?: TopazParams }).topaz; } catch { /* unreadable */ }
  return t && (t.tool === "image" || t.tool === "video") ? { row, t } : null;
}
async function patch(genId: string, fields: Partial<TopazParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.topaz.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${entries.map(() => "?,?").join(",")}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, TOPAZ_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── The body: the generate route's two Topaz models, and the door's own shape ──────────────────────────────────────────────── */

/**
 * The door's own request from what the generate route is sent for an upscale (lib/shell/upscale.ts: the Astra model with a source clip, the image model with one reference), or the door's own
 * request as it is (a prepared request replays as it was captured). Null for anything else: the generate route carries on with the fal path.
 */
export function topazBodyFromGenerate(input: Record<string, unknown>): Record<string, unknown> | null {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  if (input.tool === "image" || input.tool === "video") return input;
  if (input.model === ASTRA_MODEL)
    return clean({ tool: "video", sourceGenId: input.sourceGenId, sourceUploadId: input.sourceUploadId, astra: input.astra, projectId: input.projectId, shotId: input.shotId, maxCredits: input.maxCredits, quoteOnly: input.quoteOnly });
  if (input.model === TOPAZ_IMAGE_MODEL) {
    const refs = Array.isArray(input.references) ? input.references : [];
    const ref = refs.length === 1 && refs[0] && typeof refs[0] === "object" ? (refs[0] as { genId?: unknown; uploadId?: unknown }) : null;
    return clean({ tool: "image", sourceGenId: ref?.genId, sourceUploadId: ref?.uploadId, topaz: input.topaz, projectId: input.projectId, shotId: input.shotId, maxCredits: input.maxCredits, quoteOnly: input.quoteOnly });
  }
  return null;
}

/* ── Sources ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

type ImageSource = { kind: "upload" | "generation"; id: string; name: string; bytes: number; ref: Reference };
async function resolveImage(uploadId: unknown, genId: unknown): Promise<ImageSource | { error: string; status: number }> {
  const up = uploadId ? String(uploadId) : "", gen = genId ? String(genId) : "";
  if ((!up && !gen) || (up && gen)) return { error: "Pick one image original.", status: 400 };
  if ((up && !SOURCE_ID.test(up)) || (gen && !SOURCE_ID.test(gen))) return { error: "That source is not valid.", status: 400 };
  if (up) {
    const row = (await db().execute({ sql: "SELECT id, filename, mime, ext, stored_url, kind, bytes FROM uploads WHERE id=? LIMIT 1", args: [up] })).rows[0];
    /* A person's request reads only an upload they may open (lib/uploadAccess.ts); anything else is the same "not in this workspace" a missing one gets. */
    const viewer = currentViewer();
    if (!row || row.kind !== "image" || (viewer && !(await uploadOpenableBy(up, viewer)))) return { error: "That image original is not in this workspace.", status: 404 };
    return { kind: "upload", id: up, name: String(row.filename ?? up), bytes: Number(row.bytes ?? 0), ref: { id: up, mime: String(row.mime || "image/png"), ext: String(row.ext || "png"), storedUrl: String(row.stored_url ?? ""), role: "reference_image", kind: "image", fromGeneration: false } };
  }
  const row = (await db().execute({ sql: "SELECT id, title, prompt, stored_url, bytes, params FROM generations WHERE id=? AND deleted=0 AND status='succeeded' AND kind='image' AND stored_url IS NOT NULL LIMIT 1", args: [gen] })).rows[0];
  if (!row) return { error: "That image original is not in this workspace.", status: 404 };
  return { kind: "generation", id: gen, name: String(row.title || String(row.prompt ?? "").slice(0, 80) || gen), bytes: Number(row.bytes ?? 0), ref: { id: gen, mime: "image/png", ext: "png", storedUrl: String(row.stored_url), role: "reference_image", kind: "image", fromGeneration: true } };
}

const videoRef = (s: StoredSource): Reference => ({ id: s.id, mime: s.mime || "video/mp4", ext: s.ext || "mp4", storedUrl: String(s.storedUrl ?? ""), role: "reference_video", kind: "video", fromGeneration: s.kind === "generation" });

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const executeTopazAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitTopaz(input, got, options);

/** Admission: validate, measure the original on the server, quote, and (unless quoteOnly) fund one job and hand it to the worker. */
export async function admitTopaz(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(TOPAZ_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const tool = body.tool;
  if (tool !== "image" && tool !== "video") return admissionReply({ error: "Pick image or video." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!topazConfigured()) return admissionReply({ error: "This is not set up: TOPAZ_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("topaz");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  const model = tool === "image" ? TOPAZ_IMAGE_MODEL : ASTRA_MODEL;
  const notices: string[] = [];
  let settings: TopazImageSettings | AstraSettings;
  let source: { kind: "upload" | "generation"; id: string; name: string; bytes: number };
  let measured: { inputWidth: number; inputHeight: number; outputWidth: number; outputHeight: number; outputMegapixels: number; seconds: number; fps: number; sourceFps: number; container: "mp4" | "mov" };
  let credits: number;
  if (tool === "image") {
    try { settings = topazImageSettings(body.topaz); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    const found = await resolveImage(body.sourceUploadId, body.sourceGenId);
    if ("error" in found) return admissionReply({ error: found.error }, { status: found.status });
    if (!(found.bytes > 0) || found.bytes > IMAGE_SOURCE_LIMIT) return admissionReply({ error: "Use an original image up to 30 MB for Topaz." }, { status: 400 });
    let out: { width: number; height: number };
    try { out = await inspectTopazImage(found.ref, settings); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    const factor = (settings as TopazImageSettings).factor;
    measured = { inputWidth: out.width / factor, inputHeight: out.height / factor, outputWidth: out.width, outputHeight: out.height, outputMegapixels: (out.width * out.height) / 1_000_000, seconds: 0, fps: 0, sourceFps: 0, container: "mp4" };
    try { credits = topazImageCredits(measured.outputMegapixels); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    source = { kind: found.kind, id: found.id, name: found.name, bytes: found.bytes };
  } else {
    try { settings = astraSettings(body.astra); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    const up = body.sourceUploadId ? String(body.sourceUploadId) : "", gen = body.sourceGenId ? String(body.sourceGenId) : "";
    if ((!up && !gen) || (up && gen)) return admissionReply({ error: "Pick one clip to upscale." }, { status: 400 });
    if ((up && !SOURCE_ID.test(up)) || (gen && !SOURCE_ID.test(gen))) return admissionReply({ error: "That source is not valid." }, { status: 400 });
    const found = await findStoredSource(up ? { uploadId: up } : { genId: gen });
    if (!found || found.mediaKind !== "video") return admissionReply({ error: "That clip is not in this workspace." }, { status: 404 });
    if (found.demo) return admissionReply({ error: "A starter clip is a sample, not a stored original: upscale a clip of your own." }, { status: 400 });
    if (!(found.bytes > 0) || found.bytes > VIDEO_INSPECTION_LIMIT) return admissionReply({ error: "Topaz takes clips up to 200 MB." }, { status: 400 });
    let meta: Awaited<ReturnType<typeof inspectOriginalVideo>>;
    try { meta = await inspectOriginalVideo(videoRef(found), found.bytes, true); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    if (!(meta.seconds > 0) || meta.seconds > VIDEO_TOOL_MAX_SECONDS) return admissionReply({ error: `Topaz takes clips of five minutes or less; this one is ${Math.round(meta.seconds)}s.` }, { status: 400 });
    let out: ReturnType<typeof topazVideoOutput>;
    try { out = topazVideoOutput(meta, settings as AstraSettings); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    measured = { inputWidth: meta.width, inputHeight: meta.height, outputWidth: out.width, outputHeight: out.height, outputMegapixels: 0, seconds: meta.seconds, fps: out.frameRate, sourceFps: meta.fps && meta.fps > 0 ? meta.fps : 30, container: String(found.ext).toLowerCase() === "mov" ? "mov" : "mp4" };
    try { credits = topazVideoCredits({ seconds: meta.seconds, fps: out.frameRate, tier: topazVideoTierOf(out.height) }); } catch (error) { return admissionReply({ error: (error as Error).message }, { status: 400 }); }
    source = { kind: found.kind, id: found.id, name: found.name, bytes: found.bytes };
    notices.push("Topaz Astra chooses its final dimensions. This quote uses the 4K tier and the selected output frame rate.");
  }
  const usd = topazCreditsUsd(credits);

  let projectId = body.projectId ? String(body.projectId) : null;
  const shotId = body.shotId ? String(body.shotId) : null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return admissionReply({ error: "That shot is gone." }, { status: 400 });
    if (projectId && shot.projectId && shot.projectId !== projectId) return admissionReply({ error: "That shot belongs to another production." }, { status: 400 });
    projectId ??= shot.projectId;
  }
  if (projectId && !(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length) return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });
  /* The approval unit, through the margin table keyed by the model (as the fal route's own quote is). No number of ours here. */
  const estimatedCredits = quotedCredits(usd, model);
  const inCredits = creditsApply(requireTenant());
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "topaz", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool, model, outputWidth: measured.outputWidth, outputHeight: measured.outputHeight, ...(tool === "video" ? { seconds: measured.seconds, fps: measured.fps } : { megapixels: Math.round(measured.outputMegapixels * 10) / 10 }) });
  const wall = await allowanceCheck("topaz", usd, model);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, model);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(tool === "image" ? 64 * 1024 * 1024 : Math.min(1024 * 1024 * 1024, source.bytes * 8));
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(options, body, got, tool, usd, model, { task: TOPAZ_TASK, tool, model, source: { kind: source.kind, id: source.id }, settings, outputWidth: measured.outputWidth, outputHeight: measured.outputHeight, seconds: measured.seconds, projectId, shotId }, { engine: "topaz" });
  if (stopped) return stopped;
  /* The approval comes after the checkpoint: preparing a quote (the generate route's two-step) ends at the checkpoint, and only the admission that follows it carries the approved amount. */
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });

  const genId = newId("gen"), ts = now();
  const topaz: TopazParams = {
    status: "queued", tool, model, source: { kind: source.kind, id: source.id }, settings,
    ...measured, sourceBytes: source.bytes, quoteCredits: credits, reservedUsd: usd, estimateCredits: estimatedCredits,
    funded: 0, claimedAt: null, sendingAt: null, vendorId: null, statedCredits: null, estimatedHigh: null, submittedAt: null, readyAt: null, lastPolledAt: null, pollUntil: null, settled: 0,
    cleanupDue: 0, cleanupCancel: 0, cleanupTries: 0, vendorDeleted: 0, reconcile: 0,
  };
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(measured.outputWidth, measured.outputHeight);
  const lineage = source.kind === "generation" ? { sourceGenId: source.id } : { sourceUploadId: source.id };
  const params = {
    task: TOPAZ_TASK, job: "fix", topaz, ...lineage, estUsd: usd, estCredits: 0, ratio: `${measured.outputWidth / g}:${measured.outputHeight / g}`, size: `${measured.outputWidth}x${measured.outputHeight}`,
    ...(tool === "video" ? { resolution: measured.outputHeight > 1080 ? "4k" : "1080p", duration: Math.round(measured.seconds) } : {}),
    ...(tool === "image" ? { references: [{ role: "reference_image", ...(source.kind === "generation" ? { genId: source.id } : { uploadId: source.id }) }] } : {}),
  };
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id, source_gen_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, tool, model, `Upscale · ${source.name}`.slice(0, 5000), JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "topaz", "upscale", `${source.name.replace(/\.[A-Za-z0-9]{1,8}$/, "")} · upscaled`.slice(0, 80), "topaz", shotId, source.kind === "generation" ? source.id : null],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: tool, engine: "topaz", model, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was submitted. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The reservation could not be made.";
    await settleTopaz(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the job runs in this request's continuation, polling every few seconds, and the ten-minute cron picks up whatever is still running. */
  await options.defer(() => driveTopaz(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, model, notices: [...notices, ...(capV.notice ? [capV.notice] : [])] });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing billed. */
export async function settleTopaz(
  genId: string, status: "done" | "failed",
  outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; seconds?: number | null; said?: ProviderOutcome | null; reconcile?: boolean; cleanup?: "delete" | "cancel" | null },
): Promise<void> {
  const job = await load(genId);
  if (!job || job.t.settled) return;
  const { row, t } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "topaz").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  /* A finished job is charged at most the quote, whatever Topaz reports: what it reports past the quote is recorded as the overrun (the platform's, flagged to reconcile), never billed.
     A failure Topaz charged for (costUsd above nothing) is recorded at that cost on the ledger line and billed to nobody. */
  const cost = ok ? Math.min(outcome.costUsd, t.reservedUsd) : Math.max(0, outcome.costUsd);
  const overrunUsd = ok && outcome.costUsd > t.reservedUsd + 1e-9 ? Math.round((outcome.costUsd - t.reservedUsd) * 1e6) / 1e6 : null;
  const reconcile = outcome.reconcile === true || overrunUsd !== null;
  /* A clip's vendor copy is deleted once the take is over (or its request cancelled when it never started); a still's has no endpoint to call. */
  const cleanup = t.tool === "video" && t.vendorId && outcome.cleanup !== null ? 1 : 0;
  const cancel = outcome.cleanup === "cancel" ? 1 : 0;
  const write = ok
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, duration_s=COALESCE(?,duration_s),
                params=json_set(params,'$.topaz.status','done','$.topaz.settled',1,'$.topaz.reconcile',?,'$.topaz.cleanupDue',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, cost, ms, outcome.seconds ?? null, reconcile ? 1 : 0, cleanup, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?, provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.topaz.status','failed','$.topaz.settled',1,'$.topaz.reconcile',?,'$.topaz.cleanupDue',?,'$.topaz.cleanupCancel',?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The upscale failed.").slice(0, 600), ms, cost, said ? serializeOutcome(said) : null, reconcile ? 1 : 0, cleanup, cancel, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: t.tool, engine: "topaz", model: t.model, status: ok ? "succeeded" : "failed", engineCostUsd: cost, durationMs: ms,
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
const defaultStore = (genId: string, bytes: Buffer, kind: "image" | "video") => (kind === "image" ? storeImageBytes(genId, bytes) : storeVideoBytes(genId, bytes));

/** One step, safe to call from anywhere at any time. Public: no seams (the cron and the continuation call this one). */
export const advanceTopazJob = (genId: string): Promise<TopazParams | null> => advanceTopazJobWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceTopazJobWith(genId: string, deps: TopazDeps): Promise<TopazParams | null> {
  const clock = deps.clock ?? now;
  /* A job that ends without its work: settled, then its vendor request (a clip's) cancelled or its copy deleted. A failed clean-up is retried by the cron and never blocks. */
  const end = async (status: "done" | "failed", outcome: Parameters<typeof settleTopaz>[2]) => {
    await settleTopaz(genId, status, outcome);
    if (outcome.cleanup !== null) await cleanupTopazVendor(genId, deps).catch(() => {});
  };
  return withRecoveryJob(requireTenant().id, genId, async () => {
    let job = await load(genId);
    if (!job) return null;
    if (job.t.settled || job.t.status === "uncertain" || job.t.status === "failed" || job.t.status === "done") return job.t;
    if (job.t.status === "queued") {
      if (!job.t.funded) return job.t;
      const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.topaz.status')='queued' AND json_extract(params,'$.topaz.funded')=1 AND json_extract(params,'$.topaz.claimedAt') IS NULL AND status='running'" });
      if (!claimed) {
        // Someone holds the claim. A young claim is a submission in flight; an old one is judged by how far it got.
        const held = (await load(genId))?.t;
        if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
          /* `sendingAt` is written the instant before the one request that starts paid work. A claim that never reached it sent nothing paid: settled at nothing (a clip's request cancelled). Only one that did, with no answer, is a lost acknowledgement. */
          if (!held.sendingAt) await end("failed", { message: "Nothing was submitted: the job stopped before it was sent. Nothing was billed.", costUsd: 0, cleanup: "cancel" });
          else await patch(genId, { status: "uncertain" });
        }
        return (await load(genId))?.t ?? null;
      }
      job = (await load(genId))!;
      const { t } = job;
      /* The original is read before anything is sent: one that cannot be read submits nothing and refunds everything. */
      let bytes: Buffer;
      try {
        if (t.tool === "image") {
          bytes = t.source.kind === "upload"
            ? await (async () => { const up = (await db().execute({ sql: "SELECT ext, stored_url FROM uploads WHERE id=? LIMIT 1", args: [t.source.id] })).rows[0]; if (!up) throw new Error("The original is no longer available in this workspace."); return readUploadBytes(t.source.id, String(up.ext), String(up.stored_url), IMAGE_SOURCE_LIMIT); })()
            : await readImageBytes(t.source.id);
          if (bytes.length > IMAGE_SOURCE_LIMIT) throw new Error("The original is larger than 30 MB.");
        } else {
          const found = await findStoredSource(t.source.kind === "upload" ? { uploadId: t.source.id } : { genId: t.source.id });
          if (!found) throw new Error("The original is no longer available in this workspace.");
          bytes = await readStoredSourceBytes(found, VIDEO_INSPECTION_LIMIT);
        }
      } catch (error) {
        await end("failed", { message: `Nothing was submitted: ${messageOf(error, "the original could not be read.")} Nothing was billed.`, costUsd: 0, cleanup: null });
        return (await load(genId, { any: true }))?.t ?? null;
      }
      if (t.tool === "image") {
        try {
          await patch(genId, { sendingAt: clock() });
          const sent = await (deps.submitImage ?? submitImageUpscale)({ bytes, filename: "original.png", mime: "image/png", width: t.inputWidth, height: t.inputHeight, settings: t.settings as TopazImageSettings });
          await patch(genId, { status: "submitted", vendorId: sent.id, submittedAt: clock() });
        } catch (error) {
          if (error instanceof TopazError && error.rejectedBeforeWork) {
            // Refused before work: the whole reservation comes back.
            await end("failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: directErrorOutcome("topaz", error.status ?? 400, error.message), cleanup: null });
            return (await load(genId, { any: true }))?.t ?? null;
          }
          // A timeout or a dropped connection: Topaz may hold a charged job under an id we never saw. Held for review, never sent again.
          await patch(genId, { status: "uncertain" });
          await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
          return (await load(genId))?.t ?? null;
        }
      } else {
        /* A clip: the request, the accept and the parts are free (TO CONFIRM); work begins at the completed upload. Anything that goes wrong before it submits nothing paid: settled at nothing, the request cancelled. */
        try {
          const created = await (deps.createVideo ?? createVideoRequest)({ source: { container: t.container, sizeBytes: bytes.length, durationSeconds: t.seconds, frameRate: t.sourceFps, width: t.inputWidth, height: t.inputHeight }, settings: t.settings as AstraSettings });
          await patch(genId, { vendorId: created.id, estimatedHigh: created.estimatedCredits?.high ?? null });
          if (created.estimatedCredits && created.estimatedCredits.high > t.quoteCredits) {
            await end("failed", { message: "Topaz estimates this clip above the approved price, so nothing was uploaded. Nothing was billed.", costUsd: 0, cleanup: "cancel" });
            return (await load(genId, { any: true }))?.t ?? null;
          }
          const accepted = await (deps.accept ?? acceptVideo)(created.id);
          const parts = await (deps.uploadParts ?? uploadVideoParts)(accepted.uploadUrls, bytes);
          await patch(genId, { sendingAt: clock() });
          await (deps.complete ?? completeVideoUpload)(created.id, parts);
          await patch(genId, { status: "submitted", submittedAt: clock() });
        } catch (error) {
          const started = Boolean((await load(genId))?.t.sendingAt);
          if (!started || (error instanceof TopazError && error.rejectedBeforeWork)) {
            await end("failed", { message: `${messageOf(error, "The upload did not complete.")} Nothing was billed.`, costUsd: 0, said: error instanceof TopazError && error.status ? directErrorOutcome("topaz", error.status, error.message) : silentOutcome("topaz", "submit", "upload_failed", messageOf(error, "")), cleanup: "cancel" });
            return (await load(genId, { any: true }))?.t ?? null;
          }
          // The completed upload went out and no answer came: Topaz may have started a charged job. Held for review, never sent again.
          await patch(genId, { status: "uncertain" });
          await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
          return (await load(genId))?.t ?? null;
        }
      }
      job = (await load(genId))!;
    }
    const t = job.t;
    const vendorId = t.vendorId;
    if (!vendorId) return t;
    // One poller at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const leased = await patch(genId, { pollUntil: until }, { sql: "json_extract(params,'$.topaz.settled')=0 AND COALESCE(json_extract(params,'$.topaz.pollUntil'),0)<?", args: [clock()] });
    if (!leased) return t;
    try {
      await patch(genId, { lastPolledAt: clock() });
      const state = t.tool === "image" ? await (deps.imageStatus ?? imageStatus)(vendorId) : await (deps.videoStatus ?? videoStatus)(vendorId);
      if (state.status === "failed" || state.status === "cancelled") {
        /* Whatever Topaz reports it charged is the ledger line's cost (nobody is billed it); none reported: recorded as nothing and marked to reconcile against Topaz's invoice. */
        const credits = state.credits != null && state.credits > 0 ? state.credits : 0;
        await end("failed", { message: `${state.status === "cancelled" ? "Topaz stopped this upscale" : "Topaz could not make this upscale"}${state.error ? `: ${state.error}` : "."} Nothing was billed.`, costUsd: topazCreditsUsd(credits), reconcile: state.credits == null, said: silentOutcome("topaz", "run", "failed", state.error), cleanup: "delete" });
        return (await load(genId, { any: true }))?.t ?? null;
      }
      if (state.status !== "completed") return (await load(genId))?.t ?? null;
      if (state.credits != null) await patch(genId, { statedCredits: state.credits });
      const url = t.tool === "video" ? (state as TopazVideoProcess).downloadUrl : undefined;
      if (t.tool === "video" && !url) {
        /* Done at Topaz, no address yet: asked again. Past the grace it is a failure to collect, which Topaz charged for (its reported credits, else the quote, billed to nobody, marked to reconcile). */
        if (!t.readyAt) await patch(genId, { readyAt: clock() });
        else if (clock() - Number(t.readyAt) > READY_GRACE_MS) {
          await end("failed", { message: "The upscale was ready but could not be saved in time. Nothing was billed.", costUsd: topazCreditsUsd(state.credits ?? t.quoteCredits), reconcile: state.credits == null, said: silentOutcome("topaz", "run", "not_kept", "no download address"), cleanup: "delete" });
        }
        return (await load(genId, { any: true }))?.t ?? null;
      }
      const output = t.tool === "image" ? await (deps.downloadImage ?? downloadImage)(vendorId) : await (deps.downloadVideo ?? downloadVideo)({ id: vendorId, url });
      const { value: stored } = await withRetry(() => (deps.store ?? defaultStore)(genId, output, t.tool), { max: 3 });
      /* Topaz's own figure when it reports one, else the quote and marked to reconcile; never billed above the quote (settleTopaz records the excess as the overrun and marks it). */
      const statedCredits = state.credits ?? t.statedCredits;
      await settleTopaz(genId, "done", { costUsd: statedCredits != null ? topazCreditsUsd(statedCredits) : t.reservedUsd, reconcile: statedCredits == null, storedUrl: stored.url, bytes: stored.bytes, seconds: t.tool === "video" ? Math.round(t.seconds * 1000) / 1000 : null });
      /* Stored and settled: a clip's vendor copy goes. A failure is retried by the cron and never blocks the take. */
      await cleanupTopazVendor(genId, deps).catch(() => {});
      return (await load(genId, { any: true }))?.t ?? null;
    } catch (error) {
      // Transport or storage: keep the id and the reservation; the next pass asks again. Nothing is resubmitted.
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [messageOf(error, "The upscale could not be collected yet."), now(), genId] });
      throw error;
    } finally {
      await patch(genId, { pollUntil: null }, { sql: "json_extract(params,'$.topaz.pollUntil')=?", args: [until] }).catch(() => {});
    }
  });
}

/**
 * Deletes a clip's vendor copy (`DELETE /video/{id}/media`), or cancels a request that never started (`DELETE /video/{id}`). A still has nothing to delete: Topaz's image API names no such endpoint, so its copy
 * is Topaz's to expire. A copy that cannot be deleted is tried again by the cron up to CLEANUP_MAX_TRIES times; it never blocks, fails or re-bills the take.
 */
export async function cleanupTopazVendor(genId: string, deps: TopazDeps = {}): Promise<void> {
  const job = await load(genId, { any: true });
  if (!job || !job.t.cleanupDue || !job.t.vendorId) return;
  const { t } = job;
  const vendorId = t.vendorId;
  if (!vendorId) return;
  let gone = false;
  try { gone = t.cleanupCancel ? await (deps.cancel ?? cancelVideo)(vendorId) : await (deps.deleteMedia ?? deleteVideoMedia)(vendorId); } catch { gone = false; }
  if (gone) { await patch(genId, { cleanupDue: 0, vendorDeleted: 1 }); return; }
  const tries = t.cleanupTries + 1;
  await patch(genId, tries >= CLEANUP_MAX_TRIES ? { cleanupTries: tries, cleanupDue: 0 } : { cleanupTries: tries });
  if (tries >= CLEANUP_MAX_TRIES) console.error(JSON.stringify({ level: "error", event: "topaz.vendor_copy_not_deleted", generation: genId }));
}

/** Runs a job in this request's own continuation: steps and short pauses until it ends or the time is up; the cron takes over after. */
export async function driveTopaz(genId: string, options: { budgetMs?: number; pauseMs?: number } = {}): Promise<void> {
  const until = Date.now() + (options.budgetMs ?? 240_000);
  for (;;) {
    const t = await advanceTopazJob(genId).catch(() => null);
    if (!t || t.settled || t.status === "uncertain" || t.status === "done" || t.status === "failed" || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? (t.tool === "image" ? TOPAZ_IMAGE_POLL_INTERVAL_MS : TOPAZ_VIDEO_POLL_INTERVAL_MS)));
  }
}

/** The cron's stage: queued and submitted jobs are advanced when their last check is old enough, and finished clips whose vendor copy is still there are cleaned up. Uncertain and terminal rows are left alone. */
export async function recoverTopazJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: TopazDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.topaz.status') IN ('queued','submitted') ORDER BY updated_at ASC LIMIT ?`,
    args: [TOPAZ_TASK, limit],
  })).rows.map((r) => String(r.id));
  const cleaning = (await db().execute({
    sql: `SELECT id FROM generations WHERE json_extract(params,'$.task')=? AND json_extract(params,'$.topaz.cleanupDue')=1 ORDER BY updated_at ASC LIMIT ?`,
    args: [TOPAZ_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    const job = await load(id);
    const gap = job?.t.tool === "image" ? TOPAZ_IMAGE_POLL_INTERVAL_MS : TOPAZ_VIDEO_POLL_INTERVAL_MS;
    if (job && job.t.status !== "queued" && job.t.lastPolledAt && clock() - Number(job.t.lastPolledAt) < gap) continue;
    attempted++;
    try { await advanceTopazJobWith(id, deps); } catch { failed++; }
  }
  for (const id of cleaning) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await cleanupTopazVendor(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tools ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const COMMON = { provider: "topaz", kind: "engine" as const, route: "/api/topaz", needs: ["TOPAZ_API_KEY", "TOPAZ_DIRECT_ENABLED"], who: "prepare: anyone; approve: a person" as const };
/** The two tools, declared beside their handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer; an upscale is a finishing step, so it is always asked, never run on its own. */
export const TOPAZ_TOOLS = [
  { ...COMMON, id: "topaz_upscale_image", tool: "image" as const, models: [TOPAZ_IMAGE_MODEL], inputs: { sourceUploadId: "an image of this workspace (or sourceGenId: one of its takes)", topaz: "model (a preset), factor 1, 2 or 4, faceEnhancement, faceStrength", projectId: "optional", maxCredits: "the approved price" }, output: "an image take, linked to its original" },
  { ...COMMON, id: "topaz_upscale_video", tool: "video" as const, models: [ASTRA_MODEL], inputs: { sourceUploadId: "a clip of this workspace (or sourceGenId: one of its takes)", astra: "creativity, realism, sharpness (0 to 1) and fps 30 or 60", projectId: "optional", maxCredits: "the approved price" }, output: "a video take, linked to its original" },
];

/** The tools present for a workspace: none unless the engine is on for it. */
export async function topazTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof TOPAZ_TOOLS> {
  return (await engineEnabled(TOPAZ_SWITCH, workspace)) ? TOPAZ_TOOLS : [];
}

