import { fundedOutcome } from "./providerFailure";
import { googleErrorOutcome, safetyBlockOutcome, serializeOutcome, silentOutcome, type ProviderOutcome } from "./providerOutcome";
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
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { currentViewer, uploadOpenableBy } from "./uploadAccess";
import { engineEnabled } from "./engineGate";
import { VEO_RATES, type VeoAspect, type VeoModel, type VeoResolution } from "./vendorRates";
import { VEO_REFERENCE_LIMIT_BYTES, VEO_MAX_REFERENCES, VEO_SWITCH, VeoError, fetchResult, isVeoModel, pollVideo, submitVideo, veoConfigured, veoQuoteUsd, veoSettingsError } from "./veo";
import { billedWholeSeconds, mp4DurationSeconds } from "./mp4Duration";
import { ConsentMatchError, faceCheckAvailable, requireConsentMatch, type ConsentMatch, type ConsentScope } from "./consentMatch";
import { getConsent } from "./security/consent";
import { consentLive } from "./security/consent-words";

/**
 * Veo 3.1 through the Gemini API (lib/veo.ts): `veo_video`, a clip with its sound from words, from words and a first frame, or from words and up to three reference
 * images of this workspace. One door (POST /api/veo) for the button, Make, a board card, Atomik, a saved skill and an outside agent: the same quote, the same approval,
 * the same price, and for any image the same consent gate. An ASYNCHRONOUS vendor job kept as a durable workflow in the take's own row (generations.params.veo; no new
 * table, no migration), shaped like FLUX.2 (lib/bflImage.ts) and lip-sync (lib/lipSync.ts):
 *
 *   queued     admitted, consent passed (any image), funded (the reservation is the whole price)
 *   submitted  the job is with Google (an operation name)
 *   done       the clip is fetched THE MOMENT the operation is done (Google keeps it two days), STORED under the workspace's own prefix, the take settled
 *   failed     refused before work (settled at NOTHING, "Nothing billed"); blocked, failed or never finished after submission: Google charges only for a clip that is
 *              generated, so the workspace is billed nothing and the ledger line records nothing; a clip lost after Google made it is recorded at the quote, unbilled
 *   uncertain  the submission's acknowledgement was lost. Nothing here ever submits a second time: a lost reply may still be a charged job
 *
 * CONSENT. A first frame or a reference may show a real person. Every image therefore carries the cast member it shows and passes `requireConsentMatch` (lib/consentMatch.ts) BEFORE
 * a row is written or a cent reserved, and the consent is judged again at the moment of sending. Today that gate runs for the house workspace only and refuses every check until
 * the owner chooses a reference source, so **a clip from images is refused today**; there is no "this shows nobody" exemption. A clip from words alone has no image and no gate.
 *
 * MONEY. Quote: the seconds at VEO_RATES (lib/vendorRates.ts, verified against Google's pricing page, 16 Oct 2026; confirm against the first invoice), through the margin table
 * (`quotedCredits`, keyed by the model); reserved at the quote on the meter; Google states no cost, so a clip is settled at its own measured length (read from the stored
 * file's container header, lib/mp4Duration.ts, rounded up to whole seconds as Google bills per second) times the rate, or at the quote when its length cannot be read, and marked `reconcile` (the figure is ours), and
 * NEVER billed above the quote. Google bills only on success ("You will only be charged if your video is successfully generated"; blocked videos are not charged), so a failure we can see
 * is settled at nothing. A clip Google made and we could not keep (its address lives two days) is recorded on the ledger line at the quote, billed to nobody, marked `reconcile`.
 * A person approves: `maxCredits` must cover the quote (over MCP only the workspace's own Ask/Auto setting does: lib/directEngineMcp.ts).
 *
 * PRIVACY. Images are read from this workspace (the same open-by-person rule as every source) and sent as data, never as a link of ours. Whether Google's terms allow training on
 * inputs and outputs is for counsel before any customer switch.
 */
export const VEO_TASK = "veo_video";
const ENTITY_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const POLL_LEASE_MS = 120_000;
const SUBMIT_GRACE_MS = 10 * 60_000;
export const VEO_POLL_INTERVAL_MS = 10_000;
/** Google keeps a finished clip two days; we treat it as gone a little before. */
export const VEO_RESULT_LIFETIME_MS = 2 * 86_400_000;
const RESULT_MARGIN_MS = 30 * 60_000;
/** An operation that has not finished in this long is given up on: it never produced a clip we could see, and Google bills only for one it generates. */
export const VEO_OPERATION_LIMIT_MS = 3 * 3_600_000;
const USES = ["production", "ads", "social"] as const;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OUTPUT_ROOM_BYTES = 64 * 1024 * 1024;

export type VeoState = "queued" | "submitted" | "done" | "failed" | "uncertain";
export type VeoImage = { role: "first" | "reference"; uploadId: string; castMemberId: string; consentId: string; faceSha256: string };
export type VeoParams = {
  status: VeoState; model: VeoModel; durationSeconds: number; resolution: VeoResolution; aspectRatio: VeoAspect; seed: number | null; negativePrompt: string | null;
  images: VeoImage[]; reservedUsd: number; estimateCredits: number; use: string | null;
  funded: number; claimedAt: number | null; operation: string | null;
  submittedAt: number | null; sendingAt: number | null; readyAt: number | null; lastPolledAt: number | null; pollUntil: number | null; settled: number;
  /** 1 when the figure on the ledger line is ours, not Google's (Google states none), or the clip was lost: to be checked against Google's invoice. */
  reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string; prompt: string };
type Job = { row: Row; veo: VeoParams };

/** The adapter seams for the workflow, for tests. Public callers (the route, the cron) pass none. */
export type VeoDeps = {
  submit?: typeof submitVideo; poll?: typeof pollVideo; fetchClip?: typeof fetchResult;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>; clock?: () => number;
};
/** What the admission may be handed in a test. The public admission passes none. */
export type VeoSeams = { consent?: (castMemberId: string, face: Buffer, scope: ConsentScope) => Promise<ConsentMatch> };

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params, prompt FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, VEO_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let veo: VeoParams | undefined;
  try { veo = (JSON.parse(row.params) as { veo?: VeoParams }).veo; } catch { /* unreadable */ }
  return veo && isVeoModel(veo.model) ? { row, veo } : null;
}
async function patch(genId: string, fields: Partial<VeoParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.veo.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${entries.map(() => "?,?").join(",")}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, VEO_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const executeVeoAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitVeo(input, got, options, {});

/** The same with the test seams. Internal: only the tests import it (tests/unit/veoVideo.spec.ts says so by reading the source). */
export async function admitVeo(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: VeoSeams): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(VEO_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  if (body.tool !== "video") return admissionReply({ error: "Pick video." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!veoConfigured()) return admissionReply({ error: "This is not set up: GEMINI_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("gemini");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  if (body.model != null && !isVeoModel(body.model)) return admissionReply({ error: `Pick ${Object.keys(VEO_RATES.models).join(" or ")}.` }, { status: 400 });
  const model: VeoModel = isVeoModel(body.model) ? body.model : VEO_RATES.defaultModel;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 5000) return admissionReply({ error: "Write what to make, in up to 5,000 characters." }, { status: 400 });
  const durationSeconds = body.durationSeconds == null ? 8 : Number(body.durationSeconds);
  const resolution = (body.resolution == null ? "720p" : body.resolution) as VeoResolution;
  const aspectRatio = (body.aspectRatio == null ? "16:9" : body.aspectRatio) as VeoAspect;
  let seed: number | null = null;
  if (body.seed != null) { if (!Number.isInteger(body.seed) || (body.seed as number) < 0 || (body.seed as number) > 2 ** 31) return admissionReply({ error: "A seed is a whole number." }, { status: 400 }); seed = body.seed as number; }
  let negativePrompt: string | null = null;
  if (body.negativePrompt != null) { if (typeof body.negativePrompt !== "string" || body.negativePrompt.length > 1000) return admissionReply({ error: "What to avoid is up to 1,000 characters." }, { status: 400 }); negativePrompt = body.negativePrompt.trim() || null; }

  /* The images: an optional first frame and up to three references, each of this workspace, openable by this person, a still of a known type, naming the cast member it shows. */
  type Img = { role: "first" | "reference"; uploadId: string; castMemberId: string; ext: string; stored: string };
  const imgs: Img[] = [];
  const viewer = currentViewer();
  const takeImage = async (entry: unknown, role: Img["role"]): Promise<AdmissionReply | null> => {
    const uploadId = entry && typeof entry === "object" ? (entry as { uploadId?: unknown }).uploadId : undefined;
    const cast = entry && typeof entry === "object" ? (entry as { castMemberId?: unknown }).castMemberId : undefined;
    if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) return admissionReply({ error: "That image is not valid." }, { status: 400 });
    const row = (await db().execute({ sql: "SELECT ext, mime, stored_url, bytes FROM uploads WHERE id=? LIMIT 1", args: [uploadId] })).rows[0];
    const openable = !row || !viewer || (await uploadOpenableBy(uploadId, viewer));
    if (!row || !openable || !IMAGE_MIMES.has(String(row.mime ?? "").toLowerCase())) return admissionReply({ error: "Pick images from this workspace's PNG, JPEG or WebP uploads." }, { status: 404 });
    if (Number(row.bytes) > VEO_REFERENCE_LIMIT_BYTES) return admissionReply({ error: "An image is up to 20 MB." }, { status: 400 });
    if (typeof cast !== "string" || !ENTITY_ID.test(cast)) return admissionReply({ error: "Say which cast member each image shows: every face needs the person's consent on record.", code: "bad-input" }, { status: 400 });
    imgs.push({ role, uploadId, castMemberId: cast, ext: String(row.ext), stored: String(row.stored_url) });
    return null;
  };
  if (body.references != null) {
    if (!Array.isArray(body.references)) return admissionReply({ error: "References are a list." }, { status: 400 });
    if (body.references.length > VEO_MAX_REFERENCES) return admissionReply({ error: `At most ${VEO_MAX_REFERENCES} reference images.` }, { status: 400 });
    if (body.firstFrame != null && body.references.length) return admissionReply({ error: "Use a first frame or reference images, not both." }, { status: 400 });
  }
  if (body.firstFrame != null) { const bad = await takeImage(body.firstFrame, "first"); if (bad) return bad; }
  if (Array.isArray(body.references)) {
    for (const entry of body.references) { const bad = await takeImage(entry, "reference"); if (bad) return bad; }
  }
  const referenceCount = imgs.filter((i) => i.role === "reference").length;
  const settingsError = veoSettingsError({ model, durationSeconds, resolution, aspectRatio, references: Array(referenceCount).fill(0) });
  if (settingsError) return admissionReply({ error: settingsError }, { status: 400 });
  const usd = veoQuoteUsd({ model, durationSeconds, resolution });

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
  /* The approval unit, through the margin table keyed by the model. No number of ours here. */
  const estimatedCredits = quotedCredits(usd, model);
  const inCredits = creditsApply(requireTenant());
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "gemini", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2), as the fal path judges it: with a cap per shot, a member's take past it needs an admin. Refused, for a quote and a press, before any row is written. */
  if (shotId && shotCode) {
    /* An admin's own press: not a token, an MCP client, an agent or an Atomik Auto step (the same person test jobLineNow applies). */
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: model, isAdmin: shotCapAdmin(got, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool: "video", model, durationSeconds, resolution, aspectRatio, images: imgs.length, ...(imgs.length ? { needs: ["castMemberId on each image", "projectId", "use"] } : {}) });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  const wall = await allowanceCheck("gemini", usd, model);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, model);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(OUTPUT_ROOM_BYTES);
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(options, body, got, "video", usd, model, { task: VEO_TASK, tool: "video", model, durationSeconds, resolution, aspectRatio, seed, images: imgs.map((i) => i.uploadId), projectId, shotId }, { engine: "veo" });
  if (stopped) return stopped;

  /* ── The consent gate (any image): every one, BEFORE a row is written or a cent reserved. ── */
  const use = typeof body.use === "string" && (USES as readonly string[]).includes(body.use) ? (body.use as (typeof USES)[number]) : null;
  const matched: VeoImage[] = [];
  if (imgs.length) {
    if (!projectId || !use) return admissionReply({ error: "Name the production and what it is for (production, ads or social): a clip from a person's image needs their consent on record.", code: "bad-input" }, { status: 400 });
    try {
      if (!(await faceCheckAvailable())) throw new ConsentMatchError("off", "The face check isn't on for this workspace, so an image of a real person can't be used here yet.", 403);
      for (const img of imgs) {
        const bytes = await readUploadBytes(img.uploadId, img.ext, img.stored, VEO_REFERENCE_LIMIT_BYTES);
        const match = await (seams.consent ?? requireConsentMatch)(img.castMemberId, bytes, { projectId, use });
        matched.push({ role: img.role, uploadId: img.uploadId, castMemberId: img.castMemberId, consentId: match.consentId, faceSha256: match.faceSha256 });
      }
    } catch (error) {
      if (error instanceof ConsentMatchError) return admissionReply({ error: error.message, code: error.code }, { status: error.status });
      return admissionReply({ error: "The face check could not be done. Nothing was billed.", code: "unavailable" }, { status: 503 });
    }
  }

  const genId = newId("gen"), ts = now();
  const veo: VeoParams = {
    status: "queued", model, durationSeconds, resolution, aspectRatio, seed, negativePrompt, images: matched, reservedUsd: usd, estimateCredits: estimatedCredits, use,
    funded: 0, claimedAt: null, operation: null, submittedAt: null, sendingAt: null, readyAt: null, lastPolledAt: null, pollUntil: null, settled: 0, reconcile: 0,
  };
  const params = { task: VEO_TASK, job: shotId ? "shot" : "other", ratio: aspectRatio, resolution, duration: durationSeconds, veo, estUsd: usd, estCredits: 0 };
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "video", model, prompt, JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "veo", "generate", prompt.slice(0, 60), "veo", shotId],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "video", engine: "veo", model, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was submitted. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The reservation could not be made.";
    await settleVeo(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the job runs in this request's continuation, polling every ten seconds, and the ten-minute cron picks up whatever is still running. */
  await options.defer(() => driveVeo(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, model, durationSeconds, notices: capV.notice ? [capV.notice] : undefined });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing unless Google made the clip. */
export async function settleVeo(genId: string, status: "done" | "failed", outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; seconds?: number | null; said?: ProviderOutcome | null; reconcile?: boolean }): Promise<void> {
  const job = await load(genId);
  if (!job || job.veo.settled) return;
  const { row, veo } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "google").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  /* A finished clip is charged at most the quote, whatever is stated: what is stated past the quote is recorded as the overrun (the platform's, flagged to reconcile), never billed.
     A failure Google charged for (costUsd above nothing: a clip made and lost) is recorded at that cost on the ledger line and billed to nobody. */
  const cost = ok ? Math.min(outcome.costUsd, veo.reservedUsd) : Math.max(0, outcome.costUsd);
  const overrunUsd = ok && outcome.costUsd > veo.reservedUsd + 1e-9 ? Math.round((outcome.costUsd - veo.reservedUsd) * 1e6) / 1e6 : null;
  const reconcile = outcome.reconcile === true || overrunUsd !== null;
  const write = ok
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, duration_s=?, params=json_set(params,'$.veo.status','done','$.veo.settled',1,'$.veo.reconcile',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, cost, ms, outcome.seconds ?? veo.durationSeconds, reconcile ? 1 : 0, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?, provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.veo.status','failed','$.veo.settled',1,'$.veo.reconcile',?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The clip failed.").slice(0, 600), ms, cost, said ? serializeOutcome(said) : null, reconcile ? 1 : 0, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: "video", engine: "veo", model: veo.model, status: ok ? "succeeded" : "failed", engineCostUsd: cost, durationMs: ms,
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

/** One step, safe to call from anywhere at any time. Public: no seams (the cron and the continuation call this one). */
export const advanceVeoJob = (genId: string): Promise<VeoParams | null> => advanceVeoJobWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceVeoJobWith(genId: string, deps: VeoDeps): Promise<VeoParams | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, genId, async () => {
    let job = await load(genId);
    if (!job) return null;
    if (job.veo.settled || job.veo.status === "uncertain" || job.veo.status === "failed" || job.veo.status === "done") return job.veo;
    if (job.veo.status === "queued") {
      if (!job.veo.funded) return job.veo;
      const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.veo.status')='queued' AND json_extract(params,'$.veo.funded')=1 AND json_extract(params,'$.veo.claimedAt') IS NULL AND status='running'" });
      if (!claimed) {
        // Someone holds the claim. A young claim is a submission in flight; an old one with no operation is a lost acknowledgement.
        const held = (await load(genId))?.veo;
        if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
          /* `sendingAt` is written the instant before the one request goes out. A claim that never reached it never sent anything: settled at nothing. Only one that did, and has no operation, is a lost acknowledgement. */
          if (!held.sendingAt) await settleVeo(genId, "failed", { message: "Nothing was submitted: the job stopped before it was sent. Nothing was billed.", costUsd: 0 });
          else await patch(genId, { status: "uncertain" });
        }
        return (await load(genId))?.veo ?? null;
      }
      job = (await load(genId))!;
      const { veo, row } = job;
      /* Consent is judged again at the moment of sending: a record withdrawn or ended while the job waited stops it, and nothing has been sent. */
      for (const img of veo.images) {
        const c = await getConsent(img.consentId).catch(() => null);
        if (!c || !consentLive(c)) { await settleVeo(genId, "failed", { message: "Nothing was sent: a person's consent no longer holds. Nothing was billed.", costUsd: 0 }); return (await load(genId, { any: true }))?.veo ?? null; }
      }
      /* The images are read before anything is sent: one that cannot be read submits nothing and refunds everything. */
      const files: { role: VeoImage["role"]; bytes: Buffer; mime: string }[] = [];
      try {
        for (const img of veo.images) {
          const up = (await db().execute({ sql: "SELECT ext, mime, stored_url FROM uploads WHERE id=? LIMIT 1", args: [img.uploadId] })).rows[0];
          if (!up) throw new Error("An image is no longer available in this workspace.");
          files.push({ role: img.role, mime: String(up.mime).toLowerCase(), bytes: await readUploadBytes(img.uploadId, String(up.ext), String(up.stored_url), VEO_REFERENCE_LIMIT_BYTES) });
        }
      } catch (error) {
        await settleVeo(genId, "failed", { message: `Nothing was submitted: ${messageOf(error, "an image could not be read.")} Nothing was billed.`, costUsd: 0 });
        return (await load(genId, { any: true }))?.veo ?? null;
      }
      const first = files.find((f) => f.role === "first");
      const references = files.filter((f) => f.role === "reference");
      try {
        await patch(genId, { sendingAt: clock() });
        const sent = await (deps.submit ?? submitVideo)({
          model: veo.model, prompt: row.prompt, durationSeconds: veo.durationSeconds, resolution: veo.resolution, aspectRatio: veo.aspectRatio,
          ...(veo.negativePrompt ? { negativePrompt: veo.negativePrompt } : {}), ...(veo.seed != null ? { seed: veo.seed } : {}),
          ...(first ? { firstFrame: { bytes: first.bytes, mime: first.mime } } : {}), ...(references.length ? { references: references.map((r) => ({ bytes: r.bytes, mime: r.mime })) } : {}),
        });
        await patch(genId, { status: "submitted", operation: sent.operation, submittedAt: clock() });
      } catch (error) {
        if (error instanceof VeoError && error.rejectedBeforeGeneration) {
          // Refused before work: the whole reservation comes back.
          await settleVeo(genId, "failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: googleErrorOutcome(error.status ?? 400, { error: { message: error.message } }) });
          return (await load(genId, { any: true }))?.veo ?? null;
        }
        // A timeout or a dropped connection: Google may hold a charged job under a name we never saw. Held for review, never sent again.
        await patch(genId, { status: "uncertain" });
        await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
        return (await load(genId))?.veo ?? null;
      }
      job = (await load(genId))!;
    }
    const veo = job.veo;
    if (!veo.operation) return veo;
    // One poller at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const leased = await patch(genId, { pollUntil: until }, { sql: "json_extract(params,'$.veo.settled')=0 AND COALESCE(json_extract(params,'$.veo.pollUntil'),0)<?", args: [clock()] });
    if (!leased) return veo;
    try {
      await patch(genId, { lastPolledAt: clock() });
      /* Past the two days a finished clip's address is dead: Google made it, so Google charged for it: recorded at the quote, billed to nobody, marked to reconcile. */
      if (veo.readyAt && clock() - Number(veo.readyAt) > VEO_RESULT_LIFETIME_MS - RESULT_MARGIN_MS) {
        await settleVeo(genId, "failed", { message: "The clip was ready but could not be saved in time. Nothing was billed.", costUsd: veo.reservedUsd, reconcile: true, said: silentOutcome("google", "run", "not_kept", "result expired before it was saved") });
        return (await load(genId, { any: true }))?.veo ?? null;
      }
      /* An operation that never finishes is let go: Google bills only for a clip it generates, so it is settled at nothing and marked to reconcile in case one appears on the invoice. */
      if (!veo.readyAt && veo.submittedAt && clock() - Number(veo.submittedAt) > VEO_OPERATION_LIMIT_MS) {
        await settleVeo(genId, "failed", { message: "Google did not finish this clip. Nothing was billed.", costUsd: 0, reconcile: true, said: silentOutcome("google", "run", "timeout", "operation did not finish") });
        return (await load(genId, { any: true }))?.veo ?? null;
      }
      const state = await (deps.poll ?? pollVideo)({ operation: veo.operation });
      if (state.status === "failed") {
        /* Google charges only for a clip that is generated; a blocked or failed one is not charged. */
        const blocked = /safety filter/i.test(state.failure ?? "");
        await settleVeo(genId, "failed", { message: `${state.failure ?? "Google could not make this clip."} Nothing was billed.`, costUsd: 0, said: blocked ? safetyBlockOutcome("google", "SAFETY") : silentOutcome("google", "run", "failed", state.failure) });
        return (await load(genId, { any: true }))?.veo ?? null;
      }
      if (state.status !== "ready" || !state.resultUrl) return (await load(genId))?.veo ?? null;
      if (!veo.readyAt) await patch(genId, { readyAt: clock() });
      /* The moment it is done: fetched and stored, before anything else. The key goes on the first request only (lib/veo.ts). */
      const bytes = await (deps.fetchClip ?? fetchResult)(state.resultUrl);
      const { value: stored } = await withRetry(() => (deps.store ?? storeVideoBytes)(genId, bytes), { max: 3 });
      /* Google states no cost. The clip's own length is read from its container: what Google bills is the seconds it made, so a clip shorter than asked settles at the
         seconds it has times the rate (never above the quote); one we cannot measure settles at the quote. Either way the figure is ours, marked to reconcile. */
      const read = mp4DurationSeconds(bytes);
      const billedSeconds = read != null ? billedWholeSeconds(read) : null;
      /* A length that bills as nothing (a header under a twentieth of a second) is not a length: it is read as unreadable and the quote stands. */
      const measured = billedSeconds != null && billedSeconds > 0 ? read : null;
      const rate = VEO_RATES.models[veo.model].usdPerSecond[veo.resolution];
      /* Google bills per second, so the measured length is rounded UP to whole seconds (lib/mp4Duration.ts: a 7.96 s clip is 8). */
      const measuredUsd = measured != null && billedSeconds != null ? Math.ceil(billedSeconds * rate * 1e6 - 1e-6) / 1e6 : null;
      await settleVeo(genId, "done", { costUsd: measuredUsd != null ? Math.min(veo.reservedUsd, measuredUsd) : veo.reservedUsd, seconds: measured, reconcile: true, storedUrl: stored.url, bytes: stored.bytes });
      return (await load(genId, { any: true }))?.veo ?? null;
    } catch (error) {
      // Transport or storage: keep the operation and the reservation; the next pass asks again (the two days still run). Nothing is resubmitted.
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [messageOf(error, "The clip could not be collected yet."), now(), genId] });
      throw error;
    } finally {
      await patch(genId, { pollUntil: null }, { sql: "json_extract(params,'$.veo.pollUntil')=?", args: [until] }).catch(() => {});
    }
  });
}

/** Runs a job in this request's own continuation: steps and pauses until it ends or the time is up; the cron takes over after. */
export async function driveVeo(genId: string, options: { budgetMs?: number; pauseMs?: number } = {}): Promise<void> {
  const until = Date.now() + (options.budgetMs ?? 240_000);
  for (;;) {
    const veo = await advanceVeoJob(genId).catch(() => null);
    if (!veo || veo.settled || veo.status === "uncertain" || veo.status === "done" || veo.status === "failed" || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? VEO_POLL_INTERVAL_MS));
  }
}

/** The cron's stage: queued and submitted jobs are advanced (a finished clip is collected at once). Uncertain and terminal rows are left alone. */
export async function recoverVeoJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: VeoDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.veo.status') IN ('queued','submitted')
          ORDER BY updated_at ASC LIMIT ?`,
    args: [VEO_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await advanceVeoJobWith(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tool ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The one tool, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer. */
export const VEO_TOOLS = [
  {
    provider: "google", kind: "engine" as const, route: "/api/veo", needs: ["GEMINI_API_KEY", "VEO_ENABLED"], who: "prepare: anyone; approve: a person" as const,
    models: Object.keys(VEO_RATES.models) as VeoModel[], id: "veo_video", tool: "video" as const,
    inputs: { prompt: "what to make", model: "veo-3.1-generate-preview (default) or veo-3.1-fast-generate-preview", durationSeconds: "4, 6 or 8 (default 8)", resolution: "720p (default) or 1080p (8 s only)", aspectRatio: "16:9 (default) or 9:16", firstFrame: "optional { uploadId, castMemberId }", references: "up to three { uploadId, castMemberId }, 8 s", projectId: "the production (required with an image)", use: "production, ads or social (required with an image)", maxCredits: "the approved price" },
    output: "a video take, with its sound",
    gate: "a live consent record for the person each image shows (lib/consentMatch.ts)",
  },
];

/** The tools present for a workspace: none unless the engine is on for it. */
export async function veoTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof VEO_TOOLS> {
  if (!(await engineEnabled(VEO_SWITCH, workspace))) return [];
  return VEO_TOOLS;
}
