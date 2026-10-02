import { createHash } from "node:crypto";
import { creditState } from "../credits";
import { db, now } from "../db";
import { runCharges } from "../generationRequests";
import { platformDb, platformReady } from "../platform";
import { requireTenant } from "../tenant";
import { fromTenths, runLimitVerdict, runTally, toTenths, type RunSpend } from "../runLimit";
import { creditFigure, type RigAgentState, type RigAgentStepState } from "./rig-agent-plan";
import { getRun, patchRun, patchStep, type PauseKind, type RunRow, type StepRow } from "./rig-agent-store";

/*
 * The moves every paid step of a run is made of (lib/workbench/rig-agent-runs.ts
 * renders and fixes, lib/workbench/rig-agent-checks.ts checks): carry on, stop
 * the tick, wait a while, wait for a person — the whole run, or only the
 * step's own shot — and the run's limit and the balance asked before anything
 * is approved or sent.
 */

export type PaidTick = { state: RigAgentState | null; more: boolean; waitFor?: { genId: string } };
export type Moved = { kind: "continue" } | { kind: "stop"; tick: PaidTick };
export const CONTINUE: Moved = { kind: "continue" };
export const stop = (tick: PaidTick): Moved => ({ kind: "stop", tick });

export type PaidContext = {
  deadline: number;
  enabled: () => boolean;
  offReason: string;
  pausedWakeMs: number;
  /** Renews the run's lease before each step (throws when it was lost). */
  renew: () => Promise<void>;
  /** Holds the run's lease for a call that may take longer than a step (a check's judge, the fix writer). */
  holdFor?: (ms: number) => Promise<void>;
};

export const figure = (credits: number) => `${creditFigure(credits)} cr`;

/** Where a step that waits for a person holds things up: its own shot (the run carries on with the others), or the whole run. */
export type WaitScope = "shot" | "run";

/**
 * The owner's choice: a shot whose check needs a person — unsure, failed with no targeted fix, or
 * failed after its fixes — is flagged, and the run carries on with its other shots. Every other
 * wait holds the whole run, as before: a render waiting for its tap or over the per-job line, the
 * run's limit, the balance, an admin, a refusal, a price or a record to fix.
 */
export function waitScope(kind: PauseKind): WaitScope {
  return kind === "check" ? "shot" : "run";
}

/** Called once the run has started waiting for a person (lib/workbench/rig-agent.ts tells them). */
let onNeedsYou: ((run: RunRow, reason: string) => Promise<void>) | null = null;
export function whenNeedsYou(hook: ((run: RunRow, reason: string) => Promise<void>) | null) {
  onNeedsYou = hook;
}

/** What the run needs a person for: said on the run card, and it waits there (needs_you). */
export async function needsYou(run: RunRow, reason: string): Promise<Moved> {
  const changed = await patchRun(db(), run.id, { state: "needs_you", reason, wake_at: null }, ["running"]);
  if (changed && onNeedsYou) await onNeedsYou(run, reason).catch((error) => console.error("rig agent needs you:", (error as Error).message));
  return stop({ state: (await getRun(db(), run.id))?.state ?? "needs_you", more: false });
}

/**
 * A step waits for a person, with the reason. One whose wait holds only its shot (waitScope) lets
 * the run carry on with the others; any other holds the run.
 */
export async function pause(run: RunRow, step: StepRow, reason: string, kind: PauseKind, from: readonly RigAgentStepState[]): Promise<Moved> {
  if (!(await patchStep(db(), step.id, { state: "paused", reason, pause: kind }, from))) return CONTINUE;
  return waitScope(kind) === "shot" ? CONTINUE : needsYou(run, reason);
}

export async function wakeIn(run: RunRow, ms: number, tick: PaidTick): Promise<Moved> {
  await patchRun(db(), run.id, { wake_at: now() + ms }, ["running"]);
  return stop(tick);
}

/* ── The run's limit and the balance, before anything is approved or sent ── */

/** Why this job does not fit under the run's limit now, or null. The reservation checks it again under its write lock. */
export async function limitProblem(run: Pick<RunRow, "id" | "capCredits">, quote: number, band: number, what = "render"): Promise<string | null> {
  if (run.capCredits == null) return "This run has no approved limit, so nothing in it is paid.";
  const tally = runTally(await runCharges(run.id));
  const verdict = runLimitVerdict({ limitTenths: toTenths(run.capCredits), tally, jobTenths: toTenths(quote), band });
  if (verdict.ok) return null;
  const could = band > 1 ? ` and may settle at up to ${figure(quote * band)}` : "";
  return `The next ${what} is about ${figure(quote)}${could}; this run's limit of ${figure(run.capCredits)} leaves about ${figure(fromTenths(verdict.leftTenths))}. Raise the limit, skip this ${what}, or stop.`;
}

/** Why the balance cannot pay `credits` now (credit workspaces), or null. The reservation's own wall decides in the end. */
export async function creditsShort(credits: number, what = "render"): Promise<string | null> {
  const state = await creditState();
  if (!state || state.balance >= credits) return null;
  return `Not enough credits: the next ${what} is about ${figure(credits)} and ${figure(Math.max(0, state.balance))} are left. Top up, then press Retry.`;
}

/** What a reservation needs to count a job toward this run: refused when the run was stopped or switched off meanwhile. */
export function runSpend(run: RunRow, band: number, ctx: Pick<PaidContext, "enabled" | "offReason">): RunSpend {
  return {
    id: run.id, limitCredits: run.capCredits ?? 0, band,
    live: async () => {
      if (!ctx.enabled()) return ctx.offReason;
      const fresh = await getRun(db(), run.id);
      return fresh?.state === "running" ? null : "This run was stopped before this render was sent. Nothing was charged.";
    },
  };
}

/* ── Identity: every paid attempt's durable key ───────────────────────── */

/** A node id as a key part: itself when plain, else a digest of it. */
const nodeKey = (nodeId: string) => (/^[A-Za-z0-9._-]{1,64}$/.test(nodeId) ? nodeId : "n" + createHash("sha256").update(nodeId).digest("hex").slice(0, 16));

/** The plan's render of a shot: its durable request key, saved on its step before anything is sent. */
export function requestKeyFor(runId: string, nodeId: string, attempt: number): string {
  return `rig-agent:${runId}:${nodeKey(nodeId)}:take:${attempt}`;
}

/** A render again of a shot (a person's choice, round n): its own key per send attempt. */
export function retakeRequestKey(runId: string, nodeId: string, round: number, attempt: number): string {
  return `rig-agent:${runId}:${nodeKey(nodeId)}:take:${round}:${attempt}`;
}

/** A fix's durable request key, per send attempt: its shot, its round, and which attempt at sending it. */
export function fixRequestKey(runId: string, nodeId: string, round: number, attempt: number): string {
  return `rig-agent:${runId}:${nodeKey(nodeId)}:fix:${round}:${attempt}`;
}

/** The durable request key a paid step's attempt is sent under: a fix's own, a render again's own, or the plan's render's. */
export function stepRequestKey(runId: string, step: Pick<StepRow, "purpose" | "nodeId" | "round">, attempt: number): string {
  if (!step.nodeId) throw new Error("A paid step names its card.");
  if (step.purpose === "fix") {
    if (!step.round || step.round < 1) throw new Error("A fix step carries its round.");
    return fixRequestKey(runId, step.nodeId, step.round, attempt);
  }
  return step.round ? retakeRequestKey(runId, step.nodeId, step.round, attempt) : requestKeyFor(runId, step.nodeId, attempt);
}

/**
 * The request id a check's development job is started under (development request ids allow letters,
 * digits, `_` and `-` only): the run, its shot, which take it checks (0 for the plan's render, n for
 * round n) and the attempt. Saved on the check's step before its job is started, so a lost reply finds
 * the same job, which is checked and charged once.
 */
export function checkRequestId(runId: string, nodeId: string, round: number, attempt: number): string {
  const node = createHash("sha256").update(nodeId).digest("hex").slice(0, 12);
  return `rigv_${runId.replace(/^rar_/, "")}_${node}_${round}_${attempt}`;
}

/** The steps after the build that may spend: renders, checks of their takes, and fixes. */
export const PAID_PURPOSES = ["take", "verify", "fix"] as const;

/** How many times one render's request may be sent under new keys (each earlier one proven never admitted or refused unbilled). */
export const MAX_SEND_ATTEMPTS = 8;
/** How soon a render in flight is looked at again, when nothing wakes the run sooner. */
export const RENDER_CHECK_MS = 15_000;
/** How soon a request still being accepted, or whose reply was lost, is asked about again. */
export const PENDING_CHECK_MS = 5_000;
/** How soon a render refused for want of a free slot is tried again. */
export const SLOT_WAIT_MS = 30_000;
export const LIVE_JOB = new Set(["queued", "running", "held"]);
export const TERMINAL: readonly RigAgentStepState[] = ["done", "failed", "skipped"];
/** A render a stop let go of before it was sent (or that its reservation refused once the stop landed). */
export const STOPPED_UNSENT = "Stopped before it was sent. Nothing was charged.";

/**
 * What Auto sends without a tap, inside the run's limit and under the per-job line (plan §8): drafts of
 * the renders, and the checks of their takes (the owner's choice). A fix always waits for a tap with
 * its price, in Auto too, and so does a render at full quality.
 */
export const AUTO_PURPOSES: readonly string[] = ["take", "verify"];

/* ── Words and the ledger ──────────────────────────────────────────────── */

/** The shot a paid step is about, as the plan named it. */
export function stepTitle(run: Pick<RunRow, "plan">, step: Pick<StepRow, "nodeId" | "label">): string {
  return run.plan?.next.find((n) => n.id === step.nodeId)?.title
    ?? step.label.replace(/^(?:Check fix \d+ · |Fix \d+ · |Render again · |Check again · |Render |Check )/, "").replace(/ · priced$/, "").replace(/ against its masters$/, "");
}

/** What a paid step is, in words: "Fix 2 for <shot>", "<shot> again", or the shot. */
export function stepWhat(run: Pick<RunRow, "plan">, step: Pick<StepRow, "nodeId" | "label" | "purpose" | "round">): string {
  const title = stepTitle(run, step);
  if (step.purpose === "fix") return `${/^Fix (\d+)/.exec(step.label)?.[0] ?? "A fix"} for ${title}`;
  return step.purpose === "take" && step.round ? `${title} again` : title;
}

/** The take a check reads: its shot's latest render or fix before it. */
export function checkSubject(steps: readonly StepRow[], check: Pick<StepRow, "nodeId" | "seq">): StepRow | null {
  return [...steps].reverse().find((s) => (s.purpose === "take" || s.purpose === "fix") && s.nodeId === check.nodeId && s.seq < check.seq) ?? null;
}

/**
 * A render the run added for a shot — a fix, or a render again a person asked for — that the
 * provider did not render: never one of the fixes that count, never retried on its own; the shot
 * goes to a person. (A failed take of the plan's own render ends as it did: its check never runs.)
 */
export function failedRound(step: Pick<StepRow, "purpose" | "round" | "state"> | null): boolean {
  return !!step && (step.purpose === "fix" || step.purpose === "take") && step.round != null && step.state === "failed";
}

/** What the ledger shows for a job: its meter row (null: never reserved). */
export async function meterOf(jobId: string): Promise<{ status: string; credits: number } | null> {
  await platformReady();
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE workspace_id=? AND id=?", args: [requireTenant().id, jobId] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits ?? 0) } : null;
}

export async function jobOf(jobId: string): Promise<{ status: string; error: string | null } | null> {
  const row = (await db().execute({ sql: "SELECT status,error FROM generations WHERE id=?", args: [jobId] })).rows[0];
  return row ? { status: String(row.status), error: row.error == null ? null : String(row.error) } : null;
}
