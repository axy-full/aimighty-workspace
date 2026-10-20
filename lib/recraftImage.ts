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
import { readImageBytes, readUploadBytes, storeImageBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { uploadOpenableBy, type Viewer } from "./uploadAccess";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { engineEnabled } from "./engineGate";
import { VendorPriceUnavailable, fileVendorQuote } from "./vendorPriceFile";
import {
  RECRAFT_DEFAULT_MODEL, RECRAFT_DEFAULT_SIZE, RECRAFT_MODELS, RECRAFT_RASTER_MODELS, RECRAFT_SIZES, RECRAFT_SOURCE_LIMITS, RECRAFT_STYLE, RECRAFT_SWITCH, RecraftError, generateImage, isRecraftModel, isVectorModel,
  recraftConfigured, removeBackground, vectorize, type RecraftModel, type RecraftReply,
} from "./recraft";

/**
 * Recraft through its own API (lib/recraft.ts): `recraft_image` (a still from words), `recraft_remove_background` (a still of this workspace with its background removed) and `recraft_vectorize`
 * (a still turned into an SVG), one door (POST /api/recraft { tool }) for the button, Make, a board card, Atomik, a saved skill and an outside agent: the same quote, the same approval, the same
 * price. The vendor's reply carries the image, so the job is ONE request kept as a durable workflow in the take's own row (generations.params.recraft; no new table), shaped like
 * lip-sync's (lib/lipSync.ts) without the polling:
 *
 *   queued     admitted and funded (the reservation is the whole price)
 *   done       the one request was answered, the image STORED under the workspace's own prefix, the take settled
 *   failed     refused before work (settled at NOTHING, "Nothing billed"); or the image Recraft made could not be kept: billed to nobody, the ledger line records what Recraft charged (below)
 *   uncertain  the request's reply was lost. Nothing here ever sends it a second time: a lost reply may still be a charged job
 *
 * **SVG IS REFUSED, and that is a must-have to lift.** A vector image and a vectorized still come back as an SVG, which is a document that can carry script and external references (lib/serveType.ts keeps
 * `image/svg+xml` off the inline list for exactly that). The repository has NO SVG sanitiser, so every request whose output would be an SVG (the vector models, `recraft_vectorize`) is refused in words
 * BEFORE anything is quoted for work, written or reserved, and the tools that would make one are listed as unavailable. Lifting it needs: a strict allow-list sanitiser (no script, no event
 * handler, no external reference, no foreignObject), SVG as a stored original with a download-only serve (or `default-src 'none'`), and tests of each. Nothing here stores or serves an SVG.
 *
 * MONEY. Quote: the model's (or the tool's) cost per image from the server's private vendor price file (lib/vendorPriceFile.ts, VENDOR_PRICES_PATH; no figure is in the
 * repo), keyed by the model or tool id (`recraftModelOf`), through the margin table keyed by the same id (`quotedCredits`). No file, a bad file, or no row for the id (or a
 * banded one): the quote is refused (503, "unpriced") before any row is written, with nothing reserved or sent. The per-image rate the job was quoted at is kept on its row
 * (`rateUsd`); it is reserved at the quote and settled at THAT rate for its one image, never above the quote, and the file is never read again for it. The units Recraft's reply
 * states (its `credits`) are kept on the row (`statedUnits`) for reconciling against the invoice, never turned into dollars here. A failure Recraft's pages say nothing about is
 * settled at nothing ("Nothing billed"); an image lost after Recraft answered is always charged (the kept rate, marked `reconcile`), recorded unbilled. A person approves:
 * `maxCredits` must cover the quote. One image a job: ask again for more.
 *
 * NO FACE MATCHING. The owner has taken consent matching out of the product (16 Oct 2026: "No face matching anywhere, ever"), so nothing here checks a face or a consent record. Style references
 * (which would carry a person's image) are not offered, and a still sent to be cut out is read from this workspace like any other source.
 *
 * PRIVACY. A source is read from this workspace (the same open-by-person rule as every source) and sent as data, never as a link of ours. Recraft's terms: API Assets are not stored by default (§ 4.2) and not used for training (§ 6.3).
 */
export const RECRAFT_TASK = "recraft_image";
export const SVG_REFUSAL = "SVG output is not switched on yet: an SVG can carry script and outside references, and a sanitiser has to clean it before it is stored or served. Nothing was quoted for work and nothing was billed.";
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SUBMIT_GRACE_MS = 10 * 60_000;
export type RecraftTool = "image" | "remove_background" | "vectorize";
export type RecraftState = "queued" | "done" | "failed" | "uncertain";
export type RecraftParams = {
  status: RecraftState; tool: RecraftTool; model: string; size: string; style: string | null; source: { kind: "upload" | "generation"; id: string } | null;
  /** The per-image rate from the price file at the quote: the job settles at it, never re-reading the file. */
  rateUsd: number; reservedUsd: number; estimateCredits: number; funded: number; claimedAt: number | null; sendingAt: number | null;
  /** The API units Recraft's reply stated it used, when it said: for reconciling against the invoice, never billed from. */
  statedUnits: number | null; settled: number; reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string; prompt: string };
type Job = { row: Row; r: RecraftParams };

/** The adapter seams for the workflow, for tests. Public callers (the route, the cron) pass none. */
export type RecraftDeps = {
  generate?: typeof generateImage; vectorize?: typeof vectorize; removeBackground?: typeof removeBackground;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>; clock?: () => number;
};

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params, prompt FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, RECRAFT_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let r: RecraftParams | undefined;
  try { r = (JSON.parse(row.params) as { recraft?: RecraftParams }).recraft; } catch { /* unreadable */ }
  return r && (r.tool === "image" || r.tool === "remove_background" || r.tool === "vectorize") ? { row, r } : null;
}
async function patch(genId: string, fields: Partial<RecraftParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.recraft.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${entries.map(() => "?,?").join(",")}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, RECRAFT_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── The quote ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The model a tool is quoted and metered under: a still's model id, or the tool's own id. */
export const recraftModelOf = (tool: RecraftTool, model: RecraftModel): string => (tool === "image" ? model : `recraft_${tool}`);
/**
 * Dollars for one call (one image), to the micro-dollar, and the per-image rate it is at, from the vendor price file (one read). Throws VendorPriceUnavailable when the
 * id has no price on this server (no file, a bad one, no row, or a banded row).
 */
export function recraftQuote(tool: RecraftTool, model: RecraftModel): { usd: number; rateUsd: number } {
  const { costUsd, rateUsd } = fileVendorQuote(recraftModelOf(tool, model), { unit: "image", quantity: 1 });
  return { usd: costUsd, rateUsd };
}
/**
 * What a job's one image costs, from the job's own record only: the rate it was quoted at, rounded up to the micro-dollar as the quote is, never past what was reserved.
 * A row with no usable rate settles at its reservation. The price file is never read here.
 */
export function recraftSettledUsd(r: Pick<RecraftParams, "rateUsd" | "reservedUsd">): number {
  const reserved = Number(r.reservedUsd);
  const cap = Number.isFinite(reserved) && reserved > 0 ? reserved : 0;
  const rate = Number(r.rateUsd);
  const usd = Number.isFinite(rate) && rate > 0 ? Math.ceil(rate * 1e6 - 1e-6) / 1e6 : cap;
  return Math.min(usd, cap);
}

/* ── Sources ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

type Source = { kind: "upload" | "generation"; id: string; name: string; ext: string; stored: string; mime: string; bytes: number };
async function resolveSource(uploadId: unknown, genId: unknown, viewer: Viewer): Promise<(Source & { width: number; height: number }) | { error: string; status: number }> {
  const up = uploadId ? String(uploadId) : "", gen = genId ? String(genId) : "";
  if ((!up && !gen) || (up && gen)) return { error: "Pick one still of this workspace.", status: 400 };
  if ((up && !SOURCE_ID.test(up)) || (gen && !SOURCE_ID.test(gen))) return { error: "That source is not valid.", status: 400 };
  let found: Source;
  if (up) {
    const row = (await db().execute({ sql: "SELECT id, filename, mime, ext, stored_url, kind, bytes FROM uploads WHERE id=? LIMIT 1", args: [up] })).rows[0];
    /* An upload is read only by a person who may open it (lib/uploadAccess.ts), for an Atomik run (as the person who started it) as for a person; anything else is the
       same "not in this workspace" a missing one gets. */
    if (!row || row.kind !== "image" || !(await uploadOpenableBy(up, viewer))) return { error: "That still is not in this workspace.", status: 404 };
    found = { kind: "upload", id: up, name: String(row.filename ?? up), ext: String(row.ext || "png"), stored: String(row.stored_url ?? ""), mime: String(row.mime || "image/png"), bytes: Number(row.bytes ?? 0) };
  } else {
    const row = (await db().execute({ sql: "SELECT id, title, prompt, stored_url, bytes FROM generations WHERE id=? AND deleted=0 AND status='succeeded' AND kind='image' AND stored_url IS NOT NULL LIMIT 1", args: [gen] })).rows[0];
    if (!row) return { error: "That still is not in this workspace.", status: 404 };
    found = { kind: "generation", id: gen, name: String(row.title || String(row.prompt ?? "").slice(0, 80) || gen), ext: "png", stored: String(row.stored_url), mime: "image/png", bytes: Number(row.bytes ?? 0) };
  }
  if (!(found.bytes > 0) || found.bytes > RECRAFT_SOURCE_LIMITS.bytes) return { error: "Recraft takes a still under 20 MB.", status: 400 };
  let meta: { width?: number; height?: number; format?: string; pages?: number; hasAlpha?: boolean };
  try {
    const bytes = await readSource(found);
    meta = await (await import("sharp")).default(bytes, { limitInputPixels: 16_000_000 }).metadata();
  } catch { return { error: "That still could not be read: use a PNG, JPEG or WebP of up to 16 megapixels.", status: 400 }; }
  const { width, height } = meta;
  if (!width || !height || !["png", "jpeg", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) !== 1) return { error: "Recraft takes one PNG, JPEG or WebP image.", status: 400 };
  if (Math.max(width, height) > RECRAFT_SOURCE_LIMITS.longest || Math.min(width, height) < RECRAFT_SOURCE_LIMITS.shortest || (width * height) / 1_000_000 > RECRAFT_SOURCE_LIMITS.megapixels)
    return { error: "Recraft takes a still of at least 256 px on its shortest side, at most 4,096 px on its longest and 16 megapixels.", status: 400 };
  return { ...found, width, height };
}
async function readSource(s: Pick<Source, "kind" | "id" | "ext" | "stored">): Promise<Buffer> {
  return s.kind === "upload" ? readUploadBytes(s.id, s.ext, s.stored, RECRAFT_SOURCE_LIMITS.bytes) : readImageBytes(s.id);
}

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export async function executeRecraftAdmission(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(RECRAFT_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const tool = body.tool;
  if (tool !== "image" && tool !== "remove_background" && tool !== "vectorize") return admissionReply({ error: "Pick image, remove_background or vectorize." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  /* An SVG is refused before anything else is read or written (see the header). */
  if (tool === "vectorize") return admissionReply({ error: SVG_REFUSAL, code: "svg-sanitiser-missing" }, { status: 422 });
  if (!recraftConfigured()) return admissionReply({ error: "This is not set up: RECRAFT_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("recraft");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  if (body.model != null && !isRecraftModel(body.model)) return admissionReply({ error: `Pick ${Object.keys(RECRAFT_MODELS).join(", ")}.` }, { status: 400 });
  const model: RecraftModel = isRecraftModel(body.model) ? body.model : RECRAFT_DEFAULT_MODEL;
  if (tool === "image" && isVectorModel(model)) return admissionReply({ error: SVG_REFUSAL, code: "svg-sanitiser-missing" }, { status: 422 });
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  let size: string = RECRAFT_DEFAULT_SIZE, style: string | null = null;
  let source: (Source & { width: number; height: number }) | null = null;
  if (tool === "image") {
    if (!prompt || prompt.length > 1000) return admissionReply({ error: "Write what to make, in up to 1,000 characters." }, { status: 400 });
    if (body.size != null) { if (typeof body.size !== "string" || !(RECRAFT_SIZES as readonly string[]).includes(body.size)) return admissionReply({ error: `Pick a size: ${RECRAFT_SIZES.join(", ")}.` }, { status: 400 }); size = body.size; }
    if (body.style != null) { if (typeof body.style !== "string" || !RECRAFT_STYLE.test(body.style)) return admissionReply({ error: "A style is a name of lower-case letters, digits and underscores." }, { status: 400 }); style = body.style; }
    if (body.references != null) return admissionReply({ error: "Style references are not offered yet." }, { status: 400 });
  } else {
    /* The person this request acts for (the signed-in person, or an Atomik run's owner): none, and no source is read, before anything is written or reserved. */
    const viewer = await actingViewer();
    if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });
    const found = await resolveSource(body.sourceUploadId, body.sourceGenId, viewer);
    if ("error" in found) return admissionReply({ error: found.error }, { status: found.status });
    source = found;
    size = `${found.width}x${found.height}`;
  }

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
  const marginKey = recraftModelOf(tool, model);
  /* The price, from the server's vendor price file. None (no file, a bad one, no row for the id): refused here, before any row, reservation or request. */
  let priced: { usd: number; rateUsd: number };
  try { priced = recraftQuote(tool, model); }
  catch (e) {
    if (e instanceof VendorPriceUnavailable) return admissionReply({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
  const { usd, rateUsd } = priced;
  /* The approval unit, through the margin table keyed by the model or tool id. No number of ours here. */
  const estimatedCredits = quotedCredits(usd, marginKey);
  const inCredits = creditsApply(requireTenant());
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "recraft", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2), as the fal path judges it: with a cap per shot, a take past it needs an admin who is a person: a token, an agent identity or an Atomik Auto run is never one (the same test as jobLineNow's). Refused before a row is written. */
  if (shotId && shotCode) {
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: marginKey, isAdmin: shotCapAdmin(got, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool, model: marginKey, size });
  const wall = await allowanceCheck("recraft", usd, marginKey);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, marginKey);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(8 * 1024 * 1024);
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const stopped = admissionCheckpoint(options, body, got, "image", usd, marginKey, { task: RECRAFT_TASK, tool, model: marginKey, size, style, source: source ? { kind: source.kind, id: source.id } : null, prompt, projectId, shotId }, { engine: "recraft" });
  if (stopped) return stopped;
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });

  const genId = newId("gen"), ts = now();
  const recraft: RecraftParams = {
    status: "queued", tool, model: marginKey, size, style, source: source ? { kind: source.kind, id: source.id } : null,
    rateUsd, reservedUsd: usd, estimateCredits: estimatedCredits, funded: 0, claimedAt: null, sendingAt: null, statedUnits: null, settled: 0, reconcile: 0,
  };
  const [w, h] = size.split("x").map(Number);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  const lineage = source ? (source.kind === "generation" ? { sourceGenId: source.id } : { sourceUploadId: source.id }) : {};
  const params = { task: RECRAFT_TASK, job: tool === "image" ? "keyframe" : "fix", recraft, ...lineage, estUsd: usd, estCredits: 0, ratio: `${w / g}:${h / g}`, size };
  const title = (tool === "image" ? prompt : `${source!.name.replace(/\.[A-Za-z0-9]{1,8}$/, "")} · ${tool === "remove_background" ? "no background" : "vector"}`).slice(0, 80);
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id, source_gen_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "image", marginKey, tool === "image" ? prompt : `${tool === "remove_background" ? "Remove background" : "Vectorize"} · ${source!.name}`.slice(0, 5000), JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "recraft", tool === "image" ? "generate" : "upscale", title, "recraft", shotId, source?.kind === "generation" ? source.id : null],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "image", engine: "recraft", model: marginKey, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was sent. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The reservation could not be made.";
    await settleRecraft(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the one request goes out in this request's continuation, and the ten-minute cron sends a funded job that never got out. */
  await options.defer(() => advanceRecraftJob(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, model: marginKey, notices: capV.notice ? [capV.notice] : undefined });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing billed. */
export async function settleRecraft(genId: string, status: "done" | "failed", outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; said?: ProviderOutcome | null; reconcile?: boolean }): Promise<void> {
  const job = await load(genId);
  if (!job || job.r.settled) return;
  const { row, r } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "recraft").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  /* A finished job is charged at most the quote, whatever Recraft states: what it states past the quote is recorded as the overrun (the platform's, flagged to reconcile), never billed.
     A failure Recraft charged for (costUsd above nothing) is recorded at that cost, never above the quote, on the ledger line and billed to nobody. */
  const cost = ok ? Math.min(outcome.costUsd, r.reservedUsd) : Math.min(Math.max(0, outcome.costUsd), r.reservedUsd);
  const overrunUsd = outcome.costUsd > r.reservedUsd + 1e-9 ? Math.round((outcome.costUsd - r.reservedUsd) * 1e6) / 1e6 : null;
  const reconcile = outcome.reconcile === true || overrunUsd !== null;
  const write = ok
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, params=json_set(params,'$.recraft.status','done','$.recraft.settled',1,'$.recraft.reconcile',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, cost, ms, reconcile ? 1 : 0, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?, provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.recraft.status','failed','$.recraft.settled',1,'$.recraft.reconcile',?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The image failed.").slice(0, 600), ms, cost, said ? serializeOutcome(said) : null, reconcile ? 1 : 0, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: "image", engine: "recraft", model: r.model, status: ok ? "succeeded" : "failed", engineCostUsd: cost, durationMs: ms,
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
/** What a stored raster must be, by its first bytes: never an SVG, never anything else. */
export function isRasterImage(bytes: Buffer): boolean {
  const b = bytes;
  return (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP");
}

/** One step, safe to call from anywhere at any time. Public: no seams (the cron and the continuation call this one). */
export const advanceRecraftJob = (genId: string): Promise<RecraftParams | null> => advanceRecraftJobWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceRecraftJobWith(genId: string, deps: RecraftDeps): Promise<RecraftParams | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, genId, async () => {
    const job = await load(genId);
    if (!job) return null;
    if (job.r.settled || job.r.status !== "queued") return job.r;
    if (!job.r.funded) return job.r;
    const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.recraft.status')='queued' AND json_extract(params,'$.recraft.funded')=1 AND json_extract(params,'$.recraft.claimedAt') IS NULL AND status='running'" });
    if (!claimed) {
      // Someone holds the claim. A young claim is a request in flight; an old one is judged by how far it got.
      const held = (await load(genId))?.r;
      if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
        /* `sendingAt` is written the instant before the one request goes out. A claim that never reached it sent nothing: settled at nothing. Only one that did, with no answer, is a lost reply. */
        if (!held.sendingAt) await settleRecraft(genId, "failed", { message: "Nothing was sent: the job stopped before it was sent. Nothing was billed.", costUsd: 0 });
        else await patch(genId, { status: "uncertain" });
      }
      return (await load(genId))?.r ?? null;
    }
    const { row, r } = (await load(genId))!;
    /* The source is read before anything is sent: one that cannot be read sends nothing and refunds everything. */
    let sourceBytes: Buffer | null = null;
    let sourceName = "source", sourceMime = "image/png";
    if (r.tool !== "image") {
      try {
        const up = r.source?.kind === "upload" ? (await db().execute({ sql: "SELECT ext, stored_url, filename, mime FROM uploads WHERE id=? LIMIT 1", args: [r.source.id] })).rows[0] : null;
        if (r.source?.kind === "upload" && !up) throw new Error("The still is no longer available in this workspace.");
        sourceBytes = await readSource({ kind: r.source!.kind, id: r.source!.id, ext: String(up?.ext ?? "png"), stored: String(up?.stored_url ?? "") });
        if (up) { sourceName = String(up.filename ?? "source"); sourceMime = String(up.mime || "image/png"); }
      } catch (error) {
        await settleRecraft(genId, "failed", { message: `Nothing was sent: ${messageOf(error, "the still could not be read.")} Nothing was billed.`, costUsd: 0 });
        return (await load(genId, { any: true }))?.r ?? null;
      }
    }
    let reply: RecraftReply;
    try {
      await patch(genId, { sendingAt: clock() });
      if (r.tool === "image") reply = await (deps.generate ?? generateImage)({ model: r.model as RecraftModel, prompt: row.prompt, size: r.size, ...(r.style ? { style: r.style } : {}) });
      else if (r.tool === "remove_background") reply = await (deps.removeBackground ?? removeBackground)({ bytes: sourceBytes!, filename: sourceName, mime: sourceMime });
      else reply = await (deps.vectorize ?? vectorize)({ bytes: sourceBytes!, filename: sourceName, mime: sourceMime });
    } catch (error) {
      if (error instanceof RecraftError && error.rejectedBeforeGeneration) {
        // Refused before work: the whole reservation comes back.
        await settleRecraft(genId, "failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: directErrorOutcome("recraft", error.status ?? 400, error.message) });
        return (await load(genId, { any: true }))?.r ?? null;
      }
      if (error instanceof RecraftError && error.unusableReply) {
        // Recraft answered 200, so it did the work and charged for it, but the reply held no image we can keep (none, too large, unreadable): a charged failure (the quote, marked to reconcile), billed to nobody. Not "uncertain": the answer came.
        await settleRecraft(genId, "failed", { message: "Recraft's reply was not a picture Particl keeps. Nothing was billed.", costUsd: recraftSettledUsd(r), reconcile: true, said: silentOutcome("recraft", "run", "not_kept", error.message) });
        return (await load(genId, { any: true }))?.r ?? null;
      }
      // A timeout, a dropped connection or a 5xx: Recraft may have done the work. Held for review, never sent again.
      await patch(genId, { status: "uncertain" });
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The request did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
      return (await load(genId))?.r ?? null;
    }
    /* Recraft answered: it did the work. The job's cost is its kept rate for its one image (never the file again); the units Recraft stated are kept for reconciling.
       A reply we cannot keep is a failure it charged for (at the kept rate, marked to reconcile), billed to nobody. */
    const cost = recraftSettledUsd(r);
    if (reply.units != null) await patch(genId, { statedUnits: reply.units });
    if (!isRasterImage(reply.bytes)) {
      await settleRecraft(genId, "failed", { message: "Recraft's reply was not a picture Particl keeps. Nothing was billed.", costUsd: cost, reconcile: true, said: silentOutcome("recraft", "run", "not_kept", "reply was not a raster image") });
      return (await load(genId, { any: true }))?.r ?? null;
    }
    try {
      const { value: stored } = await withRetry(() => (deps.store ?? storeImageBytes)(genId, reply.bytes), { max: 3 });
      await settleRecraft(genId, "done", { costUsd: cost, storedUrl: stored.url, bytes: stored.bytes });
    } catch (error) {
      await settleRecraft(genId, "failed", { message: `The image was made but could not be saved. Nothing was billed.`, costUsd: cost, reconcile: true, said: silentOutcome("recraft", "run", "not_kept", messageOf(error, "")) });
    }
    return (await load(genId, { any: true }))?.r ?? null;
  });
}

/** The cron's stage: a funded job whose one request never went out is sent (once) or settled at nothing; a lost reply (uncertain) and terminal rows are left alone. */
export async function recoverRecraftJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: RecraftDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.recraft.status')='queued' ORDER BY updated_at ASC LIMIT ?`,
    args: [RECRAFT_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await advanceRecraftJobWith(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tools ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const COMMON = { provider: "recraft", kind: "engine" as const, route: "/api/recraft", needs: ["RECRAFT_API_KEY", "RECRAFT_ENABLED"], who: "prepare: anyone; approve: a person" as const };
/** The three tools, declared beside their handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer. `unavailable` names why a tool cannot run yet. */
export const RECRAFT_TOOLS: ({ id: string; tool: RecraftTool; models: string[]; inputs: Record<string, string>; output: string; unavailable?: string } & typeof COMMON)[] = [
  { ...COMMON, id: "recraft_image", tool: "image", models: [...RECRAFT_RASTER_MODELS], inputs: { prompt: "what to make", model: "recraftv4_1 (default) or recraftv4_1_pro", size: "one of the listed sizes (default 1024x1024)", style: "optional", maxCredits: "the approved price" }, output: "an image take" },
  { ...COMMON, id: "recraft_remove_background", tool: "remove_background", models: ["recraft_remove_background"], inputs: { sourceUploadId: "a still of this workspace (or sourceGenId: one of its takes)", maxCredits: "the approved price" }, output: "a transparent PNG take, linked to its original" },
  { ...COMMON, id: "recraft_vectorize", tool: "vectorize", models: ["recraft_vectorize"], inputs: { sourceUploadId: "a still of this workspace (or sourceGenId: one of its takes)", maxCredits: "the approved price" }, output: "an SVG take, linked to its original", unavailable: SVG_REFUSAL },
];

/** The tools present for a workspace: none unless the engine is on for it. A tool that cannot run yet says so (`unavailable`). */
export async function recraftTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof RECRAFT_TOOLS> {
  return (await engineEnabled(RECRAFT_SWITCH, workspace)) ? RECRAFT_TOOLS : [];
}
