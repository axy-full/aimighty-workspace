/**
 * Background collection for connected-account jobs. The account keeps working
 * after the page closes, so the workspace heartbeat (app/api/cron/sync) reads
 * a few due, accepted jobs on each visit through each workflow's own leased
 * poll: the same free status read and the same one-time collection the page
 * would run. A finished job is filed and settled, a refused one is settled
 * with its receipt, and either way its slot is freed with no tab open.
 *
 * Nothing here quotes, dispatches or re-sends anything, and no job is read
 * more than once per CONSUMER_SWEEP_INTERVAL_MS. A job that cannot be read
 * right now (disconnected, grant changed, the account busy) is simply tried
 * again on a later visit, behind the others.
 */
import { claimConsumerSweep, type ConsumerJobScope, type ConsumerWorkflow } from "./jobs";
import { pollConsumerGeneration } from "./generation-service";
import { pollConsumerMarketingVideo } from "./video-service";
import { pollConsumerGenjutsu } from "./genjutsu-service";
import { pollConsumerMarketingTemplate } from "./marketing-template-service";
import { pollConsumerVoiceTool } from "./voice-tool-service";
import { pollConsumerShorts } from "./shorts-service";

export type ConsumerSweepPoll = (scope: ConsumerJobScope) => Promise<unknown>;
const POLLS: Partial<Record<ConsumerWorkflow, ConsumerSweepPoll>> = {
  generation: pollConsumerGeneration,
  "marketing-video": pollConsumerMarketingVideo,
  genjutsu: pollConsumerGenjutsu,
  "marketing-template": pollConsumerMarketingTemplate,
  "voice-tool": pollConsumerVoiceTool,
  shorts: pollConsumerShorts,
};

/**
 * Read up to `limit` due jobs of the current tenant, one at a time, stopping
 * at `deadlineAt`. Never throws for one job's failure (it is counted); only a
 * ledger failure escapes. `polls` replaces the workflow polls in tests.
 */
export async function sweepConsumerJobs(options: {
  limit?: number;
  deadlineAt: number;
  polls?: Partial<Record<ConsumerWorkflow, ConsumerSweepPoll>>;
}): Promise<{ read: number; unavailable: number; deferred: boolean }> {
  const polls = options.polls ?? POLLS;
  const workflows = Object.keys(polls) as ConsumerWorkflow[];
  const limit = options.limit ?? 2;
  const report = { read: 0, unavailable: 0, deferred: false };
  if (!workflows.length) return report;
  for (let taken = 0; taken < limit; taken++) {
    if (Date.now() >= options.deadlineAt) {
      report.deferred = true;
      break;
    }
    const job = await claimConsumerSweep(workflows);
    if (!job) break;
    try {
      await polls[job.workflow]!({ userId: job.userId, draftId: job.draftId, id: job.id });
      report.read++;
    } catch {
      // Provider, grant and storage errors can carry URLs or account detail:
      // count them only. The job stays accepted and is read again later.
      report.unavailable++;
    }
  }
  return report;
}
