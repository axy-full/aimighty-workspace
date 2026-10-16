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
import { readUploadBytes, storeImageBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { currentViewer, uploadOpenableBy } from "./uploadAccess";
import { engineEnabled } from "./engineGate";
import { BFL_RATES, type BflModel } from "./vendorRates";
import { BFL_RESULT_LIFETIME_MS, BFL_REFERENCE_LIMIT_BYTES, BFL_SWITCH, BflError, bflConfigured, fetchResult, isBflModel, pollImage, submitImage } from "./bfl";

/**
 * FLUX.2 through BFL (lib/bfl.ts): `flux2_image` (a still from words) and `flux2_edit` (a still from words and one to eight references of this workspace),
 * one door (POST /api/bfl { tool }) for the button, Make, a board card, Atomik, a saved skill and an outside agent: the same quote, the same approval, the same
 * price. An ASYNCHRONOUS vendor job kept as a durable workflow in the take's own row (generations.params.bfl; no new table),
 * shaped like lip-sync (lib/lipSync.ts):
 *
 *   queued     admitted, funded (the reservation is the whole price)
 *   submitted  the job is with BFL (an id and the polling address BFL named)
 *   done       the image is fetched THE MOMENT it is Ready (its signed address lives ten minutes), STORED under the workspace's own prefix, the take settled
 *   failed     refused before work (settled at NOTHING, "Nothing billed"); moderated or failed after submission, or its image lost past the ten minutes: the workspace is billed nothing, and the ledger
 *              line records what BFL charged (below)
 *   uncertain  the submission's acknowledgement was lost. Nothing here ever submits a second time: a lost reply may still be a charged job
 *
 * CONSENT, FINAL (owner, 16 Oct 2026): there is NO face check and no consent record here. Particl matches no face and screens no prompt for resemblance; the person
 * generating is responsible, BFL's own filters apply and their refusals are shown as they come. A reference is an image upload of this workspace, nothing more.
 *
 * MONEY. Quote: the output megapixels (rounded up) and each reference's megapixels (rounded up) at BFL_RATES (lib/vendorRates.ts, verified against BFL's published
 * pricing data, 16 Oct 2026; confirm against the first invoice), through the margin table (`quotedCredits`, keyed by the model); reserved at the quote on the meter; settled at the cost BFL states when it states one,
 * else at the quote (and marked `reconcile`: the figure is ours), and NEVER billed above the quote (a stated figure above it settles at the quote, the excess is recorded as the meter's `overrun_usd` and marked `reconcile`).
 * A failure BFL charged for is recorded on the ledger line at its cost, unbilled (the workspace still reads "Nothing billed"): an image lost after BFL said Ready is always charged (its stated cost, else the quote,
 * marked `reconcile`); a moderated or failed job at the cost BFL's reply stated for it, and at nothing, marked `reconcile`, when it stated none (BFL's pages say nothing about billing those). A person approves: `maxCredits` must cover the quote.
 *
 * PRIVACY. References are read from this workspace (the same open-by-person rule as every source) and sent as data, never as a link of ours. BFL's privacy
 * policy allows training on inputs and outputs unless the account has opted out (the owner has done the opt-out in BFL's dashboard; counsel before any customer switch).
 */
export const BFL_TASK = "bfl_image";
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const POLL_LEASE_MS = 120_000;
const SUBMIT_GRACE_MS = 10 * 60_000;
export const BFL_POLL_INTERVAL_MS = 2_000;
const MULTIPLE = 16;
const MIN_SIDE = 64;

export type BflState = "queued" | "submitted" | "done" | "failed" | "uncertain";
export type BflParams = {
  status: BflState; tool: "image" | "edit"; model: BflModel; width: number; height: number; seed: number | null;
  references: { uploadId: string; megapixels: number }[];
  outputMegapixels: number; reservedUsd: number; estimateCredits: number;
  funded: number; claimedAt: number | null; bflId: string | null; pollingUrl: string | null; statedUsd: number | null;
  submittedAt: number | null; sendingAt: number | null; readyAt: number | null; lastPolledAt: number | null; pollUntil: number | null; settled: number;
  /** 1 when the figure on the ledger line is ours, not BFL's (none stated, or BFL stated more than the quote): to be checked against BFL's invoice. */
  reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string; prompt: string };
type Job = { row: Row; bfl: BflParams };

/** The adapter seams for the workflow, for tests. Public callers (the route, the cron) pass none. */
export type BflDeps = {
  submit?: typeof submitImage; poll?: typeof pollImage; fetchImage?: typeof fetchResult;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>; clock?: () => number;
};
/** What the admission may be handed in a test. The public admission passes none. */
export type BflSeams = Record<never, never>;

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params, prompt FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, BFL_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let bfl: BflParams | undefined;
  try { bfl = (JSON.parse(row.params) as { bfl?: BflParams }).bfl; } catch { /* unreadable */ }
  return bfl && isBflModel(bfl.model) ? { row, bfl } : null;
}
async function patch(genId: string, fields: Partial<BflParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.bfl.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${entries.map(() => "?,?").join(",")}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, BFL_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── The quote ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Whole megapixels, rounded up (BFL prices the first and each further megapixel). */
export const megapixels = (width: number, height: number): number => Math.max(1, Math.ceil((width * height) / 1_000_000 - 1e-9));

/** The price in dollars, or a refusal in words: only what the plan records is priced. */
export function bflQuote(model: BflModel, outputMp: number, referenceMps: number[]): { usd: number } | { error: string } {
  const r = BFL_RATES.models[model];
  if (outputMp > r.maxMp) return { error: `${model} makes up to ${r.maxMp} megapixels.` };
  if (referenceMps.length > r.maxRefs) return { error: `${model} takes up to ${r.maxRefs} references.` };
  let usd = r.firstMp;
  if (outputMp > 1) usd += (outputMp - 1) * r.extraMp;
  if (referenceMps.length) usd += referenceMps.reduce((n, mp) => n + mp, 0) * r.refMp;
  /* Rounded UP to the micro-dollar, so a quote is never under. */
  return { usd: Math.ceil(usd * 1e6 - 1e-6) / 1e6 };
}

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const executeBflAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitBfl(input, got, options);

/** The admission. Internal: only the tests and the door import it (tests/unit/bfl.spec.ts says so by reading the source). */
export async function admitBfl(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(BFL_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const tool = body.tool;
  if (tool !== "image" && tool !== "edit") return admissionReply({ error: "Pick image or edit." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!bflConfigured()) return admissionReply({ error: "This is not set up: BFL_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("bfl");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  if (body.model != null && !isBflModel(body.model)) return admissionReply({ error: "Pick flux-2-pro, flux-2-flex or flux-2-max." }, { status: 400 });
  const model: BflModel = isBflModel(body.model) ? body.model : BFL_RATES.defaultModel;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 5000) return admissionReply({ error: "Write what to make, in up to 5,000 characters." }, { status: 400 });
  const width = body.width == null ? 1024 : Number(body.width), height = body.height == null ? 1024 : Number(body.height);
  for (const side of [width, height]) if (!Number.isInteger(side) || side < MIN_SIDE || side % MULTIPLE !== 0) return admissionReply({ error: `Width and height are whole numbers from ${MIN_SIDE}, in steps of ${MULTIPLE}.` }, { status: 400 });
  const outputMp = megapixels(width, height);
  if ((width * height) / 1_000_000 > BFL_RATES.models[model].maxMp + 1e-9) return admissionReply({ error: `${model} makes up to ${BFL_RATES.models[model].maxMp} megapixels.` }, { status: 400 });
  let seed: number | null = null;
  if (body.seed != null) { if (!Number.isInteger(body.seed) || (body.seed as number) < 0 || (body.seed as number) > 2 ** 31) return admissionReply({ error: "A seed is a whole number." }, { status: 400 }); seed = body.seed as number; }

  /* The references of an edit: each of this workspace, openable by this person, an image of a measured size, naming the cast member it shows. */
  type Ref = { uploadId: string; mp: number; ext: string; stored: string };
  const refs: Ref[] = [];
  if (tool === "image") { if (body.references != null) return admissionReply({ error: "A still from words takes no references: use edit." }, { status: 400 }); }
  else {
    const list = Array.isArray(body.references) ? body.references : [];
    if (!list.length) return admissionReply({ error: "Add one to eight reference images." }, { status: 400 });
    if (list.length > BFL_RATES.models[model].maxRefs) return admissionReply({ error: `${model} takes up to ${BFL_RATES.models[model].maxRefs} references.` }, { status: 400 });
    const viewer = currentViewer();
    for (const entry of list) {
      const uploadId = entry && typeof entry === "object" ? (entry as { uploadId?: unknown }).uploadId : undefined;
      if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) return admissionReply({ error: "That reference is not valid." }, { status: 400 });
      const row = (await db().execute({ sql: "SELECT ext, mime, stored_url, bytes, width, height FROM uploads WHERE id=? LIMIT 1", args: [uploadId] })).rows[0];
      const openable = !row || !viewer || (await uploadOpenableBy(uploadId, viewer));
      if (!row || !openable || !String(row.mime ?? "").startsWith("image/")) return admissionReply({ error: "Pick references from this workspace's image uploads." }, { status: 404 });
      if (Number(row.bytes) > BFL_REFERENCE_LIMIT_BYTES) return admissionReply({ error: "A reference is up to 20 MB." }, { status: 400 });
      const w = Number(row.width), h = Number(row.height);
      if (!(w > 0) || !(h > 0)) return admissionReply({ error: "A reference has no measured size, so it cannot be priced." }, { status: 422 });
      refs.push({ uploadId, mp: megapixels(w, h), ext: String(row.ext), stored: String(row.stored_url) });
    }
  }
  const priced = bflQuote(model, outputMp, refs.map((r) => r.mp));
  if ("error" in priced) return admissionReply({ error: priced.error }, { status: 400 });
  const usd = priced.usd;

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
  /* The approval unit, through the margin table keyed by the model (as the reservation keys an image job). No number of ours here. */
  const estimatedCredits = quotedCredits(usd, model);
  const inCredits = creditsApply(requireTenant());
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "bfl", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2): with a cap per shot, a member's take past it needs an admin. Refused on the quote and the press, before any face is checked and any row is written, so no failed take is left in the Library. */
  if (shotId && shotCode) {
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: model, isAdmin: shotCapAdmin(got, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool, model, width, height, megapixels: outputMp, references: refs.length });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  const wall = await allowanceCheck("bfl", usd, model);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, model);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(8 * 1024 * 1024);
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(options, body, got, "image", usd, model, { task: BFL_TASK, tool, model, width, height, seed, references: refs.map((r) => r.uploadId), projectId, shotId }, { engine: "bfl" });
  if (stopped) return stopped;

  const matched: BflParams["references"] = refs.map((r) => ({ uploadId: r.uploadId, megapixels: r.mp }));

  const genId = newId("gen"), ts = now();
  const bfl: BflParams = {
    status: "queued", tool, model, width, height, seed, references: matched, outputMegapixels: outputMp, reservedUsd: usd, estimateCredits: estimatedCredits,
    funded: 0, claimedAt: null, bflId: null, pollingUrl: null, statedUsd: null, submittedAt: null, sendingAt: null, readyAt: null, lastPolledAt: null, pollUntil: null, settled: 0, reconcile: 0,
  };
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(width, height);
  const params = { task: BFL_TASK, job: tool === "edit" ? "fix" : "keyframe", ratio: `${width / g}:${height / g}`, size: `${width}x${height}`, bfl, estUsd: usd, estCredits: 0 };
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "image", model, prompt, JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "bfl", "generate", prompt.slice(0, 60), "bfl", shotId],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "image", engine: "bfl", model, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was submitted. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The reservation could not be made.";
    await settleBfl(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the job runs in this request's continuation, polling every couple of seconds, and the ten-minute cron picks up whatever is still running. */
  await options.defer(() => driveBfl(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, model, notices: capV.notice ? [capV.notice] : undefined });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing. */
export async function settleBfl(genId: string, status: "done" | "failed", outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; said?: ProviderOutcome | null; reconcile?: boolean }): Promise<void> {
  const job = await load(genId);
  if (!job || job.bfl.settled) return;
  const { row, bfl } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "bfl").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  /* A finished job is charged at most the quote, whatever BFL states: what it states past the quote is recorded as the overrun (the platform's, flagged to reconcile), never billed.
     A failure BFL charged for (costUsd above nothing) is recorded at that cost on the ledger line and billed to nobody. */
  const cost = Math.min(Math.max(0, outcome.costUsd), bfl.reservedUsd);
  const overrunUsd = outcome.costUsd > bfl.reservedUsd + 1e-9 ? Math.round((outcome.costUsd - bfl.reservedUsd) * 1e6) / 1e6 : null;
  const reconcile = outcome.reconcile === true || overrunUsd !== null;  const write = ok
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, params=json_set(params,'$.bfl.status','done','$.bfl.settled',1,'$.bfl.reconcile',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, cost, ms, reconcile ? 1 : 0, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?, provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.bfl.status','failed','$.bfl.settled',1,'$.bfl.reconcile',?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The image failed.").slice(0, 600), ms, cost, said ? serializeOutcome(said) : null, reconcile ? 1 : 0, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: "image", engine: "bfl", model: bfl.model, status: ok ? "succeeded" : "failed", engineCostUsd: cost, durationMs: ms,
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
export const advanceBflJob = (genId: string): Promise<BflParams | null> => advanceBflJobWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceBflJobWith(genId: string, deps: BflDeps): Promise<BflParams | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, genId, async () => {
    let job = await load(genId);
    if (!job) return null;
    if (job.bfl.settled || job.bfl.status === "uncertain" || job.bfl.status === "failed" || job.bfl.status === "done") return job.bfl;
    if (job.bfl.status === "queued") {
      if (!job.bfl.funded) return job.bfl;
      const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.bfl.status')='queued' AND json_extract(params,'$.bfl.funded')=1 AND json_extract(params,'$.bfl.claimedAt') IS NULL AND status='running'" });
      if (!claimed) {
        // Someone holds the claim. A young claim is a submission in flight; an old one with no job id is a lost acknowledgement.
        const held = (await load(genId))?.bfl;
        if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
          /* `sendingAt` is written the instant before the one request goes out. A claim that never reached it never sent anything: settled at nothing. Only one that did, and has no job id, is a lost acknowledgement. */
          if (!held.sendingAt) await settleBfl(genId, "failed", { message: "Nothing was submitted: the job stopped before it was sent. Nothing was billed.", costUsd: 0 });
          else await patch(genId, { status: "uncertain" });
        }
        return (await load(genId))?.bfl ?? null;
      }
      job = (await load(genId))!;
      const { bfl, row } = job;
      /* The references are read before anything is sent: one that cannot be read submits nothing and refunds everything. */
      let references: Buffer[];
      try {
        references = [];
        for (const ref of bfl.references) {
          const up = (await db().execute({ sql: "SELECT ext, stored_url FROM uploads WHERE id=? LIMIT 1", args: [ref.uploadId] })).rows[0];
          if (!up) throw new Error("A reference is no longer available in this workspace.");
          references.push(await readUploadBytes(ref.uploadId, String(up.ext), String(up.stored_url), BFL_REFERENCE_LIMIT_BYTES));
        }
      } catch (error) {
        await settleBfl(genId, "failed", { message: `Nothing was submitted: ${messageOf(error, "a reference could not be read.")} Nothing was billed.`, costUsd: 0 });
        return (await load(genId, { any: true }))?.bfl ?? null;
      }
      try {
        await patch(genId, { sendingAt: clock() });
        const sent = await (deps.submit ?? submitImage)({ model: bfl.model, prompt: row.prompt, width: bfl.width, height: bfl.height, ...(bfl.seed != null ? { seed: bfl.seed } : {}), references });
        await patch(genId, { status: "submitted", bflId: sent.id, pollingUrl: sent.pollingUrl, statedUsd: sent.statedUsd, submittedAt: clock() });
      } catch (error) {
        if (error instanceof BflError && error.rejectedBeforeGeneration) {
          // Refused before work: the whole reservation comes back.
          await settleBfl(genId, "failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: directErrorOutcome("bfl", error.status ?? 400, error.message) });
          return (await load(genId, { any: true }))?.bfl ?? null;
        }
        // A timeout or a dropped connection: BFL may hold a charged job under an id we never saw. Held for review, never sent again.
        await patch(genId, { status: "uncertain" });
        await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
        return (await load(genId))?.bfl ?? null;
      }
      job = (await load(genId))!;
    }
    const bfl = job.bfl;
    if (!bfl.bflId || !bfl.pollingUrl) return bfl;
    // One poller at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const leased = await patch(genId, { pollUntil: until }, { sql: "json_extract(params,'$.bfl.settled')=0 AND COALESCE(json_extract(params,'$.bfl.pollUntil'),0)<?", args: [clock()] });
    if (!leased) return bfl;
    try {
      await patch(genId, { lastPolledAt: clock() });
      /* Past the ten minutes a Ready image's address is dead: it is a failure to collect, settled at nothing (the platform absorbs it). */
      if (bfl.readyAt && clock() - Number(bfl.readyAt) > BFL_RESULT_LIFETIME_MS - 30_000) {
        /* BFL made it (it said Ready), so BFL charged for it: recorded at its stated cost, else the quote, billed to nobody, and marked to reconcile when the figure is ours. */
        await settleBfl(genId, "failed", { message: "The image was ready but could not be saved in time. Nothing was billed.", costUsd: bfl.statedUsd ?? bfl.reservedUsd, reconcile: bfl.statedUsd == null, said: silentOutcome("bfl", "run", "not_kept", "result expired before it was saved") });
        return (await load(genId, { any: true }))?.bfl ?? null;
      }
      const state = await (deps.poll ?? pollImage)({ id: bfl.bflId, pollingUrl: bfl.pollingUrl });
      if (state.status === "failed") {
        /* BFL's pages say nothing about billing a failed or moderated job. When its reply stated a cost for the job, that is what it is recorded at (billed to nobody); when it stated none it is recorded as nothing and marked to reconcile against BFL's invoice. */
        await settleBfl(genId, "failed", { message: `${state.failure ?? "BFL could not make this image."} Nothing was billed.`, costUsd: bfl.statedUsd ?? 0, reconcile: bfl.statedUsd == null, said: silentOutcome("bfl", "run", "failed", state.failure) });
        return (await load(genId, { any: true }))?.bfl ?? null;
      }
      if (state.status !== "ready" || !state.resultUrl) return (await load(genId))?.bfl ?? null;
      if (!bfl.readyAt) await patch(genId, { readyAt: clock() });
      /* The moment it is Ready: fetched and stored, before anything else. Never fetched with our key, only from the bfl.ai address in the poll. */
      const bytes = await (deps.fetchImage ?? fetchResult)(state.resultUrl);
      const { value: stored } = await withRetry(() => (deps.store ?? storeImageBytes)(genId, bytes), { max: 3 });
      /* BFL's own figure when it states one, else the quote and marked to reconcile; never billed above the quote (settleBfl records the excess as the overrun and marks it). */
      await settleBfl(genId, "done", { costUsd: bfl.statedUsd ?? bfl.reservedUsd, reconcile: bfl.statedUsd == null, storedUrl: stored.url, bytes: stored.bytes });
      return (await load(genId, { any: true }))?.bfl ?? null;
    } catch (error) {
      // Transport or storage: keep the id and the reservation; the next pass asks again (the ten minutes still run). Nothing is resubmitted.
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [messageOf(error, "The image could not be collected yet."), now(), genId] });
      throw error;
    } finally {
      await patch(genId, { pollUntil: null }, { sql: "json_extract(params,'$.bfl.pollUntil')=?", args: [until] }).catch(() => {});
    }
  });
}

/** Runs a job in this request's own continuation: steps and short pauses until it ends or the time is up; the cron takes over after. */
export async function driveBfl(genId: string, options: { budgetMs?: number; pauseMs?: number } = {}): Promise<void> {
  const until = Date.now() + (options.budgetMs ?? 240_000);
  for (;;) {
    const bfl = await advanceBflJob(genId).catch(() => null);
    if (!bfl || bfl.settled || bfl.status === "uncertain" || bfl.status === "done" || bfl.status === "failed" || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? BFL_POLL_INTERVAL_MS));
  }
}

/** The cron's stage: queued and submitted jobs are advanced (a Ready image is collected at once). Uncertain and terminal rows are left alone. */
export async function recoverBflJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: BflDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.bfl.status') IN ('queued','submitted')
          ORDER BY updated_at ASC LIMIT ?`,
    args: [BFL_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await advanceBflJobWith(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tools ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const COMMON = { provider: "bfl", kind: "engine" as const, route: "/api/bfl", needs: ["BFL_API_KEY", "BFL_ENABLED"], who: "prepare: anyone; approve: a person" as const, models: Object.keys(BFL_RATES.models) as BflModel[] };
/** The two tools, declared beside their handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer. */
export const BFL_TOOLS = [
  { ...COMMON, id: "flux2_image", tool: "image" as const, inputs: { prompt: "what to make", model: "flux-2-pro (default), flux-2-flex or flux-2-max", width: "a multiple of 16 (default 1024)", height: "a multiple of 16 (default 1024)", seed: "optional", maxCredits: "the approved price" }, output: "an image take" },
  { ...COMMON, id: "flux2_edit", tool: "edit" as const, inputs: { prompt: "what to change", references: "one to eight { uploadId } of this workspace", projectId: "the production (optional)", maxCredits: "the approved price" }, output: "an image take, linked to every reference" },
];

/** The tools present for a workspace: none unless the engine is on for it (the house, or a workspace on the engine list). No face check gates any of them. */
export async function bflTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof BFL_TOOLS> {
  return (await engineEnabled(BFL_SWITCH, workspace)) ? BFL_TOOLS : [];
}
