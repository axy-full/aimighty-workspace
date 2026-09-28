/**
 * The money path of a website-only tool run for a managed workspace on the
 * platform's designated website account. It adds nothing new to how Particl
 * charges: the account's own price (its website credits) is converted with
 * the private rate into a dollar cost, the existing retail terms turn that
 * into whole Particl credits, and the existing reservation, receipt and
 * recovery seams carry it.
 *
 * 1. Quote: an exact Particl-credit price, P. Quotes are free on the account.
 * 2. Admission, just before the one paid call: P is recomputed with today's
 *    rate and terms (any change refuses, nothing reserved); P is reserved
 *    through `reserveGenerationSpend`, and the job's platform registry row is
 *    written in the same transaction (the account's global capacity and each
 *    workspace's share are decided there); then the job's own claim.
 * 3. Settlement at P, whether the job succeeds or fails — a failed
 *    website-tool job is charged its approved price (owner decision, 27
 *    September), which the client is told before approving.
 * 4. Nothing sent (the call never left, or admission stopped after the
 *    reservation): released to zero. A lost reply keeps its reservation, as
 *    every paid job does; it is never sent again.
 *
 * The account's credits, the rate and the dollar cost never leave the server.
 */
import { randomUUID } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { accountTransaction } from "@/lib/accountDb";
import { creditsAtTerms, currentBillingTerms } from "@/lib/billingTerms";
import { reserveGenerationSpend, SpendReservationError } from "@/lib/generationRequests";
import { meter } from "@/lib/meter";
import { websiteAccountCreditUsd, websiteAccountFixedCredits, websiteAccountMinWalletCredits } from "@/lib/vendorRates";
import { mailConfigured, sendMail } from "@/lib/mail";
import {
  ConsumerJobError,
  claimConsumerDispatch,
  consumerJobsById,
  fenceConsumerQuotes,
  type ConsumerJob,
  type ConsumerJobScope,
} from "./jobs";
import {
  markWebsiteWalletAlerted,
  moveWebsiteJobTx,
  noteWebsiteWallet,
  registerWebsiteDispatchTx,
  releaseWebsiteLease,
  takeWebsiteLease,
  websiteJobPin,
  websiteJobsReady,
  type WebsiteJobPin,
} from "./platform-jobs";
import { readPlatformDesignation, WebsiteToolsUnavailableError } from "./platform-account";
import { WEBSITE_METER_ENGINE, websiteMeterModel, websiteTool, type WebsiteToolId } from "./website-tools";
import { ConsumerVideoError } from "./video-contract";

/** What kind of output each tool's job is metered as. */
const METER_KIND: Record<WebsiteToolId, "video" | "image" | "audio"> = {
  "marketing-video": "video",
  shorts: "video",
  reframe: "video",
  "marketing-template": "image",
  generation: "image",
  "voice-change": "video",
  dubbing: "video",
  "video-analysis": "video",
  virality: "video",
  "soul-build": "image",
  "element-build": "image",
};
export const websiteMeterKind = (tool: WebsiteToolId) => METER_KIND[tool];

/** The whole Particl-credit price of an account price, at today's private rate and retail terms. Server-only. */
export function websitePrice(tool: WebsiteToolId, websiteCredits: number): { particlCredits: number; usd: number; rate: number } {
  const rate = websiteAccountCreditUsd();
  if (rate === null || !Number.isFinite(websiteCredits) || websiteCredits <= 0) throw new ConsumerJobError("particl_quote_unavailable", 409);
  const usd = websiteCredits * rate;
  const particlCredits = creditsAtTerms(usd, currentBillingTerms(websiteMeterKind(tool), websiteMeterModel(tool)));
  if (!Number.isSafeInteger(particlCredits) || particlCredits < 1) throw new ConsumerJobError("particl_quote_unavailable", 409);
  return { particlCredits, usd, rate };
}
/** A tool without a price of its own: its private fixed price, in the account's credits. */
export function websiteFixedCredits(tool: WebsiteToolId): number {
  const fixed = websiteAccountFixedCredits()[tool];
  if (websiteTool(tool).pricing !== "fixed" || fixed === undefined) throw new ConsumerJobError("particl_quote_unavailable", 409);
  return fixed;
}

export class WebsitePriceChangedError extends Error {
  readonly code = "price_changed";
  readonly status = 409;
  readonly paidAttempted = false;
  constructor() {
    super("The price changed since this quote. Review the new price; nothing was charged.");
    this.name = "WebsitePriceChangedError";
  }
}

const meterEvent = (job: ConsumerJob, tool: WebsiteToolId, status: "running" | "succeeded" | "failed", usd: number) => ({
  id: job.meterId!,
  kind: websiteMeterKind(tool),
  engine: WEBSITE_METER_ENGINE,
  model: websiteMeterModel(tool),
  status,
  engineCostUsd: usd,
  createdBy: job.userId,
});

/**
 * Admission, inside the transport's `admit` (after its last wallet and price
 * checks, before its one paid call): today's price must still be exactly the
 * approved one; then P is reserved with the job's registry row, then the job
 * is claimed. A claim that cannot be taken releases the reservation and
 * answers null (the job was already claimed). Returns the claim token.
 * Nothing here is ever retried.
 */
export async function admitWebsiteJob(
  scope: ConsumerJobScope,
  job: ConsumerJob,
  tool: WebsiteToolId,
  websiteCredits: number,
): Promise<string | null> {
  if (job.funding !== "platform_account" || !job.meterId || job.particlCredits === null) throw new ConsumerJobError("particl_quote_unavailable", 409);
  const price = websitePrice(tool, websiteCredits);
  if (price.particlCredits !== job.particlCredits) throw new WebsitePriceChangedError();
  const designation = await readPlatformDesignation();
  if (!designation) throw new WebsiteToolsUnavailableError("unset");
  await websiteJobsReady();
  const workspaceId = requireTenant().id;
  try {
    await reserveGenerationSpend(meterEvent(job, tool, "running", price.usd), {
      expectedCredits: job.particlCredits,
      within: async (tx, ts) => {
        await registerWebsiteDispatchTx(tx, {
          meterId: job.meterId!, workspaceId, jobId: job.id, userId: job.userId, workflow: job.workflow, tool,
          host: { workspaceId: designation.workspaceId, userId: designation.userId },
          subjectHash: designation.subjectHash, generation: job.connectionGeneration,
          websiteCredits, creditUsd: price.rate, particlCredits: job.particlCredits!,
        }, ts);
      },
    });
  } catch (error) {
    if (error instanceof SpendReservationError && /price changed/i.test(error.message)) throw new WebsitePriceChangedError();
    throw error;
  }
  let claim: Awaited<ReturnType<typeof claimConsumerDispatch>>;
  try {
    claim = await claimConsumerDispatch(scope, { meterId: job.meterId });
  } catch (error) {
    // Refused while still a quote (expired, the workspace's own slots, a deleted project): nothing was claimed.
    await releaseWebsiteJob(job, tool);
    throw error;
  }
  if (!claim) {
    // No longer a quote: another admission of this same job holds it, with
    // this same reservation. Only a job still quoted gives its reservation back.
    const current = (await consumerJobsById([job.id]))[0];
    if (current?.status === "quoted") await releaseWebsiteJob(job, tool);
    return null;
  }
  // Housekeeping reads `reserved` as possibly unclaimed; a failed note here is repaired there.
  await accountTransaction((tx) => moveWebsiteJobTx(tx, { workspaceId, jobId: job.id }, "claimed")).catch(() => {});
  return claim.claimToken;
}

/** The job's registry row, or null when it was never admitted here. Server-only. */
async function pinOf(job: ConsumerJob): Promise<WebsiteJobPin | null> {
  if (job.funding !== "platform_account") return null;
  return websiteJobPin(requireTenant().id, job.id);
}
/** Accepted by the account under exactly this provider job. */
export async function acceptWebsiteJob(job: ConsumerJob, providerJobId: string) {
  if (!(await pinOf(job))) return;
  await accountTransaction((tx) => moveWebsiteJobTx(tx, { workspaceId: requireTenant().id, jobId: job.id }, "accepted", { providerJobId }));
}
/** The reply was lost: the reservation stays, and the job is never sent again. */
export async function holdUncertainWebsiteJob(job: ConsumerJob) {
  if (!(await pinOf(job))) return;
  await accountTransaction((tx) => moveWebsiteJobTx(tx, { workspaceId: requireTenant().id, jobId: job.id }, "uncertain"));
}
/** Nothing was sent: the reservation is released to zero. Idempotent. */
export async function releaseWebsiteJob(job: ConsumerJob, tool: WebsiteToolId) {
  const pin = await pinOf(job);
  if (!pin || pin.state === "settled" || pin.state === "released") return;
  await meter(meterEvent(job, tool, "failed", 0), { critical: true });
  await accountTransaction((tx) => moveWebsiteJobTx(tx, { workspaceId: requireTenant().id, jobId: job.id }, "released"));
}
/**
 * The job ended (collected, or failed on the account): its bill is the
 * approved price either way, settled at the reservation. Idempotent: a second
 * settlement changes nothing.
 */
export async function settleWebsiteJob(job: ConsumerJob, tool: WebsiteToolId, outcome: "succeeded" | "failed") {
  const pin = await pinOf(job);
  if (!pin || pin.state === "settled" || pin.state === "released") return;
  const usd = pin.websiteCredits * pin.creditUsd;
  await meter({ ...meterEvent(job, tool, outcome, usd), ...(outcome === "failed" ? { final: true } : {}) }, { critical: true });
  await accountTransaction((tx) => moveWebsiteJobTx(tx, { workspaceId: requireTenant().id, jobId: job.id }, "settled"));
}

/**
 * A platform job that has ended, settled from its own ledger row: collected →
 * the approved price; failed on the account (or its result could not be kept)
 * → the approved price too; refused before it was ever sent → released to
 * zero. Idempotent, and a no-op for anything else.
 */
export async function settleEndedWebsiteJob(job: ConsumerJob, tool: WebsiteToolId) {
  if (job.funding !== "platform_account") return;
  if (job.status === "completed") await settleWebsiteJob(job, tool, "succeeded");
  else if (job.status === "failed" && (job.failureCode === "provider_failed" || job.failureCode === "invalid_result")) await settleWebsiteJob(job, tool, "failed");
  else if (job.status === "failed") await releaseWebsiteJob(job, tool);
}

/** How long a reservation may wait for its claim before it is known never to have been sent. */
export const WEBSITE_UNCLAIMED_MS = 10 * 60_000;
/**
 * Housekeeping for this workspace's platform jobs (the sweep and the recovery
 * drain run it). Reads only this workspace's registry rows and jobs.
 * - The crash window between a reservation and its claim: a row still
 *   `reserved` whose job is still a quote. The quote is fenced first (it can
 *   never be claimed after this), then the reservation is released — nothing
 *   was sent. A job its claim did take is only marked claimed.
 * - A job that ended but was not settled (a crash after the job's own ledger
 *   moved): settled from that ledger, exactly as its poll would have.
 * Never sends, quotes or resubmits anything.
 */
export async function repairWebsiteJobs(now = Date.now()): Promise<{ released: number; settled: number }> {
  await websiteJobsReady();
  const workspaceId = requireTenant().id;
  const rows = (await accountTransaction((tx) =>
    tx.execute({
      sql: `SELECT job_id,tool,state,created_at FROM website_account_jobs WHERE workspace_id=? AND state IN ('reserved','claimed','accepted','uncertain')
        ORDER BY created_at LIMIT 50`,
      args: [workspaceId],
    }),
  )).rows;
  const out = { released: 0, settled: 0 };
  if (!rows.length) return out;
  const jobs = new Map((await consumerJobsById(rows.map((row) => String(row.job_id)))).map((job) => [job.id, job]));
  for (const row of rows) {
    const job = jobs.get(String(row.job_id));
    if (!job) continue;
    const tool = String(row.tool) as WebsiteToolId;
    if (job.status === "completed" || job.status === "failed") {
      await settleEndedWebsiteJob(job, tool);
      out.settled++;
      continue;
    }
    if (row.state !== "reserved" || Number(row.created_at) > now - WEBSITE_UNCLAIMED_MS) continue;
    const [fenced] = await fenceConsumerQuotes([{ userId: job.userId, draftId: job.draftId, id: job.id }]);
    if (fenced.status === "quoted") {
      await releaseWebsiteJob(fenced, tool);
      out.released++;
    } else await accountTransaction((tx) => moveWebsiteJobTx(tx, { workspaceId, jobId: job.id }, "claimed"));
  }
  return out;
}

/** Longer than one transport session (lib/higgsfield-consumer/mcp.ts QUALIFICATION_LIMITS), so a lease never lapses mid-call. */
export const WEBSITE_DISPATCH_LEASE_MS = 120_000;
/**
 * One dispatch at a time on the shared account, across every workspace: its
 * last wallet check and its one paid call. Busy is the neutral refusal;
 * nothing was sent or charged.
 */
export async function takeDispatchLease(): Promise<{ release(): Promise<void> }> {
  const holder = randomUUID();
  if (!(await takeWebsiteLease("dispatch", holder, WEBSITE_DISPATCH_LEASE_MS))) throw new WebsiteToolsUnavailableError("busy");
  return { release: () => releaseWebsiteLease("dispatch", holder).then(() => {}, () => {}) };
}

/* ── The account's floor ──────────────────────────────────────────────── */

type Mail = (message: { to: string; subject: string; text: string; html: string }) => Promise<unknown>;
/**
 * The platform owner is told, at most once a day, that the account is under
 * its floor — by email when mail is set up, and on the platform desk always.
 * Best effort: a failed send is tried again with the next low reading.
 */
async function tellOwnerAccountLow(send: Mail = sendMail) {
  const to = (process.env.SUPER_ADMIN_EMAIL ?? "").trim();
  if (!to || !mailConfigured()) return;
  const text = "The account that runs website tools for managed workspaces is under its floor. New website-tool quotes are refused until it is topped up; no client was charged for a refusal. The platform desk shows it too.";
  await send({ to, subject: "Website tools: the account is running low", text, html: `<p>${text}</p>` });
  await markWebsiteWalletAlerted();
}
/**
 * A platform quote's own reading of the account's wallet (nothing else is
 * read): the account must be able to pay its price and stay at or above its
 * private floor (`HF_ACCOUNT_MIN_WALLET_CREDITS`, none by default), or the
 * quote is refused with the one neutral answer before anyone approves a
 * price the account cannot pay. The desk learns whether it was under, never
 * the balance.
 */
export async function guardWebsiteWallet(balance: number, price: number, options: { send?: Mail } = {}) {
  const floor = websiteAccountMinWalletCredits();
  const low = !Number.isFinite(balance) || balance - price < floor;
  const { alertDue } = await noteWebsiteWallet(low).catch(() => ({ alertDue: false }));
  if (alertDue) await tellOwnerAccountLow(options.send).catch(() => {});
  if (low) throw new WebsiteToolsUnavailableError("low_balance");
}
/** The transport found the account's wallet short of a price at submission: the desk and the owner are told. */
export async function noteWebsiteWalletShort(job: Pick<ConsumerJob, "funding">, error: unknown, options: { send?: Mail } = {}) {
  if (job.funding !== "platform_account" || !(error instanceof ConsumerVideoError) || error.code !== "insufficient_credits") return;
  const { alertDue } = await noteWebsiteWallet(true).catch(() => ({ alertDue: false }));
  if (alertDue) await tellOwnerAccountLow(options.send).catch(() => {});
}

/* ── The paid-call half every website-tool service shares ───────────── */

/**
 * The admission a service's transport runs just before its one paid call,
 * for either funding: a job on its owner's own account is claimed exactly as
 * always; a platform job is priced, reserved (with its registry row) and
 * claimed. Null: the job already has a submission.
 */
export async function admitConsumerJob(scope: ConsumerJobScope, job: ConsumerJob, tool: WebsiteToolId): Promise<string | null> {
  if (job.funding !== "platform_account") return (await claimConsumerDispatch(scope))?.claimToken ?? null;
  return admitWebsiteJob(scope, job, tool, job.quoteCredits);
}
/** The transport's answer, on the platform registry (a job on its owner's own account has none). */
export async function recordWebsiteSubmission(job: ConsumerJob, result: { state: "accepted"; providerJobId: string } | { state: "uncertain" }) {
  if (job.funding !== "platform_account") return;
  if (result.state === "accepted") await acceptWebsiteJob(job, result.providerJobId);
  else await holdUncertainWebsiteJob(job);
}
/**
 * Whether an error after the claim proves the paid call never left. The
 * transports throw a ConsumerVideoError only before sending (an error after
 * sending is an uncertain reply, not a throw), and an admission that stopped
 * after its claim never called the transport at all. Only a platform job
 * acts on it (failed, its reservation released to zero); a job on its
 * owner's own account stays uncertain, as it always has.
 */
export const websiteCallNeverLeft = (job: Pick<ConsumerJob, "funding">, error: unknown, admitted: boolean) =>
  job.funding === "platform_account" && (!admitted || error instanceof ConsumerVideoError);

/** What a client is told before approving a website-tool job: its exact price, and that a failed job is still charged it. */
export const WEBSITE_CHARGE_TERMS = Object.freeze({ onFailure: "charged" as const });
