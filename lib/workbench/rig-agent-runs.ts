import type { AdmissionActor, AdmissionReply, PreparedAdmission, PrepareAdmissionResult } from "../admissionTypes";
import { preparedClaimFingerprint } from "../admissionSupport";
import { db, now } from "../db";
import { DRAFT_RESOLUTION } from "../draftFinal";
import { checkGenerationRequest, RUN_LIMIT_REACHED } from "../generationRequests";
import { jobBand, toTenths, type RunSpend } from "../runLimit";
import { requireTenant } from "../tenant";
import { shotEngine } from "../workspace/engines";
import { shotReferenceAssets, shotReferenceRole } from "../workspace/rig";
import { shotRequestInput } from "../workspace/rig-requests";
import { isShotNode, rigShots } from "../workspace/shots";
import { generationRequestBody, type GenerationReference } from "./generation-request";
import { mediaReferenceIdentity } from "./media-reference-input";
import { mapNodeShot, readDraft } from "./records";
import { releaseStepCharge } from "./rig-agent-charges";
import { advanceCheck, closeCheck, type CheckDeps } from "./rig-agent-checks";
import { advanceFixNext, type FixDeps } from "./rig-agent-fix-steps";
import { effectiveJobCeiling, rigJobCeiling } from "./rig-agent-limits";
import {
  AUTO_PURPOSES, CONTINUE, LIVE_JOB, MAX_SEND_ATTEMPTS, PAID_PURPOSES, PENDING_CHECK_MS, RENDER_CHECK_MS, SLOT_WAIT_MS, STOPPED_UNSENT, TERMINAL,
  checkSubject, creditsShort, failedRound, figure, jobOf, limitProblem, meterOf, needsYou, pause, runSpend, stepRequestKey, stepTitle, stepWhat, stop, wakeIn, waitScope,
  type Moved, type PaidContext, type PaidTick,
} from "./rig-agent-moves";
import { getRun, patchRun, patchStep, stepsOf, type PauseKind, type RunRow, type StepRow } from "./rig-agent-store";
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
 *  - approved: by a tap from the person who asked (Ask, the default), or in
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
 *
 * Each take is then checked against its masters (plan PR 7, through its seam),
 * and a take that fails its check is fixed (PR 11): a fix is a new take made by
 * editing the failed one (lib/workbench/rig-agent-fixes.ts), added as a step
 * while the run is live, with the check of the fixed take after it. A fix is
 * sent like a render, under its own key per send attempt —
 * `rig-agent:<runId>:<nodeId>:fix:<n>:<attempt>` — and never as a fresh
 * generation of the shot.
 *
 * One shot waiting for a person does not hold up the others when what it waits
 * for is its check (waitScope): the run flags that shot and carries on, and it
 * says "needs you" once nothing else can move. Every other wait holds the run.
 * Work in flight is followed first, so one paid step is in flight at a time.
 */



export {
  AUTO_PURPOSES, MAX_SEND_ATTEMPTS, PAID_PURPOSES, PENDING_CHECK_MS, RENDER_CHECK_MS, SLOT_WAIT_MS, STOPPED_UNSENT,
  checkRequestId, checkSubject, fixRequestKey, limitProblem, requestKeyFor, retakeRequestKey, stepRequestKey, stepTitle, stepWhat, waitScope,
  type PaidContext, type PaidTick, type WaitScope,
} from "./rig-agent-moves";

const INCOMPLETE_RECORD = "This render's request record is incomplete, so nothing more is sent for it. Press Price again, skip it, or stop.";
/** A check whose take never landed (it failed, or was skipped): nothing to check. */
export const NOTHING_TO_CHECK = "Nothing to check: its take did not land. Nothing was charged.";
const MISMATCHED_RECORD = "This render's record does not match what was approved, so nothing more is sent for it. Press Price again, skip it, or stop.";



/**
 * THE LOCK SEAM (plan PR 4, #476): Atomik may lock a master a plan names, never unlock one. Until
 * #476 is in main this is null and a lock step stays a next step a person takes. Once it is:
 * `(input) => lockMaster({ canvas: { productionId: input.productionId, nodeId: input.nodeId } },
 *   { userId: input.owner.userId, name: input.owner.name, admin: input.owner.admin, agent: { runId: input.runId } })`
 * from lib/masters.ts. Locking is free.
 */
export type RigLock = (input: { runId: string; productionId: string; nodeId: string; owner: { userId: string; name: string; admin: boolean } }) => Promise<{ unchanged: boolean }>;
export const RIG_AGENT_LOCK: RigLock | null = null;

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
  /** The checks of the run's takes: the development framework's dependencies (the tests script the judge here). */
  checks?: CheckDeps;
  /** The fix writer (the tests script it here). */
  fixes?: FixDeps;
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


/** Why the balance cannot pay for this render now (credit workspaces), or null. Admission's own wall decides in the end. */
async function creditsProblem(admission: PreparedAdmission): Promise<string | null> {
  return admission.quote.unit !== "cr" ? null : creditsShort(admission.quote.estimatedCredits);
}

/* ── Pricing a render: the body the Rig's own Generate sends ─────────── */

type Priced = { ok: true; admission: PreparedAdmission; quote: number; band: number } | { ok: false; reason: string; pause: PauseKind };

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
    return fail(said, prepared.status === 403 ? "admin" : "unpriced");
  }
  const quote = prepared.value.quote.estimatedCredits;
  /* A job with no estimate is never run. */
  if (!(Number.isFinite(quote) && quote > 0)) return fail(`${stepTitle(run, step)} has no price, so Atomik does not render it.`, "unpriced");
  const provider = String((prepared.value.compiled.model as { provider?: unknown } | undefined)?.provider ?? "");
  return { ok: true, admission: prepared.value, quote, band: jobBand({ approximate: !!prepared.value.quote.approximate, statesCharge: provider === "xai" }) };
}

/* ── One tick of paid work ────────────────────────────────────────────── */

/** What the run does next with its paid steps: move one on, wait for a person, or nothing is left. */
export type PaidMove = { kind: "step"; step: StepRow } | { kind: "wait"; step: StepRow } | { kind: "done" };



/**
 * The run's next paid move, in step order (the plan's steps, then those added while it ran):
 *  1. work in flight — a request being sent, a take rendering, a check running — is followed
 *     first, so one paid step is in flight at a time;
 *  2. otherwise the first step that can move: a render or fix that has not ended, a check whose
 *     take landed (or whose fix the provider did not render: its shot then waits for a person), a
 *     lock once its seam lands. A step paused for the whole run is that move: the run waits for a
 *     person. A shot held by a wait of its own (waitScope) is passed over, and the others carry on;
 *  3. when nothing else can move and a shot waits for a person, the run waits (for the first);
 *  4. otherwise nothing is left: the run is done.
 */
export function nextPaidMove(steps: readonly StepRow[], seams: { verify: boolean; lock: boolean } = { verify: true, lock: !!RIG_AGENT_LOCK }): PaidMove {
  const open = steps.filter((s) => (PAID_PURPOSES as readonly string[]).includes(s.purpose) || s.purpose === "lock")
    .filter((s) => !TERMINAL.includes(s.state) && (s.purpose !== "verify" || seams.verify) && (s.purpose !== "lock" || seams.lock));
  const flying = open.find((s) => s.state === "sending" || s.state === "rendering");
  if (flying) return { kind: "step", step: flying };
  const held = new Set<string>();
  let waiting: StepRow | null = null;
  for (const step of open) {
    const shot = step.nodeId ?? step.id;
    if (held.has(shot)) continue;
    if (step.state === "paused" && waitScope(step.pause ?? "refused") === "shot") {
      held.add(shot);
      waiting ??= step;
      continue;
    }
    /* A check waits for its take to land; one whose render never does (failed, skipped) never runs. A fix, or a render again, the provider failed hands its shot to a person. */
    if (step.purpose === "verify" && step.state !== "paused") {
      const subject = checkSubject(steps, step);
      if (subject?.state !== "done" && !failedRound(subject)) continue;
    }
    return { kind: "step", step };
  }
  return waiting ? { kind: "wait", step: waiting } : { kind: "done" };
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
    /* A run asked before limits spends nothing after its build. */
    const move: PaidMove = run.capCredits == null ? { kind: "done" } : nextPaidMove(await stepsOf(db(), run.id), { verify: true, lock: !!RIG_AGENT_LOCK });
    if (move.kind === "done") {
      /* A check whose take never landed has nothing to check: let go, nothing charged. */
      await db().execute({ sql: "UPDATE rig_agent_steps SET state='skipped',reason=?,updated_at=? WHERE run_id=? AND purpose='verify' AND state='next'", args: [NOTHING_TO_CHECK, now(), run.id] });
      const finished = await patchRun(db(), run.id, { state: "done", reason: null, finished_at: now(), wake_at: null }, ["running"]);
      return { state: finished ? "done" : (await getRun(db(), run.id))?.state ?? null, more: false };
    }
    const moved = move.kind === "wait"
      ? await needsYou(run, move.step.reason ?? `${stepTitle(run, move.step)} needs you.`)
      : await advanceStep(run, move.step, ctx, deps);
    if (moved.kind === "stop") return moved.tick;
  }
  await patchRun(db(), runId, { wake_at: now() + 1000 }, ["running"]);
  return { state: "running", more: true };
}

async function advanceStep(run: RunRow, step: StepRow, ctx: PaidContext, deps: PaidDeps): Promise<Moved> {
  /* Paused for the whole run: the run waits for a person (a shot's own wait never reaches here). */
  if (step.state === "paused") return needsYou(run, step.reason ?? "This render waits for you.");
  if (step.purpose === "lock") return lockStep(run, step);
  if (step.purpose === "verify") return advanceCheck(run, step, ctx, deps.checks ?? {});
  /* A fix is written, then priced as an edit of the failed take — never as a fresh render of its shot. */
  if (step.purpose === "fix" && step.state === "next")
    return advanceFixNext(run, step, ctx, { fix: deps.fixes ?? {}, asOwner: deps.asOwner ?? defaultAsOwner, prepare: deps.prepare ?? defaultPrepare });
  switch (step.state) {
    case "next": return price(run, step, deps);
    case "waiting": return gate(run, step, deps);
    case "approved": return send(run, step, ctx, deps);
    case "sending": return recover(run, step);
    case "rendering": return follow(run, step, deps);
    default: return needsYou(run, "This render waits for you.");
  }
}

async function price(run: RunRow, step: StepRow, deps: PaidDeps): Promise<Moved> {
  const priced = await priceRender(run, step, deps);
  if (!priced.ok) return pause(run, step, priced.reason, priced.pause, ["next"]);
  await patchStep(db(), step.id, {
    state: "waiting", admission: priced.admission, quote_credits: priced.quote, band: priced.band, reason: null, pause: null,
  }, ["next"]);
  return CONTINUE;
}

async function gate(run: RunRow, step: StepRow, deps: PaidDeps): Promise<Moved> {
  const admission = step.admission;
  if (!admission || step.quoteCredits == null) {
    await patchStep(db(), step.id, { state: "next" }, ["waiting"]);
    return CONTINUE;
  }
  const band = step.band ?? 1;
  const over = await limitProblem(run, step.quoteCredits, band);
  if (over) return pause(run, step, over, "limit", ["waiting"]);
  const short = await creditsProblem(admission);
  if (short) return pause(run, step, short, "credits", ["waiting"]);
  const fingerprint = admission.quote.fingerprint;
  /* A tap already covers this exact price. */
  if (step.approvedFingerprint === fingerprint) {
    await patchStep(db(), step.id, { state: "approved", reason: null }, ["waiting"]);
    return CONTINUE;
  }
  const line = effectiveJobCeiling(run.perJobCap, await (deps.ceiling ?? rigJobCeiling)());
  const title = stepTitle(run, step);
  /* Auto spends without a tap only on drafts of the plan's renders (plan §8; AUTO_PURPOSES): a shot whose engine has no draft renders at full quality, so it asks. */
  const draft = admission.request.draft === true;
  const auto = run.mode === "auto" && AUTO_PURPOSES.includes(step.purpose);
  if (auto && draft && toTenths(step.quoteCredits) <= toTenths(line)) {
    await patchStep(db(), step.id, { state: "approved", approved_at: now(), approved_by: "auto", approved_fingerprint: fingerprint, reason: null }, ["waiting"]);
    return CONTINUE;
  }
  const what = stepWhat(run, step);
  const why = !auto ? `${what} is ready to render · about ${figure(step.quoteCredits)}.`
    : !draft ? `${title} has no draft on its engine, so Atomik asks before rendering it in full · about ${figure(step.quoteCredits)}. Render it, skip it, or stop.`
    : `${title} is about ${figure(step.quoteCredits)}, over the ${figure(line)} a draft may cost without asking. Render it, skip it, or stop.`;
  await patchStep(db(), step.id, { reason: why }, ["waiting"]);
  return needsYou(run, why);
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
  const key = stepRequestKey(run.id, step, attempt);
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


async function recordReply(run: RunRow, step: StepRow, reply: AdmissionReply): Promise<Moved> {
  const body = reply.body ?? {};
  const error = typeof body.error === "string" && body.error ? body.error : null;
  const jobId = typeof body.id === "string" && body.id ? body.id : null;
  if (jobId) return landed(run, step, jobId, reply.status);
  /* Still being accepted, or interrupted: never sent again; asked about by its key. */
  if (body.pending === true || reply.status >= 500) return wakeIn(run, PENDING_CHECK_MS, { state: "running", more: false });
  /* The shot or its price moved since it was priced: priced again, and approved again. */
  if (body.quoteChanged === true) {
    await patchStep(db(), step.id, { state: "next", admission: null, quote_credits: null, reason: "This shot changed since it was priced, so it is priced again." }, ["sending"]);
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
 *  - a take whose end the settlement delivered before its step knew its job is recorded now;
 *  - a fix is closed the same way as a render (it is one: an edit of the failed take);
 *  - a check is followed through its development job (closeCheck): one never started is let go,
 *    one still being admitted is asked about again by the cron, and one that ran is recorded at
 *    what the ledger settled — an admitted check finishes and settles on its own, like a take;
 *  - a step's own paid text still reserved is released, unbilled (nobody is sending it: the stop
 *    or the cron holds the run's lease, which a worker holds for as long as its turn may take).
 * Run under the run's lease: at the stop, and by the cron for anything still open.
 */
export async function closeEndedSteps(run: RunRow): Promise<void> {
  for (const step of await stepsOf(db(), run.id)) {
    if (step.charge === "reserved") await releaseStepCharge(run, step, null);
    if (step.purpose === "take" || step.purpose === "fix") {
      if (step.state === "sending") await closeSend(run, step);
      else if (step.state === "rendering" && step.jobId) await recordTakeEnd(step, step.jobId);
    } else if (step.purpose === "verify" && (step.state === "sending" || step.state === "rendering")) {
      await closeCheck(run, step);
    }
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

/** A master the plan names (plan PR 4): locked through its seam once #476 lands; until then a person's next step. */
async function lockStep(run: RunRow, step: StepRow): Promise<Moved> {
  if (!RIG_AGENT_LOCK || !step.nodeId) return CONTINUE;
  const actor = await defaultAsOwner(run.owner, async (a) => a.user);
  await RIG_AGENT_LOCK({ runId: run.id, productionId: run.productionId, nodeId: step.nodeId, owner: { userId: actor.id, name: actor.name, admin: actor.role === "admin" } });
  await patchStep(db(), step.id, { state: "done", reason: null }, ["next"]);
  return CONTINUE;
}
