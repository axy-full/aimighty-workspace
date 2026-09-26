/**
 * Atomik on the connected account (slices A1 + A2), server side.
 *
 * - Context (A1): the fixed free reads of planner-reads.ts, made once per
 *   turn in one bounded session, summarised into lines the planner reads as
 *   data.
 * - Proposals (A2): the connected catalogue becomes proposable engines. Each
 *   proposal is validated (planner-proposals.ts) and priced with the live
 *   `get_cost` quote through the Generate page's own service
 *   (generation-service.ts: import once per quote under a durable claim,
 *   exact credits, five-minute lifetime). Only a priced proposal becomes a
 *   step; anything else is reported as "needs a priced run first".
 * - Approval, polling and filing reuse the same service: exact-credit
 *   approval, one durable dispatch claim, leased polls, the original
 *   collected into private storage and filed on the project.
 *
 * Owner-operated, like every connected-account surface: only the workspace
 * owner's own connection is ever used.
 */
import { createHash, randomUUID } from "node:crypto";
import { db, ready } from "@/lib/db";
import { requireTenant } from "@/lib/tenant";
import { claimStep, getStep, patchStep, type Step } from "@/lib/atomik";
import { getConsumerAccess } from "./oauth";
import { readConnectedPlannerReads } from "./mcp";
import { plannerReads, summarizePlannerReads, type PlannerContext } from "./planner-reads";
import {
  buildConnectedProposal,
  connectedEngineLine,
  connectedMeta,
  plannerModels,
  CONNECTED_PREFIX,
  type ConnectedProposal,
  type ConnectedStepMeta,
  type ProposalFile,
  type RawConnectedProposal,
} from "./planner-proposals";
import {
  connectedGenerationCatalogue,
  consumerGenerationView,
  pollConsumerGeneration,
  quoteConsumerGeneration,
  submitConsumerGenerationJob,
  submitConsumerGenerationBatchJobs,
  type ConsumerGenerationView,
} from "./generation-service";
import { getConsumerJob } from "./jobs";
import type { ConnectedModel } from "./catalogue";

const CONTEXT_TTL_MS = 2 * 60_000;
const contextCache = new Map<string, { context: PlannerContext; expiresAt: number }>();

/** Product copy never names the provider. */
export const neutralReason = (message: string) =>
  message
    .replace(/\b(?:the|your|The|Your) Higgsfield\b/g, "the connected account")
    .replace(/\bHiggsfield(?:’s|'s)\b/g, "the connected account’s")
    .replace(/\bHiggsfield\b/g, "the connected account")
    .replace(/\bthe connected account account\b/g, "the connected account")
    .replace(/\bSupercomputer\b/gi, "the connected account")
    .slice(0, 240);

/** The owner's saved workbench project for this production, if any: connected
 * results file into it exactly as the Generate page's do. */
export async function draftForProduction(userId: string, productionId: string | null): Promise<string | null> {
  if (!productionId) return null;
  await ready();
  const row = (await db().execute({
    sql: "SELECT project_id FROM workbench_projects WHERE owner=? AND (project_id=? OR json_extract(body,'$.productionProjectId')=?) ORDER BY updated_at DESC LIMIT 1",
    args: [userId, productionId, productionId],
  })).rows[0];
  return row ? String(row.project_id) : null;
}

export type ConnectedPlanner = {
  models: ConnectedModel[];
  /** Engine lines for the planner's preamble. */
  engineText: string;
  /** Read-only account context lines (data, not instructions). */
  contextText: string;
  context: PlannerContext;
  /** Validates and live-prices one proposal; never submits. */
  quote: (raw: RawConnectedProposal, files: ProposalFile[]) => Promise<{ ok: true; meta: ConnectedStepMeta } | { ok: false; title: string; reason: string }>;
};

/** Cached per connection for two minutes, so the paid planning quote and the
 * turn it prices see the same context. */
async function plannerContext(userId: string, generation: string, accessToken: string): Promise<PlannerContext> {
  const key = createHash("sha256").update(`${requireTenant().id}:${userId}:${generation}`).digest("hex");
  const cached = contextCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.context;
  const context = summarizePlannerReads(await readConnectedPlannerReads(accessToken, plannerReads("")));
  contextCache.set(key, { context, expiresAt: Date.now() + CONTEXT_TTL_MS });
  while (contextCache.size > 256) contextCache.delete(contextCache.keys().next().value!);
  return context;
}

/**
 * The connected planner for this turn, or null when the owner has no
 * connection or it cannot be read (the planner then proposes Particl's own
 * engines only, exactly as before).
 */
export async function connectedPlanner(userId: string, productionId: string | null): Promise<ConnectedPlanner | null> {
  const access = await getConsumerAccess(requireTenant().id, userId).catch(() => null);
  if (!access) return null;
  let models: ConnectedModel[];
  try {
    models = plannerModels((await connectedGenerationCatalogue(userId)).models);
  } catch {
    return null;
  }
  const context = await plannerContext(userId, access.generation, access.accessToken).catch(
    (): PlannerContext => ({ lines: [], recommended: [], presets: [], balance: null, unavailable: [] }),
  );
  const draftId = await draftForProduction(userId, productionId);
  return {
    models,
    engineText: models.map(connectedEngineLine).join("\n"),
    contextText: context.lines.map((line) => `  ${line}`).join("\n"),
    context,
    quote: async (raw, files) => {
      const built: ConnectedProposal = buildConnectedProposal(raw, models, files, context.presets);
      if (!built.ok) return built;
      if (!draftId) return { ok: false, title: built.title, reason: "save this production's project in Studio so results have somewhere to file" };
      if (context.balance !== null && context.balance <= 0) return { ok: false, title: built.title, reason: "the connected account has no credits" };
      try {
        const view = await quoteConsumerGeneration(userId, draftId, built.input, randomUUID());
        if (view.status !== "quoted" || view.quoteCredits == null || !view.workspaceId)
          return { ok: false, title: built.title, reason: "the connected account returned no usable price" };
        return {
          ok: true,
          meta: {
            model: built.model.id,
            type: built.model.outputType,
            modelName: built.model.name,
            input: built.input,
            jobId: view.id,
            draftId,
            credits: view.quoteCredits,
            workspaceId: view.workspaceId,
            workspaceName: view.workspaceName,
            quoteExpiresAt: view.quoteExpiresAt,
            ...(built.input.presetId ? { presetName: context.presets.find((p) => p.id === built.input.presetId)?.name || built.input.presetId } : {}),
          },
        };
      } catch (error) {
        return { ok: false, title: built.title, reason: neutralReason(error instanceof Error ? error.message : "the price could not be read") };
      }
    },
  };
}

export class ConnectedStepError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly step?: Step | null) {
    super(message);
    this.name = "ConnectedStepError";
  }
}
const scopeOf = (userId: string, meta: ConnectedStepMeta) => ({ userId, draftId: meta.draftId, id: meta.jobId });
async function requireConnectedStep(stepId: string) {
  const step = await getStep(stepId);
  if (!step) throw new ConnectedStepError("not_found", "That step is gone.", 404);
  const meta = connectedMeta(step.params);
  if (!meta || !step.model.startsWith(CONNECTED_PREFIX)) throw new ConnectedStepError("not_connected", "That step does not run on the connected account.", 400);
  return { step, meta };
}
/** A fresh quote for an expired one. The step keeps its request; the owner
 * must approve the new exact price before anything is sent. */
async function requote(userId: string, step: Step, meta: ConnectedStepMeta): Promise<Step> {
  const view = await quoteConsumerGeneration(userId, meta.draftId, meta.input, randomUUID());
  if (view.status !== "quoted" || view.quoteCredits == null || !view.workspaceId)
    throw new ConnectedStepError("price_unavailable", "The connected account returned no usable price. Nothing was sent.");
  const next: ConnectedStepMeta = { ...meta, jobId: view.id, credits: view.quoteCredits, workspaceId: view.workspaceId, workspaceName: view.workspaceName, quoteExpiresAt: view.quoteExpiresAt };
  return (await patchStep(step.id, { params: { connected: next } }))!;
}

/**
 * Approve exactly the credits the card showed. An expired quote is refreshed
 * and returned for a new approval (nothing sent); a changed price or wallet
 * refuses. Then the step is claimed once and the quote submitted once.
 */
export async function approveConnectedStep(userId: string, stepId: string, approval: { credits: number; workspaceId: string }) {
  const { step, meta } = await requireConnectedStep(stepId);
  if (step.status !== "proposed") throw new ConnectedStepError("already_claimed", "That one is already running — it was approved a moment ago.", 409, step);
  if (approval.credits !== meta.credits || approval.workspaceId !== meta.workspaceId)
    throw new ConnectedStepError("approval_changed", "The price or wallet changed. Review the step again.", 409, step);
  const job = await getConsumerJob({ userId, draftId: meta.draftId, id: meta.jobId });
  if (!job || job.workflow !== "generation") throw new ConnectedStepError("quote_missing", "This step's quote is gone. Ask Atomik for it again.", 409, step);
  if (job.status === "quoted" && job.quoteExpiresAt <= Date.now()) {
    const refreshed = await requote(userId, step, meta);
    throw new ConnectedStepError("quote_refreshed", "The quote expired, so it was priced again. Approve the new price to continue.", 409, refreshed);
  }
  if (job.status !== "quoted" || job.quoteCredits !== meta.credits)
    throw new ConnectedStepError("approval_changed", "The price changed. Review the step again.", 409, step);
  const claimed = await claimStep(stepId);
  if (!claimed) throw new ConnectedStepError("already_claimed", "That one is already running — it was approved a moment ago.", 409, await getStep(stepId));
  let view: ConsumerGenerationView;
  try {
    view = await submitConsumerGenerationJob(scopeOf(userId, meta), { workspaceId: meta.workspaceId, credits: meta.credits });
  } catch (error) {
    /* Refused before any paid call (the service turns anything after its own
       dispatch claim into an uncertain job instead of throwing): nothing was
       spent, so the step goes back to waiting for approval, unbilled. */
    const code = (error as { code?: string })?.code;
    const reason = code === "capacity" ? "all four connected-account slots are in use (Workspace › Engines lists yours)" : neutralReason(error instanceof Error ? error.message : "the connected account refused it");
    const back = await patchStep(stepId, { status: "proposed", error: `Not sent, not billed: ${reason}` });
    throw new ConnectedStepError(code === "capacity" ? "capacity" : "not_sent", `Not sent, not billed: ${reason}`, code === "capacity" ? 429 : 409, back);
  }
  return settle(stepId, view);
}
async function settle(stepId: string, view: ConsumerGenerationView) {
  const original = view.result && typeof view.result === "object" && !Array.isArray(view.result) ? (view.result as Record<string, unknown>).original : null;
  const genId = original && typeof original === "object" && typeof (original as { generationId?: unknown }).generationId === "string" ? (original as { generationId: string }).generationId : null;
  if (view.status === "completed" && genId) return { step: await patchStep(stepId, { status: "done", genId, error: null }), job: view };
  if (view.status === "failed")
    return { step: await patchStep(stepId, { status: "failed", error: view.failureCode === "provider_failed" ? "The connected account could not make it. Failed runs are not billed." : view.failureCode === "invalid_result" ? "The account finished it, but its result could not be kept. Its receipt is saved." : "It did not run. Failed runs are not billed." }), job: view };
  if (view.status === "uncertain")
    return { step: await patchStep(stepId, { error: "The connected account may have accepted this run. It is kept and never sent again; check its status." }), job: view };
  return { step: await getStep(stepId), job: view };
}
/** One leased status read of a running connected step. */
export async function pollConnectedStep(userId: string, stepId: string) {
  const { step, meta } = await requireConnectedStep(stepId);
  if (step.status !== "running") {
    const job = await getConsumerJob(scopeOf(userId, meta));
    return { step, job: job ? await consumerGenerationView(job) : null };
  }
  const polled = await pollConsumerGeneration(scopeOf(userId, meta));
  const settled = await settle(stepId, polled.job);
  return { ...settled, pollAfterSeconds: polled.pollAfterSeconds ?? 15 };
}

/** Only the workspace owner, signed in (not an API token), plans on the connected account. */
const ownsConnection = (user: { id: string; owner?: boolean } | undefined, token: unknown) => Boolean(user?.owner && !token);
export async function connectedPlannerFor(user: { id: string; owner?: boolean } | undefined, token: unknown, productionId: string | null) {
  return ownsConnection(user, token) ? connectedPlanner(user!.id, productionId).catch(() => null) : null;
}
/** The connected models for the engine list (catalogue cache only; no reads). */
export async function connectedEngineModels(user: { id: string; owner?: boolean } | undefined, token: unknown): Promise<{ models: ConnectedModel[] } | null> {
  if (!ownsConnection(user, token)) return null;
  try {
    const access = await getConsumerAccess(requireTenant().id, user!.id);
    if (!access) return null;
    return { models: plannerModels((await connectedGenerationCatalogue(user!.id)).models) };
  } catch {
    return null;
  }
}

/**
 * ONE approval for a batch (A4): every still-waiting step of the batch, at the
 * exact summed connected credits the card showed. Expired quotes are re-priced
 * and returned for a new approval (nothing sent). All steps are claimed, then
 * one durable claim per item and one paid batch call; each step settles on
 * its own, and an item the account refuses is failed and not billed.
 */
export async function approveConnectedBatch(userId: string, stepIds: string[], approval: { credits: number; workspaceId: string }) {
  if (stepIds.length < 2 || new Set(stepIds).size !== stepIds.length)
    throw new ConnectedStepError("invalid_batch", "Choose the steps of one batch.", 400);
  const loaded = await Promise.all(stepIds.map((id) => requireConnectedStep(id)));
  const batchId = loaded[0].meta.batch?.id;
  if (!batchId || loaded.some(({ meta }) => meta.batch?.id !== batchId || meta.draftId !== loaded[0].meta.draftId || meta.type !== loaded[0].meta.type))
    throw new ConnectedStepError("invalid_batch", "Those steps are not one batch.", 400);
  if (loaded.some(({ step }) => step.status !== "proposed"))
    throw new ConnectedStepError("already_claimed", "A step in this batch is already running. Review the batch again.", 409);
  const total = loaded.reduce((sum, { meta }) => sum + meta.credits, 0);
  if (total !== approval.credits || loaded.some(({ meta }) => meta.workspaceId !== approval.workspaceId))
    throw new ConnectedStepError("approval_changed", "The batch total or wallet changed. Review it again.", 409);
  const jobs = await Promise.all(loaded.map(({ meta }) => getConsumerJob({ userId, draftId: meta.draftId, id: meta.jobId })));
  if (jobs.some((job, i) => !job || job.workflow !== "generation" || (job.status === "quoted" && job.quoteCredits !== loaded[i].meta.credits)))
    throw new ConnectedStepError("approval_changed", "A price in this batch changed. Review it again.", 409);
  if (jobs.some((job) => job!.status === "quoted" && job!.quoteExpiresAt <= Date.now())) {
    const refreshed: Step[] = [];
    for (const [i, { step, meta }] of loaded.entries())
      refreshed.push(jobs[i]!.quoteExpiresAt <= Date.now() ? await requote(userId, step, meta) : step);
    throw new ConnectedStepError("quote_refreshed", "A quote in this batch expired, so it was priced again. Approve the new total to continue.", 409, refreshed[0]);
  }
  if (jobs.some((job) => job!.status !== "quoted"))
    throw new ConnectedStepError("approval_changed", "A step in this batch already ran. Review it again.", 409);
  const claimed: string[] = [];
  for (const id of stepIds) {
    if (await claimStep(id)) claimed.push(id);
    else {
      for (const back of claimed) await patchStep(back, { status: "proposed" });
      throw new ConnectedStepError("already_claimed", "A step in this batch is already running.", 409);
    }
  }
  let views: ConsumerGenerationView[];
  try {
    views = await submitConsumerGenerationBatchJobs(userId, loaded[0].meta.draftId, loaded.map(({ meta }) => meta.jobId), approval);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const reason = code === "capacity" ? "the connected account already has jobs running; a batch needs room for all of its steps" : neutralReason(error instanceof Error ? error.message : "the connected account refused it");
    for (const id of stepIds) await patchStep(id, { status: "proposed", error: `Not sent, not billed: ${reason}` });
    throw new ConnectedStepError(code === "capacity" ? "capacity" : "not_sent", `Not sent, not billed: ${reason}`, code === "capacity" ? 429 : 409, await getStep(stepIds[0]));
  }
  const steps = [];
  for (const [i, id] of stepIds.entries()) steps.push((await settle(id, views[i])).step);
  return { steps, jobs: views };
}
