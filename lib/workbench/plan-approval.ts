import { createHash, randomUUID } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { creditFigure, fromTenths, toTenths } from "../runLimit";

/*
 * A plan is approved once (CLAUDE.md rule 14; the scope's § 0 Money): one tap by the person who asked Atomik
 * approves the plan's listed renders, each at the price it was approved at, plus at most two fixes per shot, up to
 * the plan's total including those fixes. Anything outside it asks again at its own price.
 *
 *  - The quote is the server's: every render the plan names, priced on the exact request it will send (the run's
 *    own free, repeatable preparation). T is the sum of their worst cases; the plan may never spend more than
 *    PLAN_CEILING_MULTIPLE × T in all ("Make 3 shots · 93 cr · at most 186 cr").
 *  - The approval is one row in `rig_plan_approvals` (the workspace's own database): who, when, until when, each
 *    listed step with its price's fingerprint, T, the ceiling, the fixes drawn per shot, and when it closed.
 *  - The run's limit is set to what the run already used plus the ceiling, so the reservation enforces the total
 *    under its write lock (lib/generationRequests.ts), as it does for every run. The approval replaces only the
 *    tap: the balance, the production's cap, the workspace's monthly allowance and the run's limit are all still
 *    checked at the hold.
 *  - Only a person approves. An approver id that is an agent, an MCP caller, a token or Auto is refused here and by
 *    the table's own check.
 *
 * Pure helpers first; the store at the end. A1 later reads these rows as `tool_approvals` with scope `plan`.
 */

/** The most a plan may spend, renders and fixes together, as a multiple of its renders' total (owner decision 1). */
export const PLAN_CEILING_MULTIPLE = 2;
/** At most this many fixes per shot under one approval; a further one asks at its price. */
export const MAX_FIXES_PER_SHOT = 2;
/** How long an approval may be drawn on (owner decision 4), unless the run is stopped or undone first. */
export const PLAN_APPROVAL_MS = 7 * 24 * 60 * 60 * 1000;

export const PEOPLE_ONLY = "Only a person approves spending. Atomik, outside agents and tokens can prepare a plan, never approve it.";
export const THIRD_FIX = `This shot has had its ${MAX_FIXES_PER_SHOT} fixes under this plan. Another one asks at its own price.`;
export const NOT_IN_PLAN = "Not in the approved plan, so it asks at its own price.";
export const PRICE_MOVED = "This render's price changed since the plan was approved. Look at it again.";

/** Approver id prefixes that name a machine, never a person. The function and the table's own check read this one list. */
export const MACHINE_PREFIXES = ["agent", "mcp", "token", "auto", "plan", "system", "cron", "worker"] as const;
const MACHINE = new RegExp(`^(${MACHINE_PREFIXES.join("|")}):`, "i");

/** An approver id that names a person: never an agent's run, an MCP caller, a token, Auto or the system. */
export function isPersonApprover(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (!value || value !== id) return false;
  if (value.toLowerCase() === "auto") return false;
  return !MACHINE.test(value);
}

/**
 * The same refusal in SQL, for the table's CHECK and its guard triggers: blank, padded with any whitespace
 * String.prototype.trim removes, `auto` in any case, or a machine prefix in any case.
 */
const JS_WHITESPACE = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
export function notAPersonSql(column: string): string {
  return `(${column} IS NULL OR ${column} = '' OR ${column} <> trim(${column}, ${JS_WHITESPACE}) OR lower(${column}) = 'auto' OR `
    + MACHINE_PREFIXES.map((p) => `lower(${column}) LIKE '${p}:%'`).join(" OR ") + ")";
}

/* ── The quote ────────────────────────────────────────────────────────── */

/** A render step as the quote reads it. `worst` is its price at its band (what the limit keeps room for). */
export type QuoteInputStep = {
  seq: number; nodeId: string | null; title: string; state: string; fixOf: number | null;
  quote: number | null; worst: number | null; fingerprint: string | null; pause: string | null; reason: string | null;
};

/** One render the approval lists: its shot, its price, and the price's fingerprint. */
export type PlanStepQuote = { seq: number; nodeId: string; title: string; quote: number; worst: number; fingerprint: string };

export type PlanQuote =
  | {
    ready: true;
    /** The renders one approval covers. */
    steps: PlanStepQuote[];
    /** Renders that are priced but ask on their own (above the per-job line). */
    asks: { seq: number; title: string; worst: number }[];
    totalTenths: number;
    ceilingTenths: number;
    total: number;
    ceiling: number;
    /** Some render may settle above its quote (an approximate engine): the total is "up to". */
    approximate: boolean;
    /** What the person approves: every listed step's price fingerprint and figure. */
    fingerprint: string;
  }
  | { ready: false; reason: string };

/** States in which a plan's render still waits to be sent. */
const OPEN: readonly string[] = ["next", "waiting", "paused"];
/** Pauses that keep a price (the run's limit, the balance): the approval sets the limit and the hold checks the balance again. */
const KEEPS_PRICE: readonly string[] = ["limit", "credits"];

/**
 * The plan's quote from its render steps: every original render not yet sent must carry the server's price.
 * A render above the per-job line is listed to ask on its own and is not in the total.
 */
export function planQuote(steps: readonly QuoteInputStep[], jobLine: number): PlanQuote {
  const open = steps.filter((s) => s.fixOf == null && OPEN.includes(s.state));
  if (!open.length) return { ready: false, reason: "Nothing in this plan is waiting to render." };
  const listed: PlanStepQuote[] = [];
  const asks: { seq: number; title: string; worst: number }[] = [];
  let approximate = false;
  for (const s of open) {
    const priced = s.quote != null && s.worst != null && !!s.fingerprint && !!s.nodeId && (s.state === "waiting" || (s.state === "paused" && KEEPS_PRICE.includes(s.pause ?? "")));
    if (!priced) {
      return { ready: false, reason: s.state === "paused" && s.reason ? `${s.title}: ${s.reason}` : `${s.title} is not priced yet.` };
    }
    if (toTenths(s.worst!) > toTenths(s.quote!)) approximate = true;
    if (toTenths(s.worst!) > toTenths(jobLine)) { asks.push({ seq: s.seq, title: s.title, worst: s.worst! }); continue; }
    listed.push({ seq: s.seq, nodeId: s.nodeId!, title: s.title, quote: s.quote!, worst: s.worst!, fingerprint: s.fingerprint! });
  }
  if (!listed.length) return { ready: false, reason: `Every render here is over the ${creditFigure(jobLine)} cr a render may cost inside a plan, so each asks on its own.` };
  const totalTenths = listed.reduce((sum, s) => sum + toTenths(s.worst), 0);
  const ceilingTenths = totalTenths * PLAN_CEILING_MULTIPLE;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    v: 1, steps: listed.map((s) => [s.seq, s.fingerprint, toTenths(s.worst)]), asks: asks.map((a) => a.seq), ceilingTenths,
  })).digest("hex");
  return { ready: true, steps: listed, asks, totalTenths, ceilingTenths, total: fromTenths(totalTenths), ceiling: fromTenths(ceilingTenths), approximate, fingerprint };
}

/* ── The approval, and what it covers ─────────────────────────────────── */

export type PlanApprovalRow = {
  id: string; runId: string; productionId: string;
  approvedBy: string; approvedAt: number; expiresAt: number;
  fingerprint: string;
  steps: PlanStepQuote[];
  totalTenths: number; ceilingTenths: number;
  /** Fix steps drawn, by the shot's step: `{ "3": [9, 11] }`. */
  fixes: Record<string, number[]>;
  /** The run's limit the approval set, in credits. */
  limitCredits: number;
  closedAt: number | null; closedReason: string | null;
};

/** Why an approval can no longer be drawn on, or null while it can. */
export function approvalClosed(approval: Pick<PlanApprovalRow, "closedAt" | "closedReason" | "expiresAt">, at: number): string | null {
  if (approval.closedAt != null) return approval.closedReason ?? "This plan's approval was closed.";
  if (at >= approval.expiresAt) return "This plan's approval has expired, so this render asks at its own price.";
  return null;
}

export type CoverStep = { seq: number; fixOf: number | null; quote: number; worst: number; fingerprint: string };

/**
 * Whether one render is covered by the plan's approval, with no new tap: a listed render at the very price
 * approved, or a fix drawn under it priced no higher than its shot, never above the per-job line. Room under the
 * total is the reservation's to enforce (the run's limit); this says only whether the tap is already given.
 */
export function coverage(approval: PlanApprovalRow, step: CoverStep, at: number, jobLine: number): { ok: true } | { ok: false; reason: string } {
  const closed = approvalClosed(approval, at);
  if (closed) return { ok: false, reason: closed };
  if (toTenths(step.worst) > toTenths(jobLine)) return { ok: false, reason: `Over the ${creditFigure(jobLine)} cr a render may cost without its own tap, so it asks.` };
  if (step.fixOf == null) {
    const listed = approval.steps.find((s) => s.seq === step.seq);
    if (!listed) return { ok: false, reason: NOT_IN_PLAN };
    if (listed.fingerprint !== step.fingerprint) return { ok: false, reason: PRICE_MOVED };
    return { ok: true };
  }
  const shot = approval.steps.find((s) => s.seq === step.fixOf);
  if (!shot || !(approval.fixes[String(step.fixOf)] ?? []).includes(step.seq)) return { ok: false, reason: NOT_IN_PLAN };
  if (toTenths(step.worst) > toTenths(shot.worst)) return { ok: false, reason: "This fix costs more than its shot was approved at, so it asks at its own price." };
  return { ok: true };
}

/** The fixes a shot has drawn, and whether another may be. */
export function fixRoom(approval: Pick<PlanApprovalRow, "fixes" | "steps">, shotSeq: number): { used: number; left: number; listed: boolean } {
  const used = (approval.fixes[String(shotSeq)] ?? []).length;
  return { used, left: Math.max(0, MAX_FIXES_PER_SHOT - used), listed: approval.steps.some((s) => s.seq === shotSeq) };
}

/* ── The store (the workspace's own database; additive) ───────────────── */

type Executor = Pick<Client, "execute"> | Transaction;

export const PLAN_APPROVAL_SCHEMA = `CREATE TABLE IF NOT EXISTS rig_plan_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  production_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  steps TEXT NOT NULL,
  total_tenths INTEGER NOT NULL,
  ceiling_tenths INTEGER NOT NULL,
  fixes TEXT NOT NULL DEFAULT '{}',
  limit_credits REAL NOT NULL,
  closed_at INTEGER,
  closed_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK (NOT ${notAPersonSql("approved_by")})
)`;

/**
 * The same rule for a table made before its CHECK matched the function (SQLite cannot change a CHECK in place, and a
 * rebuild is not additive): triggers that refuse a machine approver on insert and on any change of approved_by.
 * Created on first use beside the table; harmless on a table whose CHECK already refuses the same ids.
 */
export const PLAN_APPROVAL_GUARDS = (["INSERT", "UPDATE OF approved_by"] as const).map((event) =>
  `CREATE TRIGGER IF NOT EXISTS rig_plan_approvals_person_${event === "INSERT" ? "insert" : "update"} BEFORE ${event} ON rig_plan_approvals
   WHEN ${notAPersonSql("NEW.approved_by")}
   BEGIN SELECT RAISE(ABORT, 'Only a person approves spending.'); END`);

const parse = <T,>(text: unknown, fallback: T): T => { if (text == null) return fallback; try { return JSON.parse(String(text)) as T; } catch { return fallback; } };

function approvalOf(r: Record<string, unknown>): PlanApprovalRow {
  return {
    id: String(r.id), runId: String(r.run_id), productionId: String(r.production_id),
    approvedBy: String(r.approved_by), approvedAt: Number(r.approved_at), expiresAt: Number(r.expires_at),
    fingerprint: String(r.fingerprint), steps: parse<PlanStepQuote[]>(r.steps, []),
    totalTenths: Number(r.total_tenths), ceilingTenths: Number(r.ceiling_tenths),
    fixes: parse<Record<string, number[]>>(r.fixes, {}), limitCredits: Number(r.limit_credits),
    closedAt: r.closed_at == null ? null : Number(r.closed_at), closedReason: r.closed_reason == null ? null : String(r.closed_reason),
  };
}

/** Whether the table is there (a read never creates it). */
async function tableExists(executor: Executor): Promise<boolean> {
  return (await executor.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_plan_approvals'")).rows.length > 0;
}

/** The run's plan approval, or null (one per run: a plan is approved once). */
export async function planApprovalOf(executor: Executor, runId: string): Promise<PlanApprovalRow | null> {
  if (!(await tableExists(executor))) return null;
  const row = (await executor.execute({ sql: "SELECT * FROM rig_plan_approvals WHERE run_id=?", args: [runId] })).rows[0];
  return row ? approvalOf(row as unknown as Record<string, unknown>) : null;
}

export async function insertPlanApproval(tx: Transaction, input: {
  runId: string; productionId: string; approvedBy: string; at: number; quote: Extract<PlanQuote, { ready: true }>; limitCredits: number;
}): Promise<string> {
  if (!isPersonApprover(input.approvedBy)) throw new Error(PEOPLE_ONLY);
  const id = "rpa_" + randomUUID().replaceAll("-", "").slice(0, 24);
  await tx.execute({
    sql: `INSERT INTO rig_plan_approvals(id,run_id,production_id,approved_by,approved_at,expires_at,fingerprint,steps,total_tenths,ceiling_tenths,fixes,limit_credits,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,'{}',?,?)`,
    args: [id, input.runId, input.productionId, input.approvedBy, input.at, input.at + PLAN_APPROVAL_MS, input.quote.fingerprint,
      JSON.stringify(input.quote.steps), input.quote.totalTenths, input.quote.ceilingTenths, input.limitCredits, input.at],
  });
  return id;
}

/** Records a fix drawn on a shot (the counter only grows: a fix that fails still counts). */
export async function recordFix(tx: Transaction, approvalId: string, shotSeq: number, fixSeq: number, fixes: Record<string, number[]>) {
  const next = { ...fixes, [String(shotSeq)]: [...(fixes[String(shotSeq)] ?? []), fixSeq] };
  await tx.execute({ sql: "UPDATE rig_plan_approvals SET fixes=? WHERE id=? AND closed_at IS NULL", args: [JSON.stringify(next), approvalId] });
}

/** Closes the run's approval (a stop, an undo): nothing more is drawn on it. */
export async function closePlanApproval(executor: Executor, runId: string, reason: string, at: number) {
  if (!(await tableExists(executor))) return;
  await executor.execute({ sql: "UPDATE rig_plan_approvals SET closed_at=?,closed_reason=? WHERE run_id=? AND closed_at IS NULL", args: [at, reason, runId] });
}
