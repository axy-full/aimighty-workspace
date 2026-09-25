/**
 * Durable "voice-tool" workflow for the connected account (Atomik Generate,
 * slice I3): cached voice listing → validated quote (the tool's own get_cost
 * form, verified against its advertised schema, or refused as price_unknown
 * before any import) → owner approval of the exact connected-credit price →
 * one admitted create → leased status polling → a revoiced/dubbed video
 * collected into private storage and the project library, or an analysis
 * report kept on the job as a bounded note. Same claim, uncertain and receipt
 * semantics as the Generate service; no automatic retries of paid calls.
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
  consumerJobSetAside,
  type ConsumerJob,
  type ConsumerJobScope,
  type ConsumerJson,
} from "./jobs";
import { getConsumerVoiceToolQuote, submitConsumerVoiceTool, readConsumerVoiceToolJob, readConnectedVoices } from "./mcp";
import {
  VoiceToolError,
  consumerVoiceToolAcknowledgement,
  consumerVoiceToolOriginalResult,
  consumerVoiceToolFailureResult,
  consumerVideoAnalysisReport,
  consumerVideoAnalysisFailure,
  consumerVoiceToolParams,
  consumerVoiceToolSourceKey,
  parseConsumerVoiceToolInput,
  requireVoiceTool,
  type ConnectedVoices,
  type ConsumerVoiceToolInput,
  type ConsumerVoiceToolParams,
  type VoiceToolShape,
} from "./voice-tools";
import { loadConnectedVoices } from "./voices-cache";
import { describeConsumerVoiceToolSource, resolveConsumerVoiceToolSource, resolveConsumerVoiceToolImport } from "./voice-tool-sources";
import { sameConsumerValue } from "./video-contract";
import { CONSUMER_ORIGINAL_SECONDS, collectConsumerVideoOriginal, uncollectableOriginal } from "./video-original";
import { consumerOriginalAvailability, type ConsumerOriginalAvailability } from "./video-availability";
import { ConsumerVideoServiceError } from "./video-service";

const QUOTE_LIFETIME_MS = 5 * 60_000;
/** Analyse video stays off: no price preflight and an unverified report schema (19 September 2026). */
export const VIDEO_ANALYSIS_ENABLED = process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED === "1";
type Snapshot = {
  input: ConsumerVoiceToolInput;
  params: ConsumerVoiceToolParams;
  shape: VoiceToolShape;
  priceSource: "get_cost";
  workspaceName: string;
  tool: { name: ConsumerVoiceToolInput["tool"]; label: string; suffix: string; output: "video" | "report" };
  source: { kind: string; name: string };
};
function presentVoiceTool(job: ConsumerJob, availability: ConsumerOriginalAvailability, observedAt: number) {
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  let result = job.resultManifest;
  if (availability !== "available" && result?.original && typeof result.original === "object" && !Array.isArray(result.original))
    result = { ...result, original: Object.fromEntries(Object.entries(result.original).filter(([key]) => key !== "asset")) };
  const report = snapshot.tool.output === "report";
  return {
    id: job.id,
    draftId: job.draftId,
    status: job.status,
    input: snapshot.input,
    tool: snapshot.tool,
    source: snapshot.source,
    priceSource: snapshot.priceSource,
    // The stored source duration the reframe price was quoted for.
    ...(typeof snapshot.params?.duration_seconds === "number" ? { pricedSeconds: snapshot.params.duration_seconds } : {}),
    workspaceName: snapshot.workspaceName,
    workspaceId: job.higgsfieldWorkspaceId,
    quoteCredits: job.quoteCredits,
    creditUnit: job.creditUnit,
    quoteExpiresAt: job.quoteExpiresAt,
    quoteExpired: job.status === "quoted" && job.quoteExpiresAt <= observedAt,
    providerJobId: job.providerJobId,
    result,
    originalAvailability: report ? "not_collected" : availability,
    originalAvailable: !report && availability === "available",
    providerReceipt: job.providerReceipt,
    failureCode: job.failureCode,
    setAside: consumerJobSetAside(job, observedAt),
    createdAt: job.createdAt,
  };
}
export type ConsumerVoiceToolView = ReturnType<typeof presentVoiceTool>;
export async function consumerVoiceToolView(job: ConsumerJob) {
  const observedAt = Date.now();
  if (job.status === "quoted" && job.quoteExpiresAt <= observedAt) {
    const current = await readConsumerJobAfterAdmissions({ id: job.id, userId: job.userId, draftId: job.draftId });
    if (!current) throw new ConsumerJobError("not_found", 404);
    job = current;
  }
  const availability = await consumerOriginalAvailability([job]);
  return presentVoiceTool(job, availability.get(job.id)!, observedAt);
}
async function connected(userId: string, expectedGeneration?: string) {
  const access = await getConsumerAccess(requireTenant().id, userId, { expectedGeneration });
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  return access;
}
const fingerprintFor = (userId: string, generation: string) =>
  createHash("sha256").update(`${requireTenant().id}:${userId}:${generation}:voices`).digest("hex").slice(0, 48);
export async function connectedVoices(userId: string, options: { refresh?: boolean } = {}): Promise<ConnectedVoices> {
  const access = await connected(userId);
  return loadConnectedVoices({
    fingerprint: fingerprintFor(userId, access.generation),
    refresh: options.refresh,
    read: () => readConnectedVoices(access.accessToken),
  });
}
const sameInput = (a: unknown, b: ConsumerVoiceToolInput) => sameConsumerValue(parseConsumerVoiceToolInput(a), b);
export function assertVoiceToolEnabled(input: Pick<ConsumerVoiceToolInput, "tool">) {
  if (input.tool === "video_analysis" && !VIDEO_ANALYSIS_ENABLED)
    throw new VoiceToolError("analysis_disabled", "Analyse video is not available: the connected account advertises no price for it and its report format is unverified.");
}
export async function quoteConsumerVoiceTool(userId: string, draftId: string, input: ConsumerVoiceToolInput, idempotencyKey: string) {
  const normalized = parseConsumerVoiceToolInput(input);
  assertVoiceToolEnabled(normalized);
  // A voice the owner made on the account is its own library, never Particl's.
  if (normalized.voice && normalized.voice.type !== "preset")
    throw new VoiceToolError("invalid_input", "Choose one of the account's preset voices.");
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (previous.workflow !== "voice-tool" || !sameInput(stored.input, normalized)) throw new ConsumerJobError("idempotency_conflict");
    return consumerVoiceToolView(previous);
  }
  if (!(await readDraft(userId, draftId)))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a quote.", 404);
  // Argument validation precedes source resolution, imports and pricing.
  consumerVoiceToolParams(normalized, "00000000-0000-4000-8000-000000000000", normalized.tool === "reframe" ? { durationSeconds: 1 } : {});
  const access = await connected(userId);
  const described = await describeConsumerVoiceToolSource(normalized);
  const source = await resolveConsumerVoiceToolSource(normalized);
  // A voice change or dub is as long as its source; one longer than Particl
  // can keep would be paid for and never collected.
  if (requireVoiceTool(normalized.tool).output === "video" && source.durationSeconds !== undefined && source.durationSeconds > CONSUMER_ORIGINAL_SECONDS)
    throw new VoiceToolError("invalid_input", `Choose a video up to ${CONSUMER_ORIGINAL_SECONDS / 60} minutes long; a longer result cannot be kept.`);
  // Reframe is priced from the stored duration; an unknown or over-long one stops here.
  if (normalized.tool === "reframe") consumerVoiceToolParams(normalized, "00000000-0000-4000-8000-000000000000", { durationSeconds: source.durationSeconds });
  const quote = await getConsumerVoiceToolQuote(access.accessToken, normalized, source, {
    resolveMedia: async (workspaceId, perform) => {
      await connected(userId, access.generation);
      return resolveConsumerVoiceToolImport(
        { userId, draftId, quoteKey: idempotencyKey, request: normalized, workspaceId, connectionGeneration: access.generation },
        perform,
      );
    },
  });
  await connected(userId, access.generation);
  const tool = requireVoiceTool(normalized.tool);
  const payload: Snapshot = {
    input: quote.input,
    params: quote.params,
    shape: quote.shape,
    priceSource: quote.priceSource,
    workspaceName: quote.workspace.name ?? "Connected wallet",
    tool: { name: tool.name, label: tool.label, suffix: tool.suffix, output: tool.output },
    source: described,
  };
  try {
    const { job } = await createConsumerJob({
      userId,
      draftId,
      connectedOwnerId: userId,
      connectionGeneration: access.generation,
      higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "voice-tool",
      idempotencyKey,
      payload: payload as unknown as { [key: string]: ConsumerJson },
      quoteCredits: quote.credits,
      quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS,
      originalAssetIds: [consumerVoiceToolSourceKey(normalized.source)],
    });
    return consumerVoiceToolView(job);
  } catch (error) {
    if (error instanceof ConsumerJobError && error.code === "idempotency_conflict") {
      const winner = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
      if (winner?.workflow === "voice-tool" && sameInput(JSON.parse(winner.payloadJson).input, normalized)) return consumerVoiceToolView(winner);
    }
    throw error;
  }
}
async function ownedJob(input: ConsumerJobScope) {
  const job = await getConsumerJob(input);
  if (!job || job.workflow !== "voice-tool" || job.connectedOwnerId !== input.userId)
    throw new ConsumerVideoServiceError("not_found", "This voice job is not available.", 404);
  return job;
}
export async function submitConsumerVoiceToolJob(scope: ConsumerJobScope, approval: { workspaceId: string; credits: number }) {
  const job = await ownedJob(scope);
  if (job.status !== "quoted") return consumerVoiceToolView(job);
  if (approval.workspaceId !== job.higgsfieldWorkspaceId || approval.credits !== job.quoteCredits)
    throw new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  const input = parseConsumerVoiceToolInput(snapshot.input);
  assertVoiceToolEnabled(input);
  const access = await connected(scope.userId, job.connectionGeneration);
  let claimToken: string | undefined;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  try {
    const result = await submitConsumerVoiceTool(access.accessToken, input, snapshot.params, snapshot.shape, approval.workspaceId, approval.credits, {
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
    return consumerVoiceToolView(next ?? (await ownedJob(scope)));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    if (claimToken) {
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      return consumerVoiceToolView(next ?? (await ownedJob(scope)));
    }
    throw error;
  }
}
export async function pollConsumerVoiceTool(scope: ConsumerJobScope) {
  let prior = await ownedJob(scope);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const savedId = consumerVoiceToolAcknowledgement(prior.providerReceipt);
    const responseId = consumerVoiceToolAcknowledgement(prior.providerReceipt.response);
    const providerJobId = savedId && responseId && savedId !== responseId ? null : (savedId ?? responseId);
    if (providerJobId) {
      await connected(scope.userId, prior.connectionGeneration);
      prior = (await reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: prior.providerReceipt })) ?? (await ownedJob(scope));
    }
  }
  if (prior.status !== "accepted") return { job: await consumerVoiceToolView(prior) };
  const access = await connected(scope.userId, prior.connectionGeneration);
  const claim = await claimConsumerPoll(scope);
  if (!claim) return { job: await consumerVoiceToolView(await ownedJob(scope)), pollAfterSeconds: 30 };
  let pollAfterSeconds = 15;
  try {
    const snapshot = JSON.parse(claim.job.payloadJson) as Snapshot;
    const providerJobId = claim.job.providerJobId!;
    const response = await readConsumerVoiceToolJob(access.accessToken, providerJobId, claim.job.higgsfieldWorkspaceId!, snapshot.input.tool);
    pollAfterSeconds = Math.max(15, response.pollAfterSeconds ?? 30);
    const report = snapshot.tool.output === "report";
    const failed = report ? consumerVideoAnalysisFailure(response.raw, providerJobId) : consumerVoiceToolFailureResult(response.raw, providerJobId);
    if (failed) {
      await connected(scope.userId, claim.job.connectionGeneration);
      const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      return { job: await consumerVoiceToolView(settled ?? (await ownedJob(scope))), providerStatus: { status: failed }, pollAfterSeconds };
    }
    if (report) {
      const analysis = consumerVideoAnalysisReport(response.raw, providerJobId);
      if (analysis) {
        await connected(scope.userId, claim.job.connectionGeneration);
        const completed = await completeConsumerJob({
          ...scope,
          leaseToken: claim.leaseToken,
          resultManifest: { report: analysis as unknown as ConsumerJson, providerResult: { tool: snapshot.input.tool, estimate: true } },
        });
        return { job: await consumerVoiceToolView(completed ?? (await ownedJob(scope))), pollAfterSeconds };
      }
    } else {
      const terminal = consumerVoiceToolOriginalResult(response.raw, providerJobId);
      if (terminal) {
        await connected(scope.userId, claim.job.connectionGeneration);
        let original;
        try {
          original = await collectConsumerVideoOriginal(claim.job, terminal.url);
        } catch (error) {
          // Refused the same way on every poll: settle once, receipt kept.
          if (!uncollectableOriginal(error)) throw error;
          const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "invalid_result" });
          return { job: await consumerVoiceToolView(settled ?? (await ownedJob(scope))), collection: { code: error.code, message: error.message }, pollAfterSeconds };
        }
        const completed = await completeConsumerJob({
          ...scope,
          leaseToken: claim.leaseToken,
          resultManifest: { original, providerResult: { tool: snapshot.input.tool, type: "video" } },
        });
        return { job: await consumerVoiceToolView(completed ?? (await ownedJob(scope))), pollAfterSeconds };
      }
    }
    return { job: await consumerVoiceToolView(await ownedJob(scope)), providerStatus: response.raw, pollAfterSeconds };
  } finally {
    await releaseConsumerPoll({ ...scope, leaseToken: claim.leaseToken, nextPollAt: Date.now() + pollAfterSeconds * 1000 });
  }
}
export async function consumerVoiceToolJobs(userId: string, draftId: string) {
  const observedAt = Date.now();
  const jobs = await listConsumerRecoveryJobs({ userId, draftId, workflow: "voice-tool", limit: 25 });
  const availability = await consumerOriginalAvailability(jobs);
  return jobs.map((job) => presentVoiceTool(job, availability.get(job.id)!, observedAt));
}
