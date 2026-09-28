import { createHash } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { readDraft, saveDraft } from "@/lib/workbench/records";
import { newProject } from "@/lib/workbench/studio";
import { approvalMatches, providerDetail, workspaceJobView } from "./client-view";
import { accessForJob, accessForNewWork } from "./access";
import { websiteFunding } from "./funding";
import { acceptWebsiteJob, admitConsumerJob, recordWebsiteSubmission, releaseWebsiteJob, settleEndedWebsiteJob, takeDispatchLease, websiteCallNeverLeft, websitePrice } from "./account-billing";
import {
  ownsConsumerJob,
  createConsumerJob, getConsumerJob, getConsumerJobByKey, listConsumerRecoveryJobs, readConsumerJobAfterAdmissions,
  markConsumerAccepted, markConsumerUncertain, markConsumerFailed,
  claimConsumerPoll, releaseConsumerPoll, ConsumerJobError,
  reconcileConsumerReceipt, completeConsumerJob, failConsumerPoll, consumerJobSetAside,
  type ConsumerJob, type ConsumerJobScope, type ConsumerJson,
} from "./jobs";
import { getConsumerVideoQuote, submitConsumerVideo, readConsumerVideoJob } from "./mcp";
import { parseConsumerVideoInput, consumerVideoAcknowledgement, consumerVideoFailureResult, consumerVideoOriginalResult, consumerVideoProviderResult, type ConsumerVideoInput } from "./video-contract";
import { collectConsumerVideoOriginal, uncollectableOriginal } from "./video-original";
import { setupIdsOfVideoInput } from "./marketing-records";
import { refuseForeignMarketingSetup } from "./marketing-setup";
import { refuseForeignAccountObjects } from "./account-objects";
import { consumerOriginalAvailability, type ConsumerOriginalAvailability } from "./video-availability";

/** The owner-approved verification run. Its creative mode is explicit:
 * without one the provider defaults to UGC, which staged a presenter in the
 * 18 September rehearsal despite the no-people prompt. */
export const MARKETING_VIDEO_REHEARSAL: ConsumerVideoInput = {
  prompt: "A plain reusable bottle on a clean studio background. A short product demo with no people, logos or text.",
  duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true, mode: "product_showcase",
};
const QUOTE_LIFETIME_MS = 5 * 60_000;
/** This service's website tool, for the platform's account (lib/higgsfield-consumer/website-tools.ts). */
const TOOL = "marketing-video" as const;
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
    const project = { ...newProject("Connected-account qualification"), id,
      description: "Internal provider verification. Synthetic product demonstrations only.",
      brief: MARKETING_VIDEO_REHEARSAL.prompt };
    try { await saveDraft(userId, project, 0); }
    catch (error) { if (!await readDraft(userId, id)) throw error; }
  }
  return id;
}
function presentVideo(job: ConsumerJob, availability: ConsumerOriginalAvailability, observedAt: number) {
  const snapshot = JSON.parse(job.payloadJson) as { input: ConsumerVideoInput; workspaceName: string };
  let result = job.resultManifest;
  if (availability !== "available" && result?.original && typeof result.original === "object" && !Array.isArray(result.original))
    result = { ...result, original: Object.fromEntries(Object.entries(result.original).filter(([key]) => key !== "asset")) };
  return workspaceJobView(job, {
    id: job.id, draftId: job.draftId, status: job.status,
    input: snapshot.input, workspaceName: snapshot.workspaceName,
    workspaceId: job.higgsfieldWorkspaceId, quoteCredits: job.quoteCredits,
    creditUnit: job.creditUnit, quoteExpiresAt: job.quoteExpiresAt,
    quoteExpired: job.status === "quoted" && job.quoteExpiresAt <= observedAt,
    providerJobId: job.providerJobId, result,
    originalAvailability: availability, originalAvailable: availability === "available",
    providerReceipt: job.providerReceipt, failureCode: job.failureCode, setAside: consumerJobSetAside(job, observedAt), createdAt: job.createdAt,
  });
}
export async function consumerVideoView(job: ConsumerJob) {
  const observedAt = Date.now();
  // A row read just before expiry may already have admitted a concurrent
  // dispatch. Re-read after expiry before declaring the quote safe to retire.
  if (job.status === "quoted" && job.quoteExpiresAt <= observedAt) {
    const current = await readConsumerJobAfterAdmissions({ id: job.id, userId: job.userId, draftId: job.draftId });
    if (!current) throw new ConsumerJobError("not_found", 404);
    job = current;
  }
  const availability = await consumerOriginalAvailability([job]);
  return presentVideo(job, availability.get(job.id)!, observedAt);
}
export async function quoteConsumerMarketingVideo(userId: string, draftId: string, input: ConsumerVideoInput, idempotencyKey: string) {
  const funding = await websiteFunding({ workflow: "marketing-video" });
  const normalized = parseConsumerVideoInput(input);
  // Standalone: a setup item Particl may not send refuses before anything else.
  await refuseForeignMarketingSetup(userId, setupIdsOfVideoInput(normalized), funding);
  // An element token in the prompt must name one this workspace made.
  await refuseForeignAccountObjects({ prompt: normalized.prompt }, funding);
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (previous.workflow !== "marketing-video" || JSON.stringify(parseConsumerVideoInput(stored.input)) !== JSON.stringify(normalized))
      throw new ConsumerJobError("idempotency_conflict");
    return consumerVideoView(previous);
  }
  if (!await readDraft(userId, draftId))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a quote.", 404);
  const access = await accessForNewWork(userId, funding);
  const quote = await getConsumerVideoQuote(access.accessToken, normalized);
  // Reconnection during the quote cannot bind its result to a replacement grant.
  await accessForNewWork(userId, funding, access.generation);
  // On the platform's account the client's price is Particl credits, converted
  // privately from the account's own price; the account's wallet is never named.
  const platform = funding.kind === "platform_account";
  const particlCredits = platform ? websitePrice(TOOL, quote.credits).particlCredits : undefined;
  try {
    const { job } = await createConsumerJob({ userId, draftId, funding: funding.kind, connectedOwnerId: access.connectedOwnerId,
      connectionGeneration: access.generation, higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "marketing-video", idempotencyKey,
      payload: { input: { ...quote.input }, workspaceName: platform ? "" : quote.workspace.name ?? "connected workspace" },
      quoteCredits: quote.credits, quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS, originalAssetIds: [],
      ...(particlCredits === undefined ? {} : { particlCredits }),
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
  if (!job || job.workflow !== "marketing-video" || !ownsConsumerJob(job, input.userId))
    throw new ConsumerVideoServiceError("not_found", "This marketing job is not available.", 404);
  return job;
}
export async function submitConsumerMarketingVideo(scope: ConsumerJobScope, approval: { workspaceId?: string | null; credits: number }) {
  const job = await ownedVideo(scope);
  if (job.status !== "quoted") return consumerVideoView(job);
  if (!approvalMatches(job, approval))
    throw new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const platform = job.funding === "platform_account";
  // A tool switched off, unpriced or paused since the quote refuses here: nothing is sent.
  if (platform && (await websiteFunding({ workflow: "marketing-video" })).kind !== "platform_account") throw new ConsumerJobError("particl_quote_unavailable", 409);
  const input = parseConsumerVideoInput(JSON.parse(job.payloadJson).input);
  const access = await accessForJob(job);
  let claimToken: string | undefined;
  let admitted = false;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  // One dispatch at a time on the shared account: its last wallet check and its paid call.
  const lease = platform ? await takeDispatchLease() : null;
  try {
    const result = await submitConsumerVideo(access.accessToken, input, job.higgsfieldWorkspaceId!, job.quoteCredits, {
      admit: async () => {
        await accessForJob(job);
        // A platform job's price must still be the approved one; it is reserved, with its registry row, then claimed.
        const token = await admitConsumerJob(scope, job, TOOL);
        if (!token) throw new ConsumerVideoServiceError("already_submitted", "This job already has a submission. Refresh its status.");
        claimToken = token;
        admitted = true;
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
    await recordWebsiteSubmission(job, result);
    return consumerVideoView(next ?? await ownedVideo(scope));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    // Never turn it back into a quote or automatically submit it again.
    if (claimToken) {
      // On the platform's account a call that never left is failed and its
      // reservation released to zero (lib/higgsfield-consumer/account-billing.ts).
      if (websiteCallNeverLeft(job, error, admitted)) {
        const failed = await markConsumerFailed({ ...scope, claimToken });
        if (failed?.status === "failed") await releaseWebsiteJob(job, TOOL);
        return consumerVideoView(failed ?? await ownedVideo(scope));
      }
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      await recordWebsiteSubmission(job, { state: "uncertain" });
      return consumerVideoView(next ?? await ownedVideo(scope));
    }
    throw error;
  } finally {
    await lease?.release();
  }
}
/** A platform job that ended is settled once (also a repair when an earlier
 * poll ended the job but did not reach its settlement). */
const settleEnded = (job: ConsumerJob) => settleEndedWebsiteJob(job, TOOL);
export async function pollConsumerMarketingVideo(scope: ConsumerJobScope) {
  let prior = await ownedVideo(scope);
  await settleEnded(prior);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const savedId = consumerVideoAcknowledgement(prior.providerReceipt);
    const responseId = consumerVideoAcknowledgement(prior.providerReceipt.response);
    // The outer ID survives truncation of a large diagnostic response. Both
    // identifiers must agree if both are present; never scrape its preview.
    const providerJobId = savedId && responseId && savedId !== responseId ? null : savedId ?? responseId;
    if (providerJobId) {
      await accessForJob(prior);
      prior = await reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: prior.providerReceipt }) ?? await ownedVideo(scope);
      if (prior.status === "accepted" && prior.providerJobId && prior.funding === "platform_account") await acceptWebsiteJob(prior, prior.providerJobId);
    }
  }
  if (prior.status !== "accepted") return { job: await consumerVideoView(prior) };
  const access = await accessForJob(prior);
  const claim = await claimConsumerPoll(scope);
  if (!claim) return { job: await consumerVideoView(await ownedVideo(scope)), pollAfterSeconds: 30 };
  let pollAfterSeconds = 15;
  try {
    const response = await readConsumerVideoJob(access.accessToken, claim.job.providerJobId!, claim.job.higgsfieldWorkspaceId!);
    pollAfterSeconds = Math.max(15, response.pollAfterSeconds ?? 30);
    const input = parseConsumerVideoInput(JSON.parse(claim.job.payloadJson).input);
    const terminal = consumerVideoOriginalResult(response.raw, claim.job.providerJobId!, input);
    // The account rejected exactly our video (failed, nsfw, …): it will never
    // be collected. Settle it once, keep the receipt, and free its slot, like
    // every other workflow. A completed reply Particl cannot read (no result
    // yet, another key, settings echoed differently) is diagnostic only and
    // stays accepted: a later poll, or a parser fix, may still collect it.
    const failed = consumerVideoFailureResult(response.raw, claim.job.providerJobId!);
    if (failed) {
      await accessForJob(claim.job);
      const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      if (settled) await settleEnded(settled);
      return { job: await consumerVideoView(settled ?? await ownedVideo(scope)), providerStatus: providerDetail(claim.job, { status: failed }), pollAfterSeconds };
    }
    if (terminal) {
      // A refresh is the same grant; reconnect/disconnect during the read cannot
      // authorize collection under a replacement connection.
      await accessForJob(claim.job);
      const providerResult = consumerVideoProviderResult(response.raw, input);
      let original;
      try {
        original = await collectConsumerVideoOriginal(claim.job, terminal.url, { enhancedPrompt: providerResult.enhancedPrompt });
      } catch (error) {
        // Refused the same way on every poll: settle once, receipt kept.
        if (!uncollectableOriginal(error)) throw error;
        const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "invalid_result" });
        if (settled) await settleEnded(settled);
        return { job: await consumerVideoView(settled ?? await ownedVideo(scope)), collection: { code: error.code, message: error.message }, pollAfterSeconds };
      }
      const completed = await completeConsumerJob({ ...scope, leaseToken: claim.leaseToken, resultManifest: { original, providerResult } });
      if (completed) await settleEnded(completed);
      // An expired/stolen lease cannot publish stale completion. The committed
      // original remains recoverable by the next admitted poll.
      return { job: await consumerVideoView(completed ?? await ownedVideo(scope)), pollAfterSeconds };
    }
    return { job: await consumerVideoView(await ownedVideo(scope)), providerStatus: providerDetail(claim.job, response.raw), pollAfterSeconds };
  } finally { await releaseConsumerPoll({ ...scope, leaseToken: claim.leaseToken, nextPollAt: Date.now() + pollAfterSeconds * 1000 }); }
}
export async function consumerMarketingJobs(userId: string, draftId?: string) {
  const observedAt = Date.now();
  const jobs = await listConsumerRecoveryJobs({ userId, draftId: draftId ?? rehearsalId(userId), workflow: "marketing-video", limit: 25 });
  const availability = await consumerOriginalAvailability(jobs);
  return jobs.map(job => presentVideo(job, availability.get(job.id)!, observedAt));
}
