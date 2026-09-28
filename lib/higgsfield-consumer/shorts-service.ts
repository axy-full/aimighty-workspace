/**
 * Durable "shorts" workflow (Subatomik, slice F4): cached style listing →
 * validated quote (the cost-only `shorts_studio_create` form for the stored
 * source duration, read before the source is imported) → owner approval of the
 * exact connected-credit price → one admitted create (one session) → leased
 * session polling → every successful clip collected as its own original and
 * filed on the project → ONE settlement for the whole session.
 *
 * Same claim, uncertain and receipt semantics as the other connected
 * workflows; no automatic retries of the paid call. Clip collection is
 * idempotent per (job, clip index), so a poll that runs out of time simply
 * continues on the next one; the job completes only once every clip is
 * collected or reported failed.
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/tenant";
import { readDraft } from "@/lib/workbench/records";
import { uploadReservationsReady } from "@/lib/uploadReservations";
import { ConsumerOAuthError } from "./oauth";
import { approvalMatches, providerDetail, workspaceJobView } from "./client-view";
import { accessForJob, accessForNewWork, consumerCacheScope, type ResolvedAccess } from "./access";
import { OWN_ACCOUNT, websiteFunding, type ConsumerFunding } from "./funding";
import {
  acceptWebsiteJob, admitConsumerJob, recordWebsiteSubmission, releaseWebsiteJob, settleEndedWebsiteJob, guardWebsiteWallet, noteWebsiteWalletShort, takeDispatchLease, websiteCallNeverLeft, websitePrice,
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
import { getConsumerShortsQuote, submitConsumerShorts, readConsumerShortsSession, readConsumerShortsClips, readShortsPresets } from "./mcp";
import {
  SHORTS_LISTED_SOURCES,
  ShortsStudioError,
  consumerShortsAcknowledgement,
  consumerShortsParams,
  parseConsumerShortsInput,
  parseShortsSessionStatus,
  shortsSettlement,
  type ConsumerShortsInput,
  type ConsumerShortsParams,
  type ShortsClipOutcome,
  type ShortsPresets,
} from "./shorts-studio";
import { consumerVoiceToolFailureResult, consumerVoiceToolOriginalResult } from "./voice-tools";
import { describeConsumerShortsSource, resolveConsumerShortsImport, resolveConsumerShortsSource } from "./shorts-sources";
import { consumerMediaKey } from "./genjutsu-contract";
import { sameConsumerValue } from "./video-contract";
import { ConsumerOriginalError, collectConsumerVideoOriginal, consumerClipKey, consumerOriginalGenerationId, uncollectableOriginal } from "./video-original";
import { ConsumerVideoServiceError } from "./video-service";

const QUOTE_LIFETIME_MS = 5 * 60_000;
const PRESETS_TTL_MS = 3_600_000;
/** This service's website tool, for the platform's account (lib/higgsfield-consumer/website-tools.ts). */
const TOOL = "shorts" as const;
/** Stop starting new clip downloads after this much of one poll request. */
const COLLECT_BUDGET_MS = 60_000;
type Snapshot = {
  input: ConsumerShortsInput;
  params: ConsumerShortsParams;
  workspaceName: string;
  source: { kind: string; name: string };
};
export type ShortsClipView = {
  index: number;
  providerJobId: string;
  state: "collected" | "failed";
  reason?: string;
  availability?: "available" | "deleted" | "unavailable";
  original?: ConsumerJson;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Tenant-local check of each collected clip's retained original. */
async function clipAvailability(job: ConsumerJob, clips: ShortsClipView[]) {
  const collected = clips.filter((clip) => clip.state === "collected" && object(clip.original));
  if (!collected.length) return;
  await uploadReservationsReady();
  const keys = collected.map((clip) => consumerClipKey(job.id, clip.index));
  const rows = (await db().execute({
    sql: `SELECT o.job_id,o.generation_id,o.owner_id,o.draft_id,o.provider_job_id,o.state,o.sha256,o.bytes,g.deleted AS gen_deleted,g.stored_url AS gen_url,g.bytes AS gen_bytes,g.params AS gen_params
      FROM consumer_video_originals o LEFT JOIN generations g ON g.id=o.generation_id WHERE o.job_id IN (${keys.map(() => "?").join(",")})`,
    args: keys,
  })).rows;
  const byKey = new Map(rows.map((row) => [String(row.job_id), row]));
  for (const clip of collected) {
    const key = consumerClipKey(job.id, clip.index), row = byKey.get(key), original = clip.original as Record<string, unknown>;
    const generationId = consumerOriginalGenerationId(requireTenant().id, key);
    let params: Record<string, unknown> | null = null;
    try { params = row ? JSON.parse(String(row.gen_params)) : null; } catch { params = null; }
    clip.availability = "unavailable";
    if (!row || row.state !== "stored" || row.owner_id !== job.userId || row.draft_id !== job.draftId || row.provider_job_id !== clip.providerJobId ||
        row.generation_id !== generationId || original.generationId !== generationId || original.providerJobId !== clip.providerJobId ||
        original.sha256 !== row.sha256 || original.bytes !== Number(row.bytes) || params?.consumerJobId !== key || params?.consumerParentJobId !== job.id)
      continue;
    if (Number(row.gen_deleted)) clip.availability = "deleted";
    else if (typeof row.gen_url === "string" && row.gen_url && Number(row.gen_bytes) === original.bytes) clip.availability = "available";
  }
}
function manifestClips(job: ConsumerJob): ShortsClipView[] {
  const clips = job.resultManifest?.clips;
  if (!Array.isArray(clips)) return [];
  return clips.flatMap((clip) => {
    if (!object(clip) || typeof clip.index !== "number" || typeof clip.providerJobId !== "string" || (clip.state !== "collected" && clip.state !== "failed")) return [];
    return [{ index: clip.index, providerJobId: clip.providerJobId, state: clip.state, ...(typeof clip.reason === "string" ? { reason: clip.reason } : {}),
      ...(clip.state === "collected" ? { original: clip.original as ConsumerJson } : {}) }];
  });
}
async function presentShorts(job: ConsumerJob, observedAt: number, progress?: { clips: number; collected: number; status: string }) {
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  const clips = manifestClips(job);
  await clipAvailability(job, clips);
  for (const clip of clips) if (clip.availability !== "available" && object(clip.original)) clip.original = Object.fromEntries(Object.entries(clip.original).filter(([key]) => key !== "asset")) as ConsumerJson;
  return workspaceJobView(job, {
    id: job.id,
    draftId: job.draftId,
    status: job.status,
    input: snapshot.input,
    source: snapshot.source,
    pricedSeconds: snapshot.params.duration_seconds,
    priceSource: "get_cost" as const,
    workspaceName: snapshot.workspaceName,
    workspaceId: job.higgsfieldWorkspaceId,
    quoteCredits: job.quoteCredits,
    creditUnit: job.creditUnit,
    quoteExpiresAt: job.quoteExpiresAt,
    quoteExpired: job.status === "quoted" && job.quoteExpiresAt <= observedAt,
    providerJobId: job.providerJobId,
    clips,
    settlement: job.status === "completed" && object(job.resultManifest?.settlement) ? job.resultManifest!.settlement : null,
    ...(progress ? { progress } : {}),
    providerReceipt: job.providerReceipt,
    failureCode: job.failureCode,
    setAside: consumerJobSetAside(job, observedAt),
    createdAt: job.createdAt,
  });
}
export type ConsumerShortsView = Awaited<ReturnType<typeof presentShorts>>;
export async function consumerShortsView(job: ConsumerJob, progress?: { clips: number; collected: number; status: string }) {
  const observedAt = Date.now();
  if (job.status === "quoted" && job.quoteExpiresAt <= observedAt) {
    const current = await readConsumerJobAfterAdmissions({ id: job.id, userId: job.userId, draftId: job.draftId });
    if (!current) throw new ConsumerJobError("not_found", 404);
    job = current;
  }
  return presentShorts(job, observedAt, progress);
}
const fingerprintFor = (userId: string, access: ResolvedAccess) =>
  createHash("sha256").update(`${consumerCacheScope(userId, access)}:shorts-presets`).digest("hex").slice(0, 48);
const presetCache = new Map<string, ShortsPresets>();
/** The style presets, read at most once an hour per connection (memory cache), with the grant that will quote. */
export async function connectedShortsPresets(userId: string, options: { refresh?: boolean; funding?: ConsumerFunding } = {}): Promise<ShortsPresets> {
  const access = await accessForNewWork(userId, options.funding ?? OWN_ACCOUNT);
  const key = fingerprintFor(userId, access), cached = presetCache.get(key), now = Date.now();
  if (!options.refresh && cached && cached.fetchedAt > now - PRESETS_TTL_MS && cached.fetchedAt <= now) return cached;
  const presets = await readShortsPresets(access.accessToken);
  presetCache.set(key, presets);
  return presets;
}
export function forgetShortsPresets() {
  presetCache.clear();
}
const sameInput = (a: unknown, b: ConsumerShortsInput) => sameConsumerValue(parseConsumerShortsInput(a), b);
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
export async function quoteConsumerShorts(userId: string, draftId: string, input: ConsumerShortsInput, idempotencyKey: string) {
  const funding = await websiteFunding({ workflow: "shorts" });
  const normalized = parseConsumerShortsInput(input);
  // A style the owner saved on the account is its own library, never Particl's.
  if (!SHORTS_LISTED_SOURCES.includes(normalized.preset.source))
    throw new ShortsStudioError("invalid_input", "Choose one of the listed styles.");
  const previous = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
  if (previous) {
    if (previous.workflow !== "shorts" || !sameInput(JSON.parse(previous.payloadJson).input, normalized)) throw new ConsumerJobError("idempotency_conflict");
    return consumerShortsView(previous);
  }
  if (!(await readDraft(userId, draftId)))
    throw new ConsumerVideoServiceError("project_missing", "Save this project before requesting a quote.", 404);
  // The style must be one the account lists as a library style now, not one
  // the request merely labels "cms": the standalone rule is enforced here,
  // not only by what the page lists (hourly cached, free read).
  const listed = await connectedShortsPresets(userId, { funding });
  const presetId = normalized.preset.id.toLowerCase();
  if (!listed.presets.some((preset) => preset.id === presetId && SHORTS_LISTED_SOURCES.includes(preset.source)))
    throw new ShortsStudioError("invalid_input", "Choose one of the listed styles.");
  const described = await describeConsumerShortsSource(normalized);
  const source = await resolveConsumerShortsSource(normalized);
  // The stored duration prices the session; an unknown or out-of-range one stops here.
  consumerShortsParams(normalized, PLACEHOLDER, source.durationSeconds);
  const access = await accessForNewWork(userId, funding);
  const quote = await getConsumerShortsQuote(access.accessToken, normalized, source, {
    resolveMedia: async (workspaceId, perform) => {
      await accessForNewWork(userId, funding, access.generation);
      return resolveConsumerShortsImport(
        { userId, draftId, quoteKey: idempotencyKey, request: normalized, workspaceId, connectionGeneration: access.generation },
        perform,
      );
    },
  });
  await accessForNewWork(userId, funding, access.generation);
  // On the platform's account the client's price is Particl credits, converted
  // privately from the account's own price for the whole session; its wallet is never named.
  const platform = funding.kind === "platform_account";
  const particlCredits = platform ? websitePrice(TOOL, quote.credits).particlCredits : undefined;
  // The account's wallet as this quote read it: under its private floor after this price, refused neutrally.
  if (platform) await guardWebsiteWallet(quote.workspace.credits, quote.credits);
  const payload: Snapshot = { input: quote.input, params: quote.params, workspaceName: platform ? "" : quote.workspace.name ?? "Connected wallet", source: described };
  try {
    const { job } = await createConsumerJob({
      userId,
      draftId,
      funding: funding.kind,
      connectedOwnerId: access.connectedOwnerId,
      connectionGeneration: access.generation,
      higgsfieldWorkspaceId: quote.workspace.id,
      workflow: "shorts",
      idempotencyKey,
      payload: payload as unknown as { [key: string]: ConsumerJson },
      quoteCredits: quote.credits,
      quoteExpiresAt: Date.now() + QUOTE_LIFETIME_MS,
      originalAssetIds: [consumerMediaKey(normalized.source)],
      ...(particlCredits === undefined ? {} : { particlCredits }),
    });
    return consumerShortsView(job);
  } catch (error) {
    if (error instanceof ConsumerJobError && error.code === "idempotency_conflict") {
      const winner = await getConsumerJobByKey({ userId, draftId, idempotencyKey });
      if (winner?.workflow === "shorts" && sameInput(JSON.parse(winner.payloadJson).input, normalized)) return consumerShortsView(winner);
    }
    throw error;
  }
}
async function ownedJob(input: ConsumerJobScope) {
  const job = await getConsumerJob(input);
  if (!job || job.workflow !== "shorts" || !ownsConsumerJob(job, input.userId))
    throw new ConsumerVideoServiceError("not_found", "This Shorts session is not available.", 404);
  return job;
}
export async function submitConsumerShortsJob(scope: ConsumerJobScope, approval: { workspaceId?: string | null; credits: number }) {
  const job = await ownedJob(scope);
  if (job.status !== "quoted") return consumerShortsView(job);
  if (!approvalMatches(job, approval))
    throw new ConsumerVideoServiceError("approval_changed", "Review this session’s wallet and exact credit quote again.");
  if (job.quoteExpiresAt <= Date.now()) throw new ConsumerJobError("quote_expired");
  const platform = job.funding === "platform_account";
  // A tool switched off, unpriced or paused since the quote refuses here: nothing is sent.
  if (platform && (await websiteFunding({ workflow: "shorts" })).kind !== "platform_account") throw new ConsumerJobError("particl_quote_unavailable", 409);
  const snapshot = JSON.parse(job.payloadJson) as Snapshot;
  const input = parseConsumerShortsInput(snapshot.input);
  const access = await accessForJob(job);
  let claimToken: string | undefined;
  let admitted = false;
  let providerReceipt: Record<string, ConsumerJson> | undefined;
  // One dispatch at a time on the shared account: its last wallet check and its paid call.
  const lease = platform ? await takeDispatchLease() : null;
  try {
    const result = await submitConsumerShorts(access.accessToken, input, snapshot.params, job.higgsfieldWorkspaceId!, job.quoteCredits, {
      admit: async () => {
        await accessForJob(job);
        // A platform session's price must still be the approved one; it is reserved, with its registry row, then claimed.
        const token = await admitConsumerJob(scope, job, TOOL);
        if (!token) throw new ConsumerVideoServiceError("already_submitted", "This session already has a submission. Refresh its status.");
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
    const next =
      result.state === "accepted"
        ? await markConsumerAccepted({ ...scope, claimToken, providerJobId: result.providerJobId })
        : await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
    await recordWebsiteSubmission(job, result);
    return consumerShortsView(next ?? (await ownedJob(scope)));
  } catch (error) {
    if (claimToken) {
      // On the platform's account a call that never left is failed and its
      // reservation released to zero (lib/higgsfield-consumer/account-billing.ts).
      if (websiteCallNeverLeft(job, error, admitted)) {
        const failed = await markConsumerFailed({ ...scope, claimToken });
        if (failed?.status === "failed") await releaseWebsiteJob(job, TOOL);
        return consumerShortsView(failed ?? (await ownedJob(scope)));
      }
      const next = await markConsumerUncertain({ ...scope, claimToken, providerReceipt });
      await recordWebsiteSubmission(job, { state: "uncertain" });
      return consumerShortsView(next ?? (await ownedJob(scope)));
    }
    // The account's wallet was short of the price (nothing was sent): the desk and the owner are told.
    await noteWebsiteWalletShort(job, error);
    throw error;
  } finally {
    await lease?.release();
  }
}
/** A platform session that ended is settled once, for the whole session:
 * collected or not, its approved price (also a repair when an earlier poll
 * ended it but did not reach its settlement). */
const settleEnded = (job: ConsumerJob) => settleEndedWebsiteJob(job, TOOL);
/**
 * One leased poll: read the session; once it is terminal read every clip's
 * `job_status`, collect each completed clip (idempotent per clip), and settle
 * the job exactly once when every clip is collected or failed.
 */
export async function pollConsumerShorts(scope: ConsumerJobScope) {
  let prior = await ownedJob(scope);
  await settleEnded(prior);
  if (prior.status === "uncertain" && prior.providerReceipt) {
    const saved = typeof prior.providerReceipt.job_id === "string" ? consumerShortsAcknowledgement({ id: prior.providerReceipt.job_id }) : null;
    const response = consumerShortsAcknowledgement(prior.providerReceipt.response);
    const providerJobId = saved && response && saved !== response ? null : (saved ?? response);
    if (providerJobId) {
      await accessForJob(prior);
      prior = (await reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: prior.providerReceipt })) ?? (await ownedJob(scope));
      if (prior.status === "accepted" && prior.providerJobId && prior.funding === "platform_account") await acceptWebsiteJob(prior, prior.providerJobId);
    }
  }
  if (prior.status !== "accepted") return { job: await consumerShortsView(prior) };
  const access = await accessForJob(prior);
  const claim = await claimConsumerPoll(scope);
  if (!claim) return { job: await consumerShortsView(await ownedJob(scope)), pollAfterSeconds: 30 };
  let pollAfterSeconds = 30;
  const started = Date.now();
  try {
    const sessionId = claim.job.providerJobId!, wallet = claim.job.higgsfieldWorkspaceId!;
    let session;
    try {
      session = parseShortsSessionStatus(await readConsumerShortsSession(access.accessToken, sessionId, wallet), sessionId);
    } catch (error) {
      if (error instanceof ShortsStudioError) return { job: await consumerShortsView(await ownedJob(scope)), pollAfterSeconds };
      throw error;
    }
    const progress = { clips: session.jobIds.length, collected: 0, status: session.status };
    if (!session.terminal) return { job: await consumerShortsView(await ownedJob(scope), progress), pollAfterSeconds };
    if (!session.jobIds.length) {
      await accessForJob(claim.job);
      const settled = await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      if (settled) await settleEnded(settled);
      return { job: await consumerShortsView(settled ?? (await ownedJob(scope))), providerStatus: providerDetail(claim.job, { status: session.status }) };
    }
    const statuses = await readConsumerShortsClips(access.accessToken, session.jobIds, wallet);
    const outcomes: ShortsClipOutcome[] = [];
    let pending = false;
    /** Why a completed clip is not filed yet (storage full, busy, …), shown to the owner. */
    let collection: { code: string; message: string } | undefined;
    for (const [index, { jobId, raw }] of statuses.entries()) {
      const failure = consumerVoiceToolFailureResult(raw, jobId);
      if (failure) { outcomes.push({ index, providerJobId: jobId, state: "failed", reason: failure.slice(0, 40) }); continue; }
      const terminal = consumerVoiceToolOriginalResult(raw, jobId);
      if (!terminal || Date.now() - started > COLLECT_BUDGET_MS) { pending = true; continue; }
      try {
        await accessForJob(claim.job);
        const original = await collectConsumerVideoOriginal(claim.job, terminal.url, { clip: { index, providerJobId: jobId } });
        outcomes.push({ index, providerJobId: jobId, state: "collected", original: original as unknown as Record<string, unknown> });
      } catch (error) {
        // A clip deleted from the library, or one whose result can never be
        // kept (over the size limit, not a valid video), is settled as failed.
        // Anything that can pass later (storage full, busy, time limit) is
        // retried on the next poll, and the reason goes back to the owner.
        if (error instanceof ConsumerOriginalError && (error.code === "deleted" || uncollectableOriginal(error)))
          outcomes.push({ index, providerJobId: jobId, state: "failed", reason: error.code });
        else {
          pending = true;
          collection ??= error instanceof ConsumerOriginalError || error instanceof ConsumerOAuthError
            ? { code: error.code, message: error.message }
            : { code: "unavailable", message: "A finished clip could not be saved yet. It is tried again on the next check." };
        }
      }
    }
    progress.collected = outcomes.filter((clip) => clip.state === "collected").length;
    if (pending) {
      pollAfterSeconds = 15;
      return { job: await consumerShortsView(await ownedJob(scope), progress), ...(collection ? { collection } : {}), pollAfterSeconds };
    }
    await accessForJob(claim.job);
    const settlement = shortsSettlement(outcomes);
    const done = settlement.collected
      ? await completeConsumerJob({
          ...scope,
          leaseToken: claim.leaseToken,
          resultManifest: {
            session: { id: sessionId, status: session.status },
            clips: outcomes as unknown as ConsumerJson,
            settlement: { ...settlement, credits: claim.job.quoteCredits, creditUnit: "higgsfield_credits" },
          },
        })
      : await failConsumerPoll({ ...scope, leaseToken: claim.leaseToken, failureCode: "provider_failed" });
    if (done) await settleEnded(done);
    return { job: await consumerShortsView(done ?? (await ownedJob(scope))) };
  } finally {
    await releaseConsumerPoll({ ...scope, leaseToken: claim.leaseToken, nextPollAt: Date.now() + pollAfterSeconds * 1000 }).catch(() => null);
  }
}
export async function consumerShortsJobs(userId: string, draftId: string) {
  const jobs = await listConsumerRecoveryJobs({ userId, draftId, workflow: "shorts", limit: 25 });
  return Promise.all(jobs.map((job) => presentShorts(job, Date.now())));
}
