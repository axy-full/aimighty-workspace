import { randomUUID } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { db, now, ready } from "@/lib/db";
import type { PreparedAdmission } from "../admissionTypes";
import type { CanvasOp, OpOutcome } from "./canvas-ops-model";
import type { CompiledPlan, RigAgentMode, RigAgentState, RigAgentStepState, StepTool } from "./rig-agent-plan";

/*
 * rig_agent_runs and rig_agent_steps: an Atomik run on a production's Rig
 * board, in the workspace's own database. Additive: both tables are created
 * the first time someone asks Atomik to build a board. The state lives here;
 * Inngest, the native worker, a request's after() and the cron only wake it.
 *
 *  - A run is one request, from the person who asked, with its proposal (the
 *    plan and the fingerprint they approve), its state, and a lease so one
 *    worker at a time moves it. A production has at most one run in progress
 *    (a unique partial index), and a request id makes asking twice ask once.
 *  - A step is one batch of canvas operations with its op id (applying it again
 *    changes nothing), its state and what became of each operation — including
 *    the ones a person's edit held. Priced steps (a render) and person-only
 *    ones (locking a master) are kept as `next`: shown, never run by the build.
 *  - After the build, a render is a paid step (lib/workbench/rig-agent-runs.ts):
 *    its price (the prepared admission, server-only), who approved it and at
 *    which price, its durable request key (saved before anything is sent), the
 *    job it made, and the credits reserved and settled for it. A run records
 *    the limit a person approved for it and every change to that limit.
 *  - A take that fails its check is fixed by new steps added while the run is
 *    live (insertLiveSteps): a fix (`fix` = its number on that shot) and the
 *    check of the fixed take, appended after the plan's own steps. A shot's
 *    fix n exists once (a unique index). A step's own paid text (the fix
 *    writer's turn) is reserved, settled or released like the planning turn:
 *    `charge_id` names its meter event and `charge` says where it stands.
 */

type Executor = Pick<Client, "execute"> | Transaction;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rig_agent_runs (
     id TEXT PRIMARY KEY,
     production_id TEXT NOT NULL,
     draft_id TEXT NOT NULL,
     owner TEXT NOT NULL,
     request_id TEXT NOT NULL,
     goal TEXT NOT NULL,
     mode TEXT NOT NULL DEFAULT 'ask',
     cap_credits INTEGER,
     per_job_cap INTEGER,
     model TEXT NOT NULL,
     state TEXT NOT NULL,
     reason TEXT,
     plan TEXT,
     plan_fingerprint TEXT,
     usage TEXT,
     planning_started_at INTEGER,
     approved_at INTEGER,
     approved_by TEXT,
     finished_at INTEGER,
     undone_at INTEGER,
     undone_by TEXT,
     undo TEXT,
     lease_token TEXT,
     lease_until INTEGER NOT NULL DEFAULT 0,
     wake_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(owner, request_id)
   )`,
  /* At most one run in progress per production: a second ask waits for it, or replaces a proposal nobody approved. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rig_agent_runs_active ON rig_agent_runs(production_id) WHERE state IN ('planning','awaiting_approval','running','paused')`,
  `CREATE INDEX IF NOT EXISTS idx_rig_agent_runs_production ON rig_agent_runs(production_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rig_agent_runs_wake ON rig_agent_runs(wake_at) WHERE wake_at IS NOT NULL`,
  /* The same, including a run that waits for a person (needs_you): a stop or its end frees the production. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rig_agent_runs_live ON rig_agent_runs(production_id) WHERE state IN ('planning','awaiting_approval','running','paused','needs_you')`,
  `CREATE TABLE IF NOT EXISTS rig_agent_steps (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     tool TEXT NOT NULL,
     label TEXT NOT NULL,
     purpose TEXT NOT NULL,
     node_id TEXT,
     attempt INTEGER NOT NULL DEFAULT 0,
     request_key TEXT,
     prepared TEXT NOT NULL,
     op_id TEXT,
     state TEXT NOT NULL,
     result TEXT,
     job_id TEXT,
     credits_reserved INTEGER,
     credits_settled INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(run_id, seq)
   )`,
];

/** Additive columns for paid work, on tables an earlier version may already have made. */
const COLUMNS: Record<string, [string, string][]> = {
  rig_agent_runs: [["limits", "TEXT"], ["plan_charge", "TEXT"]],
  rig_agent_steps: [
    ["admission", "TEXT"], ["quote_credits", "REAL"], ["band", "INTEGER"], ["approved_at", "INTEGER"], ["approved_by", "TEXT"],
    ["approved_fingerprint", "TEXT"], ["reason", "TEXT"], ["pause", "TEXT"], ["settled_at", "INTEGER"], ["outcome", "TEXT"],
    ["fix", "INTEGER"], ["charge_id", "TEXT"], ["charge", "TEXT"],
  ],
};
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_rig_agent_steps_job ON rig_agent_steps(job_id) WHERE job_id IS NOT NULL`,
  /* A shot's fix n, and the check of it, each exist once: adding them again changes nothing. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rig_agent_steps_fix ON rig_agent_steps(run_id, node_id, purpose, fix) WHERE fix IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_rig_agent_steps_charge ON rig_agent_steps(charge) WHERE charge='reserved'`,
];

async function addColumns(client: Client) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const have = new Set((await client.execute(`PRAGMA table_info(${table})`)).rows.map((row) => String(row.name)));
    for (const [column, type] of columns) {
      if (have.has(column)) continue;
      try { await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
      catch (error) { if (!/duplicate column/i.test(String(error))) throw error; }
    }
  }
  await client.batch(INDEXES, "write");
}

const created = new WeakMap<object, Promise<void>>();
/** Creates the tables on first use (idempotent). */
export async function rigAgentReady() {
  await ready();
  const client = db();
  let pending = created.get(client);
  if (!pending) {
    pending = client.batch(SCHEMA, "write").then(() => addColumns(client)).catch((error) => { created.delete(client); throw error; });
    created.set(client, pending);
  }
  await pending;
}

/** Whether this workspace has ever asked Atomik to build (a read never creates the tables). */
export async function rigAgentExists(executor: Executor = db()): Promise<boolean> {
  return (await executor.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_agent_runs'")).rows.length > 0;
}

export type UndoRecord = { removed: number; kept: number; reasons: string[] };
export type PlanUsage = { model: string; inputTokens: number; outputTokens: number; steps: number };
/** One approval of a run's limit: at the ask, or a raise later (only ever by the person who asked). */
export type LimitRecord = { credits: number; mode: RigAgentMode; jobCeiling: number; by: string; at: number };
/** The planning turn's charge: reserved at its ceiling while Atomik plans, then settled at what it used, or released. */
export type PlanCharge = "reserved" | "settled" | "released";
/**
 * Why a paid step waits for a person. `check`: its take's check needs a person (unsure, failed
 * with no targeted fix, or failed after its fixes); the run flags that shot and carries on with the
 * others (lib/workbench/rig-agent-runs.ts waitScope).
 */
export type PauseKind = "limit" | "credits" | "admin" | "refused" | "unpriced" | "record" | "check";
const PAUSE_KINDS: readonly PauseKind[] = ["limit", "credits", "admin", "refused", "unpriced", "record", "check"];

export type RunRow = {
  id: string; productionId: string; draftId: string; owner: string; requestId: string; goal: string; mode: RigAgentMode;
  model: string; state: RigAgentState; reason: string | null; plan: CompiledPlan | null; fingerprint: string | null;
  planningStartedAt: number | null; approvedAt: number | null; approvedBy: string | null; finishedAt: number | null;
  undoneAt: number | null; undoneBy: string | null; undo: UndoRecord | null;
  /** The limit the person approved for the run, in credits (null: asked before limits, so nothing after the build is paid). */
  capCredits: number | null;
  /** The per-job line in force when the limit was approved: Auto never runs a render priced above it (nor above today's). */
  perJobCap: number | null;
  limits: LimitRecord[];
  planCharge: PlanCharge | null;
  leaseUntil: number; wakeAt: number | null; createdAt: number; updatedAt: number;
};

export type StepRow = {
  id: string; runId: string; seq: number; tool: StepTool; label: string; purpose: string; nodeId: string | null;
  /** How many times this step's paid request has been sent, each under its own key (lib/workbench/rig-agent-runs.ts stepRequestKey). */
  attempt: number; ops: CanvasOp[]; opId: string | null; state: RigAgentStepState; result: OpOutcome[] | null;
  /**
   * The saved request key of the paid attempt now being sent: `rig-agent:<runId>:<nodeId>:take:<attempt>`
   * for a render, `rig-agent:<runId>:<nodeId>:fix:<fix>:<attempt>` for a fix, and for a check the
   * request id of its development job.
   */
  requestKey: string | null;
  /** A fix step: which fix of its shot it is (1, 2, …); on a check, the fix whose take it checks. Null for the plan's own steps. */
  fix: number | null;
  /** The meter event of this step's own paid text (the fix writer's turn), once one may have been reserved. */
  chargeId: string | null;
  /** Where that charge stands: reserved while the turn may run, then settled at what it used, or released. */
  charge: PlanCharge | null;
  updatedAt: number;
  jobId: string | null;
  creditsReserved: number | null;
  creditsSettled: number | null;
  /** The render as priced (server-only): admitted exactly as approved, or refused when it changed. */
  admission: PreparedAdmission | null;
  quoteCredits: number | null;
  band: number | null;
  approvedAt: number | null;
  /** A user id (a tap), or `auto` (Auto mode, under the per-job line). */
  approvedBy: string | null;
  /** The price the approval covers: the admission's quote fingerprint. */
  approvedFingerprint: string | null;
  reason: string | null;
  pause: PauseKind | null;
  settledAt: number | null;
  outcome: "not_billed" | "charged" | "unknown" | null;
};

const parse = <T,>(text: unknown, fallback: T): T => { if (text == null) return fallback; try { return JSON.parse(String(text)) as T; } catch { return fallback; } };
const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : String(v));

function runOf(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id), productionId: String(r.production_id), draftId: String(r.draft_id), owner: String(r.owner), requestId: String(r.request_id),
    goal: String(r.goal), mode: r.mode === "auto" ? "auto" : "ask", model: String(r.model), state: String(r.state) as RigAgentState, reason: str(r.reason),
    plan: parse<CompiledPlan | null>(r.plan, null), fingerprint: str(r.plan_fingerprint),
    planningStartedAt: num(r.planning_started_at), approvedAt: num(r.approved_at), approvedBy: str(r.approved_by), finishedAt: num(r.finished_at),
    undoneAt: num(r.undone_at), undoneBy: str(r.undone_by), undo: parse<UndoRecord | null>(r.undo, null),
    capCredits: num(r.cap_credits), perJobCap: num(r.per_job_cap), limits: parse<LimitRecord[]>(r.limits, []),
    planCharge: r.plan_charge === "reserved" || r.plan_charge === "settled" || r.plan_charge === "released" ? r.plan_charge : null,
    leaseUntil: Number(r.lease_until ?? 0), wakeAt: num(r.wake_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function stepOf(r: Record<string, unknown>): StepRow {
  return {
    id: String(r.id), runId: String(r.run_id), seq: Number(r.seq), tool: String(r.tool) as StepTool, label: String(r.label), purpose: String(r.purpose),
    nodeId: str(r.node_id), attempt: Number(r.attempt ?? 0), ops: parse<CanvasOp[]>(r.prepared, []), opId: str(r.op_id),
    state: String(r.state) as RigAgentStepState, result: parse<OpOutcome[] | null>(r.result, null),
    requestKey: str(r.request_key), jobId: str(r.job_id), creditsReserved: num(r.credits_reserved), creditsSettled: num(r.credits_settled),
    admission: parse<PreparedAdmission | null>(r.admission, null), quoteCredits: num(r.quote_credits), band: num(r.band),
    approvedAt: num(r.approved_at), approvedBy: str(r.approved_by), approvedFingerprint: str(r.approved_fingerprint),
    reason: str(r.reason), pause: PAUSE_KINDS.includes(r.pause as PauseKind) ? (r.pause as PauseKind) : null, settledAt: num(r.settled_at),
    outcome: r.outcome === "not_billed" || r.outcome === "charged" || r.outcome === "unknown" ? r.outcome : null,
    fix: num(r.fix), chargeId: str(r.charge_id),
    charge: r.charge === "reserved" || r.charge === "settled" || r.charge === "released" ? r.charge : null,
    updatedAt: Number(r.updated_at ?? 0),
  };
}

const rows = async (executor: Executor, statement: InStatement) => (await executor.execute(statement)).rows as unknown as Record<string, unknown>[];

export async function getRun(executor: Executor, runId: string): Promise<RunRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_runs WHERE id=?", args: [runId] }))[0];
  return row ? runOf(row) : null;
}

/** A run of this production (never another's, whatever id is asked for). */
export async function runOfProduction(executor: Executor, productionId: string, runId: string): Promise<RunRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_runs WHERE id=? AND production_id=?", args: [runId, productionId] }))[0];
  return row ? runOf(row) : null;
}

export async function runByRequest(executor: Executor, owner: string, requestId: string): Promise<RunRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_runs WHERE owner=? AND request_id=?", args: [owner, requestId] }))[0];
  return row ? runOf(row) : null;
}

export async function activeRun(executor: Executor, productionId: string): Promise<RunRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_runs WHERE production_id=? AND state IN ('planning','awaiting_approval','running','paused','needs_you') LIMIT 1", args: [productionId] }))[0];
  return row ? runOf(row) : null;
}

/** The newest run on a production: the one its run card shows. */
export async function latestRun(executor: Executor, productionId: string): Promise<RunRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_runs WHERE production_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", args: [productionId] }))[0];
  return row ? runOf(row) : null;
}

export async function stepsOf(executor: Executor, runId: string): Promise<StepRow[]> {
  return (await rows(executor, { sql: "SELECT * FROM rig_agent_steps WHERE run_id=? ORDER BY seq", args: [runId] })).map(stepOf);
}

export function newRunId() {
  return "rar_" + randomUUID().replaceAll("-", "").slice(0, 24);
}

export async function insertRun(tx: Transaction, run: {
  id: string; productionId: string; draftId: string; owner: string; requestId: string; goal: string; model: string; at: number;
  /** The limit the person approved as they asked, the mode, and the per-job line then in force. */
  limit: { credits: number; mode: RigAgentMode; jobCeiling: number };
}) {
  const limits: LimitRecord[] = [{ credits: run.limit.credits, mode: run.limit.mode, jobCeiling: run.limit.jobCeiling, by: run.owner, at: run.at }];
  await tx.execute({
    sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,limits,model,state,lease_until,wake_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'planning',0,?,?,?)`,
    args: [run.id, run.productionId, run.draftId, run.owner, run.requestId, run.goal, run.limit.mode, run.limit.credits, run.limit.jobCeiling,
      JSON.stringify(limits), run.model, run.at, run.at, run.at],
  });
}

type RunPatch = Partial<{
  state: RigAgentState; reason: string | null; plan: CompiledPlan; plan_fingerprint: string; usage: PlanUsage; model: string;
  planning_started_at: number; approved_at: number; approved_by: string; finished_at: number;
  undone_at: number; undone_by: string; undo: UndoRecord; wake_at: number | null;
  cap_credits: number; limits: LimitRecord[]; plan_charge: PlanCharge;
}>;

/**
 * Changes a run, only while it is in one of `from` (null: any state). Answers
 * whether it changed: a stop that landed first is never overwritten.
 */
export async function patchRun(executor: Executor, runId: string, patch: RunPatch, from: readonly RigAgentState[] | null = null): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof RunPatch)[];
  const values = keys.map((key) => {
    const value = patch[key];
    return value !== null && typeof value === "object" ? JSON.stringify(value) : (value ?? null);
  });
  const guard = from ? ` AND state IN (${from.map(() => "?").join(",")})` : "";
  const result = await executor.execute({
    sql: `UPDATE rig_agent_runs SET ${[...keys.map((key) => `${key}=?`), "updated_at=?"].join(",")} WHERE id=?${guard}`,
    args: [...values, now(), runId, ...(from ?? [])] as (string | number | null)[],
  });
  return result.rowsAffected > 0;
}

export async function insertSteps(tx: Transaction, runId: string, plan: CompiledPlan, at: number) {
  for (const step of plan.steps) {
    await tx.execute({
      sql: `INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,node_id,attempt,prepared,op_id,state,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?)`,
      args: [`${runId}:${step.seq}`, runId, step.seq, step.tool, step.label, step.purpose, step.nodeId, JSON.stringify(step.ops),
        step.state === "next" ? null : stepOpId(runId, step.seq), step.state, at, at],
    });
  }
}

/** A step added while the run is live: a shot's fix n, or the check of its fixed take. */
export type LiveStep = { tool: "fix" | "verify"; purpose: "fix" | "verify"; label: string; nodeId: string; fix: number };

/**
 * Adds steps to a live run, after every step it has (in the order given), inside the caller's write
 * transaction. A step already there — the same shot's fix n, or the check of it — is kept as it is
 * and not added again, so asking twice adds once. Answers the steps as stored, in the order given.
 */
export async function insertLiveSteps(tx: Transaction, runId: string, steps: readonly LiveStep[], at: number): Promise<StepRow[]> {
  const out: StepRow[] = [];
  for (const step of steps) {
    const found = (await rows(tx, { sql: "SELECT * FROM rig_agent_steps WHERE run_id=? AND node_id=? AND purpose=? AND fix=?", args: [runId, step.nodeId, step.purpose, step.fix] }))[0];
    if (found) { out.push(stepOf(found)); continue; }
    const seq = Number((await rows(tx, { sql: "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM rig_agent_steps WHERE run_id=?", args: [runId] }))[0].seq);
    await tx.execute({
      sql: `INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,node_id,attempt,prepared,op_id,state,fix,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,0,'[]',NULL,'next',?,?,?)`,
      args: [`${runId}:${seq}`, runId, seq, step.tool, step.label, step.purpose, step.nodeId, step.fix, at, at],
    });
    out.push((await getStep(tx, runId, seq))!);
  }
  return out;
}

/** The op id a build step applies under: the same step applied again changes nothing (applyCanvasOps). */
export const stepOpId = (runId: string, seq: number) => `rig-agent:${runId}:${seq}`;
/** The op id of a run's undo. */
export const undoOpId = (runId: string) => `rig-agent:${runId}:undo`;

export async function setSteps(executor: Executor, runId: string, from: RigAgentStepState, to: RigAgentStepState) {
  await executor.execute({ sql: "UPDATE rig_agent_steps SET state=?,updated_at=? WHERE run_id=? AND state=?", args: [to, now(), runId, from] });
}

/** A step about to be applied: counted, so one that keeps failing stops the run instead of retrying forever. */
export async function attemptStep(executor: Executor, stepId: string): Promise<number> {
  const row = (await rows(executor, { sql: "UPDATE rig_agent_steps SET attempt=attempt+1,updated_at=? WHERE id=? AND state='queued' RETURNING attempt", args: [now(), stepId] }))[0];
  return row ? Number(row.attempt) : 0;
}

type StepPatch = Partial<{
  state: RigAgentStepState; attempt: number; request_key: string | null; job_id: string | null;
  credits_reserved: number | null; credits_settled: number | null; admission: PreparedAdmission | null; quote_credits: number | null;
  band: number | null; approved_at: number | null; approved_by: string | null; approved_fingerprint: string | null;
  reason: string | null; pause: PauseKind | null; settled_at: number | null; outcome: StepRow["outcome"];
  charge_id: string | null; charge: PlanCharge | null;
}>;

/**
 * Changes a paid step, only while it is in one of `from` (null: any state). Answers whether it
 * changed: two ticks, or a tick and a person, never both move the same step.
 */
export async function patchStep(executor: Executor, stepId: string, patch: StepPatch, from: readonly RigAgentStepState[] | null = null): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof StepPatch)[];
  const values = keys.map((key) => {
    const value = patch[key];
    return value !== null && typeof value === "object" ? JSON.stringify(value) : (value ?? null);
  });
  const guard = from ? ` AND state IN (${from.map(() => "?").join(",")})` : "";
  const result = await executor.execute({
    sql: `UPDATE rig_agent_steps SET ${[...keys.map((key) => `${key}=?`), "updated_at=?"].join(",")} WHERE id=?${guard}`,
    args: [...values, now(), stepId, ...(from ?? [])] as (string | number | null)[],
  });
  return result.rowsAffected > 0;
}

/**
 * Records that a step's paid text may now be reserved under `chargeId`, before the ledger is asked:
 * a worker that dies in between leaves a record the cron releases. Refused (false) while the step
 * already holds another charge that is still reserved.
 */
export async function openStepCharge(executor: Executor, stepId: string, chargeId: string): Promise<boolean> {
  const result = await executor.execute({
    sql: "UPDATE rig_agent_steps SET charge_id=?,charge='reserved',updated_at=? WHERE id=? AND (charge IS NULL OR charge<>'reserved' OR charge_id=?)",
    args: [chargeId, now(), stepId, chargeId],
  });
  return result.rowsAffected > 0;
}

/** Moves a step's reserved charge on (settled or released), only while it is that charge and still reserved. */
export async function closeStepCharge(executor: Executor, stepId: string, chargeId: string, to: "settled" | "released"): Promise<boolean> {
  const result = await executor.execute({
    sql: "UPDATE rig_agent_steps SET charge=?,updated_at=? WHERE id=? AND charge_id=? AND charge='reserved'",
    args: [to, now(), stepId, chargeId],
  });
  return result.rowsAffected > 0;
}

export async function getStep(executor: Executor, runId: string, seq: number): Promise<StepRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_steps WHERE run_id=? AND seq=?", args: [runId, seq] }))[0];
  return row ? stepOf(row) : null;
}

/** The paid step that made a job (the settlement's way back to its run). */
export async function stepOfJob(executor: Executor, jobId: string): Promise<StepRow | null> {
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_steps WHERE job_id=? LIMIT 1", args: [jobId] }))[0];
  return row ? stepOf(row) : null;
}

/** A step that was applied is done, even when a stop marked the rest skipped while it was being applied. */
export async function finishStep(executor: Executor, stepId: string, outcomes: OpOutcome[]) {
  await executor.execute({ sql: "UPDATE rig_agent_steps SET state='done',result=?,updated_at=? WHERE id=? AND state IN ('queued','skipped')", args: [JSON.stringify(outcomes), now(), stepId] });
}

/* ── One worker at a time: the run's lease ────────────────────────────── */

export type RunLease = { runId: string; token: string; until: number };

export async function claimRun(runId: string, leaseMs: number, at = now()): Promise<RunLease | null> {
  const token = randomUUID(), until = at + leaseMs;
  const claimed = await db().execute({ sql: "UPDATE rig_agent_runs SET lease_token=?,lease_until=? WHERE id=? AND lease_until<=? RETURNING id", args: [token, until, runId, at] });
  return claimed.rows.length ? { runId, token, until } : null;
}

export async function renewRun(lease: RunLease, leaseMs: number): Promise<RunLease> {
  const until = now() + leaseMs;
  const renewed = await db().execute({ sql: "UPDATE rig_agent_runs SET lease_until=? WHERE id=? AND lease_token=?", args: [until, lease.runId, lease.token] });
  if (!renewed.rowsAffected) throw new Error("The run's lease was lost.");
  return { ...lease, until };
}

export async function releaseRun(lease: RunLease) {
  await db().execute({ sql: "UPDATE rig_agent_runs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?", args: [lease.runId, lease.token] });
}

/** Runs due a wake (from the cron): in progress, due, and not held by another worker. */
export async function dueRuns(limit: number, at = now()): Promise<string[]> {
  if (!(await rigAgentExists())) return [];
  return (await rows(db(), {
    sql: "SELECT id FROM rig_agent_runs WHERE state IN ('planning','running','paused') AND wake_at IS NOT NULL AND wake_at<=? AND lease_until<=? ORDER BY wake_at LIMIT ?",
    args: [at, at, limit],
  })).map((r) => String(r.id));
}

/**
 * Runs that ended (or stopped) with their planning charge still reserved and nobody holding them:
 * a worker that died while Atomik planned. The cron releases them (lib/workbench/rig-agent.ts).
 */
export async function looseCharges(limit: number, olderThan: number, at = now()): Promise<string[]> {
  if (!(await readyIfExists())) return [];
  return (await rows(db(), {
    sql: "SELECT id FROM rig_agent_runs WHERE plan_charge='reserved' AND state NOT IN ('planning') AND lease_until<=? AND updated_at<=? ORDER BY updated_at LIMIT ?",
    args: [at, olderThan, limit],
  })).map((r) => String(r.id));
}

/** Whether this workspace has runs; when it has, the tables are brought up to date first (a sweep may read a column added since). */
async function readyIfExists(): Promise<boolean> {
  if (!(await rigAgentExists())) return false;
  await rigAgentReady();
  return true;
}

/**
 * Runs that ended with paid work still open and nobody holding them: what the stop could not close
 * yet — a render or a fix still marked as being sent or in flight, a check whose job is still being
 * admitted or running, or a step's paid text still reserved. The cron closes them (closeEndedSteps,
 * lib/workbench/rig-agent-runs.ts); free reads and releases, never a send.
 */
export async function looseSteps(limit: number, at = now()): Promise<string[]> {
  if (!(await readyIfExists())) return [];
  return (await rows(db(), {
    sql: `SELECT r.id FROM rig_agent_runs r WHERE r.state IN ('stopped','failed','done') AND r.lease_until<=?
          AND EXISTS (SELECT 1 FROM rig_agent_steps s WHERE s.run_id=r.id
            AND ((s.purpose IN ('take','fix','verify') AND s.state IN ('sending','rendering')) OR s.charge='reserved'))
          ORDER BY r.updated_at LIMIT ?`,
    args: [at, limit],
  })).map((r) => String(r.id));
}

/**
 * Runs in any state with a step's paid text still reserved since before `olderThan` and nobody
 * holding the run: a worker that died while that turn ran (a live one holds the run's lease for as
 * long as its turn may take). The cron releases the charge, unbilled; the turn is never sent again
 * on its own.
 */
export async function looseStepCharges(limit: number, olderThan: number, at = now()): Promise<string[]> {
  if (!(await readyIfExists())) return [];
  return (await rows(db(), {
    sql: `SELECT r.id AS id, MIN(s.updated_at) AS since FROM rig_agent_runs r JOIN rig_agent_steps s ON s.run_id=r.id
          WHERE s.charge='reserved' AND s.updated_at<=? AND r.lease_until<=? GROUP BY r.id ORDER BY since LIMIT ?`,
    args: [olderThan, at, limit],
  })).map((r) => String(r.id));
}

/** Every change the run made to the canvas, from the canvas's own log (lib/workbench/canvas-ops-log.ts). */
export async function runCanvasChanges(productionId: string, runId: string): Promise<{ changes: import("./canvas-ops-model").NodeChange[] }[]> {
  const exists = (await db().execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_canvas_ops'")).rows.length > 0;
  if (!exists) return [];
  return (await rows(db(), { sql: "SELECT changes FROM rig_canvas_ops WHERE production_id=? AND run_id=? AND what='agent' ORDER BY seq", args: [productionId, runId] }))
    .map((r) => ({ changes: parse(r.changes, []) }));
}
