/**
 * The cron's `connected_jobs` stage: finish connected-account jobs nobody is
 * watching. A job used to advance only while its page kept polling, so a take
 * the person left mid-render was paid for and never collected into Takes.
 *
 * It calls each workflow's own leased status poll — the very call the page
 * makes — so collection, settlement and (for Gen takes) filing into the
 * project happen exactly as they would with the page open. It never quotes or
 * submits: a sweep can read status, never spend.
 */
import {
  CONSUMER_ACTIVE_LIMIT, listConsumerDueJobs,
  type ConsumerJob, type ConsumerJobScope, type ConsumerWorkflow,
} from "./jobs";

type Poll = (scope: ConsumerJobScope) => Promise<{ job: { status: string } }>;
export type ConsumerPollers = Partial<Record<ConsumerWorkflow, () => Promise<Poll>>>;

/** Each workflow's existing poll, loaded only when a job of that kind is due. */
const POLLERS: ConsumerPollers = {
  generation: async () => (await import("./generation-service")).pollConsumerGeneration,
  genjutsu: async () => (await import("./genjutsu-service")).pollConsumerGenjutsu,
  "marketing-video": async () => (await import("./video-service")).pollConsumerMarketingVideo,
  "marketing-template": async () => (await import("./marketing-template-service")).pollConsumerMarketingTemplate,
  "voice-tool": async () => (await import("./voice-tool-service")).pollConsumerVoiceTool,
  shorts: async () => (await import("./shorts-service")).pollConsumerShorts,
};

export type ConsumerSweepReport = {
  /** Jobs asked after in this sweep. */
  attempted: number;
  /** Settled as completed (collected into Takes). */
  completed: number;
  /** Settled as failed on the account (never billed). */
  failed: number;
  /** Waiting on the person, not on the platform: a reconnect, storage room, a conflict to review. */
  waiting: number;
  /** A passing outage (the account, storage, another reader's lease): the next sweep asks again. */
  retrying: number;
  /** Unexpected problems — the stage reports failure so the health line says so. */
  errors: number;
  /** Due jobs left for the next sweep because the time budget ran out. */
  deferred: number;
};

/* Codes the consumer services raise on a status read, sorted by who can fix them.
   A person: reconnect, make room, review a conflict. Time: an outage or a busy lease. */
const WAITING = new Set([
  "reconnect_required", "connection_changed", "session_changed", "authorization_denied", "authorization_failed", "invalid_state",
  "not_found", "deleted", "conflict", "invalid_video", "quota", "idempotency_conflict", "provider_job_conflict", "receipt_conflict",
  "workspace_changed", "invalid_workspace", "invalid_job", "tool_contract_changed",
]);
const RETRY = new Set([
  "unavailable", "connection_busy", "busy", "timeout", "storage_unavailable",
  "provider_error", "status_unavailable", "tool_unavailable", "preflight_unavailable",
]);

/** How one failed status read counts. Anything without a known code is a bug to look at. */
export function sweepOutcome(error: unknown): "waiting" | "retrying" | "errors" {
  const raw = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const code = typeof raw === "string" ? raw : "";
  return WAITING.has(code) ? "waiting" : RETRY.has(code) ? "retrying" : "errors";
}

/**
 * Ask after up to `limit` due jobs in this tenant, one at a time, until the
 * deadline. Runs inside runInTenant; every read is this workspace's database.
 */
export async function sweepConsumerJobs(options: {
  limit?: number;
  deadlineAt?: number;
  clock?: () => number;
  list?: typeof listConsumerDueJobs;
  pollers?: ConsumerPollers;
} = {}): Promise<ConsumerSweepReport> {
  const clock = options.clock ?? Date.now;
  const pollers = options.pollers ?? POLLERS;
  const report: ConsumerSweepReport = { attempted: 0, completed: 0, failed: 0, waiting: 0, retrying: 0, errors: 0, deferred: 0 };
  const due: ConsumerJob[] = await (options.list ?? listConsumerDueJobs)({ limit: options.limit ?? CONSUMER_ACTIVE_LIMIT, now: clock() });
  for (const [index, job] of due.entries()) {
    if (options.deadlineAt != null && clock() >= options.deadlineAt) {
      report.deferred += due.length - index;
      break;
    }
    const load = pollers[job.workflow];
    if (!load) continue;
    report.attempted++;
    try {
      const poll = await load();
      const { job: after } = await poll({ userId: job.userId, draftId: job.draftId, id: job.id });
      if (after.status === "completed") report.completed++;
      else if (after.status === "failed") report.failed++;
    } catch (error) {
      const outcome = sweepOutcome(error);
      report[outcome]++;
      // Fixed names only: provider errors can carry URLs, prompts or tokens.
      console.error(JSON.stringify({
        level: outcome === "errors" ? "error" : "warn",
        event: "consumer_jobs.poll_unsettled",
        workflow: job.workflow,
        outcome,
      }));
    }
  }
  return report;
}
