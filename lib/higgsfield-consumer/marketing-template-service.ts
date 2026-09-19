/**
 * Durable "marketing-template" workflow for the connected account (Moleculr
 * Format → Variants): cached template catalogue and cost table → validated
 * quote (the create tool's get_cost when advertised, otherwise the catalogue's
 * versioned cost table) → owner approval of the exact connected-credit price →
 * one admitted create → leased status polling → original collection into
 * private storage and the project as a variant result. Same claim, uncertain
 * and receipt semantics as the Generate service; no automatic retries of paid
 * calls.
 */
import { createHash } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { readDraft } from "@/lib/workbench/records";
import { ConsumerOAuthError, getConsumerAccess } from "./oauth";
import {
  createConsumerJob,
  getConsumerJob,
  getConsumerJobByKey,
  listConsumerRecoveryJobs,
  readConsumerJobAfterAdmissions,
  claimConsumerDispatch,
  markConsumerAccepted,
  markConsumerUncertain,
  claimConsumerPoll,
  releaseConsumerPoll,
  ConsumerJobError,
  reconcileConsumerReceipt,
  completeConsumerJob,
  failConsumerPoll,
  type ConsumerJob,
  type ConsumerJobScope,
  type ConsumerJson,
} from "./jobs";
import {
  getConsumerMarketingTemplateQuote,
  submitConsumerMarketingTemplate,
  readConsumerMarketingTemplateJob,
  readMarketingTemplateCatalogue,
  readMarketingTemplateCosts,
  type ConsumerMarketingTemplateShape,
} from "./mcp";
import {
  MarketingTemplateError,
  consumerMarketingTemplateAcknowledgement,
  consumerMarketingTemplateOriginalResult,
  consumerMarketingTemplateFailureResult,
  consumerMarketingTemplateParams,
  findMarketingTemplate,
  listMarketingTemplates,
  parseConsumerMarketingTemplateInput,
  priceForTemplate,
  templateOutputKind,
  type ConsumerMarketingTemplateInput,
  type ConsumerMarketingTemplateParams,
  type MarketingTemplate,
  type MarketingTemplateCatalogue,
  type MarketingTemplateCosts,
  type MarketingTemplateOutputKind,
} from "./marketing-templates";
import { loadMarketingTemplateCatalogue, loadMarketingTemplateCosts } from "./marketing-template-cache";
import { resolveConsumerMarketingTemplateSource, resolveConsumerMarketingTemplateImport } from "./marketing-template-sources";
import { consumerMediaKey } from "./genjutsu-contract";
import { sameConsumerValue } from "./video-contract";
import { collectConsumerVideoOriginal } from "./video-original";
import { consumerOriginalAvailability, type ConsumerOriginalAvailability } from "./video-availability";
import { ConsumerVideoServiceError } from "./video-service";

const QUOTE_LIFETIME_MS = 5 * 60_000;
type TemplateSnapshot = { id: string; name: string; category: string; previewUrl: string | null };
type Snapshot = {
  input: ConsumerMarketingTemplateInput;
  params: ConsumerMarketingTemplateParams;
  shape: ConsumerMarketingTemplateShape;
  priceSource: "get_cost" | "cost_table" | "catalogue";
  costsVersion: string | null;
  workspaceName: string;
  template: TemplateSnapshot;
  outputKind: MarketingTemplateOutputKind;
};
function presentTemplateJob(job: ConsumerJob, availability: ConsumerOriginalAvailability, observedAt: number) {
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  let result = job.resultManifest;
  if (availability !== "available" && result?.original && typeof result.original === "object" && !Array.isArray(result.original))
    result = { ...result, original: Object.fromEntries(Object.entries(result.original).filter(([key]) => key !== "asset")) };
  return {
    id: job.id,
    draftId: job.draftId,
    status: job.status,
    input: snapshot.input,
    template: snapshot.template,
    outputKind: snapshot.outputKind,
    priceSource: snapshot.priceSource,
    costsVersion: snapshot.costsVersion,
    workspaceName: snapshot.workspaceName,
    workspaceId: job.higgsfieldWorkspaceId,
    quoteCredits: job.quoteCredits,
    creditUnit: job.creditUnit,
    quoteExpiresAt: job.quoteExpiresAt,
    quoteExpired: job.status === "quoted" && job.quoteExpiresAt <= observedAt,
    providerJobId: job.providerJobId,
    result,
    originalAvailability: availability,
    originalAvailable: availability === "available",
    providerReceipt: job.providerReceipt,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
  };
}
export type ConsumerMarketingTemplateView = ReturnType<typeof presentTemplateJob>;
export async function consumerMarketingTemplateView(job: ConsumerJob) {
  const observedAt = Date.now();
  if (job.status === "quoted" && job.quoteExpiresAt <= observedAt) {
    const current = await readConsumerJobAfterAdmissions({ id: job.id, userId: job.userId, draftId: job.draftId });
    if (!current) throw new ConsumerJobError("not_found", 404);
    job = current;
  }
  const availability = await consumerOriginalAvailability([job]);
  return presentTemplateJob(job, availability.get(job.id)!, observedAt);
}
async function connected(userId: string, expectedGeneration?: string) {
  const access = await getConsumerAccess(requireTenant().id, userId, { expectedGeneration });
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  return access;
}
/** Cache scope: this tenant, this owner, this authorization generation. */
const fingerprintFor = (userId: string, generation: string) =>
  createHash("sha256").update(`marketing-templates:${requireTenant().id}:${userId}:${generation}`).digest("hex").slice(0, 48);
export async function connectedMarketingTemplateCatalogue(userId: string, options: { refresh?: boolean } = {}): Promise<MarketingTemplateCatalogue> {
  const access = await connected(userId);
  return loadMarketingTemplateCatalogue({
    fingerprint: fingerprintFor(userId, access.generation),
    refresh: options.refresh,
    read: () => readMarketingTemplateCatalogue(access.accessToken, "all"),
  });
}
export async function connectedMarketingTemplateCosts(userId: string, options: { refresh?: boolean } = {}): Promise<MarketingTemplateCosts> {
  const access = await connected(userId);
  return loadMarketingTemplateCosts({
    fingerprint: fingerprintFor(userId, access.generation),
    refresh: options.refresh,
    read: () => readMarketingTemplateCosts(access.accessToken),
  });
}
/** The browse view: filtered templates with their catalogue price when known. */
export function presentMarketingTemplates(
  catalogue: MarketingTemplateCatalogue,
  costs: MarketingTemplateCosts | null,
  options: { category?: string; search?: string; limit?: number } = {},
) {
  const templates = listMarketingTemplates(catalogue, options);
  const limit = Math.min(Math.max(1, options.limit ?? 120), 400);
  return {
    templates: templates.slice(0, limit).map((template) => {
      const price = priceForTemplate(costs, template);
      return {
        id: template.id,
        name: template.name,
        category: template.category,
        description: template.description,
        previewUrl: template.previewUrl,
        outputKind: templateOutputKind(template),
        inputs: template.inputs,
        credits: price?.credits ?? null,
        priceSource: price?.source ?? null,
      };
    }),
    matched: templates.length,
    total: catalogue.total ?? catalogue.templates.length,
    loaded: catalogue.templates.length,
    complete: catalogue.complete,
    fetchedAt: catalogue.fetchedAt,
    categories: [...new Set(catalogue.templates.map((template) => template.category).filter(Boolean))].sort(),
    costsVersion: costs?.version ?? null,
  };
}
async function requireTemplate(userId: string, presetId: string): Promise<{ template: MarketingTemplate; costs: MarketingTemplateCosts | null }> {
  const catalogue = await connectedMarketingTemplateCatalogue(userId);
  const template = findMarketingTemplate(catalogue, presetId);
  if (!template) throw new MarketingTemplateError("template_unknown", "Choose a template from the connected catalogue.");
  let costs: MarketingTemplateCosts | null = null;
  try {
    costs = await connectedMarketingTemplateCosts(userId);
  } catch (error) {
    // A missing cost table is not fatal when the create tool prices itself; pricing decides below.
    if (!(error instanceof MarketingTemplateError)) throw error;
  }
  return { template, costs };
}
const sameInput = (a: unknown, b: ConsumerMarketingTemplateInput) => sameConsumerValue(parseConsumerMarketingTemplateInput(a), b);
export async function quoteConsumerMarketingTemplate(userId: string, draftId: string, value: ConsumerMarketingTemplateInput, idempotencyKey: string) {
  const input = parseConsumerMarketingTemplateInput(value);
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (previous.workflow !== "marketing-template" || !sameInput(stored.input, input)) throw new ConsumerJobError("idempotency_conflict");
    return consumerMarketingTemplateView(previous);
  }
  if (!(await readDraft(userId, draftId)))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a quote.", 404);
  const { template, costs } = await requireTemplate(userId, input.presetId);
  const access = await connected(userId);
  const source = await resolveConsumerMarketingTemplateSource(input);
  const quote = await getConsumerMarketingTemplateQuote(access.accessToken, template, costs, input, source, {
    resolveMedia: async (workspaceId, perform) => {
      await connected(userId, access.generation);
      return resolveConsumerMarketingTemplateImport(
        { userId, draftId, quoteKey: idempotencyKey, request: input, workspaceId, connectionGeneration: access.generation },
        perform,
      );
    },
  });
  await connected(userId, access.generation);
  const payload: Snapshot = {
    input: quote.input,
    params: quote.params,
    shape: quote.shape,
    priceSource: quote.priceSource,
    costsVersion: costs?.version ?? null,
    workspaceName: quote.workspace.name ?? "Connected wallet",
    template: { id: template.id, name: template.name, category: template.category, previewUrl: template.previewUrl },
    outputKind: templateOutputKind(template),
  };
  try {
    const { job } = await createConsumerJob({
      userId,
      draftId,
      connectedOwnerId: userId,
      connectionGeneration: access.generation,
      higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "marketing-template",
      idempotencyKey,
      payload: payload as unknown as { [key: string]: ConsumerJson },
      quoteCredits: quote.credits,
      quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS,
      originalAssetIds: input.productImage ? [consumerMediaKey(input.productImage)] : [],
    });
    return consumerMarketingTemplateView(job);
  } catch (error) {
    if (error instanceof ConsumerJobError && error.code === "idempotency_conflict") {
      const winner = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
      if (winner?.workflow === "marketing-template" && sameInput(JSON.parse(winner.payloadJson).input, input))
        return consumerMarketingTemplateView(winner);
    }
    throw error;
  }
}
async function ownedTemplateJob(input: ConsumerJobScope) {
  const job = await getConsumerJob(input);
  if (!job || job.workflow !== "marketing-template" || job.connectedOwnerId !== input.userId)
    throw new ConsumerVideoServiceError("not_found", "This template job is not available.", 404);
  return job;
}
export async function submitConsumerMarketingTemplateJob(scope: ConsumerJobScope, approval: { workspaceId: string; credits: number }) {
  const job = await ownedTemplateJob(scope);
  if (job.status !== "quoted") return consumerMarketingTemplateView(job);
  if (approval.workspaceId !== job.higgsfieldWorkspaceId || approval.credits !== job.quoteCredits)
    throw new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  const input = parseConsumerMarketingTemplateInput(snapshot.input);
  consumerMarketingTemplateParams(input, snapshot.params.product_image ?? null);
  const { template, costs } = await requireTemplate(scope.userId, input.presetId);
  const access = await connected(scope.userId, job.connectionGeneration);
  let claimToken: string | undefined;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  try {
    const result = await submitConsumerMarketingTemplate(
      access.accessToken, template, costs, input, snapshot.params, snapshot.shape, approval.workspaceId, approval.credits,
      {
        admit: async () => {
          await connected(scope.userId, job.connectionGeneration);
          const claim = await claimConsumerDispatch(scope);
          if (!claim) throw new ConsumerVideoServiceError("already_submitted", "This job already has a submission. Refresh its status.");
          claimToken = claim.claimToken;
        },
      },
    );
    if (!claimToken) throw new ConsumerVideoServiceError("not_admitted", "No paid request was admitted.");
    if (result.raw !== undefined) {
      const serialized = JSON.stringify(result.raw);
      providerReceipt = {
        ...(result.state === "accepted" ? { job_id: result.providerJobId } : {}),
        response: Buffer.byteLength(serialized) > 48000 ? { truncated: true, preview: serialized.slice(0, 20000) } : result.raw,
      };
    }
    const next =
      result.state === "accepted"
        ? await markConsumerAccepted({ ...scope, claimToken, providerJobId: result.providerJobId })
        : await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
    return consumerMarketingTemplateView(next ?? (await ownedTemplateJob(scope)));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    if (claimToken) {
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      return consumerMarketingTemplateView(next ?? (await ownedTemplateJob(scope)));
    }
    throw error;
  }
}
export async function pollConsumerMarketingTemplate(scope: ConsumerJobScope) {
  let prior = await ownedTemplateJob(scope);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const savedId = consumerMarketingTemplateAcknowledgement(prior.providerReceipt);
    const responseId = consumerMarketingTemplateAcknowledgement(prior.providerReceipt.response);
    const providerJobId = savedId && responseId && savedId !== responseId ? null : (savedId ?? responseId);
    if (providerJobId) {
      await connected(scope.userId, prior.connectionGeneration);
      prior = (await reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: prior.providerReceipt })) ?? (await ownedTemplateJob(scope));
    }
  }
  if (prior.status !== "accepted") return { job: await consumerMarketingTemplateView(prior) };
  const access = await connected(scope.userId, prior.connectionGeneration);
  const claim = await claimConsumerPoll(scope);
  if (!claim) return { job: await consumerMarketingTemplateView(await ownedTemplateJob(scope)), pollAfterSeconds: 30 };
  let pollAfterSeconds = 15;
  try {
    const providerJobId = claim.job.providerJobId!;
    const response = await readConsumerMarketingTemplateJob(access.accessToken, providerJobId, claim.job.higgsfieldWorkspaceId!);
    pollAfterSeconds = Math.max(15, response.pollAfterSeconds ?? 30);
    const terminal = consumerMarketingTemplateOriginalResult(response.raw, providerJobId);
    const failed = consumerMarketingTemplateFailureResult(response.raw, providerJobId);
    if (failed) {
      await connected(scope.userId, claim.job.connectionGeneration);
      const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      return { job: await consumerMarketingTemplateView(settled ?? (await ownedTemplateJob(scope))), providerStatus: { status: failed }, pollAfterSeconds };
    }
    if (terminal) {
      await connected(scope.userId, claim.job.connectionGeneration);
      const snapshot = JSON.parse(claim.job.payloadJson) as Snapshot;
      const original = await collectConsumerVideoOriginal(claim.job, terminal.url);
      const completed = await completeConsumerJob({
        ...scope,
        leaseToken: claim.leaseToken,
        resultManifest: { original, providerResult: { template: snapshot.template.id, outputKind: snapshot.outputKind } },
      });
      return { job: await consumerMarketingTemplateView(completed ?? (await ownedTemplateJob(scope))), pollAfterSeconds };
    }
    return { job: await consumerMarketingTemplateView(await ownedTemplateJob(scope)), providerStatus: response.raw, pollAfterSeconds };
  } finally {
    await releaseConsumerPoll({ ...scope, leaseToken: claim.leaseToken, nextPollAt: Date.now() + pollAfterSeconds * 1000 });
  }
}
export async function consumerMarketingTemplateJobs(userId: string, draftId: string) {
  const observedAt = Date.now();
  const jobs = await listConsumerRecoveryJobs({ userId, draftId, workflow: "marketing-template", limit: 25 });
  const availability = await consumerOriginalAvailability(jobs);
  return jobs.map((job) => presentTemplateJob(job, availability.get(job.id)!, observedAt));
}
