/**
 * The connected account's job ledger, read-only. Particl no longer signs in to
 * Higgsfield (CLAUDE.md ground rule 10): nothing quotes, sends, polls or
 * collects an account job any more. Its rows stay (nothing is deleted) and are
 * read by the jobs tray, Workspace › Usage, the /usage history tab, purge and
 * backups. The schema installer keeps every column, so a fresh database and an
 * older backup read alike. This module never calls a provider or spends credits.
 */
import type { Client, Row, Transaction } from "@libsql/client";
import { db, ready } from "@/lib/db";
import { columnInstaller } from "@/lib/schemaInitialization";
import { parseOutcome, type ProviderOutcome } from "@/lib/providerOutcome";

export type ConsumerWorkflow =
  "marketing-video" | "reference-match" | "virality" | "genjutsu" | "generation" | "marketing-template" | "voice-tool" | "shorts";
export const CONSUMER_WORKFLOWS: readonly ConsumerWorkflow[] = Object.freeze([
  "marketing-video", "reference-match", "virality", "genjutsu", "generation", "marketing-template", "voice-tool", "shorts",
]);
export type ConsumerJobStatus =
  "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
export type ConsumerJson =
  | null
  | boolean
  | number
  | string
  | ConsumerJson[]
  | { [key: string]: ConsumerJson };
export type ConsumerScope = { userId: string; draftId: string };
export type ConsumerJobScope = ConsumerScope & { id: string };
export type ConsumerJob = ConsumerJobScope & {
  workflow: ConsumerWorkflow;
  connectedOwnerId: string;
  connectionGeneration: string;
  higgsfieldWorkspaceId: string | null;
  idempotencyKey: string;
  payloadJson: string;
  payloadHash: string;
  quoteCredits: number;
  creditUnit: "higgsfield_credits";
  quoteExpiresAt: number;
  originalAssetIds: string[];
  status: ConsumerJobStatus;
  providerJobId: string | null;
  providerReceipt: { [key: string]: ConsumerJson } | null;
  resultManifest: { [key: string]: ConsumerJson } | null;
  failureCode: ConsumerFailureCode | null;
  /** What the account said when it failed the job, and what its ledger shows for the charge; null on older rows. */
  providerOutcome: ProviderOutcome | null;
  /** Set when the owner set this unsettled job aside; it no longer holds capacity. */
  releasedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type ConsumerFailureCode =
  "submission_rejected" | "provider_failed" | "invalid_result";
/** The ledger reads only validate their own arguments now. */
export type ConsumerJobErrorCode = "invalid_input";
export class ConsumerJobError extends Error {
  constructor(
    public readonly code: ConsumerJobErrorCode,
    public readonly status: number = 400,
  ) {
    super(code);
    this.name = "ConsumerJobError";
  }
}
export const CONSUMER_ACTIVE_LIMIT = 4;
/**
 * How long an admitted job may hold one of the four slots. A provider job is
 * finished or dead well inside this window, so a job still unsettled after it
 * (an uncertain dispatch with no receipt id, a crash mid-dispatch, a result no
 * tab ever polled) stops blocking new spend. The row, its receipt and its
 * recovery path are untouched; it simply no longer counts.
 */
export const CONSUMER_CAPACITY_WINDOW_MS = 2 * 3_600_000;
/** An owner may set a job aside this long after it was admitted, not sooner. */
export const CONSUMER_RELEASE_GRACE_MS = 15 * 60_000;
/** The jobs that hold capacity right now, in SQL: admitted, unsettled, not set
 * aside by their owner, and inside the capacity window. */
const holdsCapacity = (alias = "") =>
  `${alias}status IN ('dispatching','accepted','uncertain') AND ${alias}released_at IS NULL AND ${alias}created_at>?`;
/**
 * The same rule for one job, from its views: an unsettled job its owner set
 * aside, or one past the capacity window, no longer holds a slot and no longer
 * blocks its workflow. It stays listed, and nothing is ever dispatched again.
 */
export function consumerJobSetAside(
  job: Pick<ConsumerJob, "status" | "releasedAt" | "createdAt">,
  now = Date.now(),
): boolean {
  return (
    (job.status === "dispatching" || job.status === "accepted" || job.status === "uncertain") &&
    (job.releasedAt !== null || job.createdAt <= now - CONSUMER_CAPACITY_WINDOW_MS)
  );
}
const initialized = new WeakMap<Client, Promise<void>>();
const invalid = (): never => {
  throw new ConsumerJobError("invalid_input", 400);
};
function identifier(value: unknown, max = 200): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
}
function scope(value: ConsumerScope) {
  identifier(value.userId);
  identifier(value.draftId);
}
function jobScope(value: ConsumerJobScope) {
  scope(value);
  identifier(value.id);
}

export async function consumerJobsReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(
      client,
      client
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS higgsfield_consumer_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, draft_id TEXT NOT NULL,
      connected_owner_id TEXT NOT NULL, connection_generation TEXT NOT NULL, higgsfield_workspace_id TEXT,
      workflow TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, immutable_hash TEXT NOT NULL,
      quote_credits REAL NOT NULL CHECK(quote_credits >= 0), quote_expires_at INTEGER NOT NULL,
      original_asset_ids TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('quoted','dispatching','accepted','uncertain','failed','completed')),
      provider_job_id TEXT, dispatch_claim_hash TEXT, poll_lease_hash TEXT, poll_lease_until INTEGER,
      result_manifest TEXT, provider_receipt TEXT, failure_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id,draft_id,idempotency_key), UNIQUE(provider_job_id)
    )`,
            `CREATE INDEX IF NOT EXISTS idx_consumer_jobs_owner ON higgsfield_consumer_jobs(user_id,draft_id,created_at DESC,id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_consumer_jobs_active ON higgsfield_consumer_jobs(status)`,
          ],
          "write",
        )
        .then(async () => {
          const add = await columnInstaller(client);
          await add("higgsfield_consumer_jobs", "provider_receipt TEXT");
          // When the owner set an unsettled job aside: it keeps its status,
          // receipt and recovery path but stops holding capacity. Additive.
          await add("higgsfield_consumer_jobs", "released_at INTEGER");
          // When the background heartbeat last took the job for a read. Additive.
          await add("higgsfield_consumer_jobs", "swept_at INTEGER");
          // What the account said when the job failed — its own status, its
          // words and, from its own credit ledger, what happened to the
          // charge (lib/providerOutcome.ts). Null reads as "didn't say". Additive.
          await add("higgsfield_consumer_jobs", "provider_outcome TEXT");
        })
        .catch((error) => {
          initialized.delete(client);
          throw error;
        }),
    );
  await initialized.get(client);
}

function asJob(row: Row): ConsumerJob {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    draftId: String(row.draft_id),
    connectedOwnerId: String(row.connected_owner_id),
    connectionGeneration: String(row.connection_generation),
    higgsfieldWorkspaceId:
      row.higgsfield_workspace_id == null
        ? null
        : String(row.higgsfield_workspace_id),
    workflow: row.workflow as ConsumerWorkflow,
    idempotencyKey: String(row.idempotency_key),
    payloadJson: String(row.payload_json),
    payloadHash: String(row.payload_hash),
    quoteCredits: Number(row.quote_credits),
    creditUnit: "higgsfield_credits",
    quoteExpiresAt: Number(row.quote_expires_at),
    originalAssetIds: JSON.parse(String(row.original_asset_ids)),
    status: row.status as ConsumerJobStatus,
    providerJobId:
      row.provider_job_id == null ? null : String(row.provider_job_id),
    providerReceipt:
      row.provider_receipt == null
        ? null
        : JSON.parse(String(row.provider_receipt)),
    resultManifest:
      row.result_manifest == null
        ? null
        : JSON.parse(String(row.result_manifest)),
    failureCode: row.failure_code as ConsumerFailureCode | null,
    providerOutcome: row.provider_outcome == null ? null : parseOutcome(String(row.provider_outcome)),
    releasedAt: row.released_at == null ? null : Number(row.released_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
async function rowFor(
  tx: Pick<Transaction, "execute">,
  input: ConsumerJobScope,
): Promise<Row | undefined> {
  return (
    await tx.execute({
      sql: "SELECT * FROM higgsfield_consumer_jobs WHERE id=? AND user_id=? AND draft_id=?",
      args: [input.id, input.userId, input.draftId],
    })
  ).rows[0];
}

export async function getConsumerJob(
  input: ConsumerJobScope,
): Promise<ConsumerJob | null> {
  jobScope(input);
  await consumerJobsReady();
  const row = await rowFor(db(), input);
  return row ? asJob(row) : null;
}
export type ConsumerJobCursor = { createdAt: number; id: string };
export async function listConsumerJobs(
  input: ConsumerScope & { limit?: number; before?: ConsumerJobCursor },
): Promise<{ items: ConsumerJob[]; nextCursor: ConsumerJobCursor | null }> {
  scope(input);
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
  if (input.before) {
    identifier(input.before.id);
    if (
      !Number.isSafeInteger(input.before.createdAt) ||
      input.before.createdAt < 0
    )
      invalid();
  }
  await consumerJobsReady();
  const rows = (
    await db().execute({
      sql: `SELECT * FROM higgsfield_consumer_jobs WHERE user_id=? AND draft_id=?
      ${input.before ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC,id DESC LIMIT ?`,
      args: [
        input.userId,
        input.draftId,
        ...(input.before
          ? [input.before.createdAt, input.before.createdAt, input.before.id]
          : []),
        limit + 1,
      ],
    })
  ).rows;
  const items = rows.slice(0, limit).map(asJob),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

export type ConsumerCapacityJob = {
  id: string;
  draftId: string;
  projectName: string | null;
  workflow: ConsumerWorkflow;
  status: "dispatching" | "accepted" | "uncertain";
  createdAt: number;
  /** The owner may set it aside now (past the grace period). */
  releasable: boolean;
};
/**
 * Who holds the workspace's four connected-account slots, from one owner's
 * side: the total, and that owner's own holders across every project (other
 * members' jobs are counted, never described). Reads the ledger only.
 */
export async function consumerCapacity(
  userId: string,
  now = Date.now(),
): Promise<{ limit: number; active: number; mine: ConsumerCapacityJob[] }> {
  identifier(userId);
  await consumerJobsReady();
  const since = now - CONSUMER_CAPACITY_WINDOW_MS;
  const [total, own] = await db().batch(
    [
      { sql: `SELECT COUNT(*) AS count FROM higgsfield_consumer_jobs WHERE ${holdsCapacity()}`, args: [since] },
      {
        sql: `SELECT j.id,j.draft_id,j.workflow,j.status,j.created_at,SUBSTR(p.name,1,200) AS project_name
          FROM higgsfield_consumer_jobs j LEFT JOIN workbench_projects p ON p.owner=j.user_id AND p.project_id=j.draft_id
          WHERE j.user_id=? AND ${holdsCapacity("j.")} ORDER BY j.created_at ASC,j.id ASC LIMIT ?`,
        args: [userId, since, CONSUMER_ACTIVE_LIMIT * 4],
      },
    ],
    "read",
  );
  return {
    limit: CONSUMER_ACTIVE_LIMIT,
    active: Number(total.rows[0]?.count ?? 0),
    mine: own.rows.map((row) => ({
      id: String(row.id),
      draftId: String(row.draft_id),
      projectName: row.project_name == null ? null : String(row.project_name),
      workflow: row.workflow as ConsumerWorkflow,
      status: row.status as ConsumerCapacityJob["status"],
      createdAt: Number(row.created_at),
      releasable: Number(row.created_at) <= now - CONSUMER_RELEASE_GRACE_MS,
    })),
  };
}
/**
 * The owner sets one of their own unsettled jobs aside so it stops holding a
 * slot. Nothing is deleted or rewritten: the status, receipt and provider id
 * stay, the job stays listed and recoverable, and it can never be dispatched
 * again. Only past the grace period, so capacity cannot be bypassed by
 * setting fresh jobs aside.
 */
export async function setAsideConsumerJob(
  input: { userId: string; id: string },
  now = Date.now(),
): Promise<boolean> {
  identifier(input.userId);
  identifier(input.id);
  await consumerJobsReady();
  const changed = await db().execute({
    sql: `UPDATE higgsfield_consumer_jobs SET released_at=? WHERE id=? AND user_id=?
      AND status IN ('dispatching','accepted','uncertain') AND released_at IS NULL AND created_at<=?`,
    args: [now, input.id, input.userId, now - CONSUMER_RELEASE_GRACE_MS],
  });
  return changed.rowsAffected === 1;
}
