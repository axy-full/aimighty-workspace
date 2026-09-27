/**
 * After a connected-account job fails: what did the account do with its
 * charge? Its help centre says refunds land "within a few minutes" and every
 * charge and refund is on its own usage ledger, so a failure's charge is
 * looked up there — once as the failure is read (mcp.ts, same session), then
 * again by the heartbeat a few times over the next two hours until the
 * ledger names the job. Free, read-only reads; nothing is quoted, sent or
 * re-sent, and only the one job is kept from the ledger's page.
 */
import { requireTenant } from "@/lib/tenant";
import { accountBilling } from "@/lib/providerOutcome";
import { getConsumerAccess } from "./oauth";
import { readConsumerJobLedger } from "./mcp";
import { claimConsumerBillingCheck, getConsumerJob, recordConsumerBilling, type ConsumerJobScope, type ConsumerWorkflow } from "./jobs";

/** Every workflow whose failed jobs have a provider job id the ledger can name (Shorts' ids are sessions, not jobs). */
const WORKFLOWS: readonly ConsumerWorkflow[] = ["generation", "marketing-video", "genjutsu", "marketing-template", "voice-tool"];

/** Look up one failed job's charge in its account's ledger and record what it says (or only that it was looked at). */
export async function checkConsumerJobBilling(scope: ConsumerJobScope): Promise<boolean> {
  const job = await getConsumerJob(scope);
  if (!job || job.status !== "failed" || !job.providerJobId || !job.higgsfieldWorkspaceId) return false;
  if (job.providerOutcome && job.providerOutcome.billing.state !== "unknown") return true;
  const access = await getConsumerAccess(requireTenant().id, scope.userId, { expectedGeneration: job.connectionGeneration });
  if (!access) {
    await recordConsumerBilling({ ...scope, billing: null });
    return false;
  }
  const ledger = await readConsumerJobLedger(access.accessToken, job.providerJobId, job.higgsfieldWorkspaceId);
  const billing = ledger ? accountBilling(ledger) : null;
  await recordConsumerBilling({ ...scope, billing });
  return Boolean(billing && billing.state !== "unknown");
}

/** The heartbeat's share: up to `limit` failed jobs whose charge is still unknown, one at a time. Never throws for one job. */
export async function sweepConsumerBilling(options: { limit?: number; deadlineAt: number }): Promise<{ checked: number; settled: number; deferred: boolean }> {
  const report = { checked: 0, settled: 0, deferred: false };
  for (let taken = 0; taken < (options.limit ?? 2); taken++) {
    if (Date.now() >= options.deadlineAt) {
      report.deferred = true;
      break;
    }
    const job = await claimConsumerBillingCheck(WORKFLOWS);
    if (!job) break;
    try {
      report.checked++;
      if (await checkConsumerJobBilling({ userId: job.userId, draftId: job.draftId, id: job.id })) report.settled++;
    } catch {
      /* Counted by its stamp; looked up again on a later visit. */
    }
  }
  return report;
}
