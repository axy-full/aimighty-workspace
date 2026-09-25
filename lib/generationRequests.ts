import { acceptRecoveryJobTx } from "./recovery";
import { createHash, randomUUID } from "node:crypto";
import { db, ready, now } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";
import { paidByPlatformEngine, platformSpendRecordsSince } from "./platformSpend";
import { allowanceUsd } from "./allowance";
import { cycleBounds } from "./cycle";
import { billCredits, marginKeyOf } from "./creditTerms";
import { capVerdict, projectCap, type CapRule } from "./caps";
import { getSetting } from "./settings";
import { workspaceLimits } from "./limits";
import { cleanRule, cleanShotCap } from "./approvalRule";
import type { MeterEvent } from "./meter";
import { billingTransaction, syncBillingLedger, setCreditDebitTx, CreditBalanceError } from "./billingLedger";
import { workbenchScopeProblem } from "./workbench/request-scope";

export class SpendReservationError extends Error {
  /** `perJob`: the refusal is about this job alone (its cost, project, shot or token), not the whole workspace. */
  constructor(message: string, public readonly status: number, public readonly perJob = false) { super(message); this.name = "SpendReservationError"; }
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
export async function bindGenerationRequest(claim: GenerationRequest, genId: string): Promise<void> {
  await generationRequestsReady();
  await db().execute({ sql: `UPDATE generation_requests SET generation_id=?, updated_at=? WHERE user_id=? AND request_key=?`, args: [genId, now(), claim.userId, claim.key] });
}

/** A claim never expires into another paid attempt. An interrupted submit is recoverable by job id. */
export async function withGenerationRequest(req: Request, userId: string, run: (claim: GenerationRequest) => Promise<Response>): Promise<Response> {
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
  return withGenerationRequestData({ userId, key, fingerprint }, run);
}

/** Server-side admission uses the same durable claim without making an HTTP request.
 * The caller supplies a namespace-bound fingerprint and an authenticated actor. */
export async function withGenerationRequestData(
  input: { userId: string; key: string; fingerprint: string },
  run: (claim: GenerationRequest) => Promise<Response>,
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
    if (row.fingerprint !== fingerprint) return Response.json({ error: "This Idempotency-Key already names a different request." }, { status: 409 });
    const headers = { "Idempotency-Replayed": "true" };
    if (row.response_json) return new Response(String(row.response_json), { status: Number(row.response_status), headers: { ...headers, "Content-Type": "application/json", "Idempotency-Status": "complete" } });
    if (row.generation_id) {
      const jobs = await db().execute({ sql: `SELECT id,status,error FROM generations WHERE id=?`, args: [String(row.generation_id)] });
      const job = jobs.rows[0];
      if (job) return Response.json({ id: job.id, status: job.status, error: job.error ?? undefined }, { status: 202, headers });
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
    // Keep the durable claim: a provider might have accepted an interrupted request.
    console.error("Generation request interrupted:", (error as Error).message);
    return Response.json({ error: "The request was interrupted. Retry with the same Idempotency-Key to recover its job; it will not be submitted twice." }, { status: 503 });
  }
}

let reservationReady: Promise<void> | undefined;
async function reservationsReady(): Promise<void> {
  reservationReady ??= (async () => {
    await platformReady();
    await platformDb().execute(`CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)`);
  })().catch((error) => { reservationReady = undefined; throw error; });
  await reservationReady;
}

type Baseline = { id: string; projectId: string | null; shotId: string | null; tokenId: string | null; cost: number; credits: number; createdAt: number; status: string; deleted: boolean };

/** Reserve the existing ledger estimate under one database write lock.
 * The balance test and meter insert commit together, across server instances.
 * Meter completions update this same row to the actual cost. */
let reservationTurn: Promise<void> = Promise.resolve();
export async function reserveGenerationSpend(event: MeterEvent, options: {
  token?: { id: string; capUsd: number | null };
  projectId?: string | null;
} = {}): Promise<void> {
  // Local libsql clients share a connection; never interleave transactions on it.
  // The database transaction below also protects requests in other processes.
  const result = reservationTurn.then(() => reserveGenerationSpendLocked(event, options));
  reservationTurn = result.catch(() => {});
  return result;
}

async function reserveGenerationSpendLocked(event: MeterEvent, options: {
  token?: { id: string; capUsd: number | null };
  projectId?: string | null;
} = {}): Promise<void> {
  const ws = requireTenant();
  const projectId = event.projectId ?? options.projectId ?? null;
  const cost = Number(event.engineCostUsd);
  if (!Number.isFinite(cost) || cost < 0) throw new SpendReservationError("This job has no valid cost estimate.", 400, true);
  const paid = paidByPlatformEngine(event.engine);
  const billed = paid ? billCredits(cost, marginKeyOf(event.kind, event.model)) : 0;
  await ready();
  await reservationsReady();
  const cap = projectId ? await projectCap(projectId) : null;
  const limits = await workspaceLimits();
  const shotCap = event.shotId && currentTenant()?.user?.role !== "admin" && cleanRule(await getSetting("approvalRule")) === "cap"
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
    credits: billCredits(Number(r.cost), marginKeyOf(String(r.kind), String(r.model))), createdAt: Number(r.created_at), status: String(r.status), deleted: Boolean(r.deleted),
  }]));
  await billingTransaction(async (tx, ts) => {
    await acceptRecoveryJobTx(tx, ws.id, event.id, event.kind);
    const standing = await tx.execute({ sql: `SELECT deleted_at,suspended_at FROM workspaces WHERE id=?`, args: [ws.id] });
    // Old internal/mock records may predate the workspace registry; a known deleted/suspended workspace never spends from a stale request scope.
    if (standing.rows[0]?.deleted_at != null) throw new SpendReservationError("This workspace has been deleted.", 410);
    if (standing.rows[0]?.suspended_at != null) throw new SpendReservationError("This workspace is suspended.", 403);
    await syncBillingLedger(tx, ws.id, ts);
    const own = await tx.execute({ sql: `SELECT workspace_id,status FROM meter_events WHERE id=?`, args: [event.id] });
    if (own.rows[0] && own.rows[0].workspace_id !== ws.id) throw new SpendReservationError("This job belongs to another workspace.", 409, true);
    if (own.rows[0] && own.rows[0].status !== "running") throw new SpendReservationError("This job has already completed.", 409, true);
    const existing = await tx.execute({ sql: `SELECT m.*, r.token_id AS reservation_token FROM meter_events m LEFT JOIN generation_reservations r ON r.id=m.id WHERE m.workspace_id=? AND m.id<>?`, args: [ws.id, event.id] });
    try { await setCreditDebitTx(tx, ws.id, event.id, billed, ts); }
    catch (error) { if (error instanceof CreditBalanceError) throw new SpendReservationError(error.message, 402); throw error; }
    const merged = new Map(baseline);
    merged.delete(event.id);
    const monthly = new Map(monthlyRecords);
    monthly.delete(event.id);
    for (const r of existing.rows) {
      const prior = merged.get(String(r.id));
      merged.set(String(r.id), { id: String(r.id), projectId: r.project_id == null ? prior?.projectId ?? null : String(r.project_id), shotId: r.shot_id == null ? prior?.shotId ?? null : String(r.shot_id),
        tokenId: r.reservation_token == null ? prior?.tokenId ?? null : String(r.reservation_token),
        cost: Math.max(prior?.cost ?? 0, Number(r.engine_cost_usd ?? 0)), credits: Math.max(prior?.credits ?? 0, Number(r.billed_credits ?? 0)), createdAt: Number(r.created_at), status: String(r.status), deleted: prior?.deleted ?? false });
      if (!Number(r.paid_by_platform)) monthly.delete(String(r.id));
      else if (Number(r.created_at) >= since) monthly.set(String(r.id), Math.max(monthly.get(String(r.id)) ?? 0, Number(r.engine_cost_usd ?? 0)));
    }
    const running = [...merged.values()].filter((r) => !r.deleted && (r.status === "running" || r.status === "queued")).length;
    const recent = [...merged.values()].filter((r) => r.status !== "held" && r.createdAt >= now() - 3_600_000).length;
    if (recent >= limits.rendersPerHour) throw new SpendReservationError("This workspace has reached its hourly job limit, including reserved jobs. Try again later.", 429);
    if (running >= limits.concurrency) throw new SpendReservationError("Every job slot is reserved. Wait for an active job to finish, then try again.", 409);
    if (shotCap != null) {
      const shotCredits = [...merged.values()].filter((r) => r.shotId === event.shotId).reduce((sum, r) => sum + r.credits, 0);
      if (shotCredits + billCredits(cost, marginKeyOf(event.kind, event.model)) > shotCap) throw new SpendReservationError("This take and reserved takes exceed the shot's credit cap. An admin must start it.", 403, true);
    }
    if (monthlyCap != null && [...monthly.values()].reduce((sum, recordedCost) => sum + recordedCost, 0) + cost > monthlyCap + 1e-9) throw new SpendReservationError("This job and the reserved jobs would exceed the workspace's monthly spending cap.", 429);
    if (cap) {
      const spent = [...merged.values()].filter((r) => r.projectId === projectId).reduce((sum, r) => sum + (cap.unit === "cr" ? r.credits : r.cost), 0);
      const verdict = capVerdict({ cap: cap.cap, spent, needs: cap.unit === "cr" ? billCredits(cost + (baseline.get(event.id)?.cost ?? 0), marginKeyOf(event.kind, event.model)) : cost + (baseline.get(event.id)?.cost ?? 0),
        rule, unlocked: cap.unlocked, warnPct: 80, unit: cap.unit });
      if (!verdict.allow) throw new SpendReservationError(verdict.error!, 409, true);
    }
    if (options.token?.capUsd != null) {
      const spent = [...merged.values()].filter((r) => r.tokenId === options.token!.id && r.createdAt >= since).reduce((sum, r) => sum + r.cost, 0);
      if (spent + cost + (baseline.get(event.id)?.cost ?? 0) > options.token.capUsd + 1e-9) throw new SpendReservationError("This job and the reserved jobs would exceed this token's monthly spending ceiling.", 429, true);
    }
    await tx.execute({ sql: `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='running',engine_cost_usd=excluded.engine_cost_usd,billed_credits=excluded.billed_credits,paid_by_platform=excluded.paid_by_platform,updated_at=excluded.updated_at`,
      args: [event.id, ws.id, projectId, event.shotId ?? null, event.kind, event.engine, event.model, "running", cost, billed, paid ? 1 : 0, event.createdBy ?? null, ts, ts] });
    await tx.execute({ sql: `INSERT INTO generation_reservations(id,workspace_id,token_id) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`, args: [event.id, ws.id, options.token?.id ?? null] });
  });
}
