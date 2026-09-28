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
import { readDraft } from "@/lib/workbench/records";
import { approvalMatches, providerDetail, workspaceJobView } from "./client-view";
import { accessForJob, accessForNewWork, consumerCacheScope, type ResolvedAccess } from "./access";
import { refuseForeignAccountObjects } from "./account-objects";
import { OWN_ACCOUNT, jobFunding, websiteFunding, type ConsumerFunding } from "./funding";
import {
  acceptWebsiteJob, admitConsumerJob, recordWebsiteSubmission, releaseWebsiteJob, settleEndedWebsiteJob, takeDispatchLease, websiteCallNeverLeft, websitePrice,
} from "./account-billing";
import {
  ownsConsumerJob,
  createConsumerJob,
  getConsumerJob,
  getConsumerJobByKey,
  listConsumerRecoveryJobs,
  readConsumerJobAfterAdmissions,
  markConsumerAccepted,
  markConsumerUncertain,
  markConsumerFailed,
  claimConsumerPoll,
  releaseConsumerPoll,
  ConsumerJobError,
  reconcileConsumerReceipt,
  completeConsumerJob,
  failConsumerPoll,
  consumerJobSetAside,
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
import { collectConsumerVideoOriginal, uncollectableOriginal } from "./video-original";
import { consumerOriginalAvailability, type ConsumerOriginalAvailability } from "./video-availability";
import { ConsumerVideoServiceError } from "./video-service";

const QUOTE_LIFETIME_MS = 5 * 60_000;
/** This service's website tool, for the platform's account (lib/higgsfield-consumer/website-tools.ts). */
const TOOL = "marketing-template" as const;
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
  return workspaceJobView(job, {
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
    setAside: consumerJobSetAside(job, observedAt),
    createdAt: job.createdAt,
  });
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
/** Cache scope: this tenant, the connection it reads with, and its authorization generation. */
const fingerprintFor = (userId: string, access: ResolvedAccess) =>
  createHash("sha256").update(`marketing-templates:${consumerCacheScope(userId, access)}`).digest("hex").slice(0, 48);
export async function connectedMarketingTemplateCatalogue(userId: string, options: { refresh?: boolean; funding?: ConsumerFunding } = {}): Promise<MarketingTemplateCatalogue> {
  const access = await accessForNewWork(userId, options.funding ?? OWN_ACCOUNT);
  return loadMarketingTemplateCatalogue({
    fingerprint: fingerprintFor(userId, access),
    refresh: options.refresh,
    read: () => readMarketingTemplateCatalogue(access.accessToken, "all"),
  });
}
export async function connectedMarketingTemplateCosts(userId: string, options: { refresh?: boolean; funding?: ConsumerFunding } = {}): Promise<MarketingTemplateCosts> {
  const access = await accessForNewWork(userId, options.funding ?? OWN_ACCOUNT);
  return loadMarketingTemplateCosts({
    fingerprint: fingerprintFor(userId, access),
    refresh: options.refresh,
    read: () => readMarketingTemplateCosts(access.accessToken),
  });
}
/** The browse view never publishes an upstream wallet price as a retail quote. */
export function presentMarketingTemplates(
  catalogue: MarketingTemplateCatalogue,
  costs: MarketingTemplateCosts | null,
  options: { category?: string; search?: string; limit?: number; outputKind?: MarketingTemplateOutputKind } = {},
) {
  // Only one kind when asked (the platform's website account runs video templates only).
  const kept = (template: MarketingTemplate) => !options.outputKind || templateOutputKind(template) === options.outputKind;
  const templates = listMarketingTemplates(catalogue, options).filter(kept);
  const limit = Math.min(Math.max(1, options.limit ?? 120), 400);
  return {
    templates: templates.slice(0, limit).map((template) => {
      return {
        id: template.id,
        name: template.name,
        category: template.category,
        description: template.description,
        previewUrl: template.previewUrl,
        outputKind: templateOutputKind(template),
        inputs: template.inputs,
        credits: null,
        priceSource: null,
      };
    }),
    matched: templates.length,
    total: catalogue.total ?? catalogue.templates.length,
    loaded: catalogue.templates.length,
    complete: catalogue.complete,
    fetchedAt: catalogue.fetchedAt,
    categories: [...new Set(catalogue.templates.filter(kept).map((template) => template.category).filter(Boolean))].sort(),
    costsVersion: costs?.version ?? null,
  };
}
async function requireTemplate(userId: string, presetId: string, funding: ConsumerFunding = OWN_ACCOUNT): Promise<{ template: MarketingTemplate; costs: MarketingTemplateCosts | null }> {
  const catalogue = await connectedMarketingTemplateCatalogue(userId, { funding });
  const template = findMarketingTemplate(catalogue, presetId);
  if (!template) throw new MarketingTemplateError("template_unknown", "Choose a template from the connected catalogue.");
  let costs: MarketingTemplateCosts | null = null;
  try {
    costs = await connectedMarketingTemplateCosts(userId, { funding });
  } catch (error) {
    // A missing cost table is not fatal when the create tool prices itself; pricing decides below.
    if (!(error instanceof MarketingTemplateError)) throw error;
  }
  return { template, costs };
}
const sameInput = (a: unknown, b: ConsumerMarketingTemplateInput) => sameConsumerValue(parseConsumerMarketingTemplateInput(a), b);
export async function quoteConsumerMarketingTemplate(userId: string, draftId: string, value: ConsumerMarketingTemplateInput, idempotencyKey: string) {
  const funding = await websiteFunding({ workflow: "marketing-template" });
  const input = parseConsumerMarketingTemplateInput(value);
  // An element token in the prompt must name one this workspace made.
  await refuseForeignAccountObjects({ prompt: input.prompt }, funding);
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (previous.workflow !== "marketing-template" || !sameInput(stored.input, input)) throw new ConsumerJobError("idempotency_conflict");
    return consumerMarketingTemplateView(previous);
  }
  if (!(await readDraft(userId, draftId)))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a quote.", 404);
  const { template, costs } = await requireTemplate(userId, input.presetId, funding);
  // On the platform's account: video templates the account prices itself, only.
  // Image templates are served from the API's presets instead.
  const platform = funding.kind === "platform_account";
  if (platform && templateOutputKind(template) !== "video") throw new ConsumerJobError("particl_quote_unavailable", 409);
  const access = await accessForNewWork(userId, funding);
  const source = await resolveConsumerMarketingTemplateSource(input);
  let quote: Awaited<ReturnType<typeof getConsumerMarketingTemplateQuote>>;
  try {
    quote = await getConsumerMarketingTemplateQuote(access.accessToken, template, costs, input, source, {
      requireGetCost: platform,
      resolveMedia: async (workspaceId, perform) => {
        await accessForNewWork(userId, funding, access.generation);
        return resolveConsumerMarketingTemplateImport(
          { userId, draftId, quoteKey: idempotencyKey, request: input, workspaceId, connectionGeneration: access.generation },
          perform,
        );
      },
    });
  } catch (error) {
    // A template the account cannot price itself is not offered on its shared account.
    if (platform && error instanceof MarketingTemplateError && error.code === "price_unknown") throw new ConsumerJobError("particl_quote_unavailable", 409);
    throw error;
  }
  await accessForNewWork(userId, funding, access.generation);
  if (platform && quote.priceSource !== "get_cost") throw new ConsumerJobError("particl_quote_unavailable", 409);
  const particlCredits = platform ? websitePrice(TOOL, quote.credits).particlCredits : undefined;
  const payload: Snapshot = {
    input: quote.input,
    params: quote.params,
    shape: quote.shape,
    priceSource: quote.priceSource,
    costsVersion: costs?.version ?? null,
    workspaceName: platform ? "" : quote.workspace.name ?? "Connected wallet",
    template: { id: template.id, name: template.name, category: template.category, previewUrl: template.previewUrl },
    outputKind: templateOutputKind(template),
  };
  try {
    const { job } = await createConsumerJob({
      userId,
      draftId,
      funding: funding.kind,
      connectedOwnerId: access.connectedOwnerId,
      connectionGeneration: access.generation,
      higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "marketing-template",
      idempotencyKey,
      payload: payload as unknown as { [key: string]: ConsumerJson },
      quoteCredits: quote.credits,
      quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS,
      originalAssetIds: input.productImage ? [consumerMediaKey(input.productImage)] : [],
      ...(particlCredits === undefined ? {} : { particlCredits }),
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
  if (!job || job.workflow !== "marketing-template" || !ownsConsumerJob(job, input.userId))
    throw new ConsumerVideoServiceError("not_found", "This template job is not available.", 404);
  return job;
}
export async function submitConsumerMarketingTemplateJob(scope: ConsumerJobScope, approval: { workspaceId?: string | null; credits: number }) {
  const job = await ownedTemplateJob(scope);
  if (job.status !== "quoted") return consumerMarketingTemplateView(job);
  if (!approvalMatches(job, approval))
    throw new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const platform = job.funding === "platform_account";
  // A tool switched off, unpriced or paused since the quote refuses here: nothing is sent.
  if (platform && (await websiteFunding({ workflow: "marketing-template" })).kind !== "platform_account") throw new ConsumerJobError("particl_quote_unavailable", 409);
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  if (platform && (snapshot.priceSource !== "get_cost" || snapshot.outputKind !== "video")) throw new ConsumerJobError("particl_quote_unavailable", 409);
  const input = parseConsumerMarketingTemplateInput(snapshot.input);
  consumerMarketingTemplateParams(input, snapshot.params.product_image ?? null);
  const { template, costs } = await requireTemplate(scope.userId, input.presetId, jobFunding(job));
  const access = await accessForJob(job);
  let claimToken: string | undefined;
  let admitted = false;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  // One dispatch at a time on the shared account: its last wallet check and its paid call.
  const lease = platform ? await takeDispatchLease() : null;
  try {
    const result = await submitConsumerMarketingTemplate(
      access.accessToken, template, costs, input, snapshot.params, snapshot.shape, job.higgsfieldWorkspaceId!, job.quoteCredits,
      {
        admit: async () => {
          await accessForJob(job);
          // A platform job's price must still be the approved one; it is reserved, with its registry row, then claimed.
          const token = await admitConsumerJob(scope, job, TOOL);
          if (!token) throw new ConsumerVideoServiceError("already_submitted", "This job already has a submission. Refresh its status.");
          claimToken = token;
          admitted = true;
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
    await recordWebsiteSubmission(job, result);
    return consumerMarketingTemplateView(next ?? (await ownedTemplateJob(scope)));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    if (claimToken) {
      // On the platform's account a call that never left is failed and its
      // reservation released to zero (lib/higgsfield-consumer/account-billing.ts).
      if (websiteCallNeverLeft(job, error, admitted)) {
        const failed = await markConsumerFailed({ ...scope, claimToken });
        if (failed?.status === "failed") await releaseWebsiteJob(job, TOOL);
        return consumerMarketingTemplateView(failed ?? (await ownedTemplateJob(scope)));
      }
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      await recordWebsiteSubmission(job, { state: "uncertain" });
      return consumerMarketingTemplateView(next ?? (await ownedTemplateJob(scope)));
    }
    throw error;
  } finally {
    await lease?.release();
  }
}
/** A platform job that ended is settled once (also a repair when an earlier
 * poll ended the job but did not reach its settlement). */
const settleEnded = (job: ConsumerJob) => settleEndedWebsiteJob(job, TOOL);
export async function pollConsumerMarketingTemplate(scope: ConsumerJobScope) {
  let prior = await ownedTemplateJob(scope);
  await settleEnded(prior);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const savedId = consumerMarketingTemplateAcknowledgement(prior.providerReceipt);
    const responseId = consumerMarketingTemplateAcknowledgement(prior.providerReceipt.response);
    const providerJobId = savedId && responseId && savedId !== responseId ? null : (savedId ?? responseId);
    if (providerJobId) {
      await accessForJob(prior);
      prior = (await reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: prior.providerReceipt })) ?? (await ownedTemplateJob(scope));
      if (prior.status === "accepted" && prior.providerJobId && prior.funding === "platform_account") await acceptWebsiteJob(prior, prior.providerJobId);
    }
  }
  if (prior.status !== "accepted") return { job: await consumerMarketingTemplateView(prior) };
  const access = await accessForJob(prior);
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
      await accessForJob(claim.job);
      const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      if (settled) await settleEnded(settled);
      return { job: await consumerMarketingTemplateView(settled ?? (await ownedTemplateJob(scope))), providerStatus: providerDetail(claim.job, { status: failed }), pollAfterSeconds };
    }
    if (terminal) {
      await accessForJob(claim.job);
      const snapshot = JSON.parse(claim.job.payloadJson) as Snapshot;
      let original;
      try {
        original = await collectConsumerVideoOriginal(claim.job, terminal.url);
      } catch (error) {
        // Refused the same way on every poll: settle once, receipt kept.
        if (!uncollectableOriginal(error)) throw error;
        const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "invalid_result" });
        if (settled) await settleEnded(settled);
        return { job: await consumerMarketingTemplateView(settled ?? (await ownedTemplateJob(scope))), collection: { code: error.code, message: error.message }, pollAfterSeconds };
      }
      const completed = await completeConsumerJob({
        ...scope,
        leaseToken: claim.leaseToken,
        resultManifest: { original, providerResult: { template: snapshot.template.id, outputKind: snapshot.outputKind } },
      });
      if (completed) await settleEnded(completed);
      return { job: await consumerMarketingTemplateView(completed ?? (await ownedTemplateJob(scope))), pollAfterSeconds };
    }
    return { job: await consumerMarketingTemplateView(await ownedTemplateJob(scope)), providerStatus: providerDetail(claim.job, response.raw), pollAfterSeconds };
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
