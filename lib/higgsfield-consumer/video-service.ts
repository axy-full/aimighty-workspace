import { createHash } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { readDraft, saveDraft } from "@/lib/workbench/records";
import { newProject } from "@/lib/workbench/studio";
import { ConsumerOAuthError, getConsumerAccess } from "./oauth";
import {
  createConsumerJob, getConsumerJob, getConsumerJobByKey, listConsumerJobs,
  claimConsumerDispatch, markConsumerAccepted, markConsumerUncertain,
  claimConsumerPoll, releaseConsumerPoll, ConsumerJobError,
  type ConsumerJob, type ConsumerJobScope, type ConsumerJson,
} from "./jobs";
import { getConsumerVideoQuote, submitConsumerVideo, readConsumerVideoJob } from "./mcp";
import { parseConsumerVideoInput, type ConsumerVideoInput } from "./video-contract";

export const MARKETING_VIDEO_REHEARSAL: ConsumerVideoInput = {
  prompt: "A plain reusable bottle on a clean studio background. A short product demo with no people, logos or text.",
  duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true,
};
const QUOTE_LIFETIME_MS = 5 * 60_000;
export class ConsumerVideoServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}
function rehearsalId(userId: string) {
  return `hf-verification-${createHash("sha256").update(`${requireTenant().id}:${userId}`).digest("hex").slice(0,20)}`;
}
export async function ensureConsumerRehearsal(userId: string) {
  const id = rehearsalId(userId);
  if (!await readDraft(userId, id)) {
    const project = { ...newProject("Higgsfield qualification"), id,
      description: "Internal provider verification. Synthetic product demonstrations only.",
      brief: MARKETING_VIDEO_REHEARSAL.prompt };
    try { await saveDraft(userId, project, 0); }
    catch (error) { if (!await readDraft(userId, id)) throw error; }
  }
  return id;
}
export function consumerVideoView(job: ConsumerJob) {
  const snapshot = JSON.parse(job.payloadJson) as { input: ConsumerVideoInput; workspaceName: string };
  return {
    id: job.id, draftId: job.draftId, status: job.status,
    input: snapshot.input, workspaceName: snapshot.workspaceName,
    workspaceId: job.higgsfieldWorkspaceId, quoteCredits: job.quoteCredits,
    creditUnit: job.creditUnit, quoteExpiresAt: job.quoteExpiresAt,
    providerJobId: job.providerJobId, result: job.resultManifest,
    providerReceipt: job.providerReceipt, createdAt: job.createdAt,
  };
}
async function connected(userId: string, expectedGeneration?: string) {
  const access = await getConsumerAccess(requireTenant().id, userId, { expectedGeneration });
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  return access;
}
export async function quoteConsumerMarketingVideo(userId: string, draftId: string, input: ConsumerVideoInput, idempotencyKey: string) {
  const normalized = parseConsumerVideoInput(input);
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (previous.workflow !== "marketing-video" || JSON.stringify(parseConsumerVideoInput(stored.input)) !== JSON.stringify(normalized))
      throw new ConsumerJobError("idempotency_conflict");
    return consumerVideoView(previous);
  }
  if (!await readDraft(userId, draftId))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a Higgsfield quote.", 404);
  const access = await connected(userId);
  const quote = await getConsumerVideoQuote(access.accessToken, normalized);
  // Reconnection during the quote cannot bind its result to a replacement grant.
  await connected(userId, access.generation);
  try {
    const { job } = await createConsumerJob({ userId, draftId, connectedOwnerId: userId,
      connectionGeneration: access.generation, higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "marketing-video", idempotencyKey,
      payload: { input: { ...quote.input }, workspaceName: quote.workspace.name ?? "Higgsfield workspace" },
      quoteCredits: quote.credits, quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS, originalAssetIds: [],
    });
    return consumerVideoView(job);
  } catch (error) {
    if (error instanceof ConsumerJobError && error.code === "idempotency_conflict") {
      const winner = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
      if (winner?.workflow === "marketing-video" && JSON.stringify(parseConsumerVideoInput(JSON.parse(winner.payloadJson).input)) === JSON.stringify(normalized))
        return consumerVideoView(winner);
    }
    throw error;
  }
}
async function ownedVideo(input: ConsumerJobScope) {
  const job = await getConsumerJob(input);
  if (!job || job.workflow !== "marketing-video" || job.connectedOwnerId !== input.userId)
    throw new ConsumerVideoServiceError("not_found", "This marketing job is not available.", 404);
  return job;
}
export async function submitConsumerMarketingVideo(scope: ConsumerJobScope, approval: { workspaceId: string; credits: number }) {
  const job = await ownedVideo(scope);
  if (job.status !== "quoted") return consumerVideoView(job);
  if (approval.workspaceId !== job.higgsfieldWorkspaceId || approval.credits !== job.quoteCredits)
    throw new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const input = parseConsumerVideoInput(JSON.parse(job.payloadJson).input);
  const access = await connected(scope.userId, job.connectionGeneration);
  let claimToken: string | undefined;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  try {
    const result = await submitConsumerVideo(access.accessToken, input, approval.workspaceId, approval.credits, {
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
    const next = result.state === "accepted"
      ? await markConsumerAccepted({ ...scope, claimToken, providerJobId: result.providerJobId })
      : await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
    return consumerVideoView(next ?? await ownedVideo(scope));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    // Never turn it back into a quote or automatically submit it again.
    if (claimToken) {
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      return consumerVideoView(next ?? await ownedVideo(scope));
    }
    throw error;
  }
}
export async function pollConsumerMarketingVideo(scope: ConsumerJobScope) {
  const prior = await ownedVideo(scope);
  if (prior.status !== "accepted") return { job: consumerVideoView(prior) };
  const access = await connected(scope.userId, prior.connectionGeneration);
  const claim = await claimConsumerPoll(scope);
  if (!claim) return { job: consumerVideoView(await ownedVideo(scope)), pollAfterSeconds: 30 };
  let pollAfterSeconds = 15;
  try {
    const response = await readConsumerVideoJob(access.accessToken, claim.job.providerJobId!, claim.job.higgsfieldWorkspaceId!);
    // A provider acknowledgement is not yet a collected original. The collector
    // must verify its actual result contract before marking this job complete.
    pollAfterSeconds = Math.max(15, response.pollAfterSeconds ?? 30);
    return { job: consumerVideoView(await ownedVideo(scope)), providerStatus: response.raw, pollAfterSeconds };
  } finally { await releaseConsumerPoll({ ...scope, leaseToken: claim.leaseToken, nextPollAt: Date.now() + pollAfterSeconds * 1000 }); }
}
export async function consumerMarketingJobs(userId: string, draftId?: string) {
  const result = await listConsumerJobs({ userId, draftId: draftId ?? rehearsalId(userId), limit: 25 });
  return result.items.filter(job => job.workflow === "marketing-video").map(consumerVideoView);
}
