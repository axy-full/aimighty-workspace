import { createHash, randomUUID } from "node:crypto";
import type { ConsumerJobStatus, ConsumerWorkflow } from "../../lib/higgsfield-consumer/jobs";

/**
 * Connected-account rows as a database from before the Higgsfield sign-in was
 * removed holds them. Nothing writes these tables any more (CLAUDE.md ground
 * rule 10), so the specs for what still reads them (the jobs tray, Usage, the
 * /usage history tab, purge, deletion and backups) seed rows directly, in the
 * ledger's own shape. Call inside runInTenant; each call readies its tables.
 * Lib modules load lazily, after a spec has pointed the databases at its own
 * fixture folder.
 */
export type SeedConsumerJob = {
  id?: string;
  userId: string;
  draftId: string;
  workflow?: ConsumerWorkflow;
  status?: ConsumerJobStatus;
  quoteCredits?: number;
  payload?: Record<string, unknown>;
  /** A durable dispatch claim: every job that was sent has one; a quote never sent has none. */
  claimed?: boolean;
  providerJobId?: string | null;
  providerReceipt?: Record<string, unknown> | null;
  resultManifest?: Record<string, unknown> | null;
  failureCode?: string | null;
  providerOutcome?: string | null;
  connectionGeneration?: string;
  idempotencyKey?: string;
  originalAssetIds?: string[];
  quoteExpiresAt?: number;
  pollLeaseUntil?: number | null;
  releasedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
};

/** One job row, with every column the ledger keeps. Returns its id. */
export async function seedConsumerJob(job: SeedConsumerJob): Promise<string> {
  const { consumerJobsReady } = await import("../../lib/higgsfield-consumer/jobs");
  const { db } = await import("../../lib/db");
  await consumerJobsReady();
  const id = job.id ?? randomUUID();
  const status = job.status ?? "quoted";
  const payloadJson = JSON.stringify(job.payload ?? { input: { prompt: "Fixture" } });
  const createdAt = job.createdAt ?? Date.now();
  const sent = job.claimed ?? status !== "quoted";
  await db().execute({
    sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,higgsfield_workspace_id,workflow,
      idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,provider_job_id,
      dispatch_claim_hash,poll_lease_hash,poll_lease_until,result_manifest,provider_receipt,failure_code,created_at,updated_at,released_at,provider_outcome)
      VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`,
    args: [
      id, job.userId, job.draftId, job.userId, job.connectionGeneration ?? randomUUID(), job.workflow ?? "marketing-video",
      job.idempotencyKey ?? randomUUID(), payloadJson, createHash("sha256").update(payloadJson).digest("hex"), `immutable-${id}`,
      job.quoteCredits ?? 40, job.quoteExpiresAt ?? createdAt + 60_000, JSON.stringify(job.originalAssetIds ?? []), status,
      job.providerJobId ?? null, sent ? `claim-${id}` : null, job.pollLeaseUntil ?? null,
      job.resultManifest == null ? null : JSON.stringify(job.resultManifest),
      job.providerReceipt == null ? null : JSON.stringify(job.providerReceipt),
      job.failureCode ?? null, createdAt, job.updatedAt ?? createdAt, job.releasedAt ?? null, job.providerOutcome ?? null,
    ],
  });
  return id;
}

/**
 * An account original collected before the removal: an accepted job, the bytes
 * in Particl's storage, its server-written receipt and the Library take that
 * names it, exactly as the old collector left them. The job is still `accepted`
 * (the collector's own ledger completion never ran) unless `completed` is set.
 */
export async function seedCollectedOriginal(input: {
  userId: string; draftId: string; bytes: Buffer; generationId?: string; projectId?: string | null;
  quoteCredits?: number; completed?: boolean; metadata?: { width: number; height: number; seconds: number };
}) {
  const { db } = await import("../../lib/db");
  const { uploadReservationsReady } = await import("../../lib/uploadReservations");
  const { storeVideoBytes, videoPath } = await import("../../lib/storage");
  /* The collector's id shape: `gen_hfc_` and 40 hex characters (what the Library reads a charge line off). */
  const generationId = input.generationId ?? `gen_hfc_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 40)}`;
  const providerJobId = randomUUID(), credits = input.quoteCredits ?? 75;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const metadata = input.metadata ?? { width: 720, height: 1280, seconds: 1.5 };
  const receipt = {
    generationId, providerJobId, bytes: input.bytes.length, sha256, ...metadata, credits, creditUnit: "higgsfield_credits",
    asset: { generationId, url: `/api/media/${generationId}`, kind: "video", mime: "video/mp4", width: metadata.width, height: metadata.height, durationS: metadata.seconds },
  };
  const jobId = await seedConsumerJob({
    userId: input.userId, draftId: input.draftId, workflow: "marketing-video", status: input.completed ? "completed" : "accepted",
    quoteCredits: credits, providerJobId, resultManifest: input.completed ? { original: receipt } : null,
    payload: { input: { prompt: "A plain bottle.", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true } },
  });
  await uploadReservationsReady();
  const stored = await storeVideoBytes(generationId, input.bytes);
  await db().execute({
    sql: `INSERT INTO consumer_video_originals(job_id,generation_id,owner_id,draft_id,provider_job_id,state,sha256,bytes,metadata_json,lease,lease_until,receipt_json,updated_at)
      VALUES(?,?,?,?,?,'stored',?,?,?,NULL,NULL,?,?)`,
    args: [jobId, generationId, input.userId, input.draftId, providerJobId, sha256, input.bytes.length, JSON.stringify(metadata), JSON.stringify(receipt), Date.now()],
  });
  const params = {
    resolution: "720p", aspectRatio: "16:9", ratio: "16:9", generateAudio: true, duration: metadata.seconds,
    consumerJobId: jobId, consumerProviderJobId: providerJobId, consumerCredits: credits, consumerCreditUnit: "higgsfield_credits",
    originalSha256: sha256, width: metadata.width, height: metadata.height,
  };
  await db().execute({
    sql: `INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,kind,provider,bytes,duration_s,billed_to)
      VALUES(?,?,'marketing_studio_video','A plain bottle.',?,'succeeded',?,NULL,?,?,?,'video','higgsfield',?,?,'higgsfield')`,
    args: [generationId, input.projectId ?? null, JSON.stringify(params), videoPath(generationId), input.userId, Date.now(), Date.now(), stored.bytes, metadata.seconds],
  });
  return { jobId, generationId, providerJobId, sha256, receipt, credits };
}
