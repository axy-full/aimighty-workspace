import { acceptRecoveryJobTx } from "./recovery";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { db, ready, now } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";
import { paidByPlatformEngine, platformSpendRecordsSince } from "./platformSpend";
import { allowanceUsd } from "./allowance";
import { cycleBounds } from "./cycle";
import { billCreditsWith, creditUsd, marginFor, marginKeyOf } from "./creditTerms";
import { creditsApply } from "./credits";
import { LEDGER_UNIT_PAUSED, ledgerOpenTx, restateFactor, workspaceUnitTx } from "./ledgerUnit";
import { creditsAtTerms, currentBillingTerms, recordedBillingTerms } from "./billingTerms";
import { capVerdict, projectCap, type CapRule } from "./caps";
import { getSetting } from "./settings";
import { workspaceLimits } from "./limits";
import { cleanRule, cleanShotCap } from "./approvalRule";
import type { MeterEvent } from "./meter";
import { billingTransaction, syncBillingLedger, setCreditDebitTx, CreditBalanceError } from "./billingLedger";
import { admitToPoolTx, providerPoolReady, sharedPoolOf } from "./providerPool";
import { workbenchScopeProblem } from "./workbench/request-scope";
import { runLimitVerdict, runTally, toTenths, type RunCharge, type RunSpend } from "./runLimit";

export class SpendReservationError extends Error {
  /** `perJob`: the refusal is about this job alone (its cost, project, shot or token), not the whole workspace. */
  constructor(message: string, public readonly status: number, public readonly perJob = false) { super(message); this.name = "SpendReservationError"; }
}
/**
 * The shared provider pool has no slot for this take yet (lib/providerPool.ts).
 * Nothing was reserved: callers hold the take in the line instead of failing it.
 */
export class ProviderPoolBusyError extends SpendReservationError {
  constructor(public readonly pool: string, public readonly why: "pool" | "share" | "line") {
    super("Every shared render slot is taken. The take waits in line and starts when a slot frees.", 409, true);
    this.name = "ProviderPoolBusyError";
  }
}

const bootstrapped = new Map<string, Promise<void>>();
export async function generationRequestsReady(): Promise<void> {
  const workspace = requireTenant();
  if (!bootstrapped.has(workspace.id)) {
    const boot = (async () => {
      await ready();
      await db().execute(`CREATE TABLE IF NOT EXISTS generation_requests (
        user_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        generation_id TEXT, response_json TEXT, response_status INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, request_key)
      )`);
    })().catch((error) => { bootstrapped.delete(workspace.id); throw error; });
    bootstrapped.set(workspace.id, boot);
  }
  await bootstrapped.get(workspace.id);
}

/** Object key order is not a change in the requested generation. Array order is. */
export function generationFingerprint(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type GenerationRequest = { userId: string; key: string };
/** The bind as a statement, to commit in the same transaction or batch as the job row it names. */
export function bindGenerationRequestStatement(claim: GenerationRequest, genId: string): InStatement {
  return { sql: `UPDATE generation_requests SET generation_id=?, updated_at=? WHERE user_id=? AND request_key=?`, args: [genId, now(), claim.userId, claim.key] };
}
/** The bind statements for an admitted row (none without a claim), with the claims table in place. Call before opening the write. */
export async function claimBinding(claim: GenerationRequest | null | undefined, genId: string): Promise<InStatement[]> {
  if (!claim) return [];
  await generationRequestsReady();
  return [bindGenerationRequestStatement(claim, genId)];
}
export async function bindGenerationRequest(claim: GenerationRequest, genId: string): Promise<void> {
  await generationRequestsReady();
  await db().execute(bindGenerationRequestStatement(claim, genId));
}

/** `atomicBinding`: every job this request can create binds its claim in the same write as the row. */
export type GenerationRequestOptions = { atomicBinding?: boolean };

const UNADMITTED = "The request was interrupted before a job was created. Nothing was charged; try again.";
/** Longer than any function may run (800 s), so the request that made a claim this old is gone. */
export const STALE_CLAIM_MS = 30 * 60_000;
/**
 * A transcription answers inside its own request, whose route stops at 300 s
 * (maxDuration, app/api/audio/transcribe/route.ts): twice that, no request
 * can still be running it. Its claim is answered by then (lib/transcription.ts),
 * and its meter event, still `running` if the request was killed, holds no job
 * slot: nothing is running. Its credits stay held until what became of it is known.
 */
export const TRANSCRIPTION_STALE_MS = 10 * 60_000;
/** A transcription's meter event (transcriptionEventId, lib/transcription.ts). */
const TRANSCRIPTION_EVENT = /^stt_/;

/**
 * With atomic binding, a claim that names no job proves no job exists — so
 * nothing was reserved or sent. The claim is completed with that answer
 * instead of answering "still being accepted" for ever. Null when a job was
 * bound after all (its ordinary replay then answers).
 */
async function completeUnadmitted(userId: string, key: string): Promise<Response | null> {
  const json = JSON.stringify({ error: UNADMITTED });
  const done = await db().execute({
    sql: `UPDATE generation_requests SET response_json=?,response_status=409,updated_at=?
          WHERE user_id=? AND request_key=? AND generation_id IS NULL AND response_json IS NULL`,
    args: [json, now(), userId, key],
  });
  if (!done.rowsAffected) return null;
  return new Response(json, { status: 409, headers: { "Content-Type": "application/json", "Idempotency-Status": "complete" } });
}

/** A claim never expires into another paid attempt. An interrupted submit is recoverable by job id. */
export async function withGenerationRequest(req: Request, userId: string, run: (claim: GenerationRequest) => Promise<Response>, options: GenerationRequestOptions = {}): Promise<Response> {
  const scopeError = workbenchScopeProblem(req, requireTenant().id, userId);
  if (scopeError) return Response.json({ error: scopeError }, { status: 409 });
  const expectedActor = req.headers.get("X-Actor-Email");
  if (expectedActor && expectedActor.toLowerCase() !== currentTenant()?.user?.email.toLowerCase()) return Response.json({ error: "Sign in with the account that prepared this request before recovering it." }, { status: 409 });
  const expectedWorkspace = req.headers.get("X-Workspace-Id");
  if (expectedWorkspace && expectedWorkspace !== requireTenant().id) return Response.json({ error: "Return to the workspace where this request was prepared before recovering it." }, { status: 409 });
  const supplied = req.headers.get("Idempotency-Key");
  if (supplied != null && !/^[A-Za-z0-9._:-]{8,160}$/.test(supplied)) {
    return Response.json({ error: "Idempotency-Key must contain 8–160 letters, digits, dots, colons, dashes or underscores." }, { status: 400 });
  }
  const key = supplied ?? randomUUID();
  const fingerprint = generationFingerprint({ method: req.method, path: new URL(req.url).pathname, body: await req.clone().json().catch(() => ({})) });
  return withGenerationRequestData({ userId, key, fingerprint }, run, options);
}

/** Server-side admission uses the same durable claim without making an HTTP request.
 * The caller supplies a namespace-bound fingerprint and an authenticated actor. */
export async function withGenerationRequestData(
  input: { userId: string; key: string; fingerprint: string },
  run: (claim: GenerationRequest) => Promise<Response>,
  options: GenerationRequestOptions = {},
): Promise<Response> {
  const { userId, key, fingerprint } = input;
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) return Response.json({ error: "The request key is invalid." }, { status: 400 });
  await generationRequestsReady();
  const inserted = await db().execute({
    sql: `INSERT OR IGNORE INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?)`,
    args: [userId, key, fingerprint, now(), now()],
  });
  if (!inserted.rowsAffected) {
    const rows = await db().execute({ sql: `SELECT * FROM generation_requests WHERE user_id=? AND request_key=?`, args: [userId, key] });
    const row = rows.rows[0];
    if (row.fingerprint !== fingerprint) {
      /* A key set aside (fenceGenerationRequest) answers every request that arrives under it the same way, and admits none. */
      if (setAside(row.response_json)) return new Response(String(row.response_json), { status: Number(row.response_status), headers: { "Content-Type": "application/json", "Idempotency-Status": "complete", "Idempotency-Replayed": "true" } });
      return Response.json({ error: "This Idempotency-Key already names a different request." }, { status: 409 });
    }
    const headers = { "Idempotency-Replayed": "true" };
    if (row.response_json) return new Response(String(row.response_json), { status: Number(row.response_status), headers: { ...headers, "Content-Type": "application/json", "Idempotency-Status": "complete" } });
    if (row.generation_id) {
      const jobs = await db().execute({ sql: `SELECT id,status,error FROM generations WHERE id=?`, args: [String(row.generation_id)] });
      const job = jobs.rows[0];
      if (job) return Response.json({ id: job.id, status: job.status, error: job.error ?? undefined }, { status: 202, headers });
    }
    /* The request that made this claim died without reaching its catch (the
       function was killed), or it failed before this version bound claims
       atomically. Either way it is gone, and it named no job. Every job path
       binds its claim before any vendor is asked, and a job that was never
       sent ends at no charge (the janitor refunds it well inside this
       cutoff). The retry completes the claim instead of waiting for ever. */
    else if (options.atomicBinding && Number(row.created_at) < now() - STALE_CLAIM_MS) {
      const settled = await completeUnadmitted(userId, key);
      if (settled) {
        settled.headers.set("Idempotency-Replayed", "true");
        return settled;
      }
    }
    return Response.json({ error: "This request is still being accepted. Retry with the same Idempotency-Key; it will not submit another generation.", pending: true }, { status: 409, headers: { ...headers, "Retry-After": "2" } });
  }
  const claim = { userId, key };
  try {
    const response = await run(claim);
    const json = await response.clone().text();
    await db().execute({ sql: `UPDATE generation_requests SET response_json=?,response_status=?,updated_at=? WHERE user_id=? AND request_key=?`, args: [json, response.status, now(), userId, key] });
    response.headers.set("Idempotency-Status", "complete");
    return response;
  } catch (error) {
    /* Paused for a price change (lib/ledgerUnit.ts): nothing was reserved or sent, and the person is told so. */
    if ((error as Error)?.message === LEDGER_UNIT_PAUSED) return Response.json({ error: LEDGER_UNIT_PAUSED }, { status: 503 });
    // Keep the durable claim: a provider might have accepted an interrupted request.
    console.error("Generation request interrupted:", (error as Error).message);
    if (options.atomicBinding) {
      const settled = await completeUnadmitted(userId, key).catch(() => null);
      if (settled) return settled;
    }
    return Response.json({ error: "The request was interrupted. Retry with the same Idempotency-Key to recover its job; it will not be submitted twice." }, { status: 503 });
  }
}

/**
 * Give a claim that has no reply yet its final one, for a route whose work
 * answers in its reply rather than with a job (transcription): once no request
 * can still be running it, what it left behind is written as its answer, so a
 * request under the key is answered with that and never runs. False when the
 * claim already has a reply (its own, which stands) or does not exist.
 */
export async function completeGenerationRequest(input: { userId: string; key: string; status: number; reply: Record<string, unknown> }): Promise<boolean> {
  await generationRequestsReady();
  const done = await db().execute({
    sql: `UPDATE generation_requests SET response_json=?,response_status=?,updated_at=?
          WHERE user_id=? AND request_key=? AND response_json IS NULL`,
    args: [JSON.stringify(input.reply), input.status, now(), input.userId, input.key],
  });
  return done.rowsAffected > 0;
}

/** What a paid request sent under an Idempotency-Key became, from its claim (checkGenerationRequest). */
export type GenerationRequestCheck =
  /** It reached the server and made this job. The job's own status says how it went: a refused charge fails it, unbilled. */
  | { state: "landed"; id: string; status: string }
  /** It reached the server and was answered without a job: nothing was made or charged. */
  | { state: "refused"; status: number; error: string }
  /** It is being accepted right now: ask again in a moment. */
  | { state: "pending" }
  /** It never reached the server. Checking set its key aside, so it never will: the answer is final. */
  | { state: "absent" }
  /** The key names a different request than the one asked about. */
  | { state: "mismatch" };

const SET_ASIDE = "This request was set aside: it had not reached the server when it was checked. Nothing was charged.";
const setAside = (json: unknown) => {
  try { return Boolean(json) && (JSON.parse(String(json)) as { code?: unknown }).code === "set_aside"; } catch { return false; }
};

/**
 * Set a key the server has never seen aside for good: its claim is written
 * complete, with a reply that refuses it, so a request that arrives under it
 * later is answered with that reply and admits nothing
 * (withGenerationRequestData). True only when this call wrote it; false when a
 * claim for the key already existed, whose own record then says what it
 * became. The person's own claims, in this workspace's database only.
 */
export async function fenceGenerationRequest(input: { userId: string; key: string; fingerprint: string }): Promise<boolean> {
  await generationRequestsReady();
  const fenced = await db().execute({
    sql: `INSERT OR IGNORE INTO generation_requests(user_id,request_key,fingerprint,response_json,response_status,created_at,updated_at) VALUES(?,?,?,?,409,?,?)`,
    args: [input.userId, input.key, input.fingerprint, JSON.stringify({ error: SET_ASIDE, code: "set_aside" }), now(), now()],
  });
  return fenced.rowsAffected > 0;
}

/**
 * Did the request sent under this key land? Asked for the person who sent it
 * (the claim is theirs), in this workspace's database only, with the
 * fingerprint the request itself carries, so a key is only ever checked
 * against the request it named. For routes that bind their job atomically.
 *
 * A key the server has never seen is fenced in the same step: its claim is
 * written complete, with a reply that refuses it. If the request arrives after
 * all, withGenerationRequestData answers it with that reply and admits
 * nothing. So the answer never changes, and a recovery can send what is on
 * screen now under a new key without paying for anything twice.
 */
export async function checkGenerationRequest(input: { userId: string; key: string; fingerprint: string }): Promise<GenerationRequestCheck> {
  const { userId, key, fingerprint } = input;
  if (await fenceGenerationRequest({ userId, key, fingerprint })) return { state: "absent" };
  const read = async () => (await db().execute({ sql: `SELECT * FROM generation_requests WHERE user_id=? AND request_key=?`, args: [userId, key] })).rows[0];
  let row = await read();
  if (!row || row.fingerprint !== fingerprint) return { state: "mismatch" };
  /* No reply and no job, and no request could still be running it: it died unadmitted, and a claim naming no job proves there is none. */
  if (!row.response_json && !row.generation_id && Number(row.created_at) < now() - STALE_CLAIM_MS) {
    if (await completeUnadmitted(userId, key)) return { state: "refused", status: 409, error: UNADMITTED };
    row = await read();
  }
  let reply: { id?: unknown; status?: unknown; error?: unknown; code?: unknown } = {};
  try { reply = row.response_json ? JSON.parse(String(row.response_json)) : {}; } catch { /* an unreadable reply still names its job below */ }
  const jobId = row.generation_id ? String(row.generation_id) : typeof reply.id === "string" && reply.id ? reply.id : null;
  if (jobId) {
    const job = (await db().execute({ sql: `SELECT status FROM generations WHERE id=?`, args: [jobId] })).rows[0];
    return { state: "landed", id: jobId, status: job ? String(job.status) : typeof reply.status === "string" ? reply.status : "queued" };
  }
  if (!row.response_json) return { state: "pending" };
  if (reply.code === "set_aside") return { state: "absent" };
  return { state: "refused", status: Number(row.response_status), error: typeof reply.error === "string" && reply.error ? reply.error : `Refused (${row.response_status})` };
}

let reservationReady: Promise<void> | undefined;
async function reservationsReady(): Promise<void> {
  reservationReady ??= (async () => {
    await platformReady();
    await platformDb().execute(`CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)`);
    /* Additive: the run a job counts toward (an Atomik run's approved limit) and its band (lib/runLimit.ts). */
    const columns = new Set((await platformDb().execute("PRAGMA table_info(generation_reservations)")).rows.map((row) => String(row.name)));
    for (const [column, type] of [["run_id", "TEXT"], ["run_band", "INTEGER"]] as const) {
      if (columns.has(column)) continue;
      try { await platformDb().execute(`ALTER TABLE generation_reservations ADD COLUMN ${column} ${type}`); }
      catch (error) { if (!/duplicate column/i.test(String(error))) throw error; }
    }
    await platformDb().execute(`CREATE INDEX IF NOT EXISTS idx_generation_reservations_run ON generation_reservations(workspace_id, run_id) WHERE run_id IS NOT NULL`);
  })().catch((error) => { reservationReady = undefined; throw error; });
  await reservationReady;
}

/** A job refused because it would pass its run's approved limit (lib/runLimit.ts): nothing was reserved or sent. */
export const RUN_LIMIT_REACHED = "This would pass the limit approved for this run. Nothing was charged.";

/** What one of a run's jobs counts toward its limit: its bill in credits, or on the workspace's own keys its dollars counted in credits (quotedCredits). */
function runCredits(row: { paid: boolean; billed: number; costUsd: number }): number {
  return row.paid ? row.billed : row.costUsd > 0 ? billCreditsWith(row.costUsd, 1, creditUsd()) : 0;
}

/**
 * The run's jobs as the ledger has them (every reservation that named the run), for its limit and its card.
 * `platform` is the transaction to read in (the reservation's own), or the platform database.
 */
export async function runCharges(runId: string, options: { except?: string; workspaceId?: string; platform?: Pick<Client, "execute"> | Transaction } = {}): Promise<(RunCharge & { id: string; status: string })[]> {
  await reservationsReady();
  const ws = options.workspaceId ?? requireTenant().id;
  const rows = await (options.platform ?? platformDb()).execute({
    sql: `SELECT m.id,m.status,m.billed_credits,m.engine_cost_usd,m.paid_by_platform,r.run_band FROM generation_reservations r
          JOIN meter_events m ON m.id=r.id AND m.workspace_id=r.workspace_id
          WHERE r.workspace_id=? AND r.run_id=? AND r.id<>?`,
    args: [ws, runId, options.except ?? ""],
  });
  return rows.rows.map((r) => ({
    id: String(r.id), status: String(r.status), running: String(r.status) === "running",
    credits: runCredits({ paid: Boolean(Number(r.paid_by_platform)), billed: Number(r.billed_credits ?? 0), costUsd: Number(r.engine_cost_usd ?? 0) }),
    band: r.run_band == null ? 1 : Number(r.run_band),
  }));
}

type Baseline = { id: string; projectId: string | null; shotId: string | null; tokenId: string | null; cost: number; credits: number; createdAt: number; status: string; deleted: boolean };

/** Reserve the existing ledger estimate under one database write lock.
 * The balance test and meter insert commit together, across server instances.
 * Meter completions update this same row to the actual cost. */
let reservationTurn: Promise<void> = Promise.resolve();
type ReservationOptions = {
  /* A token's monthly ceiling: `capUsd` in the engine's dollars, `capCredits` in
     the credits a workspace on the platform's keys pays (either or both). */
  token?: { id: string; capUsd: number | null; capCredits?: number | null };
  projectId?: string | null;
  /** Whether the shot's credit cap is skipped. Omitted, the signed-in admin skips it;
   * a held take's release decides from its author instead of whoever's request released it. */
  shotCapExempt?: boolean;
  /**
   * The run this job counts toward (an Atomik run on a Rig board): refused when the run's
   * settled and in-flight jobs, at their worst case, plus this one would pass the limit a
   * person approved for it (lib/runLimit.ts), or when the run may no longer spend. Recorded
   * on the reservation, so every paid action of the run carries its id.
   */
  run?: RunSpend;
  /**
   * The take holds its ceiling, not its estimate: its bill at the quote times this band (a Cinema Studio
   * take, lib/cinemaHold.ts). The hold is what the balance must cover, what is reserved, and it is recorded
   * on the meter row (`hold_band`), so the take settles at its actual cost and never past the hold, and at
   * its quote when it has no figure (lib/meter.ts). Being the take's worst case already, a run counts it
   * once, at band 1.
   */
  holdBand?: number;
};
export async function reserveGenerationSpend(event: MeterEvent, options: ReservationOptions = {}): Promise<void> {
  // Local libsql clients share a connection; never interleave transactions on it.
  // The database transaction below also protects requests in other processes.
  const result = reservationTurn.then(() => reserveGenerationSpendLocked(event, options));
  reservationTurn = result.catch(() => {});
  return result;
}

async function reserveGenerationSpendLocked(event: MeterEvent, options: ReservationOptions = {}): Promise<void> {
  const ws = requireTenant();
  const projectId = event.projectId ?? options.projectId ?? null;
  const cost = Number(event.engineCostUsd);
  if (!Number.isFinite(cost) || cost < 0) throw new SpendReservationError("This job has no valid cost estimate.", 400, true);
  const paid = paidByPlatformEngine(event.engine);
  const holdBand = Number.isInteger(options.holdBand) && options.holdBand! > 1 ? options.holdBand! : 1;
  await ready();
  await reservationsReady();
  /* A still or video on the platform's shared provider key also takes a slot of its pool, in this same write. */
  const pool = sharedPoolOf(event);
  if (pool) await providerPoolReady();
  const cap = projectId ? await projectCap(projectId) : null;
  // Retain a pre-migration spending ceiling until the owner sets a credit cap.
  // Its private unit never appears in the refusal sent to customers.
  const legacyCap = projectId ? (await db().execute({ sql: "SELECT cap_usd,cap_credits,cap_unlocked FROM projects WHERE id=?", args: [projectId] })).rows[0] : null;
  const limits = await workspaceLimits();
  const shotCapExempt = options.shotCapExempt ?? currentTenant()?.user?.role === "admin";
  const shotCap = event.shotId && !shotCapExempt && cleanRule(await getSetting("approvalRule")) === "cap"
    ? cleanShotCap(await getSetting("shotCapCredits")) : null;
  const ruleRaw = cap ? await getSetting("atCap") : null;
  const rule: CapRule = ruleRaw === "stop" || ruleRaw === "warn" ? ruleRaw : "producer";
  const monthlyCap = paid ? allowanceUsd() : null;
  const since = cycleBounds(1, now()).start;
  const monthlyRecords = monthlyCap == null ? new Map<string, number>() : await platformSpendRecordsSince(since);
  // Preserve historical charges predating the meter; merge ledger estimates by id.
  const rows = await db().execute(`SELECT id,project_id,shot_id,token_id,kind,model,created_at,status,deleted,
    COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0) AS cost FROM generations`);
  const baseline = new Map<string, Baseline>(rows.rows.map((r) => [String(r.id), {
    id: String(r.id), projectId: r.project_id == null ? null : String(r.project_id), shotId: r.shot_id == null ? null : String(r.shot_id),
    tokenId: r.token_id == null ? null : String(r.token_id), cost: Number(r.cost),
    credits: billCreditsWith(Number(r.cost), marginFor(marginKeyOf(String(r.kind), String(r.model))), 0.10), createdAt: Number(r.created_at), status: String(r.status), deleted: Boolean(r.deleted),
  }]));
  /* A run that was stopped or switched off reserves nothing: asked last, just before the write (it reads the
     workspace's own database, which is never read inside the platform's write). */
  const stopped = options.run ? await options.run.live?.() : null;
  if (stopped) throw new SpendReservationError(stopped, 409, true);
  await billingTransaction(async (tx, ts) => {
    await acceptRecoveryJobTx(tx, ws.id, event.id, event.kind);
    const standing = await tx.execute({ sql: `SELECT deleted_at,suspended_at FROM workspaces WHERE id=?`, args: [ws.id] });
    // Old internal/mock records may predate the workspace registry; a known deleted/suspended workspace never spends from a stale request scope.
    if (standing.rows[0]?.deleted_at != null) throw new SpendReservationError("This workspace has been deleted.", 410);
    if (standing.rows[0]?.suspended_at != null) throw new SpendReservationError("This workspace is suspended.", 403);
    await syncBillingLedger(tx, ws.id, ts);
    const own = await tx.execute({ sql: `SELECT workspace_id,status,paid_by_platform,engine,kind,model,credit_usd,credit_margin FROM meter_events WHERE id=?`, args: [event.id] });
    if (own.rows[0] && own.rows[0].workspace_id !== ws.id) throw new SpendReservationError("This job belongs to another workspace.", 409, true);
    if (own.rows[0] && own.rows[0].status !== "running") throw new SpendReservationError("This job has already completed.", 409, true);
    const prior = own.rows[0];
    /* A price of a credit the record (the platform's, or this workspace's own) does not count in yet
       (lib/ledgerUnit.ts): no NEW job is reserved until the conversion restates the record. A job
       already reserved keeps its reservation and terms. */
    if (!prior && paid && creditsApply(ws) && !(await ledgerOpenTx(tx, ws.id))) throw new SpendReservationError(LEDGER_UNIT_PAUSED, 503);
    if (prior && (Boolean(prior.paid_by_platform) !== paid || prior.engine !== event.engine || prior.kind !== event.kind || prior.model !== event.model))
      throw new SpendReservationError("This job's funding or engine changed. Request a new quote.", 409, true);
    /* A new job is priced in the unit this workspace's record counts in, as meter() charges one first
       metered at settlement; admitted, that is today's price. */
    const unit = await workspaceUnitTx(tx, ws.id);
    const terms = prior ? recordedBillingTerms(prior, event.kind, event.model)
      : { ...currentBillingTerms(event.kind, event.model), ...(unit != null ? { creditUsd: unit } : {}) };
    /* A job approved at a higher price of a credit (one reserved at US$0.80 before the record moved to
       US$0.10, lib/creditConversion.ts) keeps its terms and is counted in the ledger's unit: ×8. */
    const restate = prior ? restateFactor(terms.creditUsd, unit) : 1;
    const charge = (usd: number) => creditsAtTerms(usd, terms) * restate;
    const billed = paid ? charge(cost) : 0;
    const existing = await tx.execute({ sql: `SELECT m.*, r.token_id AS reservation_token FROM meter_events m LEFT JOIN generation_reservations r ON r.id=m.id WHERE m.workspace_id=? AND m.id<>?`, args: [ws.id, event.id] });
    /* What this job reserves, and the balance must cover: its bill, or for a take held at its ceiling, the
       bill times its band (Cinema Studio's "at most 3N cr"). Short of it, nothing is reserved (402). */
    const held = billed * holdBand;
    const heldAtCeiling = paid && holdBand > 1;
    try { await setCreditDebitTx(tx, ws.id, event.id, held, ts); }
    catch (error) { if (error instanceof CreditBalanceError) throw new SpendReservationError(error.message, 402); throw error; }
    const merged = new Map(baseline);
    merged.delete(event.id);
    const monthly = new Map(monthlyRecords);
    monthly.delete(event.id);
    for (const r of existing.rows) {
      const prior = merged.get(String(r.id));
      merged.set(String(r.id), { id: String(r.id), projectId: r.project_id == null ? prior?.projectId ?? null : String(r.project_id), shotId: r.shot_id == null ? prior?.shotId ?? null : String(r.shot_id),
        tokenId: r.reservation_token == null ? prior?.tokenId ?? null : String(r.reservation_token),
        cost: Math.max(prior?.cost ?? 0, Number(r.engine_cost_usd ?? 0)), credits: Number(r.billed_credits ?? 0), createdAt: Number(r.created_at), status: String(r.status), deleted: prior?.deleted ?? false });
      if (!Number(r.paid_by_platform)) monthly.delete(String(r.id));
      else if (Number(r.created_at) >= since) monthly.set(String(r.id), Math.max(monthly.get(String(r.id)) ?? 0, Number(r.engine_cost_usd ?? 0)));
    }
    const gone = now() - TRANSCRIPTION_STALE_MS;
    const running = [...merged.values()].filter((r) => !r.deleted && (r.status === "running" || r.status === "queued")
      && !(TRANSCRIPTION_EVENT.test(r.id) && r.createdAt < gone)).length;
    const recent = [...merged.values()].filter((r) => r.status !== "held" && r.createdAt >= now() - 3_600_000).length;
    if (recent >= limits.rendersPerHour) throw new SpendReservationError("This workspace has reached its hourly job limit, including reserved jobs. Try again later.", 429);
    if (running >= limits.concurrency) throw new SpendReservationError("Every job slot is reserved. Wait for an active job to finish, then try again.", 409);
    if (shotCap != null) {
      const shotCredits = [...merged.values()].filter((r) => r.shotId === event.shotId).reduce((sum, r) => sum + r.credits, 0);
      if (shotCredits + charge(cost) > shotCap) throw new SpendReservationError("This take and reserved takes exceed the shot's credit cap. An admin must start it.", 403, true);
    }
    if (monthlyCap != null && [...monthly.values()].reduce((sum, recordedCost) => sum + recordedCost, 0) + cost > monthlyCap + 1e-9) throw new SpendReservationError("This job and the reserved jobs would exceed the workspace's monthly spending cap.", 429);
    if (cap) {
      const spent = [...merged.values()].filter((r) => r.projectId === projectId).reduce((sum, r) => sum + (cap.unit === "cr" ? r.credits : r.cost), 0);
      const verdict = capVerdict({ cap: cap.cap, spent, needs: cap.unit === "cr" ? charge(cost + (baseline.get(event.id)?.cost ?? 0)) : cost + (baseline.get(event.id)?.cost ?? 0),
        rule, unlocked: cap.unlocked, warnPct: 80, unit: cap.unit });
      if (!verdict.allow) throw new SpendReservationError(verdict.error!, 409, true);
    }
    if (legacyCap?.cap_credits == null && legacyCap?.cap_usd != null) {
      const spent = [...merged.values()].filter((r) => r.projectId === projectId).reduce((sum, r) => sum + r.cost, 0);
      const verdict = capVerdict({ cap: Number(legacyCap.cap_usd), spent, needs: cost + (baseline.get(event.id)?.cost ?? 0), rule,
        unlocked: Boolean(legacyCap.cap_unlocked), warnPct: 80, unit: "$" });
      if (!verdict.allow) throw new SpendReservationError("This job exceeds the project's saved spending cap. Ask an admin to review its credit cap.", 409, true);
    }
    if (options.token?.capUsd != null) {
      /* In what the workspace pays, as the admission check reads it (tokenSpendThisMonth): a
         workspace on credits by the credits billed at the price of a credit, never the vendors'
         dollars, which a ceiling tripping on them would give away. */
      const mine = [...merged.values()].filter((r) => r.tokenId === options.token!.id && r.createdAt >= since);
      const job = cost + (baseline.get(event.id)?.cost ?? 0);
      const spending = creditsApply(ws)
        ? (mine.reduce((sum, r) => sum + r.credits, 0) + charge(job)) * creditUsd()
        : mine.reduce((sum, r) => sum + r.cost, 0) + job;
      if (spending > options.token.capUsd + 1e-9) throw new SpendReservationError("This job and the reserved jobs would exceed this token's monthly spending ceiling.", 429, true);
    }
    /* The same wall in credits, reckoned like the production cap above: what the
       token's jobs this month billed or reserved, plus this job at the engine's margin. */
    if (options.token?.capCredits != null) {
      const spent = [...merged.values()].filter((r) => r.tokenId === options.token!.id && r.createdAt >= since).reduce((sum, r) => sum + r.credits, 0);
      const needs = charge(cost + (baseline.get(event.id)?.cost ?? 0));
      if (spent + needs > options.token.capCredits) throw new SpendReservationError(`This job and the reserved jobs would pass this token's ${options.token.capCredits.toLocaleString("en-US")} cr monthly ceiling.`, 429, true);
    }
    /* An Atomik run's approved limit, in whole tenths, under this same write lock: what the run's
       jobs have settled, what its jobs in flight could still settle at, and this job at its worst. */
    if (options.run) {
      const job = runCredits({ paid, billed: held, costUsd: cost });
      const verdict = runLimitVerdict({
        limitTenths: toTenths(options.run.limitCredits),
        tally: runTally(await runCharges(options.run.id, { except: event.id, workspaceId: ws.id, platform: tx })),
        jobTenths: toTenths(job),
        /* A take held at its ceiling reserved its worst case already: counted once, never again at its band. */
        band: heldAtCeiling ? 1 : options.run.band,
      });
      if (!verdict.ok) throw new SpendReservationError(RUN_LIMIT_REACHED, 409, true);
    }
    /* Last, once everything else admits it: a take refused here waits only for a slot. Its slot and its
       reservation commit together, and the slot is free again the moment the reservation stops running. */
    if (pool) {
      const verdict = await admitToPoolTx(tx, pool, { id: event.id, workspaceId: ws.id, at: ts });
      if (!verdict.admit) throw new ProviderPoolBusyError(pool, verdict.why);
    }
    /* The hold is recorded on the take's row (`hold_band`): its settlement charges what it cost, never past the hold. */
    await tx.execute({ sql: `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at,credit_usd,credit_margin,hold_band)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='running',engine_cost_usd=excluded.engine_cost_usd,billed_credits=excluded.billed_credits,paid_by_platform=excluded.paid_by_platform,updated_at=excluded.updated_at,credit_usd=COALESCE(meter_events.credit_usd,excluded.credit_usd),credit_margin=COALESCE(meter_events.credit_margin,excluded.credit_margin),hold_band=excluded.hold_band`,
      args: [event.id, ws.id, projectId, event.shotId ?? null, event.kind, event.engine, event.model, "running", cost, held, paid ? 1 : 0, event.createdBy ?? null, ts, ts, terms.creditUsd, terms.margin, heldAtCeiling ? holdBand : null] });
    await tx.execute({ sql: `INSERT INTO generation_reservations(id,workspace_id,token_id,run_id,run_band) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      args: [event.id, ws.id, options.token?.id ?? null, options.run?.id ?? null, options.run ? (heldAtCeiling ? 1 : Math.max(1, Math.round(options.run.band))) : null] });
  });
}
