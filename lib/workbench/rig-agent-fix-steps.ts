import type { AdmissionActor, PrepareAdmissionResult } from "../admissionTypes";
import { catalog, type CatalogModel } from "../catalog";
import { quotedCredits } from "../credits";
import { db } from "../db";
import { RUN_LIMIT_REACHED } from "../generationRequests";
import { languageAuth, languageModel } from "../language-provider";
import { engineMock } from "../mock";
import { MODELS } from "../models";
import { textVendor } from "../openai-direct";
import { DEFAULT_AGENT, verifyJudge } from "../production/agent";
import { jobBand } from "../runLimit";
import { shotRequestInput } from "../workspace/rig-requests";
import { rigShots } from "../workspace/shots";
import { generationRequestBody, type GenerationReference } from "./generation-request";
import { mapNodeShot, readDraft } from "./records";
import { releaseStepCharge, reserveStepCharge, settleStepCharge, stepChargeEventId } from "./rig-agent-charges";
import { takeOf } from "./rig-agent-checks";
import { FIX_TABLE, fixMove, type FixMoveId } from "./rig-agent-fixes";
import {
  FIX_WRITER_TIMEOUT_MS, FixWriterError, MOCK_FIX_WRITER_CATALOG, MOCK_FIX_WRITER_MODEL, fixWriterCeilingUsd, fixWriterCostUsd, mockFixWriterModel, runFixWriter,
  type FixBrief, type FixWriterOutcome,
} from "./rig-agent-fix-writer";
import { CONTINUE, limitProblem, meterOf, pause, stepTitle, stop, type Moved, type PaidContext } from "./rig-agent-moves";
import { getRun, patchStep, type RunRow, type StepRequest, type StepRow } from "./rig-agent-store";
import { readTeamCanvas } from "./team-canvas";
import { withTeamCanvas } from "./team-canvas-model";
import { VERIFY_CHECKS, type VerifyCheck } from "./verify";

/*
 * A fix of a take that failed its check (plan §6; PR 11): written, then priced,
 * then — like any render of the run — approved, sent under its own key, and
 * followed to its end (lib/workbench/rig-agent-runs.ts). This module does the
 * first two moves of a fix step:
 *
 *  - Written: the fix writer fills the fix's edit template from what the check
 *    saw (lib/workbench/rig-agent-fix-writer.ts), one bounded turn on the model
 *    the run's checks use, metered into the run's limit like the planning turn
 *    (lib/workbench/rig-agent-charges.ts). A turn that fails, or whose outcome
 *    is not known, is never written again on its own: the shot waits for a
 *    person.
 *  - Priced: never as a fresh render of the shot. A clip's fix is a Seedance
 *    Edit of the failed take, with the master attached as its reference; an
 *    edit has no draft mode, so it renders at full quality and is priced on the
 *    take it edits. A still's fix is a re-edit of the failed still on the
 *    shot's own engine, with the failed still and the master as its references.
 *
 * A fix always waits for a tap with its price, in Auto too (AUTO_PURPOSES).
 */

/** The engine a clip's fix is made on: the one with Edit (Seedance 2.5, lib/models.ts). */
export const EDIT_ENGINE = MODELS.find((m) => m.kind === "video" && !!m.supportsDraft && (m.supportsTasks ?? []).includes("edit"))!;

export type WriterPrice = { id: string; catalog: CatalogModel; direct: boolean };
export type FixDeps = {
  /** The fix writer's model and its price (default: the run's check judge; the mock writer under ENGINE_MOCK=1). */
  writerPrice?: (run: RunRow) => Promise<WriterPrice | null>;
  /** The fix writer's turn (default: the bounded writer on that model; the mock under ENGINE_MOCK=1). */
  write?: (brief: FixBrief, model: string) => Promise<FixWriterOutcome>;
  /** The catalogue the writer's model is picked from (default: the live catalogue). */
  models?: () => Promise<CatalogModel[]>;
};
export type FixKit = {
  fix: FixDeps;
  asOwner: <T>(owner: string, work: (actor: AdmissionActor) => Promise<T>) => Promise<T>;
  prepare: (input: Record<string, unknown>, actor: AdmissionActor) => Promise<PrepareAdmissionResult>;
};

const ASKED_FROM_GONE = "The project this run was asked from is no longer here.";
type FixRequest = Extract<StepRequest, { kind: "fix" }>;

async function defaultWriterPrice(run: RunRow, models: () => Promise<CatalogModel[]> = catalog): Promise<WriterPrice | null> {
  if (engineMock()) return { id: MOCK_FIX_WRITER_MODEL, catalog: MOCK_FIX_WRITER_CATALOG, direct: false };
  const { developmentModels } = await import("./development-server");
  const all = await models();
  const judge = verifyJudge(developmentModels(all), run.agent ?? DEFAULT_AGENT).model;
  const model = judge ? all.find((m) => m.id === judge.id) : undefined;
  return model ? { id: model.id, catalog: model, direct: textVendor(model.id) === "openai" } : null;
}

/**
 * What writing a fix may cost, in credits, before anything is known of it: the writer's ceiling for a brief at its
 * longest (every move, the longest names and reasons, each character at three bytes), in credits as a text turn is
 * quoted and charged (lib/credits.ts quotedCredits, so it follows the price and rounding of a credit). What a person
 * is shown for "try another fix" when the run has not been charged for writing one yet; null when the writer has no
 * model or no confirmed price, and then no fix is written either.
 */
export async function fixNoteEstimate(run: RunRow, deps: Pick<FixDeps, "writerPrice" | "models"> = {}): Promise<number | null> {
  const price = await (deps.writerPrice ?? ((r: RunRow) => defaultWriterPrice(r, deps.models)))(run).catch(() => null);
  if (!price) return null;
  const long = (n: number) => "\u2014".repeat(n);
  let most: number | null = null;
  for (const check of VERIFY_CHECKS) for (const take of ["image", "video"] as const) {
    const moves = [FIX_TABLE[check][take], ...(check === "props" ? ["add" as const] : [])].filter((m): m is FixMoveId => !!m);
    for (const move of moves) {
      const usd = fixWriterCeilingUsd(price.catalog, { move: fixMove(check, move, take), shot: long(120), master: long(120), take, reasons: [long(300), long(300), long(300)] }, price.direct);
      if (usd != null) most = Math.max(most ?? 0, usd);
    }
  }
  return most == null ? null : quotedCredits(most, "text");
}

async function defaultWrite(brief: FixBrief, id: string): Promise<FixWriterOutcome> {
  if (engineMock() || id === MOCK_FIX_WRITER_MODEL) return runFixWriter(brief, mockFixWriterModel(brief));
  return runFixWriter(brief, languageModel(id, { auth: await languageAuth(id) }));
}

/** A fix step that is not priced yet: written first (once), then priced. */
export async function advanceFixNext(run: RunRow, step: StepRow, ctx: PaidContext, kit: FixKit): Promise<Moved> {
  const request = step.request?.kind === "fix" ? step.request : null;
  if (!request) return pause(run, step, `This fix for ${stepTitle(run, step)} has no plan on record, so nothing is sent for it. Look at the take and decide.`, "check", ["next"]);
  /* A turn a worker left reserved: released, and never written again on its own. */
  if (step.charge === "reserved") {
    await releaseStepCharge(run, step, null);
    return pause(run, step, "Atomik's fix note was interrupted, and it is never written again on its own. Look at the take and decide.", "check", ["next"]);
  }
  if (!request.prompt) {
    /* A turn that ran (its charge is on the ledger) but whose note was not kept is not written again on its own either. */
    if (step.charge && (await meterOf(stepChargeEventId(run.id, step.seq, 1))))
      return pause(run, step, "Atomik's fix note was lost, and it is never written again on its own. Look at the take and decide.", "check", ["next"]);
    return writeFix(run, step, request, ctx, kit);
  }
  return priceFix(run, step, request, kit);
}

async function writeFix(run: RunRow, step: StepRow, request: FixRequest, ctx: PaidContext, kit: FixKit): Promise<Moved> {
  const price = await (kit.fix.writerPrice ?? ((r: RunRow) => defaultWriterPrice(r, kit.fix.models)))(run);
  if (!price) return pause(run, step, "No thinking model is connected to write this fix. Look at the take and decide.", "check", ["next"]);
  const brief: FixBrief = {
    move: fixMove(request.check as VerifyCheck, request.move as FixMoveId, request.take), shot: stepTitle(run, step),
    master: request.masterTitle, take: request.take, reasons: request.reasons,
  };
  const ceilingUsd = fixWriterCeilingUsd(price.catalog, brief, price.direct);
  if (ceilingUsd == null) return pause(run, step, "This thinking model has no confirmed price, so Atomik does not write fixes with it. Look at the take and decide.", "check", ["next"]);
  const charge = { id: stepChargeEventId(run.id, step.seq, 1), engine: price.direct ? "openai" : "vercel", model: price.id, ceilingUsd };
  const live = async () => {
    if (!ctx.enabled()) return ctx.offReason;
    return (await getRun(db(), run.id))?.state === "running" ? null : "This run was stopped before Atomik wrote this fix. Nothing was charged.";
  };
  const refused = await reserveStepCharge(run, step, charge, live);
  if (refused) {
    const fresh = await getRun(db(), run.id);
    if (fresh?.state !== "running") return stop({ state: fresh?.state ?? null, more: false });
    if (refused === RUN_LIMIT_REACHED) return pause(run, step, (await limitProblem(run, quotedCredits(ceilingUsd, "text"), 1, "fix note")) ?? refused, "limit", ["next"]);
    return pause(run, step, refused, /credit/i.test(refused) ? "credits" : "check", ["next"]);
  }
  /* Stopped between the reservation and the turn: nothing is sent, and the reservation is released at nothing. */
  if ((await getRun(db(), run.id))?.state !== "running") {
    await releaseStepCharge(run, { ...step, charge: "reserved", chargeId: charge.id }, 0);
    return stop({ state: (await getRun(db(), run.id))?.state ?? null, more: false });
  }
  await ctx.holdFor?.(FIX_WRITER_TIMEOUT_MS + 60_000);
  let outcome: FixWriterOutcome;
  try { outcome = await (kit.fix.write ?? defaultWrite)(brief, price.id); }
  catch (error) {
    /* No fix came back: the turn is not billed (what it used, when the model said, is recorded as the platform's). */
    const used = error instanceof FixWriterError ? fixWriterCostUsd(price.catalog, error.stepUsage, price.direct) : null;
    await settleStepCharge(run, step, charge, { billed: false, usedUsd: used });
    return pause(run, step, `${error instanceof FixWriterError ? error.message : "Atomik could not write this fix just now."} Look at the take and decide.`, "check", ["next"]);
  }
  /* Settled at what it used, never above what was reserved; usage that cannot be priced is not billed. */
  const used = fixWriterCostUsd(price.catalog, outcome.stepUsage, price.direct);
  await settleStepCharge(run, step, charge, { billed: used != null, usedUsd: used });
  await patchStep(db(), step.id, { request: { ...request, prompt: outcome.prompt } }, ["next"]);
  return CONTINUE;
}

/** A master's media identity as a reference the engine takes; none for a bundled sample. */
function referenceOf(identity: string | null): ({ genId: string } | { uploadId: string }) | null {
  const [kind, ...rest] = (identity ?? "").split(":"), id = rest.join(":");
  if (!id || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return null;
  return kind === "generation" ? { genId: id } : kind === "upload" ? { uploadId: id } : null;
}

/** The edit as admission prices it: never a fresh render of the shot. */
async function priceFix(run: RunRow, step: StepRow, request: FixRequest, kit: FixKit): Promise<Moved> {
  const title = stepTitle(run, step);
  const draft = await readDraft(run.owner, run.draftId);
  if (!draft || draft.project.productionProjectId !== run.productionId) return pause(run, step, ASKED_FROM_GONE, "refused", ["next"]);
  const saved = await readTeamCanvas(run.productionId);
  const project = saved ? withTeamCanvas(draft.project, saved.canvas) : draft.project;
  const node = project.nodes.find((n) => n.id === step.nodeId);
  if (!node) return pause(run, step, `${title} is no longer on the board, so its fix is not rendered. Look at the take and decide.`, "check", ["next"]);
  let shotId: string;
  try { shotId = await mapNodeShot(run.owner, project, node.id); }
  catch (error) { return pause(run, step, error instanceof Error ? error.message : "This shot could not be saved to the production.", "refused", ["next"]); }
  const master = referenceOf(request.master);
  const references: GenerationReference[] = master ? [{ ...master, role: "reference_image" }] : [];
  let body: Record<string, unknown>;
  if (request.take === "video") {
    const source = await takeOf(request.source);
    if (!source || source.status !== "succeeded") return pause(run, step, `The take this fix edits is not on record, so it is not rendered. Look at ${title} and decide.`, "check", ["next"]);
    /* An edit of the failed clip (no draft mode: priced on the clip it edits), at the clip's own size. */
    body = {
      prompt: `Edit @Video1: ${request.prompt}`, model: EDIT_ENGINE.id, task: "edit", sourceGenId: source.id, projectId: run.productionId, shotId,
      resolution: source.resolution ?? EDIT_ENGINE.resolutions[0], references, refine: false,
    };
  } else {
    /* A re-edit of the failed still on the shot's own engine, the failed still first among its references. */
    const shot = rigShots(project).find((s) => s.id === node.id);
    const input = shot ? shotRequestInput(project, node, shot, { shotId, productionProjectId: run.productionId }, [{ genId: request.source, role: "reference_image" }, ...references]) : null;
    if (!input || input.kind !== "image") return pause(run, step, `${title}'s engine cannot take this fix. Look at the take and decide.`, "check", ["next"]);
    body = generationRequestBody({ ...input, prompt: request.prompt });
  }
  let prepared: PrepareAdmissionResult;
  try { prepared = await kit.asOwner(run.owner, (actor) => kit.prepare(body, actor)); }
  catch { return pause(run, step, `This fix for ${title} could not be priced just now. Look at the take and decide.`, "check", ["next"]); }
  if (!prepared.ok) {
    const said = typeof prepared.body.error === "string" && prepared.body.error ? prepared.body.error : "This fix could not be priced.";
    return pause(run, step, prepared.status === 403 ? `${said} Ask an admin to render it, or decide.` : `${said} Look at the take and decide.`, prepared.status === 403 ? "admin" : "check", ["next"]);
  }
  const quote = prepared.value.quote.estimatedCredits;
  /* A fix with no estimate is never rendered. */
  if (!(Number.isFinite(quote) && quote > 0)) return pause(run, step, `This fix for ${title} has no price, so Atomik does not render it. Look at the take and decide.`, "check", ["next"]);
  const provider = String((prepared.value.compiled.model as { provider?: unknown } | undefined)?.provider ?? "");
  await patchStep(db(), step.id, {
    state: "waiting", admission: prepared.value, quote_credits: quote, band: jobBand({ approximate: !!prepared.value.quote.approximate, statesCharge: provider === "xai" }),
    reason: null, pause: null,
  }, ["next"]);
  return CONTINUE;
}
