/**
 * Durable "generation" workflow for the connected account: catalogue read →
 * validated quote (get_cost) → owner approval of the exact connected-credit
 * price → one admitted submit → leased status polling → original collection
 * into private storage and the project library. Same claim/uncertain/receipt
 * semantics as the Genjutsu service; no automatic retries of paid calls.
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
  getConsumerGenerationQuote,
  submitConsumerGeneration,
  readConsumerGenerationJob,
  readConnectedCatalogue,
} from "./mcp";
import {
  parseConsumerGenerationInput,
  consumerGenerationAcknowledgement,
  consumerGenerationOriginalResult,
  consumerGenerationFailureResult,
  type ConsumerGenerationInput,
  type ConsumerGenerationParams,
} from "./generation-contract";
import {
  CatalogueError,
  findCatalogueModel,
  listCatalogueModels,
  loadConnectedCatalogue,
  type ConnectedCatalogue,
  type ConnectedModel,
  type ConnectedOutputType,
} from "./catalogue";
import { resolveConsumerGenerationSources, resolveConsumerGenerationImport } from "./generation-sources";
import { consumerMediaKey } from "./genjutsu-contract";
import { collectConsumerVideoOriginal } from "./video-original";
import { consumerOriginalAvailability, type ConsumerOriginalAvailability } from "./video-availability";
import { ConsumerVideoServiceError } from "./video-service";

const QUOTE_LIFETIME_MS = 5 * 60_000;
type Snapshot = {
  input: ConsumerGenerationInput;
  params: ConsumerGenerationParams;
  workspaceName: string;
  model: { id: string; name: string; outputType: ConnectedOutputType };
};
function presentGeneration(job: ConsumerJob, availability: ConsumerOriginalAvailability, observedAt: number) {
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  let result = job.resultManifest;
  if (availability !== "available" && result?.original && typeof result.original === "object" && !Array.isArray(result.original))
    result = { ...result, original: Object.fromEntries(Object.entries(result.original).filter(([key]) => key !== "asset")) };
  return {
    id: job.id,
    draftId: job.draftId,
    status: job.status,
    input: snapshot.input,
    model: snapshot.model,
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
export type ConsumerGenerationView = ReturnType<typeof presentGeneration>;
export async function consumerGenerationView(job: ConsumerJob) {
  const observedAt = Date.now();
  if (job.status === "quoted" && job.quoteExpiresAt <= observedAt) {
    const current = await readConsumerJobAfterAdmissions({ id: job.id, userId: job.userId, draftId: job.draftId });
    if (!current) throw new ConsumerJobError("not_found", 404);
    job = current;
  }
  const availability = await consumerOriginalAvailability([job]);
  return presentGeneration(job, availability.get(job.id)!, observedAt);
}
async function connected(userId: string, expectedGeneration?: string) {
  const access = await getConsumerAccess(requireTenant().id, userId, { expectedGeneration });
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  return access;
}
/** Cache scope: this tenant, this owner, this authorization generation. */
const fingerprintFor = (userId: string, generation: string) =>
  createHash("sha256").update(`${requireTenant().id}:${userId}:${generation}`).digest("hex").slice(0, 48);
export async function connectedGenerationCatalogue(userId: string, options: { refresh?: boolean } = {}): Promise<ConnectedCatalogue> {
  const access = await connected(userId);
  return loadConnectedCatalogue({
    fingerprint: fingerprintFor(userId, access.generation),
    refresh: options.refresh,
    read: () => readConnectedCatalogue(access.accessToken),
  });
}
export const presentCatalogue = (catalogue: ConnectedCatalogue, type?: ConnectedOutputType) => ({
  models: listCatalogueModels(catalogue, { type }),
  unlim: catalogue.unlim,
  complete: catalogue.complete,
  fetchedAt: catalogue.fetchedAt,
});
async function requireModel(userId: string, input: ConsumerGenerationInput): Promise<ConnectedModel> {
  const catalogue = await connectedGenerationCatalogue(userId);
  const model = findCatalogueModel(catalogue, input.model);
  if (!model) throw new CatalogueError("model_unknown", "Choose a model from the connected catalogue.");
  return model;
}
const sameInput = (a: unknown, b: ConsumerGenerationInput) =>
  JSON.stringify(parseConsumerGenerationInput(a)) === JSON.stringify(b);
export async function quoteConsumerGeneration(userId: string, draftId: string, input: ConsumerGenerationInput, idempotencyKey: string) {
  const normalized = parseConsumerGenerationInput(input);
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (previous.workflow !== "generation" || !sameInput(stored.input, normalized)) throw new ConsumerJobError("idempotency_conflict");
    return consumerGenerationView(previous);
  }
  if (!(await readDraft(userId, draftId)))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a quote.", 404);
  const model = await requireModel(userId, normalized);
  const access = await connected(userId);
  const sources = await resolveConsumerGenerationSources(normalized);
  const quote = await getConsumerGenerationQuote(access.accessToken, model, normalized, sources, {
    resolveMedia: async (index, workspaceId, perform) => {
      await connected(userId, access.generation);
      return resolveConsumerGenerationImport(
        { userId, draftId, quoteKey: idempotencyKey, sourceIndex: index, request: normalized, workspaceId, connectionGeneration: access.generation },
        perform,
      );
    },
  });
  await connected(userId, access.generation);
  const payload: Snapshot = {
    input: quote.input,
    params: quote.params,
    workspaceName: quote.workspace.name ?? "Connected wallet",
    model: { id: model.id, name: model.name, outputType: model.outputType },
  };
  try {
    const { job } = await createConsumerJob({
      userId,
      draftId,
      connectedOwnerId: userId,
      connectionGeneration: access.generation,
      higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "generation",
      idempotencyKey,
      payload: payload as unknown as { [key: string]: ConsumerJson },
      quoteCredits: quote.credits,
      quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS,
      originalAssetIds: normalized.medias.map((media) => consumerMediaKey(media.source)),
    });
    return consumerGenerationView(job);
  } catch (error) {
    if (error instanceof ConsumerJobError && error.code === "idempotency_conflict") {
      const winner = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
      if (winner?.workflow === "generation" && sameInput(JSON.parse(winner.payloadJson).input, normalized))
        return consumerGenerationView(winner);
    }
    throw error;
  }
}
async function ownedGeneration(input: ConsumerJobScope) {
  const job = await getConsumerJob(input);
  if (!job || job.workflow !== "generation" || job.connectedOwnerId !== input.userId)
    throw new ConsumerVideoServiceError("not_found", "This generation job is not available.", 404);
  return job;
}
export async function submitConsumerGenerationJob(scope: ConsumerJobScope, approval: { workspaceId: string; credits: number }) {
  const job = await ownedGeneration(scope);
  if (job.status !== "quoted") return consumerGenerationView(job);
  if (approval.workspaceId !== job.higgsfieldWorkspaceId || approval.credits !== job.quoteCredits)
    throw new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  const input = parseConsumerGenerationInput(snapshot.input);
  const model = await requireModel(scope.userId, input);
  const access = await connected(scope.userId, job.connectionGeneration);
  let claimToken: string | undefined;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  try {
    const result = await submitConsumerGeneration(access.accessToken, model, input, snapshot.params, approval.workspaceId, approval.credits, {
      admit: async () => {
        await connected(scope.userId, job.connectionGeneration);
        const claim = await claimConsumerDispatch(scope);
        if (!claim) throw new ConsumerVideoServiceError("already_submitted", "This job already has a submission. Refresh its status.");
        claimToken = claim.claimToken;
      },
    });
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
    return consumerGenerationView(next ?? (await ownedGeneration(scope)));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    if (claimToken) {
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      return consumerGenerationView(next ?? (await ownedGeneration(scope)));
    }
    throw error;
  }
}
export async function pollConsumerGeneration(scope: ConsumerJobScope) {
  let prior = await ownedGeneration(scope);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const snapshot = JSON.parse(prior.payloadJson) as Snapshot;
    const savedId = consumerGenerationAcknowledgement(prior.providerReceipt, snapshot.params.model, snapshot.input.type);
    const responseId = consumerGenerationAcknowledgement(prior.providerReceipt.response, snapshot.params.model, snapshot.input.type);
    const providerJobId = savedId && responseId && savedId !== responseId ? null : (savedId ?? responseId);
    if (providerJobId) {
      await connected(scope.userId, prior.connectionGeneration);
      prior = (await reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: prior.providerReceipt })) ?? (await ownedGeneration(scope));
    }
  }
  if (prior.status !== "accepted") return { job: await consumerGenerationView(prior) };
  const access = await connected(scope.userId, prior.connectionGeneration);
  const claim = await claimConsumerPoll(scope);
  if (!claim) return { job: await consumerGenerationView(await ownedGeneration(scope)), pollAfterSeconds: 30 };
  let pollAfterSeconds = 15;
  try {
    const snapshot = JSON.parse(claim.job.payloadJson) as Snapshot;
    const response = await readConsumerGenerationJob(
      access.accessToken,
      claim.job.providerJobId!,
      claim.job.higgsfieldWorkspaceId!,
      snapshot.params.model,
      snapshot.input.type,
    );
    pollAfterSeconds = Math.max(15, response.pollAfterSeconds ?? 30);
    const terminal = consumerGenerationOriginalResult(response.raw, claim.job.providerJobId!, snapshot.params, snapshot.input.type);
    const failed = consumerGenerationFailureResult(response.raw, claim.job.providerJobId!, snapshot.params, snapshot.input.type);
    if (failed) {
      await connected(scope.userId, claim.job.connectionGeneration);
      const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      return { job: await consumerGenerationView(settled ?? (await ownedGeneration(scope))), providerStatus: { status: failed }, pollAfterSeconds };
    }
    if (terminal) {
      await connected(scope.userId, claim.job.connectionGeneration);
      const original = await collectConsumerVideoOriginal(claim.job, terminal.url);
      const completed = await completeConsumerJob({
        ...scope,
        leaseToken: claim.leaseToken,
        resultManifest: { original, providerResult: { model: snapshot.params.model, type: snapshot.input.type } },
      });
      return { job: await consumerGenerationView(completed ?? (await ownedGeneration(scope))), pollAfterSeconds };
    }
    return { job: await consumerGenerationView(await ownedGeneration(scope)), providerStatus: response.raw, pollAfterSeconds };
  } finally {
    await releaseConsumerPoll({ ...scope, leaseToken: claim.leaseToken, nextPollAt: Date.now() + pollAfterSeconds * 1000 });
  }
}
export async function consumerGenerationJobs(userId: string, draftId: string) {
  const observedAt = Date.now();
  const jobs = await listConsumerRecoveryJobs({ userId, draftId, workflow: "generation", limit: 25 });
  const availability = await consumerOriginalAvailability(jobs);
  return jobs.map((job) => presentGeneration(job, availability.get(job.id)!, observedAt));
}
