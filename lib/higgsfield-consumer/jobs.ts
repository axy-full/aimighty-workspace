/** Server-side consumer ledger. This module never calls a provider or spends credits. */
import { createHash, randomUUID } from "node:crypto";
import type { Client, Row, Transaction } from "@libsql/client";
import { db, ready } from "@/lib/db";
import { workbenchTransaction } from "@/lib/workbench/records";
import { validateConsumerGenjutsuSources } from "./genjutsu-sources";
import { validateConsumerGenerationSources } from "./generation-sources";
import { validateConsumerMarketingTemplateSources } from "./marketing-template-sources";
import { columnInstaller } from "@/lib/schemaInitialization";

export type ConsumerWorkflow =
  "marketing-video" | "reference-match" | "virality" | "genjutsu" | "generation" | "marketing-template";
export const CONSUMER_WORKFLOWS: readonly ConsumerWorkflow[] = Object.freeze([
  "marketing-video", "reference-match", "virality", "genjutsu", "generation", "marketing-template",
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
  createdAt: number;
  updatedAt: number;
};
export type CreateConsumerJob = ConsumerScope & {
  workflow: ConsumerWorkflow;
  connectedOwnerId: string;
  connectionGeneration: string;
  higgsfieldWorkspaceId?: string | null;
  idempotencyKey: string;
  payload: { [key: string]: ConsumerJson };
  quoteCredits: number;
  quoteExpiresAt: number;
  originalAssetIds: string[];
};
export type ConsumerFailureCode =
  "submission_rejected" | "provider_failed" | "invalid_result";
export type ConsumerJobErrorCode =
  | "invalid_input"
  | "not_found"
  | "idempotency_conflict"
  | "quote_expired"
  | "capacity"
  | "provider_job_conflict"
  | "receipt_conflict";
export class ConsumerJobError extends Error {
  constructor(
    public readonly code: ConsumerJobErrorCode,
    public readonly status: number = 409,
  ) {
    super(code);
    this.name = "ConsumerJobError";
  }
}
export const CONSUMER_ACTIVE_LIMIT = 4;
// A result read can include bounded original-media collection before settling.
export const CONSUMER_POLL_LEASE_MS = 180_000;
const initialized = new WeakMap<Client, Promise<void>>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
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

/** Stable JSON, with hard depth/node/byte bounds. No getters, prototypes or implicit coercion. */
function canonicalObject(value: unknown, maxBytes: number): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 12) return invalid();
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > maxBytes) return invalid();
      return JSON.stringify(item);
    }
    if (typeof item === "number")
      return Number.isFinite(item) ? JSON.stringify(item) : invalid();
    if (typeof item !== "object" || item === null) return invalid();
    if (Array.isArray(item)) {
      if (
        item.length > 10_000 ||
        Object.keys(item).length !== item.length ||
        Object.getOwnPropertySymbols(item).length
      )
        return invalid();
      const parts: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !("value" in descriptor)) return invalid();
        parts.push(visit(descriptor.value, depth + 1));
      }
      const text = `[${parts.join(",")}]`;
      return Buffer.byteLength(text) <= maxBytes ? text : invalid();
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    if (Object.getOwnPropertySymbols(item).length) return invalid();
    const parts: string[] = [];
    for (const key of Object.keys(item).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) return invalid();
      parts.push(
        `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`,
      );
    }
    const text = `{${parts.join(",")}}`;
    return Buffer.byteLength(text) <= maxBytes ? text : invalid();
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return visit(value, 0);
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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
async function requireDraft(
  tx: Pick<Transaction, "execute">,
  input: ConsumerScope,
) {
  const found = await tx.execute({
    sql: "SELECT 1 FROM workbench_projects WHERE owner=? AND project_id=? LIMIT 1",
    args: [input.userId, input.draftId],
  });
  if (!found.rows.length) throw new ConsumerJobError("not_found", 404);
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
async function requiredRow(
  tx: Pick<Transaction, "execute">,
  input: ConsumerJobScope,
) {
  const row = await rowFor(tx, input);
  if (!row) throw new ConsumerJobError("not_found", 404);
  return row;
}

/** The caller must validate source ownership and the workflow's provider schema first.
 * A repeated key never creates a second job, including after its quote expires. */
export async function createConsumerJob(
  input: CreateConsumerJob,
): Promise<{ job: ConsumerJob; replayed: boolean }> {
  scope(input);
  identifier(input.connectedOwnerId);
  identifier(input.connectionGeneration);
  identifier(input.idempotencyKey, 128);
  const workspaceId = input.higgsfieldWorkspaceId ?? null;
  if (workspaceId !== null) identifier(workspaceId);
  if (!CONSUMER_WORKFLOWS.includes(input.workflow)) invalid();
  if (
    !Number.isFinite(input.quoteCredits) ||
    input.quoteCredits < 0 ||
    input.quoteCredits > Number.MAX_SAFE_INTEGER
  )
    invalid();
  if (!Number.isSafeInteger(input.quoteExpiresAt) || input.quoteExpiresAt <= 0)
    invalid();
  if (
    !Array.isArray(input.originalAssetIds) ||
    input.originalAssetIds.length > 128
  )
    invalid();
  for (const id of input.originalAssetIds) identifier(id);
  if (new Set(input.originalAssetIds).size !== input.originalAssetIds.length)
    invalid();
  // Snapshot caller-owned fields before awaiting a database lock. Their edits
  // must not change values after the immutable fingerprint has been computed.
  input = { ...input, originalAssetIds: [...input.originalAssetIds] };
  const payloadJson = canonicalObject(input.payload, 65_536);
  const immutableHash = hash(
    canonicalObject(
      {
        workflow: input.workflow,
        connectedOwnerId: input.connectedOwnerId,
        connectionGeneration: input.connectionGeneration,
        higgsfieldWorkspaceId: workspaceId,
        payloadJson,
        quoteCredits: input.quoteCredits,
        quoteExpiresAt: input.quoteExpiresAt,
        originalAssetIds: input.originalAssetIds,
      },
      131_072,
    ),
  );
  await consumerJobsReady();
  return workbenchTransaction(async (tx) => {
    await requireDraft(tx, input);
    if(input.workflow === "genjutsu") await validateConsumerGenjutsuSources(tx, JSON.parse(payloadJson).input);
    if(input.workflow === "generation") await validateConsumerGenerationSources(tx, JSON.parse(payloadJson).input);
    if(input.workflow === "marketing-template") await validateConsumerMarketingTemplateSources(tx, JSON.parse(payloadJson).input);
    const previous = (
      await tx.execute({
        sql: "SELECT * FROM higgsfield_consumer_jobs WHERE user_id=? AND draft_id=? AND idempotency_key=?",
        args: [input.userId, input.draftId, input.idempotencyKey],
      })
    ).rows[0];
    if (previous) {
      if (previous.immutable_hash !== immutableHash)
        throw new ConsumerJobError("idempotency_conflict");
      return { job: asJob(previous), replayed: true };
    }
    const now = Date.now(),
      id = randomUUID();
    if (input.quoteExpiresAt <= now)
      throw new ConsumerJobError("quote_expired");
    await tx.execute({
      sql: `INSERT INTO higgsfield_consumer_jobs
      (id,user_id,draft_id,connected_owner_id,connection_generation,higgsfield_workspace_id,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'quoted',?,?)`,
      args: [
        id,
        input.userId,
        input.draftId,
        input.connectedOwnerId,
        input.connectionGeneration,
        workspaceId,
        input.workflow,
        input.idempotencyKey,
        payloadJson,
        hash(payloadJson),
        immutableHash,
        input.quoteCredits,
        input.quoteExpiresAt,
        JSON.stringify(input.originalAssetIds),
        now,
        now,
      ],
    });
    return {
      job: asJob(await requiredRow(tx, { ...input, id })),
      replayed: false,
    };
  });
}

export async function getConsumerJob(
  input: ConsumerJobScope,
): Promise<ConsumerJob | null> {
  jobScope(input);
  await consumerJobsReady();
  const row = await rowFor(db(), input);
  return row ? asJob(row) : null;
}
/** Expiry is actionable only after any earlier dispatch transaction has
 * committed. A plain remote/WAL read can still observe its old quoted row. */
export async function readConsumerJobAfterAdmissions(input: ConsumerJobScope): Promise<ConsumerJob | null> {
  jobScope(input);
  await consumerJobsReady();
  return workbenchTransaction(async tx => {
    const row = await rowFor(tx, input);
    return row ? asJob(row) : null;
  });
}
/** Look up a prior quote before making another provider pricing request. */
export async function getConsumerJobByKey(
  input: ConsumerScope & { idempotencyKey: string },
): Promise<ConsumerJob | null> {
  scope(input);
  identifier(input.idempotencyKey, 128);
  await consumerJobsReady();
  const row = (
    await db().execute({
      sql: "SELECT * FROM higgsfield_consumer_jobs WHERE user_id=? AND draft_id=? AND idempotency_key=?",
      args: [input.userId, input.draftId, input.idempotencyKey],
    })
  ).rows[0];
  return row ? asJob(row) : null;
}
export type ConsumerJobCursor = { createdAt: number; id: string };
/** Pin every admitted recoverable job (workspace capacity is four), so quote
 * history cannot hide a paid operation that still needs reconciliation. */
export async function listConsumerRecoveryJobs(
  input: ConsumerScope & { workflow: ConsumerWorkflow; limit?: number },
): Promise<ConsumerJob[]> {
  scope(input);
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 ||
      !CONSUMER_WORKFLOWS.includes(input.workflow)) invalid();
  await consumerJobsReady();
  const rows = await workbenchTransaction(tx => tx.execute({
    sql: `SELECT * FROM higgsfield_consumer_jobs WHERE user_id=? AND draft_id=? AND workflow=?
      ORDER BY CASE WHEN status IN ('dispatching','accepted','uncertain') AND dispatch_claim_hash IS NOT NULL THEN 0
        WHEN status IN ('dispatching','accepted','uncertain') THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT ?`,
    args: [input.userId, input.draftId, input.workflow, limit],
  }));
  return rows.rows.map(asJob);
}
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

/** A durable dispatch claim has no expiry/reclaim path: a crash may have submitted. */
export async function claimConsumerDispatch(
  input: ConsumerJobScope,
): Promise<{ job: ConsumerJob; claimToken: string } | null> {
  jobScope(input);
  await consumerJobsReady();
  return workbenchTransaction(async (tx) => {
    const row = await requiredRow(tx, input);
    if (row.status !== "quoted") return null;
    // Deletion may not initiate new spend, but already dispatched receipts
    // remain accessible to their immutable owner for reconciliation.
    await requireDraft(tx, input);
    if(row.workflow === "genjutsu") await validateConsumerGenjutsuSources(tx, JSON.parse(String(row.payload_json)).input);
    if(row.workflow === "generation") await validateConsumerGenerationSources(tx, JSON.parse(String(row.payload_json)).input);
    if(row.workflow === "marketing-template") await validateConsumerMarketingTemplateSources(tx, JSON.parse(String(row.payload_json)).input);
    const now = Date.now();
    if (Number(row.quote_expires_at) <= now)
      throw new ConsumerJobError("quote_expired");
    const active = Number(
      (
        await tx.execute(
          "SELECT COUNT(*) AS count FROM higgsfield_consumer_jobs WHERE status IN ('dispatching','accepted','uncertain')",
        )
      ).rows[0].count,
    );
    if (active >= CONSUMER_ACTIVE_LIMIT)
      throw new ConsumerJobError("capacity", 429);
    const claimToken = randomUUID();
    const changed = await tx.execute({
      sql: "UPDATE higgsfield_consumer_jobs SET status='dispatching',dispatch_claim_hash=?,updated_at=? WHERE id=? AND user_id=? AND draft_id=? AND status='quoted' AND quote_expires_at>?",
      args: [hash(claimToken), now, input.id, input.userId, input.draftId, now],
    });
    return changed.rowsAffected === 1
      ? { job: asJob(await requiredRow(tx, input)), claimToken }
      : null;
  });
}

type DispatchInput = ConsumerJobScope & { claimToken: string };
function dispatchInput(input: DispatchInput) {
  jobScope(input);
  identifier(input.claimToken);
}
/** A late definitive acknowledgement can resolve uncertainty using the original claim only. */
export async function markConsumerAccepted(
  input: DispatchInput & { providerJobId: string },
): Promise<ConsumerJob | null> {
  dispatchInput(input);
  if (
    typeof input.providerJobId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.providerJobId,
    )
  )
    invalid();
  const providerJobId = input.providerJobId.toLowerCase();
  await consumerJobsReady();
  return workbenchTransaction(async (tx) => {
    const row = await requiredRow(tx, input);
    if (row.dispatch_claim_hash !== hash(input.claimToken)) return null;
    if (row.provider_job_id != null) {
      if (row.provider_job_id !== providerJobId)
        throw new ConsumerJobError("provider_job_conflict");
      return asJob(row);
    }
    if (row.status !== "dispatching" && row.status !== "uncertain") return null;
    if (
      (
        await tx.execute({
          sql: "SELECT 1 FROM higgsfield_consumer_jobs WHERE provider_job_id=? AND id<>?",
          args: [providerJobId, input.id],
        })
      ).rows.length
    )
      throw new ConsumerJobError("provider_job_conflict");
    await tx.execute({
      sql: "UPDATE higgsfield_consumer_jobs SET status='accepted',provider_job_id=?,updated_at=? WHERE id=? AND user_id=? AND draft_id=? AND dispatch_claim_hash=? AND status IN ('dispatching','uncertain') AND provider_job_id IS NULL",
      args: [
        providerJobId,
        Date.now(),
        input.id,
        input.userId,
        input.draftId,
        hash(input.claimToken),
      ],
    });
    return asJob(await requiredRow(tx, input));
  });
}
async function finishDispatch(
  input: DispatchInput,
  status: "uncertain" | "failed",
  failureCode: ConsumerFailureCode | null,
  providerReceipt: string | null = null,
): Promise<ConsumerJob | null> {
  dispatchInput(input);
  await consumerJobsReady();
  return workbenchTransaction(async (tx) => {
    const row = await requiredRow(tx, input);
    if (row.dispatch_claim_hash !== hash(input.claimToken)) return null;
    const replay = row.status === status && row.failure_code === failureCode;
    if (row.status !== "dispatching" && !replay) return null;
    if (
      row.provider_receipt != null &&
      providerReceipt !== null &&
      row.provider_receipt !== providerReceipt
    )
      throw new ConsumerJobError("receipt_conflict");
    if (replay && (providerReceipt === null || row.provider_receipt != null))
      return asJob(row);
    await tx.execute({
      sql: "UPDATE higgsfield_consumer_jobs SET status=?,failure_code=?,provider_receipt=COALESCE(provider_receipt,?),updated_at=? WHERE id=? AND user_id=? AND draft_id=? AND status IN ('dispatching',?) AND dispatch_claim_hash=?",
      args: [
        status,
        failureCode,
        providerReceipt,
        Date.now(),
        input.id,
        input.userId,
        input.draftId,
        status,
        hash(input.claimToken),
      ],
    });
    return asJob(await requiredRow(tx, input));
  });
}

/** Recover a newly understood acknowledgement from the immutable server-saved
 * receipt. This only adopts an existing provider job; it never admits a POST.
 * The workflow service must validate the receipt format before calling. */
export async function reconcileConsumerReceipt(
  input: ConsumerJobScope & { providerJobId: string; expectedReceipt: { [key: string]: ConsumerJson } },
): Promise<ConsumerJob | null> {
  jobScope(input);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.providerJobId)) invalid();
  const providerJobId = input.providerJobId.toLowerCase();
  const expected = canonicalObject(input.expectedReceipt, 65_536);
  await consumerJobsReady();
  return workbenchTransaction(async tx => {
    const row = await requiredRow(tx, input);
    if (row.provider_receipt !== expected || !row.dispatch_claim_hash || !["marketing-video", "genjutsu", "generation", "marketing-template"].includes(String(row.workflow))) return null;
    if (row.provider_job_id != null) {
      if (row.provider_job_id !== providerJobId) throw new ConsumerJobError("provider_job_conflict");
      return asJob(row);
    }
    if (row.status !== "uncertain") return null;
    if ((await tx.execute({ sql: "SELECT 1 FROM higgsfield_consumer_jobs WHERE provider_job_id=? AND id<>?", args: [providerJobId, input.id] })).rows.length)
      throw new ConsumerJobError("provider_job_conflict");
    await tx.execute({ sql: "UPDATE higgsfield_consumer_jobs SET status='accepted',provider_job_id=?,updated_at=? WHERE id=? AND user_id=? AND draft_id=? AND status='uncertain' AND provider_receipt=? AND provider_job_id IS NULL",
      args: [providerJobId, Date.now(), input.id, input.userId, input.draftId, expected] });
    return asJob(await requiredRow(tx, input));
  });
}
/** Pass only a service-validated, secret-redacted provider acknowledgement.
 * Recording it with uncertainty is atomic and never enables resubmission. */
export const markConsumerUncertain = (
  input: DispatchInput & { providerReceipt?: { [key: string]: ConsumerJson } },
) =>
  finishDispatch(
    input,
    "uncertain",
    null,
    input.providerReceipt === undefined
      ? null
      : canonicalObject(input.providerReceipt, 65_536),
  );
/** Only for a definitive rejection before provider acceptance; never for a timeout. */
export const markConsumerFailed = (input: DispatchInput) =>
  finishDispatch(input, "failed", "submission_rejected");

type PollInput = ConsumerJobScope & { leaseToken: string };
/** Grants permission to GET the stored provider job, never to submit a generation. */
export async function claimConsumerPoll(input: ConsumerJobScope): Promise<{
  job: ConsumerJob;
  leaseToken: string;
  leaseExpiresAt: number;
} | null> {
  jobScope(input);
  await consumerJobsReady();
  return workbenchTransaction(async (tx) => {
    const row = await requiredRow(tx, input),
      now = Date.now();
    if (
      row.status !== "accepted" ||
      !row.provider_job_id ||
      Number(row.poll_lease_until) > now
    )
      return null;
    const leaseToken = randomUUID(),
      leaseExpiresAt = now + CONSUMER_POLL_LEASE_MS;
    const changed = await tx.execute({
      sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_hash=?,poll_lease_until=?,updated_at=? WHERE id=? AND user_id=? AND draft_id=? AND status='accepted' AND (poll_lease_until IS NULL OR poll_lease_until<=?)",
      args: [
        hash(leaseToken),
        leaseExpiresAt,
        now,
        input.id,
        input.userId,
        input.draftId,
        now,
      ],
    });
    return changed.rowsAffected === 1
      ? { job: asJob(await requiredRow(tx, input)), leaseToken, leaseExpiresAt }
      : null;
  });
}
async function finishPoll(
  input: PollInput,
  outcome:
    | { status: "completed"; manifest: string }
    | { status: "failed"; failureCode: ConsumerFailureCode }
    | { status: "accepted"; nextPollAt?: number },
): Promise<ConsumerJob | null> {
  jobScope(input);
  identifier(input.leaseToken);
  await consumerJobsReady();
  return workbenchTransaction(async (tx) => {
    const row = await requiredRow(tx, input),
      now = Date.now();
    if (
      row.status !== "accepted" ||
      row.poll_lease_hash !== hash(input.leaseToken) ||
      Number(row.poll_lease_until) <= now
    )
      return null;
    const changed = await tx.execute({
      sql: "UPDATE higgsfield_consumer_jobs SET status=?,result_manifest=?,failure_code=?,poll_lease_hash=NULL,poll_lease_until=?,updated_at=? WHERE id=? AND user_id=? AND draft_id=? AND status='accepted' AND poll_lease_hash=? AND poll_lease_until>?",
      args: [
        outcome.status,
        outcome.status === "completed" ? outcome.manifest : null,
        outcome.status === "failed" ? outcome.failureCode : null,
        outcome.status === "accepted" ? (outcome.nextPollAt ?? null) : null,
        now,
        input.id,
        input.userId,
        input.draftId,
        hash(input.leaseToken),
        now,
      ],
    });
    return changed.rowsAffected === 1
      ? asJob(await requiredRow(tx, input))
      : null;
  });
}
/** Workflow service validates result provenance/schema before passing its bounded manifest.
 * Keep this durable receipt even when attaching output to a deleted/changed draft
 * fails: attachment can be recovered without submitting the provider job again. */
export const completeConsumerJob = (
  input: PollInput & { resultManifest: { [key: string]: ConsumerJson } },
) =>
  finishPoll(input, {
    status: "completed",
    manifest: canonicalObject(input.resultManifest, 262_144),
  });
export function failConsumerPoll(
  input: PollInput & { failureCode: "provider_failed" | "invalid_result" },
) {
  if (!["provider_failed", "invalid_result"].includes(input.failureCode))
    invalid();
  return finishPoll(input, {
    status: "failed",
    failureCode: input.failureCode,
  });
}
export function releaseConsumerPoll(
  input: PollInput & { nextPollAt?: number },
) {
  const now = Date.now();
  if (
    input.nextPollAt !== undefined &&
    (!Number.isSafeInteger(input.nextPollAt) ||
      input.nextPollAt < now ||
      input.nextPollAt > now + 3_600_000)
  )
    invalid();
  return finishPoll(input, {
    status: "accepted",
    nextPollAt: input.nextPollAt,
  });
}
