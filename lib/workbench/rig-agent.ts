import { createHash } from "node:crypto";
import { after } from "next/server";
import { db, now } from "@/lib/db";
import { EVENTS, RIG_AGENT_STOPPED, type WorkerEvent } from "@/lib/dispatch";
import { engineMock } from "@/lib/mock";
import { getWorkspace } from "@/lib/platform";
import { withPipelineActor } from "@/lib/pipeline/actor";
import { PipelineError } from "@/lib/pipeline/schema";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireTenant, runInTenant, type TenantWorkspace } from "@/lib/tenant";
import { catalog } from "@/lib/catalog";
import { languageAuth, languageModel } from "@/lib/language-provider";
import { applyCanvasOps } from "./canvas-ops";
import type { OpOutcome } from "./canvas-ops-model";
import { readDraft, workbenchTransaction } from "./records";
import {
  ACTIVE_STATES, boardSnapshot, compilePlan, planFingerprintText, proposalView, undoOps, wiresOf,
  type BoardSnapshot, type RigAgentRunView, type RigAgentState,
} from "./rig-agent-plan";
import { mockPlannerModel, PlannerError, runPlanner, selectPlannerModel, MOCK_PLANNER_MODEL, PLANNER_TIMEOUT_MS, type PlannerOutcome } from "./rig-agent-planner";
import {
  activeRun, attemptStep, claimRun, dueRuns, finishStep, getRun, insertRun, insertSteps, latestRun, newRunId, patchRun,
  releaseRun, renewRun, rigAgentExists, rigAgentReady, runByRequest, runCanvasChanges, runOfProduction, setSteps, stepOpId, stepsOf, undoOpId,
  type RunLease, type RunRow, type StepRow,
} from "./rig-agent-store";
import { orderedIds } from "./team-canvas-model";
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
 * Building is free: planning, placing cards, wiring and tidying are never
 * priced or charged to the workspace, and nothing in a build renders. A render
 * the plan names is shown as the next step, priced, and is never run here.
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
/** A free planning turn is still a model call: one person asks for at most this many boards an hour. */
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

export function runView(run: RunRow, steps: StepRow[], viewer: string): RigAgentRunView {
  const done = steps.filter((s) => s.state === "done");
  const outcomes = (step: StepRow): OpOutcome[] => step.result ?? [];
  const cards = done.filter((s) => s.tool === "create").flatMap(outcomes).filter((o) => o.kind === "create" && !o.held).reduce((n, o) => n + o.nodeIds.length, 0);
  const wires = done.filter((s) => s.tool === "wire").flatMap(outcomes).filter((o) => o.kind === "wire" && o.nodeIds.length).length;
  const held = distinct(done.flatMap(outcomes).map((o) => o.held).filter((h): h is string => !!h));
  return {
    id: run.id, state: run.state, reason: run.reason, goal: run.goal, mine: run.owner === viewer,
    proposal: run.plan && run.fingerprint ? proposalView(run.plan, run.fingerprint) : null,
    steps: steps.map((s) => ({ seq: s.seq, label: s.label, state: s.state, held: distinct(outcomes(s).map((o) => o.held).filter((h): h is string => !!h)) })),
    built: { cards, wires },
    held,
    undo: run.undo,
    canUndo: !!run.approvedAt && !run.undoneAt && done.length > 0,
    credits: 0,
    at: run.updatedAt,
  };
}

async function viewOf(runId: string, viewer: string): Promise<RigAgentRunView> {
  const run = await getRun(db(), runId);
  if (!run) throw new RigAgentError("That build is not on this production.", 404);
  return runView(run, await stepsOf(db(), runId), viewer);
}

/** The run card's read: the switch, and the newest run on this production (with what the viewer may do). */
export async function rigAgentState(productionId: string, viewer: string): Promise<{ enabled: boolean; run: RigAgentRunView | null }> {
  await requireProduction(productionId);
  const enabled = rigAgentEnabled();
  if (!(await rigAgentExists())) return { enabled, run: null };
  const run = await latestRun(db(), productionId);
  return { enabled, run: run ? runView(run, await stepsOf(db(), run.id), viewer) : null };
}

/* ── A person's requests ──────────────────────────────────────────────── */

/**
 * Ask Atomik to build: a run in `planning`, planned by the next tick. Asking
 * again with the same request id answers the same run. A proposal nobody
 * approved yet is replaced; a build in progress must finish or be stopped first.
 */
export async function askRigAgent(input: { productionId: string; draftId: string; userId: string; requestId: string; goal: string; model?: string }): Promise<RigAgentRunView> {
  if (!rigAgentEnabled()) throw new RigAgentError(RIG_AGENT_OFF, 403);
  await requireProduction(input.productionId);
  const draft = await readDraft(input.userId, input.draftId);
  if (!draft) throw new RigAgentError("Open this project's Rig first.", 404);
  if (draft.project.productionProjectId !== input.productionId) throw new RigAgentError("This project is not saved to that production.", 409);
  await rigAgentReady();
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
    await insertRun(tx, { id, productionId: input.productionId, draftId: input.draftId, owner: input.userId, requestId: input.requestId, goal: input.goal.trim(), model: input.model ?? "auto", at });
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

async function stopRun(runId: string, reason: string) {
  const changed = await workbenchTransaction(async (tx) => {
    const stopped = await patchRun(tx, runId, { state: "stopped", reason, finished_at: now(), wake_at: null }, ["planning", "awaiting_approval", "running", "paused"]);
    if (stopped) { await setSteps(tx, runId, "queued", "skipped"); await setSteps(tx, runId, "proposed", "skipped"); }
    return stopped;
  });
  if (changed) await cancelQueued(runId);
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

export type TickDeps = {
  /** The planning turn (default: the Atomik model policy, or the mock planner under ENGINE_MOCK=1). */
  plan?: (snapshot: BoardSnapshot, want: string) => Promise<PlannerOutcome & { model: string }>;
  /** Whether the person who asked may still act here; a reason when not (default: live membership and suspension). */
  access?: (owner: string) => Promise<string | null>;
  paceMs?: number;
  deadlineAt?: number;
};
export type TickResult = { busy?: true; state: RigAgentState | null; more: boolean };

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
  /* A planning turn that started and never finished is not sent again on its own: the person asks again. */
  if (run.planningStartedAt) return failRun(run.id, "Planning stopped before it finished. Ask again.", ["planning"]);
  /* Held for as long as the turn may take, so no other worker takes a slow plan for a lost one. */
  await renewRun(lease, PLANNER_TIMEOUT_MS + LEASE_MS);
  if (!(await patchRun(db(), run.id, { planning_started_at: now() }, ["planning"]))) return (await getRun(db(), run.id))!.state;
  const draft = await readDraft(run.owner, run.draftId);
  if (!draft || draft.project.productionProjectId !== run.productionId) return failRun(run.id, "The project this was asked from is no longer here.", ["planning"]);
  const saved = await readTeamCanvas(run.productionId);
  const nodes = saved ? orderedIds(saved.canvas).map((id) => saved.canvas.nodes[id]) : draft.project.nodes;
  const canvasAssets = saved ? Object.values(saved.canvas.assets) : [];
  const snapshot = boardSnapshot(draft.project, { nodes, assets: canvasAssets }, run.goal);
  let outcome: PlannerOutcome & { model: string };
  try { outcome = await (deps.plan ?? defaultPlan)(snapshot, run.model); }
  catch (error) {
    return failRun(run.id, error instanceof PlannerError ? error.message : "Atomik could not plan this board. Ask again.", ["planning"]);
  }
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

async function defaultPlan(snapshot: BoardSnapshot, want: string): Promise<PlannerOutcome & { model: string }> {
  if (engineMock()) return { ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: MOCK_PLANNER_MODEL };
  const { atomikModels } = await import("./atomik-server");
  const id = selectPlannerModel(want, atomikModels(await catalog()));
  const model = languageModel(id, { auth: await languageAuth(id) });
  return { ...(await runPlanner(snapshot, model)), model: id };
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
  const finished = await patchRun(db(), run.id, { state: "done", reason: null, finished_at: now(), wake_at: null }, ["running"]);
  return { state: finished ? "done" : (await getRun(db(), run.id))!.state, more: false };
}

async function failRun(runId: string, reason: string, from: RigAgentState[]): Promise<RigAgentState> {
  await workbenchTransaction(async (tx) => {
    if (await patchRun(tx, runId, { state: "failed", reason, finished_at: now(), wake_at: null }, from)) await setSteps(tx, runId, "queued", "skipped");
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

/** The cron's wake: runs in progress whose wake is due, within the deadline. */
export async function drainRigAgentWakeups(options: { limit?: number; deadlineAt?: number } = {}): Promise<{ advanced: number }> {
  const ids = await dueRuns(Math.min(options.limit ?? 2, 8));
  let advanced = 0;
  for (const id of ids) {
    const left = (options.deadlineAt ?? Date.now() + 30_000) - Date.now();
    if (left <= 1000) break;
    await driveRigAgent(id, { budgetMs: Math.min(30_000, left) });
    advanced++;
  }
  return { advanced };
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
