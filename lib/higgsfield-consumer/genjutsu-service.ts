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
  getConsumerGenjutsuQuote,
  submitConsumerGenjutsu,
  readConsumerGenjutsuJob,
} from "./mcp";
import {
  parseConsumerGenjutsuInput,
  consumerMediaKey,
  consumerGenjutsuAcknowledgement,
  consumerGenjutsuOriginalResult,
  consumerGenjutsuFailureResult,
  type ConsumerGenjutsuInput,
  type ConsumerGenjutsuParams,
} from "./genjutsu-contract";
import {
  resolveConsumerGenjutsuSources,
  resolveConsumerMediaImport,
} from "./genjutsu-sources";
import { collectConsumerVideoOriginal } from "./video-original";
import {
  consumerOriginalAvailability,
  type ConsumerOriginalAvailability,
} from "./video-availability";
import { ConsumerVideoServiceError } from "./video-service";
const QUOTE_LIFETIME_MS = 5 * 60_000;
function presentGenjutsu(
  job: ConsumerJob,
  availability: ConsumerOriginalAvailability,
  observedAt: number,
) {
  const snapshot = JSON.parse(job.payloadJson) as {
    input: ConsumerGenjutsuInput;
    workspaceName: string;
  };
  let result = job.resultManifest;
  if (
    availability !== "available" &&
    result?.original &&
    typeof result.original === "object" &&
    !Array.isArray(result.original)
  )
    result = {
      ...result,
      original: Object.fromEntries(
        Object.entries(result.original).filter(([key]) => key !== "asset"),
      ),
    };
  return {
    id: job.id,
    draftId: job.draftId,
    status: job.status,
    input: snapshot.input,
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
    createdAt: job.createdAt,
  };
}
export async function consumerGenjutsuView(job: ConsumerJob) {
  const observedAt = Date.now();
  // A row read just before expiry may already have admitted a concurrent
  // dispatch. Re-read after expiry before declaring the quote safe to retire.
  if (job.status === "quoted" && job.quoteExpiresAt <= observedAt) {
    const current = await readConsumerJobAfterAdmissions({
      id: job.id,
      userId: job.userId,
      draftId: job.draftId,
    });
    if (!current) throw new ConsumerJobError("not_found", 404);
    job = current;
  }
  const availability = await consumerOriginalAvailability([job]);
  return presentGenjutsu(job, availability.get(job.id)!, observedAt);
}
async function connected(userId: string, expectedGeneration?: string) {
  const access = await getConsumerAccess(requireTenant().id, userId, {
    expectedGeneration,
  });
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  return access;
}
export async function quoteConsumerGenjutsu(
  userId: string,
  draftId: string,
  input: ConsumerGenjutsuInput,
  idempotencyKey: string,
) {
  const normalized = parseConsumerGenjutsuInput(input);
  const previous = await getConsumerJobByKey({
    userId,
    draftId,
    idempotencyKey,
  });
  if (previous) {
    const stored = JSON.parse(previous.payloadJson);
    if (
      previous.workflow !== "genjutsu" ||
      JSON.stringify(parseConsumerGenjutsuInput(stored.input)) !==
        JSON.stringify(normalized)
    )
      throw new ConsumerJobError("idempotency_conflict");
    return consumerGenjutsuView(previous);
  }
  if (!(await readDraft(userId, draftId)))
    throw new ConsumerVideoServiceError(
      "project_missing",
      "Save this project before requesting a Higgsfield quote.",
      404,
    );
  const access = await connected(userId);
  const { sources } = await resolveConsumerGenjutsuSources(normalized);
  const quote = await getConsumerGenjutsuQuote(
    access.accessToken,
    normalized,
    sources,
    {
      resolveMedia: async (index, workspaceId, perform) => {
        await connected(userId, access.generation);
        return resolveConsumerMediaImport(
          {
            userId,
            draftId,
            quoteKey: idempotencyKey,
            sourceIndex: index,
            request: normalized,
            workspaceId,
            connectionGeneration: access.generation,
          },
          perform,
        );
      },
    },
  );
  // Reconnection during the quote cannot bind its result to a replacement grant.
  await connected(userId, access.generation);
  try {
    const { job } = await createConsumerJob({
      userId,
      draftId,
      connectedOwnerId: userId,
      connectionGeneration: access.generation,
      higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "genjutsu",
      idempotencyKey,
      payload: {
        input: { ...quote.input },
        params: quote.params,
        workspaceName: quote.workspace.name ?? "Higgsfield workspace",
      },
      quoteCredits: quote.credits,
      quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS,
      originalAssetIds: [normalized.source, ...normalized.references].map(
        consumerMediaKey,
      ),
    });
    return consumerGenjutsuView(job);
  } catch (error) {
    if (
      error instanceof ConsumerJobError &&
      error.code === "idempotency_conflict"
    ) {
      const winner = await getConsumerJobByKey({
        userId,
        draftId,
        idempotencyKey,
      });
      if (
        winner?.workflow === "genjutsu" &&
        JSON.stringify(
          parseConsumerGenjutsuInput(JSON.parse(winner.payloadJson).input),
        ) === JSON.stringify(normalized)
      )
        return consumerGenjutsuView(winner);
    }
    throw error;
  }
}
async function ownedGenjutsu(input: ConsumerJobScope) {
  const job = await getConsumerJob(input);
  if (
    !job ||
    job.workflow !== "genjutsu" ||
    job.connectedOwnerId !== input.userId
  )
    throw new ConsumerVideoServiceError(
      "not_found",
      "This Genjutsu job is not available.",
      404,
    );
  return job;
}
export async function submitConsumerGenjutsuJob(
  scope: ConsumerJobScope,
  approval: { workspaceId: string; credits: number },
) {
  const job = await ownedGenjutsu(scope);
  if (job.status !== "quoted") return consumerGenjutsuView(job);
  if (
    approval.workspaceId !== job.higgsfieldWorkspaceId ||
    approval.credits !== job.quoteCredits
  )
    throw new ConsumerVideoServiceError(
      "approval_changed",
      "Review this job’s wallet and exact credit quote again.",
    );
  if (job.quoteExpiresAt <= Date.now())
    throw new ConsumerJobError("quote_expired");
  const input = parseConsumerGenjutsuInput(JSON.parse(job.payloadJson).input);
  const access = await connected(scope.userId, job.connectionGeneration);
  let claimToken: string | undefined;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  try {
    const params = JSON.parse(job.payloadJson).params as ConsumerGenjutsuParams;
    const result = await submitConsumerGenjutsu(
      access.accessToken,
      input,
      params,
      approval.workspaceId,
      approval.credits,
      {
        admit: async () => {
          await connected(scope.userId, job.connectionGeneration);
          const claim = await claimConsumerDispatch(scope);
          if (!claim)
            throw new ConsumerVideoServiceError(
              "already_submitted",
              "This job already has a submission. Refresh its status.",
            );
          claimToken = claim.claimToken;
        },
      },
    );
    if (!claimToken)
      throw new ConsumerVideoServiceError(
        "not_admitted",
        "No paid request was admitted.",
      );
    if (result.raw !== undefined) {
      const serialized = JSON.stringify(result.raw);
      providerReceipt = {
        ...(result.state === "accepted"
          ? { job_id: result.providerJobId }
          : {}),
        response:
          Buffer.byteLength(serialized) > 48000
            ? { truncated: true, preview: serialized.slice(0, 20000) }
            : result.raw,
      };
    }
    const next =
      result.state === "accepted"
        ? await markConsumerAccepted({
            ...scope,
            claimToken,
            providerJobId: result.providerJobId,
          })
        : await markConsumerUncertain({
            ...scope,
            claimToken,
            providerReceipt,
          });
    return consumerGenjutsuView(next ?? (await ownedGenjutsu(scope)));
  } catch (error) {
    // Once claimed, an interrupted request might have reached the provider.
    // Never turn it back into a quote or automatically submit it again.
    if (claimToken) {
      const next = await markConsumerUncertain({
        ...scope,
        claimToken,
        providerReceipt,
      });
      return consumerGenjutsuView(next ?? (await ownedGenjutsu(scope)));
    }
    throw error;
  }
}
export async function pollConsumerGenjutsu(scope: ConsumerJobScope) {
  let prior = await ownedGenjutsu(scope);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const params = JSON.parse(prior.payloadJson)
      .params as ConsumerGenjutsuParams;
    const savedId = consumerGenjutsuAcknowledgement(
      prior.providerReceipt,
      params.model,
    );
    const responseId = consumerGenjutsuAcknowledgement(
      prior.providerReceipt.response,
      params.model,
    );
    // The outer ID survives truncation of a large diagnostic response. Both
    // identifiers must agree if both are present; never scrape its preview.
    const providerJobId =
      savedId && responseId && savedId !== responseId
        ? null
        : (savedId ?? responseId);
    if (providerJobId) {
      await connected(scope.userId, prior.connectionGeneration);
      prior =
        (await reconcileConsumerReceipt({
          ...scope,
          providerJobId,
          expectedReceipt: prior.providerReceipt,
        })) ?? (await ownedGenjutsu(scope));
    }
  }
  if (prior.status !== "accepted")
    return { job: await consumerGenjutsuView(prior) };
  const access = await connected(scope.userId, prior.connectionGeneration);
  const claim = await claimConsumerPoll(scope);
  if (!claim)
    return {
      job: await consumerGenjutsuView(await ownedGenjutsu(scope)),
      pollAfterSeconds: 30,
    };
  let pollAfterSeconds = 15;
  try {
    const params = JSON.parse(claim.job.payloadJson)
      .params as ConsumerGenjutsuParams;
    const response = await readConsumerGenjutsuJob(
      access.accessToken,
      claim.job.providerJobId!,
      claim.job.higgsfieldWorkspaceId!,
      params.model,
    );
    pollAfterSeconds = Math.max(15, response.pollAfterSeconds ?? 30);
    const terminal = consumerGenjutsuOriginalResult(
      response.raw,
      claim.job.providerJobId!,
      params,
    );
    const failed = consumerGenjutsuFailureResult(
      response.raw,
      claim.job.providerJobId!,
      params,
    );
    if (failed) {
      await connected(scope.userId, claim.job.connectionGeneration);
      const settled = await failConsumerPoll({
        ...scope,
        leaseToken: claim.leaseToken,
        failureCode: "provider_failed",
      });
      return {
        job: await consumerGenjutsuView(
          settled ?? (await ownedGenjutsu(scope)),
        ),
        providerStatus: { status: failed },
        pollAfterSeconds,
      };
    }
    if (terminal) {
      // A refresh is the same grant; reconnect/disconnect during the read cannot
      // authorize collection under a replacement connection.
      await connected(scope.userId, claim.job.connectionGeneration);
      const original = await collectConsumerVideoOriginal(
        claim.job,
        terminal.url,
      );
      const providerResult = { model: params.model };
      const completed = await completeConsumerJob({
        ...scope,
        leaseToken: claim.leaseToken,
        resultManifest: { original, providerResult },
      });
      // An expired/stolen lease cannot publish stale completion. The committed
      // original remains recoverable by the next admitted poll.
      return {
        job: await consumerGenjutsuView(
          completed ?? (await ownedGenjutsu(scope)),
        ),
        pollAfterSeconds,
      };
    }
    return {
      job: await consumerGenjutsuView(await ownedGenjutsu(scope)),
      providerStatus: response.raw,
      pollAfterSeconds,
    };
  } finally {
    await releaseConsumerPoll({
      ...scope,
      leaseToken: claim.leaseToken,
      nextPollAt: Date.now() + pollAfterSeconds * 1000,
    });
  }
}
export async function consumerGenjutsuJobs(userId: string, draftId: string) {
  const observedAt = Date.now();
  const jobs = await listConsumerRecoveryJobs({
    userId,
    draftId,
    workflow: "genjutsu",
    limit: 25,
  });
  const availability = await consumerOriginalAvailability(jobs);
  return jobs.map((job) =>
    presentGenjutsu(job, availability.get(job.id)!, observedAt),
  );
}
