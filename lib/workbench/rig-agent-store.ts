import { randomUUID } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { db, now, ready } from "@/lib/db";
import type { CanvasOp, OpOutcome } from "./canvas-ops-model";
import type { CompiledPlan, RigAgentState, RigAgentStepState, StepTool } from "./rig-agent-plan";

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
 *    ones (locking a master) are kept as `next`: shown, never run by this build.
 *    The columns later steps need (a request key, a job, credits reserved and
 *    settled) are here, empty: nothing in a build is paid.
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

const created = new WeakMap<object, Promise<void>>();
/** Creates the tables on first use (idempotent). */
export async function rigAgentReady() {
  await ready();
  const client = db();
  let pending = created.get(client);
  if (!pending) {
    pending = client.batch(SCHEMA, "write").then(() => {}).catch((error) => { created.delete(client); throw error; });
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

export type RunRow = {
  id: string; productionId: string; draftId: string; owner: string; requestId: string; goal: string; mode: string;
  model: string; state: RigAgentState; reason: string | null; plan: CompiledPlan | null; fingerprint: string | null;
  planningStartedAt: number | null; approvedAt: number | null; approvedBy: string | null; finishedAt: number | null;
  undoneAt: number | null; undoneBy: string | null; undo: UndoRecord | null;
  leaseUntil: number; wakeAt: number | null; createdAt: number; updatedAt: number;
};

export type StepRow = {
  id: string; runId: string; seq: number; tool: StepTool; label: string; purpose: string; nodeId: string | null;
  attempt: number; ops: CanvasOp[]; opId: string | null; state: RigAgentStepState; result: OpOutcome[] | null;
};

const parse = <T,>(text: unknown, fallback: T): T => { if (text == null) return fallback; try { return JSON.parse(String(text)) as T; } catch { return fallback; } };
const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : String(v));

function runOf(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id), productionId: String(r.production_id), draftId: String(r.draft_id), owner: String(r.owner), requestId: String(r.request_id),
    goal: String(r.goal), mode: String(r.mode), model: String(r.model), state: String(r.state) as RigAgentState, reason: str(r.reason),
    plan: parse<CompiledPlan | null>(r.plan, null), fingerprint: str(r.plan_fingerprint),
    planningStartedAt: num(r.planning_started_at), approvedAt: num(r.approved_at), approvedBy: str(r.approved_by), finishedAt: num(r.finished_at),
    undoneAt: num(r.undone_at), undoneBy: str(r.undone_by), undo: parse<UndoRecord | null>(r.undo, null),
    leaseUntil: Number(r.lease_until ?? 0), wakeAt: num(r.wake_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function stepOf(r: Record<string, unknown>): StepRow {
  return {
    id: String(r.id), runId: String(r.run_id), seq: Number(r.seq), tool: String(r.tool) as StepTool, label: String(r.label), purpose: String(r.purpose),
    nodeId: str(r.node_id), attempt: Number(r.attempt ?? 0), ops: parse<CanvasOp[]>(r.prepared, []), opId: str(r.op_id),
    state: String(r.state) as RigAgentStepState, result: parse<OpOutcome[] | null>(r.result, null),
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
  const row = (await rows(executor, { sql: "SELECT * FROM rig_agent_runs WHERE production_id=? AND state IN ('planning','awaiting_approval','running','paused') LIMIT 1", args: [productionId] }))[0];
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

export async function insertRun(tx: Transaction, run: { id: string; productionId: string; draftId: string; owner: string; requestId: string; goal: string; model: string; at: number }) {
  await tx.execute({
    sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,model,state,lease_until,wake_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'ask',?,'planning',0,?,?,?)`,
    args: [run.id, run.productionId, run.draftId, run.owner, run.requestId, run.goal, run.model, run.at, run.at, run.at],
  });
}

type RunPatch = Partial<{
  state: RigAgentState; reason: string | null; plan: CompiledPlan; plan_fingerprint: string; usage: PlanUsage; model: string;
  planning_started_at: number; approved_at: number; approved_by: string; finished_at: number;
  undone_at: number; undone_by: string; undo: UndoRecord; wake_at: number | null;
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

/** Every change the run made to the canvas, from the canvas's own log (lib/workbench/canvas-ops-log.ts). */
export async function runCanvasChanges(productionId: string, runId: string): Promise<{ changes: import("./canvas-ops-model").NodeChange[] }[]> {
  const exists = (await db().execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_canvas_ops'")).rows.length > 0;
  if (!exists) return [];
  return (await rows(db(), { sql: "SELECT changes FROM rig_canvas_ops WHERE production_id=? AND run_id=? AND what='agent' ORDER BY seq", args: [productionId, runId] }))
    .map((r) => ({ changes: parse(r.changes, []) }));
}
