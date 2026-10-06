import { createHash } from "node:crypto";
import type { AdmissionActor, AdmissionReply, PreparedAdmission, PrepareAdmissionResult } from "../admissionTypes";
import { preparedClaimFingerprint } from "../admissionSupport";
import { creditState } from "../credits";
import { db, now } from "../db";
import { DRAFT_RESOLUTION } from "../draftFinal";
import { checkGenerationRequest, runCharges, RUN_LIMIT_REACHED } from "../generationRequests";
import { platformDb, platformReady } from "../platform";
import { fromTenths, jobBand, runLimitVerdict, runTally, toTenths, type RunSpend } from "../runLimit";
import { requireTenant } from "../tenant";
import { shotEngine } from "../workspace/engines";
import { shotReferenceAssets, shotReferenceRole } from "../workspace/rig";
import { shotRequestInput } from "../workspace/rig-requests";
import { isShotNode, rigShots } from "../workspace/shots";
import { generationRequestBody, type GenerationReference } from "./generation-request";
import { mediaReferenceIdentity } from "./media-reference-input";
import { mapNodeShot, readDraft } from "./records";
import { approvalClosed, coverage, planApprovalOf } from "./plan-approval";
import { effectiveJobCeiling, rigJobCeiling } from "./rig-agent-limits";
import { creditFigure, type RigAgentState, type RigAgentStepState } from "./rig-agent-plan";
import { getRun, patchRun, patchStep, rigAgentReady, stepsOf, type PauseKind, type RunRow, type StepRow } from "./rig-agent-store";
import { readTeamCanvas } from "./team-canvas";
import { withTeamCanvas } from "./team-canvas-model";

/*
 * Atomik renders drafts inside a limit a person approved (plan §5.5, §6, §8; PR 10).
 *
 * After the build, each render the plan names is a paid step, run one at a
 * time in the plan's order:
 *
 *   next → waiting → approved → sending → rendering → done | failed
 *                 ↘ paused (refused: waits for a person, with the reason)
 *
 *  - waiting: priced now, from the shot as the board has it (the body the
 *    Rig's own Generate sends: lib/workspace/rig-requests.ts), through the
 *    free, repeatable preparation (prepareGeneration). A draft where the
 *    engine has one; a job with no price is never run.
 *  - approved: by the plan's one approval (lib/workbench/plan-approval.ts:
 *    a listed render at exactly the price approved, or a fix drawn under it),
 *    by a tap from the person who asked (Ask, the default), or in
 *    Auto when it is a draft priced at or under the per-job line
 *    (lib/workbench/rig-agent-limits.ts). Anything over the line asks, and so
 *    does a full-quality render (an engine with no draft). The run's limit is
 *    checked before approval and again before sending.
 *  - sending: the durable request key is saved first —
 *    `rig-agent:<runId>:<nodeId>:take:<attempt>` — and then the prepared
 *    request is admitted exactly as priced (admitGeneration), with the run's
 *    limit enforced again inside the reservation's write lock
 *    (reserveGenerationSpend). An exception is ambiguous: the key is kept, and
 *    the next tick asks what became of it (checkGenerationRequest). A paid
 *    request is never sent twice: landed → followed; pending → waited for;
 *    absent → its key is fenced, and only a new attempt with a new key may
 *    follow, under the same approval.
 *  - rendering → done: the take settles (render.settled from the settlement,
 *    or this tick's own look at the job); the step records what the ledger
 *    charged. A failed take records what the provider did with the charge —
 *    billed, not billed, or not known yet — and the run carries on.
 *  - paused: a refusal (the run's limit, the balance, the approval rule's
 *    admin, anything else admission says) or a shot that cannot be priced. The
 *    run waits for a person ("needs you"): try again, skip, raise the limit,
 *    or stop.
 *
 * Nothing here holds a take for credits or a slot (a held take could later
 * start by itself, outside the limit): admission refuses one instead.
 */

/** A render's durable request key: saved on its step before anything is sent. */
export function requestKeyFor(runId: string, nodeId: string, attempt: number): string {
  const node = /^[A-Za-z0-9._-]{1,64}$/.test(nodeId) ? nodeId : "n" + createHash("sha256").update(nodeId).digest("hex").slice(0, 16);
  return `rig-agent:${runId}:${node}:take:${attempt}`;
}

/** How many times one render's request may be sent under new keys (each earlier one proven never admitted or refused unbilled). */
export const MAX_SEND_ATTEMPTS = 8;
/** How soon a render in flight is looked at again, when nothing wakes the run sooner. */
export const RENDER_CHECK_MS = 15_000;
/** How soon a request still being accepted, or whose reply was lost, is asked about again. */
export const PENDING_CHECK_MS = 5_000;
/** How soon a render refused for want of a free slot is tried again. */
export const SLOT_WAIT_MS = 30_000;
const LIVE_JOB = new Set(["queued", "running", "held"]);
const TERMINAL: readonly RigAgentStepState[] = ["done", "failed", "skipped"];
/** A render a stop let go of before it was sent (or that its reservation refused once the stop landed). */
export const STOPPED_UNSENT = "Stopped before it was sent. Nothing was charged.";
const INCOMPLETE_RECORD = "This render's request record is incomplete, so nothing more is sent for it. Press Price again, skip it, or stop.";
const MISMATCHED_RECORD = "This render's record does not match what was approved, so nothing more is sent for it. Press Price again, skip it, or stop.";

/**
 * THE VERIFY SEAM (plan PR 7, lane rig-verify): checking a take against its masters is a paid
 * development kind (`verify`) that is not in this build yet. Until it lands this is null: a check
 * step is shown ("Verify arrives in the next update"), never run and never charged. When it lands,
 * set it to a function that quotes the check, reserves it inside the run's limit (`run`), and
 * answers pass, fail or needs-you for the take.
 */
export type RigVerify = (input: { runId: string; nodeId: string; takeId: string; owner: string; run: RunSpend }) =>
  Promise<{ state: "pass" | "fail" | "needs_you" | "pending"; credits: number | null; reason: string | null }>;
export const RIG_AGENT_VERIFY: RigVerify | null = null;
export const VERIFY_LATER = "Verify arrives in the next update.";

/**
 * THE LOCK SEAM (plan PR 4, #476): Atomik may lock a master a plan names, never unlock one. Until
 * #476 is in main this is null and a lock step stays a next step a person takes. Once it is:
 * `(input) => lockMaster({ canvas: { productionId: input.productionId, nodeId: input.nodeId } },
 *   { userId: input.owner.userId, name: input.owner.name, admin: input.owner.admin, agent: { runId: input.runId } })`
 * from lib/masters.ts. Locking is free.
 */
export type RigLock = (input: { runId: string; productionId: string; nodeId: string; owner: { userId: string; name: string; admin: boolean } }) => Promise<{ unchanged: boolean }>;
export const RIG_AGENT_LOCK: RigLock | null = null;

export type PaidTick = { state: RigAgentState | null; more: boolean; waitFor?: { genId: string } };
type Moved = { kind: "continue" } | { kind: "stop"; tick: PaidTick };
const CONTINUE: Moved = { kind: "continue" };
const stop = (tick: PaidTick): Moved => ({ kind: "stop", tick });

export type PaidDeps = {
  /** Work as the person who asked, restored from live membership (default: the pipelines' own restore). */
  asOwner?: <T>(owner: string, work: (actor: AdmissionActor) => Promise<T>) => Promise<T>;
  /** Free, repeatable preparation of a render (default: prepareGeneration). */
  prepare?: (input: Record<string, unknown>, actor: AdmissionActor) => Promise<PrepareAdmissionResult>;
  /** Admission of a prepared render under its durable key (default: admitGeneration). */
  admit?: (prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; defer: (work: () => Promise<unknown>) => void | Promise<void>; run?: RunSpend }) => Promise<AdmissionReply>;
  /** Keeps a render's submission alive past the tick (default: after the response, else in place). */
  defer?: (work: () => Promise<unknown>) => void | Promise<void>;
  /** Moves a render in flight along: the jobs poll's own look at that one job, a free status read. */
  follow?: (jobId: string) => Promise<void>;
  /** The per-job line now (default: lib/workbench/rig-agent-limits.ts). */
  ceiling?: () => Promise<number>;
};

export type PaidContext = {
  deadline: number;
  enabled: () => boolean;
  offReason: string;
  pausedWakeMs: number;
  /** Renews the run's lease before each step (throws when it was lost). */
  renew: () => Promise<void>;
};

async function defaultAsOwner<T>(owner: string, work: (actor: AdmissionActor) => Promise<T>): Promise<T> {
  const { withPipelineActor } = await import("../pipeline/actor");
  return withPipelineActor(requireTenant().id, owner, work);
}

async function defaultPrepare(input: Record<string, unknown>, actor: AdmissionActor) {
  const { prepareGeneration } = await import("../generationAdmission");
  return prepareGeneration(input, actor);
}

async function defaultAdmit(prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; defer: (work: () => Promise<unknown>) => void | Promise<void>; run?: RunSpend }) {
  const { admitGeneration } = await import("../generationAdmission");
  return admitGeneration(prepared, actor, options);
}

async function defaultDefer(work: () => Promise<unknown>) {
  const { continueAfterResponse } = await import("../held");
  await continueAfterResponse("rig-agent-render")(async () => { await work(); });
}

async function defaultFollow(jobId: string) {
  const { getGeneration, syncGeneration } = await import("../jobs");
  const gen = await getGeneration(jobId);
  if (gen && LIVE_JOB.has(gen.status)) await syncGeneration(gen).catch(() => { /* the next look tries again */ });
}

const figure = (credits: number) => `${creditFigure(credits)} cr`;

/** The shot a render step is about, as the plan named it. */
export function stepTitle(run: Pick<RunRow, "plan">, step: Pick<StepRow, "nodeId" | "label">): string {
  return run.plan?.next.find((n) => n.id === step.nodeId)?.title ?? step.label.replace(/^(Render|Check) /, "").replace(/ · priced$/, "").replace(/ against its masters$/, "");
}

/** What the run needs a person for: said on the run card, and it waits there (needs_you). */
async function needsYou(run: RunRow, reason: string): Promise<Moved> {
  await patchRun(db(), run.id, { state: "needs_you", reason, wake_at: null }, ["running"]);
  return stop({ state: (await getRun(db(), run.id))?.state ?? "needs_you", more: false });
}

async function pause(run: RunRow, step: StepRow, reason: string, kind: PauseKind, from: readonly RigAgentStepState[]): Promise<Moved> {
  if (!(await patchStep(db(), step.id, { state: "paused", reason, pause: kind }, from))) return CONTINUE;
  /* Under the plan's approval, one that needs an admin waits on its own and the run carries on (owner decision L5). */
  if (kind === "admin" && step.purpose === "take" && (await planApprovalOf(db(), run.id))) return CONTINUE;
  return needsYou(run, reason);
}

async function wakeIn(run: RunRow, ms: number, tick: PaidTick): Promise<Moved> {
  await patchRun(db(), run.id, { wake_at: now() + ms }, ["running"]);
  return stop(tick);
}

/* ── The run's limit and the balance, before anything is approved or sent ── */

/** Why this render does not fit under the run's limit now, or null. The reservation checks it again under its write lock. */
export async function limitProblem(run: Pick<RunRow, "id" | "capCredits">, quote: number, band: number): Promise<string | null> {
  if (run.capCredits == null) return "This run has no approved limit, so nothing in it is paid.";
  const tally = runTally(await runCharges(run.id));
  const verdict = runLimitVerdict({ limitTenths: toTenths(run.capCredits), tally, jobTenths: toTenths(quote), band });
  if (verdict.ok) return null;
  const could = band > 1 ? ` and may settle at up to ${figure(quote * band)}` : "";
  return `The next render is about ${figure(quote)}${could}; this run's limit of ${figure(run.capCredits)} leaves about ${figure(fromTenths(verdict.leftTenths))}. Raise the limit, skip this render, or stop.`;
}

/** Why the balance cannot pay for this render now (credit workspaces), or null. Admission's own wall decides in the end. */
async function creditsProblem(admission: PreparedAdmission): Promise<string | null> {
  if (admission.quote.unit !== "cr") return null;
  const state = await creditState();
  if (!state || state.balance >= admission.quote.estimatedCredits) return null;
  return `Not enough credits: the next render is about ${figure(admission.quote.estimatedCredits)} and ${figure(Math.max(0, state.balance))} are left. Top up, then press Retry.`;
}

/** What a reservation needs to count a render toward this run: refused when the run was stopped or switched off meanwhile. */
function runSpend(run: RunRow, band: number, ctx: Pick<PaidContext, "enabled" | "offReason">): RunSpend {
  return {
    id: run.id, limitCredits: run.capCredits ?? 0, band,
    live: async () => {
      if (!ctx.enabled()) return ctx.offReason;
      const fresh = await getRun(db(), run.id);
      return fresh?.state === "running" ? null : "This run was stopped before this render was sent. Nothing was charged.";
    },
  };
}

/* ── Pricing a render: the body the Rig's own Generate sends ─────────── */

/** `shown`: for a render that needs an admin, its own price as an admin is quoted it: for the card and the queue only, never sent. */
type Priced = { ok: true; admission: PreparedAdmission; quote: number; band: number } | { ok: false; reason: string; pause: PauseKind; shown?: { quote: number; band: number } };

export async function priceRender(run: RunRow, step: StepRow, deps: PaidDeps = {}): Promise<Priced> {
  try { return await priceRenderOnce(run, step, deps); }
  catch (error) {
    /* Pricing is free and repeatable: a failure pauses the render (Price again prices it afresh), and nothing is sent. */
    const said = error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number" && error.message ? error.message : `${stepTitle(run, step)} could not be priced just now.`;
    return { ok: false, reason: said, pause: "unpriced" };
  }
}

async function priceRenderOnce(run: RunRow, step: StepRow, deps: PaidDeps): Promise<Priced> {
  const fail = (reason: string, kind: PauseKind): Priced => ({ ok: false, reason, pause: kind });
  const draft = await readDraft(run.owner, run.draftId);
  if (!draft || draft.project.productionProjectId !== run.productionId) return fail("The project this run was asked from is no longer here.", "refused");
  const saved = await readTeamCanvas(run.productionId);
  const project = saved ? withTeamCanvas(draft.project, saved.canvas) : draft.project;
  const node = project.nodes.find((n) => n.id === step.nodeId);
  if (!node || !isShotNode(node)) return fail(`${stepTitle(run, step)} is no longer on the board.`, "unpriced");
  const shot = rigShots(project).find((s) => s.id === node.id);
  const model = shot ? shotEngine(shot.engine) : null;
  if (!shot || !model) return fail(`Choose an available engine for ${stepTitle(run, step)}, then press Price again.`, "unpriced");
  const pictures = shotReferenceAssets(project, node);
  const references: GenerationReference[] = [];
  for (const asset of pictures) {
    const identity = mediaReferenceIdentity(asset);
    if (!identity) return fail(`A picture wired into ${stepTitle(run, step)} is not saved yet. Generate the shot once from the Rig, then press Price again.`, "unpriced");
    references.push({ ...identity, role: shotReferenceRole(node)(asset) });
  }
  let shotId: string;
  try { shotId = await mapNodeShot(run.owner, project, node.id); }
  catch (error) { return fail(error instanceof Error ? error.message : "This shot could not be saved to the production.", "refused"); }
  const input = shotRequestInput(project, node, shot, { shotId, productionProjectId: run.productionId }, references);
  if (!input) return fail(`${stepTitle(run, step)} has no prompt its engine can take. Shorten or condense it, then press Price again.`, "unpriced");
  /* A draft where the engine has one (a separately priced, watermarked take); finals stay a person's. */
  const drafting = model.kind === "video" && !!model.supportsDraft;
  const body = generationRequestBody({ ...input, ...(drafting ? { draft: true, resolution: DRAFT_RESOLUTION } : {}) });
  const prepared = await (deps.asOwner ?? defaultAsOwner)(run.owner, (actor) => (deps.prepare ?? defaultPrepare)(body, actor));
  if (!prepared.ok) {
    const said = typeof prepared.body.error === "string" && prepared.body.error ? prepared.body.error : "This shot could not be priced.";
    if (prepared.status === 403 && prepared.body.needsAdmin === true) {
      /* It needs an admin (owner decision L5): it asks on its own, with its own price, read the way an admin is quoted it.
         A free read: nothing from it is stored that could be sent, and only an admin's own admission can send it. */
      const shown = await (deps.asOwner ?? defaultAsOwner)(run.owner, (actor) => (deps.prepare ?? defaultPrepare)(body, { ...actor, user: { ...actor.user, role: "admin" } }))
        .catch(() => null);
      const credits = shown?.ok ? shown.value.quote.estimatedCredits : null;
      const provider = shown?.ok ? String((shown.value.compiled.model as { provider?: unknown } | undefined)?.provider ?? "") : "";
      return {
        ok: false, reason: said, pause: "admin",
        ...(shown?.ok && credits != null && Number.isFinite(credits) && credits > 0
          ? { shown: { quote: credits, band: jobBand({ approximate: !!shown.value.quote.approximate, statesCharge: provider === "xai" }) } } : {}),
      };
    }
    return fail(said, prepared.status === 403 ? "admin" : "unpriced");
  }
  const quote = prepared.value.quote.estimatedCredits;
  /* A job with no estimate is never run. */
  if (!(Number.isFinite(quote) && quote > 0)) return fail(`${stepTitle(run, step)} has no price, so Atomik does not render it.`, "unpriced");
  const provider = String((prepared.value.compiled.model as { provider?: unknown } | undefined)?.provider ?? "");
  return { ok: true, admission: prepared.value, quote, band: jobBand({ approximate: !!prepared.value.quote.approximate, statesCharge: provider === "xai" }) };
}

/* ── One tick of paid work ────────────────────────────────────────────── */

/** The paid step the run is on: the first render (or, once its seam lands, lock or check) that has not ended, in the plan's order. */
export function currentPaidStep(steps: readonly StepRow[], seams: { verify: boolean; lock: boolean } = { verify: !!RIG_AGENT_VERIFY, lock: !!RIG_AGENT_LOCK }): StepRow | null {
  for (const step of steps) {
    if (step.purpose === "build" || TERMINAL.includes(step.state)) continue;
    if (step.purpose === "take") return step;
    if (step.purpose === "lock" && seams.lock) return step;
    if (step.purpose === "verify" && seams.verify) {
      const take = [...steps].reverse().find((s) => s.purpose === "take" && s.nodeId === step.nodeId && s.seq < step.seq);
      if (take && take.state === "done") return step;
    }
  }
  return null;
}

/**
 * The run's paid steps, one bounded move after another, under the run's lease: price, gate,
 * send, follow. Returns when the run waits for a render or a person, or finishes.
 */
export async function advancePaidSteps(runId: string, ctx: PaidContext, deps: PaidDeps = {}): Promise<PaidTick> {
  for (let i = 0; i < 24; i++) {
    if (Date.now() >= ctx.deadline) {
      await patchRun(db(), runId, { wake_at: now() + 1000 }, ["running"]);
      return { state: "running", more: true };
    }
    const run = await getRun(db(), runId);
    if (!run || run.state !== "running") return { state: run?.state ?? null, more: false };
    /* A stop, the switch or a lost member is honoured before every paid step. */
    if (!ctx.enabled()) {
      await patchRun(db(), run.id, { state: "paused", reason: ctx.offReason, wake_at: now() + ctx.pausedWakeMs }, ["running"]);
      return { state: "paused", more: false };
    }
    await ctx.renew();
    const all = run.capCredits == null ? [] : await stepsOf(db(), run.id);
    /* Under the plan's approval, a render that waits for an admin asks on its own and holds up nothing else (owner decision L5). */
    await rigAgentReady();
    const planned = all.length ? await planApprovalOf(db(), run.id) : null;
    const forAdmin = planned ? all.filter((s) => s.purpose === "take" && s.state === "paused" && s.pause === "admin") : [];
    const step = run.capCredits == null ? null : currentPaidStep(forAdmin.length ? all.filter((s) => !forAdmin.includes(s)) : all);
    if (!step && forAdmin.length) {
      return (await needsYou(run, `${forAdmin.map((s) => stepTitle(run, s)).join(", ")} ${forAdmin.length === 1 ? "waits" : "wait"} for an admin. The rest of the plan is done.`) as { kind: "stop"; tick: PaidTick }).tick;
    }
    if (!step) {
      /* Done only if no render was added meanwhile (a Fix or a Retry pressed while this tick read the steps; review N2). */
      const at = now();
      /* (A run asked before limits never pays, so its renders stay as next steps: it simply ends.) */
      const open = run.capCredits == null ? "" : ` AND NOT EXISTS (SELECT 1 FROM rig_agent_steps WHERE run_id=? AND purpose='take' AND state IN ('next','waiting','approved','sending','rendering'))`;
      const finished = (await db().execute({
        sql: `UPDATE rig_agent_runs SET state='done',reason=NULL,finished_at=?,wake_at=NULL,updated_at=? WHERE id=? AND state='running'${open}`,
        args: run.capCredits == null ? [at, at, run.id] : [at, at, run.id, run.id],
      })).rowsAffected > 0;
      if (!finished && (await getRun(db(), run.id))?.state === "running") continue;
      return { state: finished ? "done" : (await getRun(db(), run.id))?.state ?? null, more: false };
    }
    const moved = await advanceStep(run, step, ctx, deps);
    if (moved.kind === "stop") return moved.tick;
  }
  await patchRun(db(), runId, { wake_at: now() + 1000 }, ["running"]);
  return { state: "running", more: true };
}

async function advanceStep(run: RunRow, step: StepRow, ctx: PaidContext, deps: PaidDeps): Promise<Moved> {
  if (step.purpose === "lock") return lockStep(run, step);
  if (step.purpose === "verify") return verifyStep(run, step, ctx);
  switch (step.state) {
    case "next": return price(run, step, deps);
    case "waiting": return gate(run, step, deps);
    case "approved": return send(run, step, ctx, deps);
    case "sending": return recover(run, step);
    case "rendering": return follow(run, step, deps);
    case "paused": return needsYou(run, step.reason ?? "This render waits for you.");
    default: return needsYou(run, "This render waits for you.");
  }
}

/** A render that needs an admin keeps its own price on its step (never an admission): the card and the queue show it. */
async function holdForAdmin(step: StepRow, priced: Extract<Priced, { ok: false }>, from: readonly RigAgentStepState[]) {
  if (priced.pause !== "admin" || !priced.shown) return;
  await patchStep(db(), step.id, { quote_credits: priced.shown.quote, band: priced.shown.band, admission: null }, from);
}

async function price(run: RunRow, step: StepRow, deps: PaidDeps): Promise<Moved> {
  const priced = await priceRender(run, step, deps);
  if (!priced.ok) {
    await holdForAdmin(step, priced, ["next"]);
    /* One that needs an admin does not hold up the plan's quote: the rest are priced now, as at any gate. */
    if (priced.pause === "admin" && run.mode !== "auto" && step.fixOf == null && !(await planApprovalOf(db(), run.id))) await priceAhead(run, step, deps);
    return pause(run, step, priced.reason, priced.pause, ["next"]);
  }
  await patchStep(db(), step.id, {
    state: "waiting", admission: priced.admission, quote_credits: priced.quote, band: priced.band, reason: null, pause: null,
  }, ["next"]);
  return CONTINUE;
}

async function gate(run: RunRow, waiting: StepRow, deps: PaidDeps): Promise<Moved> {
  if (!waiting.admission || waiting.quoteCredits == null) {
    await patchStep(db(), waiting.id, { state: "next" }, ["waiting"]);
    return CONTINUE;
  }
  /* Its turn: priced again from the board as it is now (review M1). A shot edited since it was priced (its prompt,
     references or engine) is a new fingerprint, so no earlier tap or plan approval covers it: it asks again. */
  const fresh = await priceRender(run, waiting, deps);
  if (!fresh.ok) {
    await holdForAdmin(waiting, fresh, ["waiting"]);
    if (fresh.pause === "admin" && run.mode !== "auto" && waiting.fixOf == null && !(await planApprovalOf(db(), run.id))) await priceAhead(run, waiting, deps);
    return pause(run, waiting, fresh.reason, fresh.pause, ["waiting"]);
  }
  let step = waiting;
  if (fresh.admission.quote.fingerprint !== waiting.admission.quote.fingerprint) {
    /* No earlier approval survives a moved price: neither the plan's nor a tap's (review N1). */
    if (!(await patchStep(db(), waiting.id, {
      admission: fresh.admission, quote_credits: fresh.quote, band: fresh.band, approval_id: null, approved_fingerprint: null, approved_by: null, approved_at: null,
    }, ["waiting"]))) return CONTINUE;
    step = { ...waiting, admission: fresh.admission, quoteCredits: fresh.quote, band: fresh.band, approvalId: null, approvedFingerprint: null, approvedBy: null, approvedAt: null };
  }
  const admission = fresh.admission;
  const quoteCredits = fresh.quote;
  const fingerprint = admission.quote.fingerprint;
  /* The plan's one approval, when the person gave it (a plan is approved once). */
  await rigAgentReady();
  const approval = await planApprovalOf(db(), run.id);
  /* A tap covers exactly this price. One the plan's approval gave holds only while that approval is open (review L2). */
  const tapped = step.approvedFingerprint === fingerprint
    && (!step.approvalId || (!!approval && approval.id === step.approvalId && !approvalClosed(approval, now())));
  /* Before it: in Ask, every render the plan names is priced now (free), so the plan can be approved once at its total. */
  if (!tapped && !approval && run.mode !== "auto" && step.fixOf == null) await priceAhead(run, step, deps);
  const band = step.band ?? 1;
  const over = await limitProblem(run, quoteCredits, band);
  if (over) return pause(run, step, over, "limit", ["waiting"]);
  const short = await creditsProblem(admission);
  if (short) return pause(run, step, short, "credits", ["waiting"]);
  /* A tap already covers this exact price. */
  if (tapped) {
    await patchStep(db(), step.id, { state: "approved", reason: null }, ["waiting"]);
    return CONTINUE;
  }
  const line = effectiveJobCeiling(run.perJobCap, await (deps.ceiling ?? rigJobCeiling)());
  const title = stepTitle(run, step);
  if (approval) {
    const worst = quoteCredits * Math.max(1, band);
    const cover = coverage(approval, { seq: step.seq, fixOf: step.fixOf, quote: quoteCredits, worst, fingerprint }, now(), line);
    if (cover.ok) {
      /* The person's plan approval is this render's approval: no new tap. The hold still checks the balance, the cap, the allowance and the limit. */
      await patchStep(db(), step.id, { state: "approved", approved_at: now(), approved_by: approval.approvedBy, approved_fingerprint: fingerprint, approval_id: approval.id, reason: null }, ["waiting"]);
      return CONTINUE;
    }
    const why = `${title} · about ${figure(quoteCredits)} · ${cover.reason}`;
    await patchStep(db(), step.id, { reason: why }, ["waiting"]);
    return needsYou(run, why);
  }
  /* Auto spends without a tap only on drafts (plan §8): a shot whose engine has no draft renders at full quality, so it asks. */
  const draft = admission.request.draft === true;
  if (run.mode === "auto" && draft && toTenths(quoteCredits) <= toTenths(line)) {
    await patchStep(db(), step.id, { state: "approved", approved_at: now(), approved_by: "auto", approved_fingerprint: fingerprint, reason: null }, ["waiting"]);
    return CONTINUE;
  }
  const why = run.mode !== "auto" ? `${title} is ready to render · about ${figure(quoteCredits)}.`
    : !draft ? `${title} has no draft on its engine, so Atomik asks before rendering it in full · about ${figure(quoteCredits)}. Render it, skip it, or stop.`
    : `${title} is about ${figure(quoteCredits)}, over the ${figure(line)} a draft may cost without asking. Render it, skip it, or stop.`;
  await patchStep(db(), step.id, { reason: why }, ["waiting"]);
  return needsYou(run, why);
}

/**
 * Prices every other render the plan names that has no price yet (free and repeatable: nothing is reserved or
 * sent), so the plan card can show the server's total before the one approval. A render that cannot be priced
 * pauses with its reason; the plan then cannot be approved until it is priced again or skipped.
 */
async function priceAhead(run: RunRow, current: StepRow, deps: PaidDeps): Promise<void> {
  for (const other of await stepsOf(db(), run.id)) {
    if (other.id === current.id || other.purpose !== "take" || other.fixOf != null || other.state !== "next") continue;
    const priced = await priceRender(run, other, deps);
    if (priced.ok) {
      await patchStep(db(), other.id, { state: "waiting", admission: priced.admission, quote_credits: priced.quote, band: priced.band, reason: null, pause: null }, ["next"]);
    } else {
      await holdForAdmin(other, priced, ["next"]);
      await patchStep(db(), other.id, { state: "paused", reason: priced.reason, pause: priced.pause }, ["next"]);
    }
  }
}

async function send(run: RunRow, step: StepRow, ctx: PaidContext, deps: PaidDeps): Promise<Moved> {
  const admission = step.admission;
  /* Nothing is sent without a price and an approval that covers exactly it. */
  if (!admission || step.quoteCredits == null || step.approvedFingerprint !== admission.quote.fingerprint || !step.nodeId) {
    await patchStep(db(), step.id, { state: "waiting" }, ["approved"]);
    return CONTINUE;
  }
  const band = step.band ?? 1;
  const over = await limitProblem(run, step.quoteCredits, band);
  if (over) return pause(run, step, over, "limit", ["approved"]);
  const short = await creditsProblem(admission);
  if (short) return pause(run, step, short, "credits", ["approved"]);
  const attempt = step.attempt + 1;
  if (attempt > MAX_SEND_ATTEMPTS)
    return pause(run, step, `Atomik tried to send ${stepTitle(run, step)} ${MAX_SEND_ATTEMPTS} times and it was not accepted. Nothing more is sent. Press Retry, skip it, or stop.`, "refused", ["approved"]);
  /* The durable key first, before anything is sent: a lost reply is asked about by it, and never replayed. */
  /* A fix renders the same shot again: its keys carry its own step, so they never meet the shot's own. */
  const key = requestKeyFor(run.id, step.fixOf != null ? `${step.nodeId}.fix${step.seq}` : step.nodeId, attempt);
  if (!(await patchStep(db(), step.id, { state: "sending", attempt, request_key: key, reason: null, pause: null }, ["approved"]))) return CONTINUE;
  const sending: StepRow = { ...step, state: "sending", attempt, requestKey: key };
  /* A stop or the switch since this tick began: the key is set aside and nothing is sent. */
  const fresh = await getRun(db(), run.id);
  if (fresh?.state !== "running" || !ctx.enabled()) return recover(run, sending);
  let reply: AdmissionReply;
  try {
    reply = await (deps.asOwner ?? defaultAsOwner)(run.owner, (actor) =>
      (deps.admit ?? defaultAdmit)(admission, actor, { requestKey: key, defer: deps.defer ?? defaultDefer, run: runSpend(run, band, ctx) }));
  } catch {
    /* Ambiguous: it may have been accepted. The key stays; the next tick asks what became of it. */
    return wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false });
  }
  return recordReply(run, sending, reply);
}

/** What the ledger shows for a job: its meter row (null: never reserved). */
async function meterOf(jobId: string): Promise<{ status: string; credits: number } | null> {
  await platformReady();
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE workspace_id=? AND id=?", args: [requireTenant().id, jobId] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits ?? 0) } : null;
}

async function jobOf(jobId: string): Promise<{ status: string; error: string | null } | null> {
  const row = (await db().execute({ sql: "SELECT status,error FROM generations WHERE id=?", args: [jobId] })).rows[0];
  return row ? { status: String(row.status), error: row.error == null ? null : String(row.error) } : null;
}

async function recordReply(run: RunRow, step: StepRow, reply: AdmissionReply): Promise<Moved> {
  const body = reply.body ?? {};
  const error = typeof body.error === "string" && body.error ? body.error : null;
  const jobId = typeof body.id === "string" && body.id ? body.id : null;
  if (jobId) return landed(run, step, jobId, reply.status);
  /* Still being accepted, or interrupted: never sent again; asked about by its key. */
  if (body.pending === true || reply.status >= 500) return wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false });
  /* The shot or its price moved since it was priced: priced again, and approved again. */
  if (body.quoteChanged === true) {
    /* Priced again, and approved again: the earlier approval goes, so an expired plan approval is never read as a tap (review N1). */
    await patchStep(db(), step.id, {
      state: "next", admission: null, quote_credits: null, approval_id: null, approved_fingerprint: null, approved_by: null, approved_at: null,
      reason: "This shot changed since it was priced, so it is priced again.",
    }, ["sending"]);
    return CONTINUE;
  }
  if (body.runHold === "slots") {
    await patchStep(db(), step.id, { state: "approved", reason: "Every render slot is busy. It goes as soon as one is free." }, ["sending"]);
    return wakeIn(run, SLOT_WAIT_MS, { state: "running", more: false });
  }
  if (body.needsAdmin === true)
    return pause(run, step, `${error ?? "This render needs an admin."} Ask an admin to render it, skip it, or stop.`, "admin", ["sending"]);
  if (reply.status === 402 || body.runHold === "credits")
    return pause(run, step, `${error ?? "Not enough credits."} Top up, then press Retry.`, "credits", ["sending"]);
  return pause(run, step, error ?? `This render was refused (${reply.status}). Nothing was charged.`, "refused", ["sending"]);
}

/** The request made a job: follow it — unless its reservation refused it (it failed before anything was reserved or sent). */
async function landed(run: RunRow, step: StepRow, jobId: string, status: number | null): Promise<Moved> {
  const job = await jobOf(jobId);
  const charge = await meterOf(jobId);
  if (job?.status === "failed" && !charge && (status == null || status >= 400)) {
    const fresh = await getRun(db(), run.id);
    if (fresh?.state !== "running") {
      await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
      return stop({ state: fresh?.state ?? null, more: false });
    }
    const said = job.error ?? "This render was refused. Nothing was charged.";
    if (said === RUN_LIMIT_REACHED) {
      const over = await limitProblem(run, step.quoteCredits ?? 0, step.band ?? 1);
      return pause(run, step, over ?? said, "limit", ["sending"]);
    }
    return pause(run, step, said, /credit/i.test(said) ? "credits" : "refused", ["sending"]);
  }
  await patchStep(db(), step.id, { state: "rendering", job_id: jobId, credits_reserved: charge?.credits ?? step.quoteCredits, reason: null }, ["sending"]);
  return CONTINUE;
}

/** A request whose reply was lost (a crash, an exception, a pending answer): asked about by its durable key, never sent again. */
async function recover(run: RunRow, step: StepRow): Promise<Moved> {
  if (!step.requestKey || !step.admission) return pause(run, step, INCOMPLETE_RECORD, "record", ["sending"]);
  const check = await checkGenerationRequest({ userId: run.owner, key: step.requestKey, fingerprint: preparedClaimFingerprint(step.admission) });
  const fresh = await getRun(db(), run.id);
  const live = fresh?.state === "running";
  switch (check.state) {
    case "landed":
      return landed(run, step, check.id, null);
    case "pending":
      return live ? wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false }) : stop({ state: fresh?.state ?? null, more: false });
    case "absent":
      /* It never arrived, and its key is set aside for good: nothing was sent or charged. A new attempt
         (a new key) may follow under the same approval — unless the run stopped. */
      if (!live) {
        await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
        return stop({ state: fresh?.state ?? null, more: false });
      }
      await patchStep(db(), step.id, { state: "approved" }, ["sending"]);
      return CONTINUE;
    case "refused":
      if (!live) {
        await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
        return stop({ state: fresh?.state ?? null, more: false });
      }
      /* It was answered without a job: nothing was made or charged. */
      return pause(run, step, check.error, check.status === 402 ? "credits" : "refused", ["sending"]);
    case "mismatch":
      return pause(run, step, MISMATCHED_RECORD, "record", ["sending"]);
  }
}

/**
 * A run that ended (a stop) leaves no paid step half-way, and nothing here sends or charges anything:
 *  - a render whose key was saved but whose reply was never recorded is asked about by that key, never
 *    sent again: it landed (followed, and recorded once its take settles); it never arrived, or was
 *    refused — at its reservation, too, once the stop reached it — so its key is fenced and nothing was
 *    charged; or it is still being accepted, and the cron asks again (drainRigAgentWakeups);
 *  - a take whose end the settlement delivered before its step knew its job is recorded now.
 * Run under the run's lease: at the stop, and by the cron for anything still open.
 */
export async function closeEndedSteps(run: RunRow): Promise<void> {
  for (const step of await stepsOf(db(), run.id)) {
    if (step.purpose !== "take") continue;
    if (step.state === "sending") await closeSend(run, step);
    else if (step.state === "rendering" && step.jobId) await recordTakeEnd(step, step.jobId);
  }
}

async function closeSend(run: RunRow, step: StepRow): Promise<void> {
  if (!step.requestKey || !step.admission) {
    await patchStep(db(), step.id, { state: "paused", pause: "record", reason: INCOMPLETE_RECORD }, ["sending"]);
    return;
  }
  const check = await checkGenerationRequest({ userId: run.owner, key: step.requestKey, fingerprint: preparedClaimFingerprint(step.admission) });
  if (check.state === "pending") return;
  if (check.state === "absent" || check.state === "refused") {
    await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
    return;
  }
  if (check.state === "mismatch") {
    await patchStep(db(), step.id, { state: "paused", pause: "record", reason: MISMATCHED_RECORD }, ["sending"]);
    return;
  }
  const [job, charge] = await Promise.all([jobOf(check.id), meterOf(check.id)]);
  /* Its reservation refused it (the stop reached it first): nothing was reserved or charged. */
  if (job?.status === "failed" && !charge) {
    await patchStep(db(), step.id, { state: "skipped", reason: STOPPED_UNSENT }, ["sending"]);
    return;
  }
  if (await patchStep(db(), step.id, { state: "rendering", job_id: check.id, credits_reserved: charge?.credits ?? step.quoteCredits, reason: null }, ["sending"]))
    await recordTakeEnd(step, check.id);
}

/** A take in flight: moved along, then recorded as it settled — the charge the ledger shows, never a guess. */
async function follow(run: RunRow, step: StepRow, deps: PaidDeps): Promise<Moved> {
  const jobId = step.jobId;
  if (!jobId) return pause(run, step, "This render's take is not on record, so nothing more is sent for it.", "record", ["rendering"]);
  let job = await jobOf(jobId);
  if (job && LIVE_JOB.has(job.status)) {
    await (deps.follow ?? defaultFollow)(jobId);
    job = await jobOf(jobId);
  }
  if (!job || LIVE_JOB.has(job.status)) return wakeIn(run, await lookAgainIn(jobId), { state: "running", more: false, waitFor: { genId: jobId } });
  if (await recordTakeEnd(step, jobId, job)) return CONTINUE;
  /* Recorded already (the settlement got there first), or its charge is still settling. */
  const recorded = (await db().execute({ sql: "SELECT state FROM rig_agent_steps WHERE id=?", args: [step.id] })).rows[0];
  if (recorded && String(recorded.state) !== "rendering") return CONTINUE;
  return wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false, waitFor: { genId: jobId } });
}

/** A young take is looked at again soon (a draft can land in seconds), an older one every RENDER_CHECK_MS. */
async function lookAgainIn(jobId: string): Promise<number> {
  const row = (await db().execute({ sql: "SELECT created_at FROM generations WHERE id=?", args: [jobId] })).rows[0];
  const age = row ? now() - Number(row.created_at) : Infinity;
  return age < 60_000 ? 3_000 : RENDER_CHECK_MS;
}

/**
 * Records a take's end on its step: done at the charge the ledger settled; or failed, with what the
 * provider did with the charge as the ledger shows it (billed, not billed, or not settled yet). A
 * take that succeeded waits for its settlement before it is recorded. Answers whether it recorded.
 */
export async function recordTakeEnd(step: Pick<StepRow, "id">, jobId: string, job?: { status: string; error: string | null } | null): Promise<boolean> {
  const seen = job ?? (await jobOf(jobId));
  if (!seen || LIVE_JOB.has(seen.status)) return false;
  const charge = await meterOf(jobId);
  if (seen.status === "succeeded") {
    if (!charge || charge.status === "running") return false;
    return patchStep(db(), step.id, { state: "done", credits_settled: charge.credits, settled_at: now(), reason: null, outcome: null }, ["rendering"]);
  }
  const outcome: StepRow["outcome"] = !charge || charge.status === "running" ? "unknown" : charge.credits > 0 ? "charged" : "not_billed";
  const recorded = await patchStep(db(), step.id, {
    state: "failed", credits_settled: outcome === "unknown" ? null : charge!.credits, settled_at: now(), outcome,
    reason: seen.error ? seen.error.slice(0, 400) : "The render failed.",
  }, ["rendering"]);
  /* A failed take whose charge settles later: its record catches up. */
  if (!recorded && outcome !== "unknown")
    await patchStep(db(), step.id, { credits_settled: charge!.credits, outcome }, ["failed"]);
  return recorded;
}

/** The check of a take (plan PR 7): run through its seam once it lands; until then shown, never run, never charged. */
async function verifyStep(run: RunRow, step: StepRow, ctx: PaidContext): Promise<Moved> {
  if (!RIG_AGENT_VERIFY || !step.nodeId) return CONTINUE;
  const take = (await stepsOf(db(), run.id)).find((s) => s.purpose === "take" && s.nodeId === step.nodeId && s.seq < step.seq && s.state === "done");
  if (!take?.jobId) return CONTINUE;
  const verdict = await RIG_AGENT_VERIFY({ runId: run.id, nodeId: step.nodeId, takeId: take.jobId, owner: run.owner, run: runSpend(run, 1, ctx) });
  if (verdict.state === "pending") return wakeIn(run, RENDER_CHECK_MS, { state: "running", more: false });
  if (verdict.state === "pass") {
    await patchStep(db(), step.id, { state: "done", credits_settled: verdict.credits, reason: verdict.reason }, ["next", "waiting", "rendering"]);
    return CONTINUE;
  }
  return pause(run, step, verdict.reason ?? "This take needs you.", "refused", ["next", "waiting", "rendering"]);
}

/** A master the plan names (plan PR 4): locked through its seam once #476 lands; until then a person's next step. */
async function lockStep(run: RunRow, step: StepRow): Promise<Moved> {
  if (!RIG_AGENT_LOCK || !step.nodeId) return CONTINUE;
  const actor = await defaultAsOwner(run.owner, async (a) => a.user);
  await RIG_AGENT_LOCK({ runId: run.id, productionId: run.productionId, nodeId: step.nodeId, owner: { userId: actor.id, name: actor.name, admin: actor.role === "admin" } });
  await patchStep(db(), step.id, { state: "done", reason: null }, ["next"]);
  return CONTINUE;
}
