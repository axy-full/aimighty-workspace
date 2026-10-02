import { catalog } from "../catalog";
import { db, now } from "../db";
import { RUN_LIMIT_REACHED, SpendReservationError } from "../generationRequests";
import { DEFAULT_AGENT, verifyJudge } from "../production/agent";
import { toTenths, type RunSpend } from "../runLimit";
import { applyCanvasOps } from "./canvas-ops";
import type { DevelopmentDependencies, DevelopmentRunOptions } from "./development-server";
import type { DevelopmentRequest } from "./development-types";
import { recoverMediaAssets } from "./job-recovery";
import { readDraft, workbenchTransaction } from "./records";
import { afterCheck, landedFixes, nextFixNumber, roundSteps } from "./rig-agent-fixes";
import { effectiveJobCeiling, rigJobCeiling } from "./rig-agent-limits";
import {
  AUTO_PURPOSES, CONTINUE, MAX_SEND_ATTEMPTS, PENDING_CHECK_MS, STOPPED_UNSENT, checkRequestId, checkSubject, creditsShort, figure, limitProblem,
  meterOf, needsYou, pause, stepTitle, stop, wakeIn, type Moved, type PaidContext,
} from "./rig-agent-moves";
import { agentNodeId, type RigAgentStepState } from "./rig-agent-plan";
import {
  getRun, insertLiveSteps, nextRound, patchStep, stepsOf, type PauseKind, type RunRow, type StepRequest, type StepRow, type StepScorecard,
} from "./rig-agent-store";
import type { CanvasNode, Project } from "./studio";
import { readTeamCanvas } from "./team-canvas";
import { withTeamCanvas } from "./team-canvas-model";
import { CHECK_MASTER, isVerifyCard, verdictLine, verifyCardFor, verifyKeyOf, verifySubject, type Verdict, type VerifyCheckResult, type VerifySubject } from "./verify";

/*
 * The check of a take in an Atomik run (plan §4, §6; PR 11). Each take a run
 * makes — the plan's render, a fix, a render again — is checked against the
 * production's masters by the Verify development kind (plan PR 7), the same
 * judge and stored scorecard as a Verify card's on the board:
 *
 *   next → (a still) priced → waiting → approved → sending → rendering → a verdict
 *        → (a clip, no stored check) waits for a person: open the board to check it
 *        → (a stored check of this take and these masters) read free → a verdict
 *
 *  - The board it reads is the person's draft with the production's team
 *    canvas, its Verify card (made on the canvas by the run, free, when the
 *    shot has none) and this take filed on its shot as that shot's take: the
 *    saved draft alone holds neither what the run made nor its takes.
 *  - A clip is checked from three frames sampled in a browser (the server has
 *    no decoder), so a clip waits for a person to check it on the board; the
 *    run reads that check, free, as soon as it is stored. A still is checked
 *    by the run itself.
 *  - Priced first ("about N cr", holding its ceiling while it runs), inside the
 *    run's limit. In Auto a check runs on its own under the per-job line; in
 *    Ask it waits for a tap. Its durable request id is saved before its job is
 *    started; a start whose reply was lost is found by it, never sent again,
 *    and a late start of an earlier attempt is refused at its reservation.
 *  - The verdict is the code's (lib/workbench/verify.ts). A pass is done; a
 *    clean fail with a targeted fix adds a fix and the check of it
 *    (lib/workbench/rig-agent-fixes.ts); anything else flags this shot for a
 *    person and the run carries on with its other shots.
 */

export type CheckDeps = {
  /** The development framework's own dependencies: the catalogue, the reservation, the judge's call (the tests script the judge here). */
  development?: Partial<DevelopmentDependencies>;
};

type Board = { project: Project; card: CanvasNode; subject: VerifySubject; title: string };
type Failed = { reason: string; pause: PauseKind };
const isFailed = (value: Board | Failed): value is Failed => "reason" in value;
const ASKED_FROM_GONE = "The project this run was asked from is no longer here.";
const NOT_ON_RECORD = "This check's record is incomplete, so nothing more is sent for it.";

/** A take as its generation row has it: what the check files on the board, and what an edit of it needs. */
export type TakeRow = { id: string; kind: "image" | "video"; shotId: string | null; prompt: string; model: string; version: number; seconds: number | null; resolution: string | null; status: string };

export async function takeOf(jobId: string): Promise<TakeRow | null> {
  const row = (await db().execute({ sql: "SELECT id,kind,shot_id,prompt,model,version,duration_s,params,status FROM generations WHERE id=?", args: [jobId] })).rows[0];
  if (!row) return null;
  let params: { resolution?: unknown; duration?: unknown } = {};
  try { params = JSON.parse(String(row.params ?? "{}")); } catch { /* a take with unreadable params still has its kind */ }
  const seconds = row.duration_s != null ? Number(row.duration_s) : typeof params.duration === "number" ? params.duration : null;
  return {
    id: String(row.id), kind: row.kind === "image" ? "image" : "video", shotId: row.shot_id == null ? null : String(row.shot_id),
    prompt: String(row.prompt ?? ""), model: String(row.model ?? ""), version: Number(row.version ?? 1), seconds,
    resolution: typeof params.resolution === "string" ? params.resolution : null, status: String(row.status),
  };
}

/**
 * The board a check of this take reads, as the run sees it: the person's draft with the team canvas,
 * the shot's Verify card (made on the canvas by the run when it has none), and the take filed on its
 * shot as that shot's take.
 */
async function boardFor(run: RunRow, step: StepRow, take: TakeRow): Promise<Board | Failed> {
  const title = stepTitle(run, step);
  const draft = await readDraft(run.owner, run.draftId);
  if (!draft || draft.project.productionProjectId !== run.productionId) return { reason: ASKED_FROM_GONE, pause: "refused" };
  let saved = await readTeamCanvas(run.productionId);
  let base = saved ? withTeamCanvas(draft.project, saved.canvas) : draft.project;
  const shot = base.nodes.find((n) => n.id === step.nodeId);
  if (!shot) return { reason: `${title} is no longer on the board, so its take is not checked.`, pause: "check" };
  let card = base.nodes.find((n) => isVerifyCard(n) && n.linked.includes(shot.id));
  if (!card) {
    const id = agentNodeId(run.id, `check-${shot.id}`);
    let made: Project;
    try { made = verifyCardFor(base, shot.id, id).project; }
    catch (error) { return { reason: error instanceof Error ? error.message : "This shot's Verify card could not be made.", pause: "check" }; }
    const node = made.nodes.find((n) => n.id === id)!;
    /* Free: a card on the team canvas like any other the run makes, and undone with them. */
    await applyCanvasOps(run.productionId, { opId: `rig-agent:${run.id}:check:${shot.id}`, ops: [{ kind: "create", node }], author: `agent:${run.id}`, runId: run.id, what: "agent" });
    saved = await readTeamCanvas(run.productionId);
    base = saved ? withTeamCanvas(draft.project, saved.canvas) : made;
    card = base.nodes.find((n) => n.id === id) ?? node;
  }
  /* The take, filed on its shot as the browser files a finished take, and shown as the shot's take for this check. */
  const filed = recoverMediaAssets(base, [{ id: take.id, status: "succeeded", kind: take.kind, shotId: take.shotId ?? undefined, prompt: take.prompt, version: take.version, model: take.model, durationS: take.seconds }]);
  if (!filed.assets.some((a) => a.id === take.id)) return { reason: `${title}'s take is not on record on this board, so it is not checked. Look at it and decide.`, pause: "check" };
  const project: Project = { ...filed, nodes: filed.nodes.map((n) => (n.id === shot.id ? { ...n, assetId: take.id } : n)) };
  const subject = verifySubject(project, card);
  if (subject.problem) return { reason: `${subject.problem} ${title}'s take is not checked until then.`, pause: "check" };
  return { project, card, subject, title };
}

/* ── One move of a check ──────────────────────────────────────────────── */

export async function advanceCheck(run: RunRow, step: StepRow, ctx: PaidContext, deps: CheckDeps): Promise<Moved> {
  switch (step.state) {
    case "next": return priceCheck(run, step, deps);
    case "waiting": return gateCheck(run, step);
    case "approved": return sendCheck(run, step, ctx, deps);
    case "sending": return recoverCheck(run, step);
    case "rendering": return followCheck(run, step, ctx, deps);
    default: return CONTINUE;
  }
}

const FROM_NEXT: RigAgentStepState[] = ["next"];

async function priceCheck(run: RunRow, step: StepRow, deps: CheckDeps): Promise<Moved> {
  const steps = await stepsOf(db(), run.id);
  const subject = checkSubject(steps, step);
  /* A fix the provider did not render: this shot waits for a person (it never counts as one of the fixes, and is never retried on its own). */
  if (subject?.purpose === "fix" && subject.state === "failed")
    return pause(run, step, `${/^Fix \d+/.exec(subject.label)?.[0] ?? "The fix"} for ${stepTitle(run, step)} did not render. ${outcomeWords(subject)} Look at the take and decide.`, "check", FROM_NEXT);
  if (subject?.state !== "done") return CONTINUE;
  if (!subject.jobId) return pause(run, step, `${stepTitle(run, step)}'s take is not on record, so it is not checked. Look at it and decide.`, "check", FROM_NEXT);
  const take = await takeOf(subject.jobId);
  if (!take || take.status !== "succeeded") return pause(run, step, `${stepTitle(run, step)}'s take is not on record, so it is not checked. Look at it and decide.`, "check", FROM_NEXT);
  const board = await boardFor(run, step, take);
  if (isFailed(board)) return pause(run, step, board.reason, board.pause, FROM_NEXT);
  const { subject: what, card } = board;
  const key = verifyKeyOf(what)!;
  const { storedVerification } = await import("./verify-server");
  const stored = await storedVerification(key);
  if (stored) return recordVerdict(run, step, { verdict: stored.verdict, checks: stored.checks, credits: 0, masters: stored.masters }, take, FROM_NEXT);
  const request: StepRequest = { kind: "check", cardId: card.id, take: key.takeId, takeKind: take.kind, body: {} };
  /* A clip is checked from frames a browser samples: a person checks it on the board, and the run reads that check, free. */
  if (what.take!.asset!.kind === "video") {
    await patchStep(db(), step.id, { request }, FROM_NEXT);
    return pause(run, step, `Open the board to check ${board.title}: a clip is checked from frames sampled on the board, and Atomik reads that check as soon as it is done.`, "check", FROM_NEXT);
  }
  const { developmentModels, quoteDevelopmentJob, DevelopmentError } = await import("./development-server");
  const judge = verifyJudge(developmentModels(await (deps.development?.models ?? catalog)()), run.agent ?? DEFAULT_AGENT);
  if (!judge.model) return pause(run, step, "No thinking model that can see the take and its masters is connected, so this take is not checked. Look at it and decide.", "check", FROM_NEXT);
  const body = { projectId: run.draftId, kind: "verify" as const, model: judge.model.id, effort: judge.effort, nodeId: card.id };
  let quote;
  try {
    quote = await quoteDevelopmentJob({ ...body, requestId: checkRequestId(run.id, step.nodeId!, step.round ?? 0, step.attempt + 1) }, run.owner, deps.development, { project: board.project });
  } catch (error) {
    if (error instanceof DevelopmentError && error.status === 409 && /being checked/i.test(error.message)) return wakeIn(run, PENDING_CHECK_MS * 3, { state: "running", more: false });
    return pause(run, step, error instanceof DevelopmentError ? `${error.message} ${board.title}'s take is not checked until then.` : `${board.title}'s check could not be priced just now. Look at the take and decide.`, "check", FROM_NEXT);
  }
  if (quote.stored) return recordVerdict(run, step, { verdict: quote.stored.verdict, checks: quote.stored.checks, credits: 0, masters: quote.stored.masters }, take, FROM_NEXT);
  /* Priced: "about N cr", holding its ceiling while it runs. A check with no price is never run. */
  if (!(Number.isFinite(quote.estimateCredits) && quote.estimateCredits >= 0) || !quote.sourceHash)
    return pause(run, step, `${board.title}'s check has no price, so Atomik does not run it. Look at the take and decide.`, "check", FROM_NEXT);
  const priced: StepRequest = { ...request, body: { ...body, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits, ...(quote.estimateUsd == null ? {} : { maxUsd: quote.estimateUsd }) } };
  await patchStep(db(), step.id, {
    state: "waiting", request: priced, quote_credits: quote.estimateCredits, hold_credits: quote.holdCredits ?? quote.estimateCredits, band: 1, reason: null, pause: null,
  }, FROM_NEXT);
  return CONTINUE;
}

const fingerprintOf = (step: Pick<StepRow, "request">) => (step.request?.kind === "check" && typeof step.request.body.sourceHash === "string" ? step.request.body.sourceHash : null);

async function gateCheck(run: RunRow, step: StepRow): Promise<Moved> {
  const fingerprint = fingerprintOf(step);
  if (!fingerprint || step.quoteCredits == null) {
    await patchStep(db(), step.id, { state: "next" }, ["waiting"]);
    return CONTINUE;
  }
  const hold = step.holdCredits ?? step.quoteCredits;
  const over = await limitProblem(run, hold, 1, "check");
  if (over) return pause(run, step, over, "limit", ["waiting"]);
  const short = await creditsShort(hold, "check");
  if (short) return pause(run, step, short, "credits", ["waiting"]);
  if (step.approvedFingerprint === fingerprint) {
    await patchStep(db(), step.id, { state: "approved", reason: null }, ["waiting"]);
    return CONTINUE;
  }
  const line = effectiveJobCeiling(run.perJobCap, await rigJobCeiling());
  if (run.mode === "auto" && AUTO_PURPOSES.includes("verify") && toTenths(hold) <= toTenths(line)) {
    await patchStep(db(), step.id, { state: "approved", approved_at: now(), approved_by: "auto", approved_fingerprint: fingerprint, reason: null }, ["waiting"]);
    return CONTINUE;
  }
  const title = stepTitle(run, step);
  const why = run.mode === "auto"
    ? `${title}'s check is about ${figure(step.quoteCredits)}, over the ${figure(line)} a check may cost without asking. Check it, skip it, or stop.`
    : `${title} is ready to check · about ${figure(step.quoteCredits)}.`;
  await patchStep(db(), step.id, { reason: why }, ["waiting"]);
  return needsYou(run, why);
}

/**
 * What a check's reservation needs: the run's limit, refused when the run was stopped or switched off
 * meanwhile, or when this attempt is no longer the one its step is sending (a late start of an
 * attempt whose reply was lost, after a newer one went: never charged).
 */
function checkSpend(run: RunRow, stepId: string, key: string, ctx: Pick<PaidContext, "enabled" | "offReason">): RunSpend {
  return {
    id: run.id, limitCredits: run.capCredits ?? 0, band: 1,
    live: async () => {
      if (!ctx.enabled()) return ctx.offReason;
      const fresh = await getRun(db(), run.id);
      if (fresh?.state !== "running") return "This run was stopped before this check was sent. Nothing was charged.";
      const row = (await db().execute({ sql: "SELECT state,request_key FROM rig_agent_steps WHERE id=?", args: [stepId] })).rows[0];
      return row && String(row.state) === "sending" && String(row.request_key) === key ? null : "This check was sent again under a newer request. Nothing was charged for this one.";
    },
  };
}

async function sendCheck(run: RunRow, step: StepRow, ctx: PaidContext, deps: CheckDeps): Promise<Moved> {
  const fingerprint = fingerprintOf(step);
  if (!fingerprint || step.quoteCredits == null || step.approvedFingerprint !== fingerprint || !step.nodeId || step.request?.kind !== "check") {
    await patchStep(db(), step.id, { state: "waiting" }, ["approved"]);
    return CONTINUE;
  }
  const hold = step.holdCredits ?? step.quoteCredits;
  const over = await limitProblem(run, hold, 1, "check");
  if (over) return pause(run, step, over, "limit", ["approved"]);
  const attempt = step.attempt + 1;
  if (attempt > MAX_SEND_ATTEMPTS)
    return pause(run, step, `Atomik tried to start ${stepTitle(run, step)}'s check ${MAX_SEND_ATTEMPTS} times and it did not start. Nothing more is sent. Look at the take and decide.`, "check", ["approved"]);
  const subject = checkSubject(await stepsOf(db(), run.id), step);
  const take = subject?.jobId ? await takeOf(subject.jobId) : null;
  if (!take) return pause(run, step, NOT_ON_RECORD, "check", ["approved"]);
  const board = await boardFor(run, step, take);
  if (isFailed(board)) return pause(run, step, board.reason, board.pause, ["approved"]);
  /* The durable request id first, before anything is reserved or sent. */
  const key = checkRequestId(run.id, step.nodeId, step.round ?? 0, attempt);
  if (!(await patchStep(db(), step.id, { state: "sending", attempt, request_key: key, reason: null, pause: null }, ["approved"]))) return CONTINUE;
  const fresh = await getRun(db(), run.id);
  if (fresh?.state !== "running" || !ctx.enabled()) return recoverCheck(run, { ...step, state: "sending", attempt, requestKey: key });
  const { prepareDevelopmentJob, DevelopmentError } = await import("./development-server");
  const options: DevelopmentRunOptions = { project: board.project, run: checkSpend(run, step.id, key, ctx) };
  try {
    const prepared = await prepareDevelopmentJob({ ...(step.request.body as Omit<DevelopmentRequest, "requestId">), requestId: key } as DevelopmentRequest, run.owner, undefined, deps.development, options);
    await patchStep(db(), step.id, { state: "rendering", job_id: prepared.job.id, reason: null }, ["sending"]);
    return CONTINUE;
  } catch (error) {
    if (error instanceof DevelopmentError && error.status < 500) {
      /* The take, its masters or the price moved since it was priced, or it was checked meanwhile: priced again (free), and approved again. */
      if (error.status === 409) {
        await patchStep(db(), step.id, { state: "next", request: null, quote_credits: null, hold_credits: null, reason: null }, ["sending"]);
        return /being checked/i.test(error.message) ? wakeIn(run, PENDING_CHECK_MS * 3, { state: "running", more: false }) : CONTINUE;
      }
      return pause(run, step, `${error.message} ${stepTitle(run, step)}'s take is not checked until then.`, "check", ["sending"]);
    }
    if (error instanceof SpendReservationError) {
      const after = await getRun(db(), run.id);
      if (after?.state !== "running") {
        await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
        return stop({ state: after?.state ?? null, more: false });
      }
      if (error.message === RUN_LIMIT_REACHED) return pause(run, step, (await limitProblem(run, hold, 1, "check")) ?? error.message, "limit", ["sending"]);
      return pause(run, step, error.message, error.status === 402 ? "credits" : "check", ["sending"]);
    }
    /* Ambiguous: its job may exist. The request id stays; the next tick looks it up, and never starts it twice. */
    return wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false });
  }
}

/** A check whose reply was lost: looked up by its request id, never started again under it. */
async function recoverCheck(run: RunRow, step: StepRow): Promise<Moved> {
  if (!step.requestKey) return pause(run, step, NOT_ON_RECORD, "check", ["sending"]);
  const job = await checkJobOf(run.owner, { requestId: step.requestKey });
  const fresh = await getRun(db(), run.id);
  if (!job) {
    if (fresh?.state !== "running") {
      await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
      return stop({ state: fresh?.state ?? null, more: false });
    }
    /* Never claimed: a new attempt may follow under a new id; a late start of this one is refused at its reservation. */
    await patchStep(db(), step.id, { state: "approved" }, ["sending"]);
    return CONTINUE;
  }
  if (job.status === "queued") return fresh?.state === "running" ? wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false }) : stop({ state: fresh?.state ?? null, more: false });
  await patchStep(db(), step.id, { state: "rendering", job_id: job.id }, ["sending"]);
  return CONTINUE;
}

/** A check's development job, as its step follows it. */
type CheckJob = { id: string; status: string; settled: boolean };
export async function checkJobOf(owner: string, by: { requestId: string } | { jobId: string }): Promise<CheckJob | null> {
  const exists = (await db().execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_development_jobs'")).rows.length > 0;
  if (!exists) return null;
  const row = ("jobId" in by
    ? await db().execute({ sql: "SELECT id,status,settled FROM workbench_development_jobs WHERE id=? AND owner=?", args: [by.jobId, owner] })
    : await db().execute({ sql: "SELECT id,status,settled FROM workbench_development_jobs WHERE owner=? AND request_id=?", args: [owner, by.requestId] })).rows[0];
  return row ? { id: String(row.id), status: String(row.status), settled: Number(row.settled ?? 0) === 1 } : null;
}

/** The judge's call, run here (a check is one phase); then the verdict, once its job has ended and settled. */
async function followCheck(run: RunRow, step: StepRow, ctx: PaidContext, deps: CheckDeps): Promise<Moved> {
  if (!step.jobId) return pause(run, step, NOT_ON_RECORD, "check", ["rendering"]);
  let job = await checkJobOf(run.owner, { jobId: step.jobId });
  if (!job) return pause(run, step, NOT_ON_RECORD, "check", ["rendering"]);
  if (job.status === "running") {
    /* One judge call: the lease is held for as long as it may take, and its phase claim keeps it from running twice. */
    await ctx.holdFor?.(300_000);
    const { runDevelopmentStep } = await import("./development-server");
    await runDevelopmentStep(job.id, run.owner, deps.development);
    job = await checkJobOf(run.owner, { jobId: step.jobId });
    if (!job) return pause(run, step, NOT_ON_RECORD, "check", ["rendering"]);
  }
  if (job.status === "queued" || job.status === "running" || !job.settled) return wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false });
  const charge = await meterOf(job.id);
  if (job.status === "succeeded") {
    const result = await checkResult(job.id);
    const subject = checkSubject(await stepsOf(db(), run.id), step);
    const take = subject?.jobId ? await takeOf(subject.jobId) : null;
    if (!result || !take) return pause(run, step, NOT_ON_RECORD, "check", ["rendering"]);
    return recordVerdict(run, step, { verdict: result.verdict, checks: result.checks, credits: charge?.credits ?? 0, masters: result.masters }, take, ["rendering"]);
  }
  /* It did not finish: the shot waits for a person, with what became of the charge as the ledger shows it. Never retried on its own. */
  const outcome: StepRow["outcome"] = !charge || charge.status === "running" ? "unknown" : charge.credits > 0 ? "charged" : "not_billed";
  await patchStep(db(), step.id, { credits_settled: outcome === "unknown" ? null : charge!.credits, outcome, settled_at: now() }, ["rendering"]);
  const said = job.status === "uncertain" ? "could not be confirmed, so what it holds is kept for review" : "did not finish";
  return pause(run, step, `${stepTitle(run, step)}'s check ${said}. ${outcomeWords({ outcome, creditsSettled: outcome === "unknown" ? null : charge!.credits })} Check again, or decide.`, "check", ["rendering"]);
}

/** A finished check's verdict, scorecard and masters, from its job. */
async function checkResult(jobId: string): Promise<{ verdict: Verdict; checks: VerifyCheckResult[]; masters: { kind: string; title: string; identity: string }[] } | null> {
  const row = (await db().execute({
    sql: "SELECT j.snapshot,s.result FROM workbench_development_jobs j JOIN workbench_development_steps s ON s.job_id=j.id AND s.stage='refine' AND s.status='succeeded' WHERE j.id=?",
    args: [jobId],
  })).rows[0];
  if (!row) return null;
  try {
    const result = (JSON.parse(String(row.result)) as { verify?: { verdict: Verdict; checks: VerifyCheckResult[] } }).verify;
    const masters = (JSON.parse(String(row.snapshot)) as { verify?: { masters?: { kind: string; title: string; identity: string }[] } }).verify?.masters ?? [];
    return result ? { verdict: result.verdict, checks: result.checks, masters: masters.map((m) => ({ kind: m.kind, title: m.title, identity: m.identity })) } : null;
  } catch { return null; }
}

/** What a failed take's ledger says, in words (never a vendor's dollars). */
function outcomeWords(step: Pick<StepRow, "outcome" | "creditsSettled">): string {
  if (step.outcome === "not_billed") return "Nothing was charged.";
  if (step.outcome === "charged") return `It was charged ${figure(step.creditsSettled ?? 0)}.`;
  return "What it was charged is not settled yet.";
}

/**
 * A check's verdict on its step, and what follows it (lib/workbench/rig-agent-fixes.ts afterCheck):
 * a pass is done; a clean fail with a targeted fix adds the shot's next fix and the check of it; anything
 * else flags this shot for a person, and the run carries on with its other shots.
 */
async function recordVerdict(
  run: RunRow, step: StepRow, found: { verdict: Verdict; checks: VerifyCheckResult[]; credits: number; masters: { kind: string; title: string; identity: string }[] },
  take: TakeRow, from: readonly RigAgentStepState[],
): Promise<Moved> {
  const scorecard: StepScorecard = {
    line: verdictLine(found.checks), checks: found.checks.map((c) => ({ check: c.check, verdict: c.verdict, reasons: c.reasons.slice(0, 3) })),
    masters: found.masters.map((m) => ({ kind: m.kind, title: m.title, identity: m.identity })),
  };
  const steps = await stepsOf(db(), run.id);
  const nodeId = step.nodeId!;
  const next = afterCheck({
    verdict: found.verdict, checks: found.checks, take: { kind: take.kind, source: { resolution: take.resolution ?? undefined, duration: take.seconds ?? undefined } },
    fixes: landedFixes(steps, nodeId), canFix: true,
  });
  const recorded = { verdict: found.verdict, scorecard, credits_settled: found.credits, settled_at: now() };
  if (next.kind === "done") {
    await patchStep(db(), step.id, { ...recorded, state: "done", reason: null, pause: null }, from);
    return CONTINUE;
  }
  if (next.kind === "person") {
    await patchStep(db(), step.id, recorded, from);
    return pause(run, step, next.words, "check", from);
  }
  const title = stepTitle(run, step);
  const fix = nextFixNumber(steps, nodeId);
  const master = found.masters.find((m) => m.kind === CHECK_MASTER[next.fix.check]) ?? null;
  await workbenchTransaction(async (tx) => {
    if (!(await patchStep(tx, step.id, { ...recorded, state: "done", reason: `${scorecard.line}. Fix ${fix} follows.`, pause: null }, from))) return;
    const round = await nextRound(tx, run.id, nodeId);
    const [made] = await insertLiveSteps(tx, run.id, roundSteps(nodeId, title, round, { kind: "fix", fix }), now());
    await patchStep(tx, made.id, {
      request: {
        kind: "fix", check: next.fix.check, move: next.fix.move, prompt: "", master: master?.identity ?? null, masterTitle: master?.title ?? null,
        reasons: next.reasons, source: take.id, take: take.kind,
      },
    }, ["next"]);
  });
  return CONTINUE;
}

/**
 * A check in flight when its run ended: followed through its job, never started again — never
 * started (let go), still being admitted (asked about again by the cron), running (left to finish),
 * or ended (recorded at what the ledger settled). Its verdict is not acted on: the run has ended.
 */
export async function closeCheck(run: RunRow, step: StepRow): Promise<void> {
  let jobId = step.jobId;
  if (step.state === "sending") {
    if (!step.requestKey) {
      await patchStep(db(), step.id, { state: "paused", pause: "record", reason: NOT_ON_RECORD }, ["sending"]);
      return;
    }
    const job = await checkJobOf(run.owner, { requestId: step.requestKey });
    /* Never started: nothing was reserved, and a start that comes late is refused at its reservation (the run has ended). */
    if (!job) {
      await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
      return;
    }
    if (job.status === "queued") return;
    if (!(await patchStep(db(), step.id, { state: "rendering", job_id: job.id, reason: null }, ["sending"]))) return;
    jobId = job.id;
  }
  const job = jobId ? await checkJobOf(run.owner, { jobId }) : null;
  if (!job) {
    await patchStep(db(), step.id, { state: "paused", pause: "record", reason: NOT_ON_RECORD }, ["rendering"]);
    return;
  }
  if (job.status === "queued" || job.status === "running" || !job.settled) return;
  const charge = await meterOf(job.id);
  if (job.status === "succeeded") {
    const result = await checkResult(job.id);
    await patchStep(db(), step.id, {
      state: "done", credits_settled: charge?.credits ?? 0, settled_at: now(), reason: null, outcome: null,
      ...(result ? { verdict: result.verdict, scorecard: { line: verdictLine(result.checks), checks: result.checks.map((c) => ({ check: c.check, verdict: c.verdict, reasons: c.reasons.slice(0, 3) })) } } : {}),
    }, ["rendering"]);
    return;
  }
  /* Its reservation refused it (the run had ended): nothing was reserved or charged. */
  if (!charge) {
    await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["rendering"]);
    return;
  }
  const outcome: StepRow["outcome"] = charge.status === "running" ? "unknown" : charge.credits > 0 ? "charged" : "not_billed";
  await patchStep(db(), step.id, {
    state: "failed", credits_settled: outcome === "unknown" ? null : charge.credits, settled_at: now(), outcome,
    reason: job.status === "uncertain" ? "The check could not be confirmed, so its estimate is held for review." : "The check did not finish.",
  }, ["rendering"]);
}
