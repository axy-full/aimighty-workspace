import { createHash } from "node:crypto";
import { TextNotSentError } from "@/lib/textDirect";
import { after } from "next/server";
import { db, now } from "@/lib/db";
import { EVENTS, RIG_AGENT_STOPPED, RIG_RENDER_SETTLED, type WorkerEvent } from "@/lib/dispatch";
import { engineMock } from "@/lib/mock";
import { getWorkspace, platformDb, platformReady } from "@/lib/platform";
import { withPipelineActor } from "@/lib/pipeline/actor";
import { PipelineError } from "@/lib/pipeline/schema";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireTenant, runInTenant, type TenantWorkspace } from "@/lib/tenant";
import { catalog, type CatalogModel } from "@/lib/catalog";
import { creditState, quotedCredits } from "@/lib/credits";
import { reserveGenerationSpend, runCharges, RUN_LIMIT_REACHED, SpendReservationError } from "@/lib/generationRequests";
import { languageAuth, languageModel } from "@/lib/language-provider";
import { meter } from "@/lib/meter";
import { isDirectText, textEngine } from "@/lib/openai-direct";
import { fromTenths, isRunLimitAmount, runTally, toTenths, type RunCharge } from "@/lib/runLimit";
import { applyCanvasOps } from "./canvas-ops";
import type { OpOutcome } from "./canvas-ops-model";
import { readDraft, workbenchTransaction } from "./records";
import { bindSampleLift } from "@/lib/demo/lift.server";
import { SAMPLE_LINE } from "@/lib/demo/sample";
import { sampleWorkspaceRefusal } from "@/lib/demo/spend-guard.server";
import {
  ACTIVE_STATES, PLAN_LIMITS, RIG_AGENT_MODES, boardSnapshot, compilePlan, creditFigure, planFingerprintText, proposalView, undoOps, wiresOf,
  type BoardSnapshot, type SnapshotAttachment, type RigAgentMode, type RigAgentMoneyView, type RigAgentPaidStepView, type RigAgentPlanView, type RigAgentRunView, type RigAgentState,
} from "./rig-agent-plan";
import {
  closePlanApproval, fixRoom, approvalClosed, insertPlanApproval, isPersonApprover, planApprovalOf, planQuote, recordFix,
  MAX_FIXES_PER_SHOT, PEOPLE_ONLY, THIRD_FIX, type PlanApprovalRow, type QuoteInputStep,
} from "./plan-approval";
import {
  mockPlannerModel, plannerCeilingUsd, plannerCostUsd, PlannerError, runPlanner, selectPlannerModel,
  MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL, NO_ATTACHMENT_CONTENT, PLANNER_TIMEOUT_MS, type PlannerAttachmentContent, type PlannerOutcome,
} from "./rig-agent-planner";
import { attachedOf, loadPlanAttachmentContent, PlanAttachmentError, resolvePlanAttachments, type AttachmentReaders, type PlanAttachment } from "./rig-agent-attachments";
import { effectiveJobCeiling, rigJobCeiling, suggestedRunLimit } from "./rig-agent-limits";
import { advancePaidSteps, closeEndedSteps, MAX_SEND_ATTEMPTS, RIG_AGENT_VERIFY, stepTitle, STOPPED_UNSENT, VERIFY_LATER, type PaidDeps } from "./rig-agent-runs";
import {
  activeRun, attemptStep, claimRun, dueRuns, finishStep, getRun, getStep, insertFixStep, insertRun, insertSteps, latestRun, looseCharges, looseSteps, newRunId, patchRun,
  patchStep, releaseRun, renewRun, rigAgentExists, rigAgentReady, runByRequest, runCanvasChanges, runOfProduction, setSteps, stepOpId, stepsOf, undoOpId,
  type LimitRecord, type RunLease, type RunRow, type StepRow,
} from "./rig-agent-store";
import { orderedIds } from "./team-canvas-model";
import { newProject, type Asset, type CanvasNode, type Project } from "./studio";
import { readTeamCanvas, requireProduction } from "./team-canvas";

/*
 * Atomik builds the board (plan §6, PR 9). A person asks; Atomik plans with
 * dry tools and proposes cards and wires; the person approves; the build is
 * applied step by step through applyCanvasOps with the run as author, so every
 * open window sees the cards arrive, and it can be undone.
 *
 * The state lives in the database (lib/workbench/rig-agent-store.ts). A tick
 * (advanceRigAgentRun) moves one run a bounded amount under its lease, and is
 * woken by Inngest (`rig-agent`, lib/workers.ts), the native worker route, this
 * request's after() when there is no queue, or the cron. Every tick checks the
 * kill switch and that the person who asked still belongs to the workspace.
 *
 * Money (plan §5.5, §8; PR 10). Before a run spends anything, the person who
 * asks approves a limit for it ("up to about N credits for this run") and a
 * mode: Ask (the default: every render waits for their tap) or Auto (a draft
 * priced at or under the per-job line runs on its own; anything else asks).
 * The planning turn is metered into that limit — reserved at its ceiling,
 * settled at what it used. Placing cards, wiring and tidying stay free. After
 * the build, the renders the plan names run as paid steps inside the limit
 * (lib/workbench/rig-agent-runs.ts), each reserved with the run's id so the
 * reservation itself refuses a job that would pass the limit.
 */

export class RigAgentError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "RigAgentError"; }
}

export const RIG_AGENT_OFF = "Atomik's board building is switched off right now.";
const LEASE_MS = 60_000;
const TICK_BUDGET_MS = 40_000;
/** A pause between steps, so the team sees the board come together batch by batch. */
const PACE_MS = 600;
const STEP_ATTEMPTS = 3;
const PAUSED_WAKE_MS = 60_000;
/** A planning turn is a model call (metered into the run's limit): one person asks for at most this many boards an hour. */
export const PLANS_PER_HOUR = 20;

/**
 * The kill switch. RIG_AGENT_ENABLED=1 turns Atomik's board building on, =0
 * off. Unset, it is off in production until the owner says go, and on in
 * development and tests. Off: no new request or approval, and a build in
 * progress pauses before its next step. Stopping and undoing still work.
 */
export function rigAgentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.RIG_AGENT_ENABLED?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return env.NODE_ENV !== "production";
}

const agentAuthor = (runId: string) => `agent:${runId}`;

/* ── What the run card shows ──────────────────────────────────────────── */

const distinct = (items: string[]) => [...new Set(items)];

/** The ledger's view of a run: every charge that named it (planning, renders), and the per-job line now. */
export type RunLedger = { charges: (RunCharge & { id: string; status: string })[]; ceiling: number | null };
const NO_LEDGER: RunLedger = { charges: [], ceiling: null };

/** The planning turn's meter event: one per run. */
export const planEventId = (runId: string) => `rigplan_${runId.replace(/^rar_/, "")}`;

/** A render step as the plan's quote reads it. */
function quoteStep(run: RunRow, s: StepRow): QuoteInputStep {
  return {
    seq: s.seq, nodeId: s.nodeId, title: stepTitle(run, s), state: s.state, fixOf: s.fixOf, pause: s.pause, reason: s.reason,
    /* A render that needs an admin carries its own price with no admission: shown, never in the plan's total. */
    quote: s.quoteCredits,
    worst: s.quoteCredits != null ? fromTenths(toTenths(s.quoteCredits) * Math.max(1, s.band ?? 1)) : null,
    fingerprint: s.admission ? s.admission.quote.fingerprint : null,
  };
}

/** The plan's one approval as the card shows it: the server's quote before it, its record after. */
function planView(run: RunRow, steps: StepRow[], viewer: string, ledger: RunLedger, approval: PlanApprovalRow | null, jobLine: number): RigAgentPlanView | null {
  const takes = steps.filter((s) => s.purpose === "take");
  if (!takes.length) return null;
  if (approval) {
    const used = runTally(ledger.charges.filter((c) => c.id !== planEventId(run.id)));
    const closed = approvalClosed(approval, now());
    return {
      quote: null, blocked: null,
      approval: {
        mine: approval.approvedBy === viewer, at: approval.approvedAt, expiresAt: approval.expiresAt,
        total: fromTenths(approval.totalTenths), ceiling: fromTenths(approval.ceilingTenths),
        /* A render that may settle above its quote keeps the total "up to" (review L3). */
        approximate: approval.steps.some((s) => toTenths(s.worst) > toTenths(s.quote)),
        used: fromTenths(used.settledTenths + used.heldTenths),
        fixes: Object.fromEntries(Object.entries(approval.fixes).map(([shot, list]) => [shot, list.length])), maxFixes: MAX_FIXES_PER_SHOT,
        open: !closed, closedReason: closed,
      },
    };
  }
  /* Only once the build is done and the run is at its renders: before that, shots may not exist to price. */
  if (!["running", "needs_you", "paused"].includes(run.state)) return { quote: null, blocked: null, approval: null };
  const quote = planQuote(takes.map((s) => quoteStep(run, s)), jobLine);
  if (!quote.ready) return { quote: null, blocked: takes.some((s) => s.state === "waiting" || s.state === "paused") ? quote.reason : null, approval: null };
  return {
    quote: { total: quote.total, ceiling: quote.ceiling, approximate: quote.approximate, fingerprint: quote.fingerprint, covered: quote.steps.map((s) => s.seq), asks: quote.asks.map((a) => a.seq) },
    blocked: null, approval: null,
  };
}

export function runView(run: RunRow, steps: StepRow[], viewer: string, ledger: RunLedger = NO_LEDGER, approval: PlanApprovalRow | null = null): RigAgentRunView {
  const done = steps.filter((s) => s.state === "done" && s.purpose === "build");
  const outcomes = (step: StepRow): OpOutcome[] => step.result ?? [];
  const cards = done.filter((s) => s.tool === "create").flatMap(outcomes).filter((o) => o.kind === "create" && !o.held).reduce((n, o) => n + o.nodeIds.length, 0);
  const wires = done.filter((s) => s.tool === "wire").flatMap(outcomes).filter((o) => o.kind === "wire" && o.nodeIds.length).length;
  const held = distinct(done.flatMap(outcomes).map((o) => o.held).filter((h): h is string => !!h));
  const tally = runTally(ledger.charges);
  const byId = new Map(ledger.charges.map((c) => [c.id, c]));
  const planning = byId.get(planEventId(run.id));
  const money: RigAgentMoneyView | null = run.capCredits == null ? null : {
    mode: run.mode,
    limit: run.capCredits,
    jobCeiling: effectiveJobCeiling(run.perJobCap, ledger.ceiling ?? run.perJobCap ?? 0),
    spent: fromTenths(tally.settledTenths),
    inFlight: fromTenths(tally.heldTenths),
    left: fromTenths(Math.max(0, toTenths(run.capCredits) - tally.settledTenths - tally.worstTenths)),
    planning: run.planCharge ? { state: run.planCharge, credits: planning ? planning.credits : null } : null,
  };
  const mine = run.owner === viewer;
  const asking = run.state === "needs_you" || run.state === "running";
  const paid: RigAgentPaidStepView[] = steps.filter((s) => s.purpose === "take" || s.purpose === "verify").map((s) => {
    const title = s.fixOf != null ? `Fix · ${stepTitle(run, s)}` : stepTitle(run, s);
    if (s.purpose === "verify")
      return { seq: s.seq, nodeId: s.nodeId, tool: "verify", title, state: s.state, quote: null, worst: null, pause: null, charged: s.creditsSettled, outcome: null, charge: null,
        reason: RIG_AGENT_VERIFY ? s.reason : VERIFY_LATER, canRender: false, fingerprint: null };
    const charge = s.jobId ? byId.get(s.jobId) : undefined;
    const ended = s.state === "done" || s.state === "failed";
    const charged = !ended ? null : charge ? (charge.running ? null : charge.credits) : s.creditsSettled;
    const outcome = s.state !== "failed" ? null : charge ? (charge.running ? "unknown" : charge.credits > 0 ? "charged" : "not_billed") : s.outcome ?? "unknown";
    const ledger = s.state !== "failed" ? null
      : charge ? { credits: charge.credits, settled: !charge.running }
      : s.creditsSettled != null ? { credits: s.creditsSettled, settled: true } : null;
    const open = s.state === "waiting" || s.state === "paused";
    return {
      seq: s.seq, nodeId: s.nodeId, tool: "render", title, state: s.state, quote: s.quoteCredits,
      worst: s.quoteCredits == null ? null : fromTenths(toTenths(s.quoteCredits) * Math.max(1, s.band ?? 1)),
      pause: s.state === "paused" ? s.pause : null, charged, outcome, charge: ledger, reason: s.reason,
      canRender: mine && open && asking, fingerprint: open && s.admission ? s.admission.quote.fingerprint : null,
      fixOf: s.fixOf, inPlan: !!s.approvalId,
    };
  });
  const jobLine = effectiveJobCeiling(run.perJobCap, ledger.ceiling ?? run.perJobCap ?? 0);
  return {
    id: run.id, state: run.state, reason: run.reason, goal: run.goal, mine,
    proposal: run.plan && run.fingerprint ? proposalView(run.plan, run.fingerprint, money) : null,
    steps: steps.filter((s) => s.purpose !== "take" && s.purpose !== "verify").map((s) => ({ seq: s.seq, label: s.label, state: s.state, held: distinct(outcomes(s).map((o) => o.held).filter((h): h is string => !!h)) })),
    built: { cards, wires },
    held,
    undo: run.undo,
    canUndo: !!run.approvedAt && !run.undoneAt && done.length > 0,
    credits: money?.spent ?? 0,
    money,
    paid,
    plan: planView(run, steps, viewer, ledger, approval, jobLine),
    at: run.updatedAt,
  };
}

/** What the ledger holds for a run (read-only). A read that fails shows the run without it rather than failing the card. */
async function ledgerOf(run: RunRow): Promise<RunLedger> {
  const [charges, ceiling] = await Promise.all([
    run.capCredits == null ? Promise.resolve([]) : runCharges(run.id).catch(() => []),
    rigJobCeiling().catch(() => null),
  ]);
  return { charges, ceiling };
}

async function viewOf(runId: string, viewer: string): Promise<RigAgentRunView> {
  const run = await getRun(db(), runId);
  if (!run) throw new RigAgentError("That build is not on this production.", 404);
  return runView(run, await stepsOf(db(), runId), viewer, await ledgerOf(run), await planApprovalOf(db(), runId));
}

/**
 * The plan gate's quote for a run on this production, exactly as the plan card shows it (its total and its "at most"),
 * or null when the run is not at the gate. Read-only: the budget read sets it against the production's budget.
 */
export async function planGateQuote(productionId: string, runId: string): Promise<{ total: number; ceiling: number } | null> {
  if (!(await rigAgentExists())) return null;
  const run = await runOfProduction(db(), productionId, runId);
  if (!run) return null;
  const ledger = await ledgerOf(run);
  const view = planView(run, await stepsOf(db(), run.id), "", ledger, await planApprovalOf(db(), run.id), effectiveJobCeiling(run.perJobCap, ledger.ceiling ?? run.perJobCap ?? 0));
  return view?.quote ? { total: view.quote.total, ceiling: view.quote.ceiling } : null;
}

/** What asking costs, for the ask form: the suggested limit, the per-job line, and the planning turn's approximate ceiling. */
export type RigAgentAskTerms = { limit: number; jobCeiling: number; planning: number | null };

/**
 * The run card's read: the switch, and the newest run on this production (with what the viewer may
 * do). With the viewer's project (draftId) and no run in progress, also what asking would cost. A
 * run in progress whose wake is due is nudged, so a board open in a browser keeps it moving.
 */
export async function rigAgentState(productionId: string, viewer: string, draftId?: string | null, attachments: readonly string[] = []): Promise<{ enabled: boolean; run: RigAgentRunView | null; ask: RigAgentAskTerms | null }> {
  await requireProduction(productionId);
  const enabled = rigAgentEnabled();
  /* Files the ask would attach are priced in: checked here as the ask checks them (an unknown or foreign one is refused). */
  const attached = attachments.length ? attachedOf(await checkedAttachments(productionId, attachments)) : [];
  const run = (await rigAgentExists()) ? await latestRun(db(), productionId) : null;
  const busy = !!run && ACTIVE_STATES.includes(run.state);
  const ask = enabled && draftId && !busy ? await askTerms(productionId, draftId, viewer, attached).catch(() => null) : null;
  if (!run) return { enabled, run: null, ask };
  await nudge(run).catch(() => {});
  return { enabled, run: runView(run, await stepsOf(db(), run.id), viewer, await ledgerOf(run), await planApprovalOf(db(), run.id)), ask };
}

async function askTerms(productionId: string, draftId: string, viewer: string, attached: readonly SnapshotAttachment[] = []): Promise<RigAgentAskTerms> {
  const [limit, jobCeiling] = await Promise.all([suggestedRunLimit(), rigJobCeiling()]);
  let planning: number | null = null;
  const draft = await readDraft(viewer, draftId);
  if (draft && draft.project.productionProjectId === productionId) {
    const saved = await readTeamCanvas(productionId);
    const nodes = saved ? orderedIds(saved.canvas).map((id) => saved.canvas.nodes[id]) : draft.project.nodes;
    planning = await planningCredits(draft.project, { nodes, assets: saved ? Object.values(saved.canvas.assets) : [] }, attached);
  }
  return { limit, jobCeiling, planning };
}

/**
 * Planning's approximate ceiling for a board, in credits; null when the planner's price can't be read. The same
 * estimator the charge reserves at (plannerCeilingUsd over boardSnapshot), with the same attached files.
 */
async function planningCredits(project: Project, canvas: { nodes: CanvasNode[]; assets: Asset[] }, attached: readonly SnapshotAttachment[] = []): Promise<number | null> {
  /* The request at its longest, so the figure holds whatever is typed. */
  const snapshot = boardSnapshot(project, canvas, "x".repeat(PLAN_LIMITS.goal), attached);
  const price = await plannerPrice("auto").catch(() => null);
  const usd = price ? plannerCeilingUsd(price.catalog, snapshot, price.direct) : null;
  return usd == null ? null : quotedCredits(usd, "text");
}

/**
 * What asking would cost on a new, empty board: Home's "Start · up to N cr", shown before its project
 * exists. The same figures askTerms gives a saved empty project. It reads prices only: nothing is
 * reserved, asked or written, and asking still goes through `askRigAgent` with its own checks.
 */
export async function newBoardAskTerms(): Promise<{ enabled: boolean; run: null; ask: RigAgentAskTerms | null }> {
  const enabled = rigAgentEnabled();
  if (!enabled) return { enabled, run: null, ask: null };
  const [limit, jobCeiling, planning] = await Promise.all([suggestedRunLimit(), rigJobCeiling(), planningCredits(newProject(""), { nodes: [], assets: [] })]);
  return { enabled, run: null, ask: { limit, jobCeiling, planning } };
}

/** A running run whose wake is due and that nobody holds: one reader claims the wake and dispatches a tick. */
const NUDGE_MS = 10_000;
async function nudge(run: RunRow) {
  const at = now();
  if (run.state !== "running" || run.wakeAt == null || run.wakeAt > at || run.leaseUntil > at) return;
  const claimed = await db().execute({
    sql: "UPDATE rig_agent_runs SET wake_at=? WHERE id=? AND state='running' AND wake_at IS NOT NULL AND wake_at<=? AND lease_until<=?",
    args: [at + NUDGE_MS, run.id, at, at],
  });
  if (claimed.rowsAffected) await dispatchRigAgent(run, `nudge-${at}`);
}

/* ── A person's requests ──────────────────────────────────────────────── */

/** The most a person may approve for one run, in credits. */
export const MAX_RUN_LIMIT = 1_000_000;

/** The files an ask attaches, checked against this production's Library in the caller's workspace; a refusal is the ask's (400). */
async function checkedAttachments(productionId: string, ids: readonly string[]): Promise<PlanAttachment[]> {
  try { return await resolvePlanAttachments(productionId, ids); }
  catch (error) { throw error instanceof PlanAttachmentError ? new RigAgentError(error.message, error.status) : error; }
}

/**
 * Ask Atomik to build: a run in `planning`, planned by the next tick. Asking
 * again with the same request id answers the same run. A proposal nobody
 * approved yet is replaced; a build in progress must finish or be stopped first.
 *
 * Asking is where the person approves the run's limit ("up to about N credits
 * for this run") and its mode: nothing in the run — the planning turn first —
 * spends beyond it, and in Ask mode every render waits for their tap.
 */
export async function askRigAgent(input: { productionId: string; draftId: string; userId: string; requestId: string; goal: string; model?: string; limit: number; mode?: RigAgentMode; attachments?: readonly string[] }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  if (!isRunLimitAmount(input.limit, MAX_RUN_LIMIT)) throw new RigAgentError("Set a limit for this run: a number of credits, in tenths at most.", 400);
  const mode: RigAgentMode = input.mode ?? "ask";
  if (!RIG_AGENT_MODES.includes(mode)) throw new RigAgentError("Choose Ask or Auto.", 400);
  await requireProduction(input.productionId);
  const draft = await readDraft(input.userId, input.draftId);
  if (!draft) throw new RigAgentError("Open this project's Rig first.", 404);
  if (draft.project.productionProjectId !== input.productionId) throw new RigAgentError("This project is not saved to that production.", 409);
  /* The files attached to the ask: each must be filed in this production's Library, in this workspace. */
  const attachments = (await checkedAttachments(input.productionId, input.attachments ?? [])).map((a) => a.id);
  await rigAgentReady();
  /* The per-job line in force as the limit is approved: Auto never goes above it (nor above the line of the day). */
  const jobCeiling = await rigJobCeiling();
  /* The sample workspace refuses every ask (lib/demo/spend-guard.server.ts) save the one its mark is lifted for: the
     run this ask makes becomes the one run the lift covers, in this same write, or nothing is written. */
  const sampleMarked = (await sampleWorkspaceRefusal()) !== null;
  /* The lift is for one APPROVED run (owner, 7 Oct): under it every render waits for a person's tap or the plan's one
     Approve. Auto is never taken from the client there, whatever it sent. */
  const runMode: RigAgentMode = sampleMarked ? "ask" : mode;
  const at = now();
  const run = await workbenchTransaction(async (tx) => {
    const again = await runByRequest(tx, input.userId, input.requestId);
    if (again) {
      if (again.productionId !== input.productionId) throw new RigAgentError("That request was for another production.", 409);
      return again;
    }
    const recent = Number((await tx.execute({ sql: "SELECT COUNT(*) AS n FROM rig_agent_runs WHERE owner=? AND created_at>?", args: [input.userId, at - 3_600_000] })).rows[0].n);
    if (recent >= PLANS_PER_HOUR) throw new RigAgentError(`You have asked Atomik for ${PLANS_PER_HOUR} boards in the last hour. Try again in a little while.`, 429);
    const active = await activeRun(tx, input.productionId);
    if (active) {
      if (active.state !== "awaiting_approval") throw new RigAgentError("Atomik is already working on this board. Stop that build, or wait for it to finish.", 409);
      await patchRun(tx, active.id, { state: "stopped", reason: "A newer request replaced this proposal.", finished_at: at, wake_at: null }, ["awaiting_approval"]);
      await setSteps(tx, active.id, "proposed", "skipped");
    }
    const id = newRunId();
    await insertRun(tx, {
      id, productionId: input.productionId, draftId: input.draftId, owner: input.userId, requestId: input.requestId, goal: input.goal.trim(), model: input.model ?? "auto", at,
      limit: { credits: input.limit, mode: runMode, jobCeiling }, attachments,
    });
    if (sampleMarked && !(await bindSampleLift(tx, { userId: input.userId, runId: id, productionId: input.productionId, at })))
      throw new RigAgentError(SAMPLE_LINE, 409);
    return (await getRun(tx, id))!;
  });
  if (run.state === "planning") await dispatchRigAgent(run, "plan");
  return viewOf(run.id, input.userId);
}

async function runFor(productionId: string, runId: string): Promise<RunRow> {
  await requireProduction(productionId);
  if (!(await rigAgentExists())) throw new RigAgentError("That build is not on this production.", 404);
  const run = await runOfProduction(db(), productionId, runId);
  if (!run) throw new RigAgentError("That build is not on this production.", 404);
  return run;
}

/** Approve the proposal as shown (its fingerprint): the build starts. Only the person who asked approves it. */
export async function approveRigAgent(input: { productionId: string; runId: string; fingerprint: string; userId: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this board can approve it.", 403);
  const started = await workbenchTransaction(async (tx) => {
    const run = (await getRun(tx, input.runId))!;
    /* The reply to an approval that landed was lost: the same answer, and nothing is applied twice. */
    if (run.approvedAt && run.approvedBy === input.userId && run.fingerprint === input.fingerprint) return false;
    if (run.state !== "awaiting_approval") throw new RigAgentError("This proposal is no longer waiting for approval.", 409);
    if (run.fingerprint !== input.fingerprint) throw new RigAgentError("This proposal changed. Look at it again before building.", 409);
    const at = now();
    await patchRun(tx, run.id, { state: "running", approved_at: at, approved_by: input.userId, wake_at: at }, ["awaiting_approval"]);
    await setSteps(tx, run.id, "proposed", "queued");
    return true;
  });
  if (started) await dispatchRigAgent(found, "build");
  return viewOf(input.runId, input.userId);
}

/** Not now: the proposal is set aside and nothing is built. Only the person who asked declines it. */
export async function declineRigAgent(input: { productionId: string; runId: string; userId: string }): Promise<RigAgentRunView> {
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this board can set it aside.", 403);
  await workbenchTransaction(async (tx) => {
    const changed = await patchRun(tx, found.id, { state: "stopped", reason: "Not built: set aside.", finished_at: now(), wake_at: null }, ["awaiting_approval", "planning"]);
    if (changed) await setSteps(tx, found.id, "proposed", "skipped");
  });
  return viewOf(input.runId, input.userId);
}

/** Stop a build (anyone on the team): what is on the board stays, and can be undone. */
export async function stopRigAgent(input: { productionId: string; runId: string; userId: string }): Promise<RigAgentRunView> {
  const found = await runFor(input.productionId, input.runId);
  await stopRun(found.id, "Stopped before it finished.");
  return viewOf(input.runId, input.userId);
}

/** Paid work not sent yet is let go: nothing was reserved for it, and nothing will be. */
async function closePaidSteps(tx: Parameters<typeof setSteps>[0], runId: string, reason: string) {
  await tx.execute({
    sql: "UPDATE rig_agent_steps SET state='skipped',reason=?,updated_at=? WHERE run_id=? AND purpose='take' AND state IN ('next','waiting','approved','paused')",
    args: [reason, now(), runId],
  });
}

async function stopRun(runId: string, reason: string) {
  const changed = await workbenchTransaction(async (tx) => {
    const stopped = await patchRun(tx, runId, { state: "stopped", reason, finished_at: now(), wake_at: null }, ["planning", "awaiting_approval", "running", "paused", "needs_you"]);
    if (stopped) {
      await setSteps(tx, runId, "queued", "skipped"); await setSteps(tx, runId, "proposed", "skipped");
      await closePaidSteps(tx, runId, STOPPED_UNSENT);
      /* Nothing more is drawn on the plan's approval: renders already sent settle at what they cost. */
      await closePlanApproval(tx, runId, "Stopped: nothing more is spent under this plan.", now());
    }
    return stopped;
  });
  if (changed) {
    await settleLooseWork(runId).catch((error) => console.error("rig agent stop:", (error as Error).message));
    await cancelQueued(runId);
  }
}

/**
 * After a stop, what the run left mid-way is settled — unless a worker still holds the run, in
 * which case it finishes its one step and records it itself:
 *  - a render whose key was saved but whose reply was never recorded is asked about by that key
 *    (closeEndedSteps): it landed (followed to its end, and charged only as it settles), or it never
 *    arrived (its key is fenced now, so it never will, and nothing was charged); one still being
 *    accepted is asked about again by the cron;
 *  - a planning charge still reserved is released: the worker that held it is gone.
 * Renders already in flight finish and settle at what they cost.
 */
async function settleLooseWork(runId: string) {
  const lease = await claimRun(runId, LEASE_MS);
  if (!lease) return;
  try {
    const run = await getRun(db(), runId);
    if (!run) return;
    await closeEndedSteps(run);
    if (run.planCharge === "reserved") await releasePlanning(run, null);
  } finally {
    await releaseRun(lease);
  }
}

/* ── The paid steps: a person approves, skips, or raises the limit ────── */

async function paidStepFor(runId: string, seq: number, tx: Parameters<typeof getStep>[0]): Promise<StepRow> {
  const step = await getStep(tx, runId, seq);
  if (!step || step.purpose !== "take") throw new RigAgentError("That render is not in this run.", 404);
  return step;
}

/**
 * Render a paid step (the person who asked): its approval at the price the card shows (its
 * fingerprint) — "Render", or "Retry" on one that paused — or "Price again" on one whose price is
 * unknown or moved, which is priced afresh and, in Ask mode, waits for another tap at the new price.
 * The run's limit and the balance are checked again before anything is sent. A lost reply to a tap
 * that landed answers the same, and approves nothing twice.
 */
export async function renderRigAgentStep(input: { productionId: string; runId: string; seq: number; fingerprint?: string | null; userId: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this run can approve its renders.", 403);
  const moved = await workbenchTransaction(async (tx) => {
    const step = await paidStepFor(found.id, input.seq, tx);
    const run = (await getRun(tx, found.id))!;
    const fingerprint = input.fingerprint ?? null;
    /* The reply to a tap that landed was lost: the same answer. */
    if (fingerprint && step.approvedFingerprint === fingerprint && step.approvedBy === input.userId && !["waiting", "paused"].includes(step.state)) return false;
    if (run.state !== "needs_you" && run.state !== "running") throw new RigAgentError("This run is not waiting for a render.", 409);
    const at = now();
    if (step.state === "waiting") {
      if (!fingerprint || !step.admission || fingerprint !== step.admission.quote.fingerprint)
        throw new RigAgentError("This render's price changed. Look at it again before approving it.", 409);
      /* A person's own tap: its own approval, not the plan's. */
      await patchStep(tx, step.id, { approved_at: at, approved_by: input.userId, approved_fingerprint: fingerprint, approval_id: null, reason: null }, ["waiting"]);
    } else if (step.state === "paused") {
      const same = !!fingerprint && !!step.admission && fingerprint === step.admission.quote.fingerprint;
      const approval = same ? { approved_at: at, approved_by: input.userId, approved_fingerprint: fingerprint, approval_id: null } : {};
      /* Retry: its checks run again at the same price; Price again: it is priced afresh. */
      await patchStep(tx, step.id, step.admission && step.pause !== "unpriced" && step.pause !== "record"
        ? { state: "waiting", reason: null, pause: null, ...approval }
        : { state: "next", admission: null, quote_credits: null, reason: null, pause: null }, ["paused"]);
    } else throw new RigAgentError("That render is not waiting for you.", 409);
    await patchRun(tx, run.id, { state: "running", reason: null, wake_at: at }, ["needs_you", "running"]);
    return true;
  });
  if (moved) await dispatchRigAgent(found, `render-${input.seq}-${now()}`);
  return viewOf(found.id, input.userId);
}

/** Skip a render that waits (the person who asked): it is not sent, nothing is charged, and the run carries on. */
export async function skipRigAgentStep(input: { productionId: string; runId: string; seq: number; userId: string }): Promise<RigAgentRunView> {
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this run can skip its renders.", 403);
  const moved = await workbenchTransaction(async (tx) => {
    const step = await paidStepFor(found.id, input.seq, tx);
    if (step.state === "skipped") return false;
    if (!(await patchStep(tx, step.id, { state: "skipped", reason: "Skipped. Nothing was charged." }, ["next", "waiting", "approved", "paused"])))
      throw new RigAgentError("That render is already on its way.", 409);
    await patchRun(tx, found.id, { state: "running", reason: null, wake_at: now() }, ["needs_you"]);
    return true;
  });
  if (moved && rigAgentEnabled()) await dispatchRigAgent(found, `skip-${input.seq}-${now()}`);
  return viewOf(found.id, input.userId);
}

/**
 * Raise the run's limit (the person who asked; never lowered here — Stop ends a run): recorded
 * with who and when, and a render that paused at the limit is checked again.
 */
export async function raiseRigAgentLimit(input: { productionId: string; runId: string; limit: number; userId: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  if (!isRunLimitAmount(input.limit, MAX_RUN_LIMIT)) throw new RigAgentError("Set a limit for this run: a number of credits, in tenths at most.", 400);
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this run can raise its limit.", 403);
  const moved = await workbenchTransaction(async (tx) => {
    const run = (await getRun(tx, found.id))!;
    /* The reply to a raise that landed was lost: the same answer. */
    if (run.capCredits != null && toTenths(run.capCredits) === toTenths(input.limit)) return false;
    if (!ACTIVE_STATES.includes(run.state)) throw new RigAgentError("This run has ended. Ask again for a new one.", 409);
    if (run.capCredits == null || toTenths(input.limit) <= toTenths(run.capCredits)) throw new RigAgentError(`A new limit must be above this run's ${creditFigure(run.capCredits ?? 0)} cr.`, 409);
    const at = now();
    const record: LimitRecord = { credits: input.limit, mode: run.mode, jobCeiling: run.perJobCap ?? 0, by: input.userId, at };
    await patchRun(tx, run.id, { cap_credits: input.limit, limits: [...run.limits, record] });
    await tx.execute({ sql: "UPDATE rig_agent_steps SET state='waiting',pause=NULL,reason=NULL,updated_at=? WHERE run_id=? AND state='paused' AND pause='limit'", args: [at, run.id] });
    await patchRun(tx, run.id, { state: "running", reason: null, wake_at: at }, ["needs_you"]);
    return true;
  });
  if (moved) await dispatchRigAgent(found, `limit-${now()}`);
  return viewOf(found.id, input.userId);
}

/**
 * Approve the plan once (CLAUDE.md rule 14): the person who asked approves every render the plan lists, each at
 * the server's price shown (the quote's fingerprint), plus at most two fixes per shot, up to the plan's ceiling
 * (lib/workbench/plan-approval.ts). Refused for anyone but that person, and for any agent, MCP caller or token.
 * The balance is checked against the total first ("Short by N cr"). The run's limit becomes what it already used
 * plus the ceiling, so the reservation enforces the total under its write lock; renders paused at the old limit
 * or the balance are checked again. A lost reply answers the same, and approves nothing twice.
 */
export async function approveRigAgentPlan(input: { productionId: string; runId: string; fingerprint: string; userId: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  if (!isPersonApprover(input.userId)) throw new RigAgentError(PEOPLE_ONLY, 403);
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this plan can approve it.", 403);
  await rigAgentReady();
  const line = effectiveJobCeiling(found.perJobCap, await rigJobCeiling());
  const [credits, charges] = await Promise.all([creditState(), runCharges(found.id)]);
  const moved = await workbenchTransaction(async (tx) => {
    const run = (await getRun(tx, found.id))!;
    const existing = await planApprovalOf(tx, run.id);
    if (existing) {
      if (existing.approvedBy === input.userId && existing.fingerprint === input.fingerprint) return false;
      throw new RigAgentError("This plan was already approved once. Anything more asks at its own price.", 409);
    }
    if (run.state !== "needs_you" && run.state !== "running") throw new RigAgentError("This plan is not waiting for approval.", 409);
    const quote = planQuote((await stepsOf(tx, run.id)).filter((s) => s.purpose === "take").map((s) => quoteStep(run, s)), line);
    if (!quote.ready) throw new RigAgentError(quote.reason, 409);
    if (quote.fingerprint !== input.fingerprint) throw new RigAgentError("The plan's prices changed. Look at it again before approving.", 409);
    /* The balance against the plan's total, before it starts (rule 14); every hold checks it again. */
    if (credits && toTenths(credits.balance) < quote.totalTenths)
      throw new RigAgentError(`Short by ${creditFigure(fromTenths(quote.totalTenths - toTenths(credits.balance)))} cr. Top up, then approve. Nothing is spent until you do.`, 402);
    /* The design's limit (review L1): what Atomik's planning used, plus the plan's ceiling, so the run never spends past the
       plan's stated "at most". A render tapped on its own before this draws on the same room; it is never added to it. */
    const planning = runTally(charges.filter((c) => c.id === planEventId(run.id)));
    const limit = fromTenths(planning.settledTenths + planning.worstTenths + quote.ceilingTenths);
    const at = now();
    await insertPlanApproval(tx, { runId: run.id, productionId: run.productionId, approvedBy: input.userId, at, quote, limitCredits: limit });
    const record: LimitRecord = { credits: limit, mode: run.mode, jobCeiling: run.perJobCap ?? 0, by: input.userId, at };
    await patchRun(tx, run.id, { cap_credits: limit, limits: [...run.limits, record] });
    await tx.execute({ sql: "UPDATE rig_agent_steps SET state='waiting',pause=NULL,reason=NULL,updated_at=? WHERE run_id=? AND purpose='take' AND state='paused' AND pause IN ('limit','credits')", args: [at, run.id] });
    await patchRun(tx, run.id, { state: "running", reason: null, wake_at: at }, ["needs_you", "running"]);
    return true;
  });
  if (moved) await dispatchRigAgent(found, `plan-${now()}`);
  return viewOf(found.id, input.userId);
}

/** What the ledger says of a failed render: confirmed not billed, charged, or not known yet. */
async function failedOutcome(runId: string, step: StepRow): Promise<"not_billed" | "charged" | "unknown"> {
  const charge = step.jobId ? (await runCharges(runId)).find((c) => c.id === step.jobId) : undefined;
  if (charge) return charge.running ? "unknown" : toTenths(charge.credits) === 0 ? "not_billed" : "charged";
  return step.outcome ?? "unknown";
}

export const RETRY_CHARGED = "This render was charged, so another one is a fix under the plan, or asks at its price.";
export const RETRY_UNKNOWN = "What this render was charged isn't known yet. Try again once it is.";

/**
 * Retry a render that failed with nothing billed (owner decision L4; CLAUDE.md rule 14): free, under the same
 * approval, at the same price. The step goes back to wait for its turn with its approval kept; when its turn comes
 * it is priced again from the board, and only the very price approved goes (a moved price asks). A new attempt is a
 * new request key. It is not a fix: the plan's fix count is unchanged, and it draws only the room its own price
 * already had (the failed attempt was charged nothing). A failure that was charged is not retried here.
 */
export async function retryRigAgentStep(input: { productionId: string; runId: string; seq: number; userId: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  if (!isPersonApprover(input.userId)) throw new RigAgentError(PEOPLE_ONLY, 403);
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this run can retry its renders.", 403);
  await rigAgentReady();
  const before = await paidStepFor(found.id, input.seq, db());
  if (before.state !== "failed") throw new RigAgentError("Only a render that failed is retried.", 409);
  const outcome = await failedOutcome(found.id, before);
  if (outcome === "charged") throw new RigAgentError(RETRY_CHARGED, 409);
  if (outcome === "unknown") throw new RigAgentError(RETRY_UNKNOWN, 409);
  const moved = await workbenchTransaction(async (tx) => {
    const step = await paidStepFor(found.id, input.seq, tx);
    if (step.state !== "failed" || step.jobId !== before.jobId) return false;
    if (!step.admission || !step.approvedFingerprint) throw new RigAgentError("This render has no approval to retry under. Render it at its price.", 409);
    if (step.approvalId) {
      const approval = await planApprovalOf(tx, found.id);
      const closed = !approval || approval.id !== step.approvalId ? "This plan's approval is no longer open." : approvalClosed(approval, now());
      if (closed) throw new RigAgentError(closed, 409);
    }
    if (step.attempt >= MAX_SEND_ATTEMPTS) throw new RigAgentError(`This render was tried ${MAX_SEND_ATTEMPTS} times. Render it again at its price.`, 409);
    const at = now();
    await patchStep(tx, step.id, {
      state: "waiting", job_id: null, request_key: null, credits_reserved: null, credits_settled: null, settled_at: null, outcome: null, reason: null, pause: null,
    }, ["failed"]);
    const run = (await getRun(tx, found.id))!;
    if (!["running", "needs_you", "done"].includes(run.state)) throw new RigAgentError("This run has ended. Ask again for a new plan.", 409);
    try {
      await patchRun(tx, run.id, { state: "running", reason: null, wake_at: at, finished_at: null }, ["running", "needs_you", "done"]);
    } catch {
      throw new RigAgentError("Another build is under way on this production. Stop it, or wait for it to finish.", 409);
    }
    return true;
  });
  if (moved) await dispatchRigAgent(found, `retry-${input.seq}-${now()}`);
  return viewOf(found.id, input.userId);
}

/**
 * A fix under the plan's approval (the person who asked; owner decision 3): one more render of a shot whose take
 * is back, drawn from the approval with no price question. At most two per shot; a third is refused and asks at
 * its own price elsewhere. The fix is priced when its turn comes and runs without a tap only when it costs no more
 * than its shot was approved at; the run's limit (the plan's ceiling) is enforced at the hold. Pressing again
 * while a fix of that shot is still on its way answers the same.
 */
export async function fixRigAgentShot(input: { productionId: string; runId: string; seq: number; userId: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  if (!isPersonApprover(input.userId)) throw new RigAgentError(PEOPLE_ONLY, 403);
  const found = await runFor(input.productionId, input.runId);
  if (found.owner !== input.userId) throw new RigAgentError("Only the person who asked Atomik for this plan can fix its shots.", 403);
  await rigAgentReady();
  /* A shot whose latest render failed with nothing billed is retried free, not fixed (owner decision L4). */
  {
    const all = await stepsOf(db(), found.id);
    const pressed = all.find((x) => x.seq === input.seq && x.purpose === "take");
    const shotSeq = pressed?.fixOf ?? pressed?.seq;
    const latest = all.filter((x) => x.purpose === "take" && (x.seq === shotSeq || x.fixOf === shotSeq)).at(-1);
    if (latest?.state === "failed" && (await failedOutcome(found.id, latest)) === "not_billed")
      return retryRigAgentStep({ ...input, seq: latest.seq });
  }
  const moved = await workbenchTransaction(async (tx) => {
    const approval = await planApprovalOf(tx, found.id);
    if (!approval) throw new RigAgentError("Fixes come with an approved plan. Approve the plan first.", 409);
    const closed = approvalClosed(approval, now());
    if (closed) throw new RigAgentError(closed, 409);
    const step = await paidStepFor(found.id, input.seq, tx);
    const shotSeq = step.fixOf ?? step.seq;
    const room = fixRoom(approval, shotSeq);
    if (!room.listed) throw new RigAgentError("That shot is not in the approved plan.", 409);
    const steps = await stepsOf(tx, found.id);
    const ofShot = steps.filter((s) => s.purpose === "take" && (s.seq === shotSeq || s.fixOf === shotSeq));
    /* A fix of this shot still on its way: the same answer (a lost reply, a second press). If a worker tick finished the
       run just as it was added, the run goes back to work so the fix is never stranded on its fix count (review N2). */
    if (ofShot.some((s) => s.fixOf === shotSeq && !["done", "failed", "skipped"].includes(s.state))) {
      const current = (await getRun(tx, found.id))!;
      if (current.state !== "done") return false;
      try {
        return await patchRun(tx, current.id, { state: "running", reason: null, wake_at: now(), finished_at: null }, ["done"]);
      } catch {
        throw new RigAgentError("Another build is under way on this production. Stop it, or wait for it to finish.", 409);
      }
    }
    if (!room.left) throw new RigAgentError(THIRD_FIX, 409);
    const latest = ofShot.at(-1)!;
    if (latest.state !== "done" && latest.state !== "failed") throw new RigAgentError("A shot is fixed once its take is back.", 409);
    const run = (await getRun(tx, found.id))!;
    if (!["running", "needs_you", "done"].includes(run.state)) throw new RigAgentError("This run has ended. Ask again for a new plan.", 409);
    const seq = Math.max(...steps.map((s) => s.seq)) + 1;
    const at = now();
    await insertFixStep(tx, run.id, { seq, nodeId: latest.nodeId!, label: `Fix ${stepTitle(run, latest)}`, fixOf: shotSeq, at });
    await recordFix(tx, approval.id, shotSeq, seq, approval.fixes);
    try {
      await patchRun(tx, run.id, { state: "running", reason: null, wake_at: at, finished_at: null }, ["running", "needs_you", "done"]);
    } catch {
      throw new RigAgentError("Another build is under way on this production. Stop it, or wait for it to finish.", 409);
    }
    return true;
  });
  if (moved) await dispatchRigAgent(found, `fix-${input.seq}-${now()}`);
  return viewOf(found.id, input.userId);
}

/**
 * Undo what the run built (anyone on the team): the inputs it wired into cards
 * it did not make come out, and its own cards are taken off, softly. A card a
 * teammate has changed or still uses stays, with the reason. Free. A build in
 * progress is stopped first. Undoing twice changes nothing more.
 */
export async function undoRigAgent(input: { productionId: string; runId: string; userId: string }, options: { waitMs?: number } = {}): Promise<RigAgentRunView> {
  const found = await runFor(input.productionId, input.runId);
  if (!found.approvedAt) throw new RigAgentError("Nothing was built from this proposal.", 409);
  if (found.undoneAt) return viewOf(found.id, input.userId);
  if (ACTIVE_STATES.includes(found.state)) await stopRun(found.id, "Stopped for an undo.");
  /* The worker placing a card finishes it first: the undo then sees everything the run put down. */
  const lease = await waitForLease(found.id, options.waitMs ?? 8_000);
  if (!lease) throw new RigAgentError("Atomik is still placing a card. Try again in a moment.", 409);
  try {
    const run = (await getRun(db(), found.id))!;
    if (run.undoneAt) return viewOf(run.id, input.userId);
    const saved = await readTeamCanvas(run.productionId);
    const wires = (await runCanvasChanges(run.productionId, run.id)).flatMap((row) => wiresOf(row.changes));
    const ops = saved ? undoOps(saved.canvas, agentAuthor(run.id), wires) : [];
    let removed = 0, kept = 0;
    let reasons: string[] = [];
    if (ops.length) {
      const result = await applyCanvasOps(run.productionId, { opId: undoOpId(run.id), ops, author: agentAuthor(run.id), runId: run.id, what: "agent-undo" });
      const removals = result.outcomes.filter((o) => o.kind === "remove");
      removed = removals.reduce((n, o) => n + (o.held ? 0 : o.nodeIds.length), 0);
      const keptCards = new Set(removals.filter((o) => o.held && o.card).map((o) => o.card!));
      kept = keptCards.size;
      reasons = distinct(result.outcomes.map((o) => o.held).filter((h): h is string => !!h));
    }
    await patchRun(db(), run.id, { undone_at: now(), undone_by: input.userId, undo: { removed, kept, reasons } });
    await closePlanApproval(db(), run.id, "Undone: nothing more is spent under this plan.", now());
  } finally {
    await releaseRun(lease);
  }
  return viewOf(found.id, input.userId);
}

async function waitForLease(runId: string, waitMs: number): Promise<RunLease | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const lease = await claimRun(runId, LEASE_MS);
    if (lease || Date.now() >= until) return lease;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* ── The tick ─────────────────────────────────────────────────────────── */

/** The thinking model a plan is priced at before it runs: its id, its catalogue price, and whether its words go to OpenAI directly. */
/** `engine`: the ledger the turn is reserved and settled on (lib/openai-direct.ts textEngine); older callers pass `direct` alone. */
export type PlannerPrice = { id: string; catalog: CatalogModel; direct: boolean; engine?: string };

export type TickDeps = PaidDeps & {
  /** The planning turn (default: the Atomik model policy, or the mock planner under ENGINE_MOCK=1), on the model it was priced at. */
  plan?: (snapshot: BoardSnapshot, model: string, attachments: PlannerAttachmentContent) => Promise<PlannerOutcome & { model: string }>;
  /** The model a plan is priced at before it runs (default: Atomik's policy, or the mock planner's price under ENGINE_MOCK=1). */
  pricing?: (want: string) => Promise<PlannerPrice>;
  /** How an attached file's bytes are read (default: the workspace's upload storage). */
  attachmentReaders?: AttachmentReaders;
  /** Whether the person who asked may still act here; a reason when not (default: live membership and suspension). */
  access?: (owner: string) => Promise<string | null>;
  paceMs?: number;
  deadlineAt?: number;
};
/** `waitFor`: a render is in flight; Inngest waits for its settlement (rig/render.settled) before the next tick. */
export type TickResult = { busy?: true; state: RigAgentState | null; more: boolean; waitFor?: { genId: string } };

/** One bounded move of one run, under its lease: plan it, or apply its next steps. Idempotent: a step applied twice changes nothing. */
export async function advanceRigAgentRun(runId: string, deps: TickDeps = {}): Promise<TickResult> {
  await rigAgentReady();
  const lease = await claimRun(runId, LEASE_MS);
  if (!lease) return { busy: true, state: null, more: false };
  try {
    let run = await getRun(db(), runId);
    if (!run || !["planning", "running", "paused"].includes(run.state)) return { state: run?.state ?? null, more: false };
    const why = !rigAgentEnabled() ? RIG_AGENT_OFF : await (deps.access ?? memberProblem)(run.owner);
    if (why) {
      await patchRun(db(), run.id, { state: "paused", reason: why, wake_at: now() + PAUSED_WAKE_MS }, ["planning", "running", "paused"]);
      return { state: "paused", more: false };
    }
    if (run.state === "paused") {
      /* Back on: a build resumes where it stopped; a request not planned yet is planned. */
      const next: RigAgentState = run.approvedAt ? "running" : "planning";
      if (!(await patchRun(db(), run.id, { state: next, reason: null, wake_at: now() }, ["paused"]))) return { state: null, more: false };
      run = (await getRun(db(), runId))!;
    }
    if (run.state === "planning") return { state: await planRun(run, lease, deps), more: false };
    return await buildRun(run, lease, deps);
  } finally {
    await releaseRun(lease);
  }
}

async function planRun(run: RunRow, lease: RunLease, deps: TickDeps): Promise<RigAgentState> {
  /* A planning turn that started and never finished is not sent again on its own: the person asks again, and its charge is released. */
  if (run.planningStartedAt) {
    await releasePlanning(run, null);
    return failRun(run.id, "Planning stopped before it finished. Ask again.", ["planning"]);
  }
  /* Held for as long as the turn may take, so no other worker takes a slow plan for a lost one. */
  await renewRun(lease, PLANNER_TIMEOUT_MS + LEASE_MS);
  if (!(await patchRun(db(), run.id, { planning_started_at: now() }, ["planning"]))) return (await getRun(db(), run.id))!.state;
  const draft = await readDraft(run.owner, run.draftId);
  if (!draft || draft.project.productionProjectId !== run.productionId) return failRun(run.id, "The project this was asked from is no longer here.", ["planning"]);
  const saved = await readTeamCanvas(run.productionId);
  const nodes = saved ? orderedIds(saved.canvas).map((id) => saved.canvas.nodes[id]) : draft.project.nodes;
  const canvasAssets = saved ? Object.values(saved.canvas.assets) : [];
  /* The attached files, checked again (one taken out of the Library since is not read) and read before anything is reserved. */
  let attached: PlanAttachment[] = [];
  let content: PlannerAttachmentContent = NO_ATTACHMENT_CONTENT;
  try {
    attached = await resolvePlanAttachments(run.productionId, run.attachments);
    content = await loadPlanAttachmentContent(attached, deps.attachmentReaders);
  } catch (error) {
    if (!(error instanceof PlanAttachmentError)) throw error;
    return failRun(run.id, `${error.message} Nothing was charged.`, ["planning"]);
  }
  const snapshot = boardSnapshot(draft.project, { nodes, assets: canvasAssets }, run.goal, attachedOf(attached));
  /* Priced before it runs: the most this turn can use, reserved inside the run's limit. */
  let price: PlannerPrice;
  try { price = await (deps.pricing ?? plannerPrice)(run.model); }
  catch (error) { return failRun(run.id, error instanceof PlannerError || error instanceof TextNotSentError ? error.message : "Atomik could not price this plan. Ask again.", ["planning"]); }
  const ceiling = plannerCeilingUsd(price.catalog, snapshot, price.direct);
  if (ceiling == null) return failRun(run.id, "This thinking model has no confirmed price, so Atomik does not plan with it. Choose another, or Auto.", ["planning"]);
  if (run.capCredits == null) return failRun(run.id, "This request has no approved limit, so Atomik does not plan it. Ask again.", ["planning"]);
  try {
    await reserveGenerationSpend(planEvent(run, price, "running", ceiling), {
      run: { id: run.id, limitCredits: run.capCredits, band: 1, live: async () => (await getRun(db(), run.id))?.state === "planning" ? null : "This run was stopped before Atomik planned it. Nothing was charged." },
    });
  } catch (error) {
    if (!(error instanceof SpendReservationError)) throw error;
    const said = error.message === RUN_LIMIT_REACHED
      ? `Planning this board may cost up to about ${creditFigure(quotedCredits(ceiling, "text"))} cr, more than this run's limit of ${creditFigure(run.capCredits)} cr. Ask again with a higher limit.`
      : /Nothing (was|has been) charged/.test(error.message) ? error.message : `${error.message} Nothing was charged.`;
    return failRun(run.id, said, ["planning"]);
  }
  await patchRun(db(), run.id, { plan_charge: "reserved" });
  /* Stopped between the reservation and the turn: nothing is sent, and the reservation is released at nothing. */
  if ((await getRun(db(), run.id))?.state !== "planning") {
    await releasePlanning({ ...run, planCharge: "reserved" }, 0);
    return (await getRun(db(), run.id))?.state ?? "stopped";
  }
  let outcome: PlannerOutcome & { model: string };
  try { outcome = await (deps.plan ?? defaultPlan)(snapshot, price.id, content); }
  catch (error) {
    /* No proposal came back: the turn is not billed (what it used, when the model said, is recorded as the platform's). */
    const used = error instanceof PlannerError ? plannerCostUsd(price.catalog, error.stepUsage, price.direct) : null;
    await settlePlanning(run, price, ceiling, { billed: false, usedUsd: used });
    return failRun(run.id, error instanceof PlannerError ? error.message : "Atomik could not plan this board. Ask again.", ["planning"]);
  }
  /* Settled at what it used (never above what was reserved); usage that cannot be priced is not billed. */
  const used = plannerCostUsd(price.catalog, outcome.stepUsage, price.direct);
  await settlePlanning(run, price, ceiling, { billed: used != null, usedUsd: used });
  const assets = new Map([...draft.project.assets, ...(draft.project.sharedAssets ?? []), ...canvasAssets].map((a) => [a.id, a]));
  const plan = compilePlan(outcome.draft, { runId: run.id, title: outcome.result.title, summary: outcome.result.summary, existing: nodes, assets });
  const fingerprint = createHash("sha256").update(planFingerprintText(plan)).digest("hex");
  return workbenchTransaction(async (tx) => {
    /* Stopped while it planned: the proposal is not shown. */
    const landed = await patchRun(tx, run.id, {
      state: "awaiting_approval", plan, plan_fingerprint: fingerprint, wake_at: null,
      usage: { model: outcome.model, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, steps: outcome.usage.steps },
    }, ["planning"]);
    if (!landed) return (await getRun(tx, run.id))!.state;
    await insertSteps(tx, run.id, plan, now());
    return "awaiting_approval";
  });
}

/** The planning turn's meter event: text, on the thinking model, for the production, by the person who asked. */
function planEvent(run: RunRow, price: PlannerPrice, status: "running" | "succeeded" | "failed", costUsd: number) {
  return {
    id: planEventId(run.id), kind: "text" as const, engine: price.engine ?? (price.direct ? "openai" : "vercel"), model: price.id, status,
    engineCostUsd: costUsd, projectId: run.productionId, createdBy: run.owner,
  };
}

/**
 * Settles the planning charge: billed at what the turn used, never above what was reserved; or
 * released unbilled (it failed, or its usage could not be priced), recording what it used — or,
 * when that is not known, what was reserved — as the platform's cost. Its outcome is then settled,
 * so the platform's recovery has nothing left to reconcile for it. A write that fails leaves the
 * charge reserved for the cron to release.
 */
async function settlePlanning(run: RunRow, price: PlannerPrice, ceilingUsd: number, outcome: { billed: boolean; usedUsd: number | null }) {
  try {
    const cost = Math.min(outcome.usedUsd ?? ceilingUsd, ceilingUsd);
    if (outcome.billed) await meter({ ...planEvent(run, price, "succeeded", cost) }, { critical: true });
    else await meter({ ...planEvent(run, price, "failed", cost), unbilled: true }, { critical: true });
    await closePlanningIntent(run.id);
    await patchRun(db(), run.id, { plan_charge: outcome.billed ? "settled" : "released" });
  } catch (error) {
    console.error("rig agent planning charge:", (error as Error).message);
  }
}

/** The planning event's outcome is settled (billed, or released unbilled): nothing for a recovery drain to reconcile. */
async function closePlanningIntent(runId: string) {
  const [{ billingTransaction }, { resolveRecoveryJobTx }] = await Promise.all([import("@/lib/billingLedger"), import("@/lib/recovery")]);
  const workspaceId = requireTenant().id;
  await billingTransaction((tx) => resolveRecoveryJobTx(tx, workspaceId, planEventId(runId)));
}

/**
 * Releases a planning charge still reserved, unbilled: the turn was stopped before it was sent
 * (`costUsd` 0), or the worker that held it is gone (null: its cost is not known, so the reserved
 * ceiling is recorded as the platform's).
 */
async function releasePlanning(run: Pick<RunRow, "id" | "productionId" | "owner" | "planCharge">, costUsd: number | null) {
  if (run.planCharge !== "reserved") return;
  await platformReady();
  const id = planEventId(run.id);
  const row = (await platformDb().execute({ sql: "SELECT kind,engine,model,status,engine_cost_usd FROM meter_events WHERE workspace_id=? AND id=?", args: [requireTenant().id, id] })).rows[0];
  if (row && String(row.status) === "running")
    await meter({
      id, kind: "text", engine: String(row.engine), model: String(row.model), status: "failed", unbilled: true,
      engineCostUsd: costUsd ?? Number(row.engine_cost_usd ?? 0), projectId: run.productionId, createdBy: run.owner,
    }, { critical: true });
  if (row) await closePlanningIntent(run.id);
  await patchRun(db(), run.id, { plan_charge: "released" });
}

/** The model a plan is priced at: the mock planner's price under ENGINE_MOCK=1, else Atomik's policy in the three families. */
export async function plannerPrice(want: string): Promise<PlannerPrice> {
  if (engineMock()) return { id: MOCK_PLANNER_MODEL, catalog: MOCK_PLANNER_CATALOG, direct: false };
  const { atomikModels } = await import("./atomik-server");
  const models = await catalog();
  const id = selectPlannerModel(want, atomikModels(models));
  const model = models.find((m) => m.id === id);
  if (!model) throw new PlannerError("That thinking model is not available right now. Choose another, or Auto.");
  /* A direct door (any vendor) is quoted at its cold cache-write ceiling and settled at its usage × this snapshot. */
  return { id, catalog: model, direct: isDirectText(id), engine: textEngine(id) };
}

async function defaultPlan(snapshot: BoardSnapshot, id: string, attachments: PlannerAttachmentContent): Promise<PlannerOutcome & { model: string }> {
  if (engineMock() || id === MOCK_PLANNER_MODEL) return { ...(await runPlanner(snapshot, mockPlannerModel(snapshot), { attachments })), model: MOCK_PLANNER_MODEL };
  const model = languageModel(id, { auth: await languageAuth(id) });
  return { ...(await runPlanner(snapshot, model, { attachments })), model: id };
}

async function buildRun(run: RunRow, lease: RunLease, deps: TickDeps): Promise<TickResult> {
  const deadline = deps.deadlineAt ?? Date.now() + TICK_BUDGET_MS;
  const pace = deps.paceMs ?? PACE_MS;
  const queued = (await stepsOf(db(), run.id)).filter((s) => s.state === "queued");
  let current = lease;
  for (let i = 0; i < queued.length; i++) {
    const step = queued[i];
    if (Date.now() >= deadline) { await patchRun(db(), run.id, { wake_at: now() + 1000 }, ["running"]); return { state: "running", more: true }; }
    /* A stop, the switch or a lost member is honoured before every step. */
    const fresh = (await getRun(db(), run.id))!;
    if (fresh.state !== "running") return { state: fresh.state, more: false };
    if (!rigAgentEnabled()) {
      await patchRun(db(), run.id, { state: "paused", reason: RIG_AGENT_OFF, wake_at: now() + PAUSED_WAKE_MS }, ["running"]);
      return { state: "paused", more: false };
    }
    current = await renewRun(current, LEASE_MS);
    const attempt = await attemptStep(db(), step.id);
    /* No longer queued: a stop landed just now. */
    if (!attempt) return { state: (await getRun(db(), run.id))!.state, more: false };
    if (attempt > STEP_ATTEMPTS) return { state: await failRun(run.id, "Atomik could not place these cards. What it placed stays on the board and can be undone.", ["running"]), more: false };
    try {
      const result = await applyCanvasOps(run.productionId, { opId: step.opId ?? stepOpId(run.id, step.seq), ops: step.ops, author: agentAuthor(run.id), runId: run.id, what: "agent" });
      await finishStep(db(), step.id, result.outcomes);
    } catch (error) {
      /* The canvas refused the batch outright (a limit, the production gone): said, and the run stops. */
      if (error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number" && (error as { status: number }).status < 500)
        return { state: await failRun(run.id, error.message, ["running"]), more: false };
      throw error;
    }
    if (pace && i < queued.length - 1) await new Promise((resolve) => setTimeout(resolve, pace));
  }
  /* The build is on the board. What comes after it — each render the plan names, priced and approved — runs inside the run's limit. */
  return advancePaidSteps(run.id, {
    deadline, enabled: () => rigAgentEnabled(), offReason: RIG_AGENT_OFF, pausedWakeMs: PAUSED_WAKE_MS,
    renew: async () => { current = await renewRun(current, LEASE_MS); },
  }, deps);
}

async function failRun(runId: string, reason: string, from: RigAgentState[]): Promise<RigAgentState> {
  await workbenchTransaction(async (tx) => {
    if (await patchRun(tx, runId, { state: "failed", reason, finished_at: now(), wake_at: null }, from)) {
      await setSteps(tx, runId, "queued", "skipped");
      await closePaidSteps(tx, runId, "Not sent: the run stopped. Nothing was charged.");
    }
  });
  return (await getRun(db(), runId))?.state ?? "failed";
}

/** The person who asked, checked against live membership before every tick (the pipelines' own check). */
async function memberProblem(owner: string): Promise<string | null> {
  try {
    await withPipelineActor(requireTenant().id, owner, async () => undefined);
    return null;
  } catch (error) {
    if (!(error instanceof PipelineError)) throw error;
    return error.status === 423 ? "This workspace is suspended, so Atomik has paused this build." : "The person who asked for this build no longer has access to this workspace.";
  }
}

/** Ticks until the run waits for someone, finishes, or the budget is spent (then its wake carries it on). */
export async function driveRigAgent(runId: string, deps: TickDeps & { budgetMs?: number } = {}): Promise<TickResult> {
  const until = Date.now() + (deps.budgetMs ?? 60_000);
  let tick: TickResult = { state: null, more: false };
  for (let i = 0; i < 20; i++) {
    tick = await advanceRigAgentRun(runId, { ...deps, deadlineAt: Math.min(until, deps.deadlineAt ?? until) });
    if (tick.busy || !tick.more || Date.now() >= until) return tick;
  }
  return tick;
}

/* ── Waking a run ─────────────────────────────────────────────────────── */

async function sender(): Promise<((event: WorkerEvent) => Promise<unknown>) | null> {
  const { queueSender } = await import("@/lib/inngest");
  return queueSender();
}

/**
 * Wakes a run: an event for Inngest or the native worker when the deployment
 * has a queue, otherwise this request's after() (local development and mocks).
 * The run's wake stays set until a tick moves it, so a lost event is picked up
 * by the cron. The event carries identifiers only.
 */
export async function dispatchRigAgent(run: Pick<RunRow, "id" | "productionId">, phase: string): Promise<"queued" | "inline" | "wake"> {
  const workspace = requireTenant();
  const send = await sender();
  if (send) {
    try {
      await send({ id: `rig-agent-${run.id}-${phase}`, name: EVENTS.rigAgent, data: { runId: run.id, productionId: run.productionId, workspaceId: workspace.id } });
      return "queued";
    } catch { return "wake"; }
  }
  /* after() first: outside a request it throws, and nothing is reserved for a continuation that would never run. */
  let continuation: (() => Promise<unknown>) | null = null;
  try { after(async () => { await continuation?.(); }); } catch { return "wake"; }
  try {
    continuation = await reserveRecoveryContinuation("rig-agent", () => runInTenant(workspace, () => driveRigAgent(run.id)));
    return "inline";
  } catch { return "wake"; }
}

/** Inngest only: a stopped run's function is cancelled at its next step (the tick would stop it anyway). */
async function cancelQueued(runId: string) {
  const { inngest, inngestConfigured } = await import("@/lib/inngest");
  if (!inngestConfigured()) return;
  await inngest.send({ name: RIG_AGENT_STOPPED, data: { runId } }).catch(() => {});
}

/**
 * The cron's wake: runs in progress whose wake is due, within the deadline. Also releases a
 * planning charge a stopped or ended run still holds after the worker that reserved it died, and
 * closes what a stopped run could not close at the stop (closeEndedSteps: a request still being
 * accepted then, a take still rendering) — free reads, never a send.
 */
export async function drainRigAgentWakeups(options: { limit?: number; deadlineAt?: number } = {}): Promise<{ advanced: number; released: number; swept: number }> {
  const ids = await dueRuns(Math.min(options.limit ?? 2, 8));
  let advanced = 0, released = 0, swept = 0;
  for (const id of ids) {
    const left = (options.deadlineAt ?? Date.now() + 30_000) - Date.now();
    if (left <= 1000) break;
    await driveRigAgent(id, { budgetMs: Math.min(30_000, left) });
    advanced++;
  }
  for (const id of await looseCharges(4, now() - PLANNER_TIMEOUT_MS - LEASE_MS)) {
    const lease = await claimRun(id, LEASE_MS);
    if (!lease) continue;
    try {
      const run = await getRun(db(), id);
      if (run?.planCharge === "reserved" && run.state !== "planning") { await releasePlanning(run, null); released++; }
    } finally {
      await releaseRun(lease);
    }
  }
  for (const id of await looseSteps(4)) {
    const lease = await claimRun(id, LEASE_MS);
    if (!lease) continue;
    try {
      const run = await getRun(db(), id);
      if (run && !ACTIVE_STATES.includes(run.state)) { await closeEndedSteps(run); swept++; }
    } finally {
      await releaseRun(lease);
    }
  }
  return { advanced, released, swept };
}

/**
 * A take a run made reached its end (lib/workbench/rig-agent-settled.ts): an Inngest run waiting for
 * it is told (rig/render.settled); otherwise the run is woken (the native worker, or this request).
 */
export async function notifyRenderSettled(run: Pick<RunRow, "id" | "productionId">, genId: string): Promise<void> {
  const { inngest, inngestConfigured } = await import("@/lib/inngest");
  if (inngestConfigured()) {
    await inngest.send({ name: RIG_RENDER_SETTLED, data: { genId, runId: run.id, workspaceId: requireTenant().id } }).catch(() => {});
    return;
  }
  await dispatchRigAgent(run, `settled-${genId}`);
}

export type RigAgentEventData = { runId: string; productionId: string; workspaceId: string };
const RUN_ID = /^rar_[a-f0-9]{24}$/;

async function workspaceFor(data: RigAgentEventData): Promise<TenantWorkspace> {
  if (!RUN_ID.test(data.runId) || !data.workspaceId) throw new Error("Invalid rig agent event.");
  const workspace = await getWorkspace(data.workspaceId);
  if (!workspace || workspace.deletedAt) throw new Error("No active workspace for this event.");
  return workspace;
}

/** Native worker: tick the run until it waits for someone or is done, within the function's lifetime. */
export async function handleRigAgent(data: RigAgentEventData): Promise<TickResult> {
  const workspace = await workspaceFor(data);
  return runInTenant(workspace, () => driveRigAgent(data.runId, { budgetMs: 240_000 }));
}

/** Inngest: one memoised tick. */
export async function rigAgentTick(data: RigAgentEventData): Promise<TickResult> {
  const workspace = await workspaceFor(data);
  return runInTenant(workspace, () => advanceRigAgentRun(data.runId));
}

/** Inngest, past its step budget: the rest of the run in a fresh event (its wake covers a send that fails). */
export async function continueRigAgent(data: RigAgentEventData): Promise<boolean> {
  const workspace = await workspaceFor(data);
  return runInTenant(workspace, async () => {
    const run = await getRun(db(), data.runId);
    if (!run || !["planning", "running", "paused"].includes(run.state)) return false;
    return (await dispatchRigAgent(run, `continue-${now()}`)) === "queued";
  });
}
