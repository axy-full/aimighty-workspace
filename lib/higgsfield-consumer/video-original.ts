import { createHash, randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import { db } from "../db";
import { currentTenant, requireTenant } from "../tenant";
import { quotaVerdict, workspaceLimits } from "../limits";
import { uploadReservationsReady } from "../uploadReservations";
import { readOriginalBytesLimited, storeOriginalBytes, storeVideoBytes } from "../storage";
import { inspectAudioBuffer } from "../mediaSource.server";
import { astraTextureDimensions, validateAstraGlb } from "../astra-blender/glb";
import { withRecoveryActivity } from "../recovery";
import { workbenchReady, workbenchTransaction } from "../workbench/records";
import {
  CONSUMER_VIDEO_BYTES,
  fetchPublicConsumerOriginalBytes,
  type ProductFetchDependencies,
} from "../workbench/product-fetch";
import { consumerJobsReady, type ConsumerJob } from "./jobs";
import { consumerVideoIdentity, type ConsumerOriginalKind } from "./original-identity";

export const CONSUMER_ORIGINAL_LEASE_MS = 180_000;
export const CONSUMER_ORIGINAL_DEADLINE_MS = 90_000;
type Metadata = { width?: number; height?: number; seconds?: number; mime?: string };
/** A retained connected-account original. Video receipts keep their original
 * shape; image, audio and 3D receipts carry only the fields their kind has. */
export type ConsumerVideoOriginal = {
  generationId: string;
  providerJobId: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  seconds?: number;
  mime?: string;
  credits: number;
  creditUnit: "higgsfield_credits";
  asset: {
    generationId: string;
    url: string;
    kind: ConsumerOriginalKind;
    mime: string;
    width?: number;
    height?: number;
    durationS?: number;
  };
};
export type ConsumerOriginal = ConsumerVideoOriginal;
export class ConsumerOriginalError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "busy"
      | "deleted"
      | "conflict"
      | "invalid_video"
      | "quota"
      | "timeout"
      | "storage_unavailable",
  ) {
    super(
      {
        not_found:
          "This accepted video is not available in the current workspace.",
        busy: "The original video is already being collected. Check again shortly.",
        deleted:
          "This original was deleted and will not be restored automatically.",
        conflict:
          "The original video differs from its recorded receipt and was not overwritten.",
        invalid_video:
          "The original must be an MP4 video up to 100 MB and 60 seconds with valid dimensions.",
        quota: "There is not enough workspace storage to retain this original.",
        timeout:
          "Original video collection reached its time limit. Its receipt remains available for recovery.",
        storage_unavailable:
          "The original could not be retained. Its reserved storage remains protected for recovery.",
      }[code],
    );
    this.name = "ConsumerOriginalError";
  }
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** The originals-ledger key of one clip of a multi-clip job (Shorts Studio):
 * each clip is its own retained original, keyed apart from its parent job. */
export const consumerClipKey = (jobId: string, index: number) => `${jobId}.clip-${index}`;
export type ConsumerClip = { index: number; providerJobId: string };
export function consumerOriginalGenerationId(
  workspaceId: string,
  jobId: string,
) {
  return `gen_hfc_${createHash("sha256")
    .update(JSON.stringify([workspaceId, jobId]))
    .digest("hex")
    .slice(0, 40)}`;
}

/** Metadata/packet inspection only, never transcoding or fetching references. */
export async function inspectConsumerVideoOriginal(
  bytes: Buffer,
): Promise<{ width: number; height: number; seconds: number }> {
  if (!bytes.length || bytes.length > CONSUMER_VIDEO_BYTES)
    throw new ConsumerOriginalError("invalid_video");
  const { Input, BufferSource, MP4, EncodedPacketSink } =
    await import("mediabunny");
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        if ((await input.getFormat()) !== MP4)
          throw new ConsumerOriginalError("invalid_video");
        const track = await input.getPrimaryVideoTrack();
        if (!track || !track.codec)
          throw new ConsumerOriginalError("invalid_video");
        const packets = new EncodedPacketSink(track);
        const [first, end, packet, lastPacket] = await Promise.all([
          track.getFirstTimestamp(),
          track.computeDuration({ skipLiveWait: true }),
          packets.getFirstPacket(),
          packets.getPacket(Infinity),
        ]);
        const width = track.displayWidth,
          height = track.displayHeight,
          seconds = end - Math.min(0, first);
        if (
          !packet?.data.byteLength ||
          !lastPacket?.data.byteLength ||
          ![width, height, seconds].every(
            (value) => Number.isFinite(value) && value > 0,
          ) ||
          seconds > 60 ||
          width > 16384 ||
          height > 16384 ||
          width * height > 40_000_000
        )
          throw new ConsumerOriginalError("invalid_video");
        return { width, height, seconds };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ConsumerOriginalError("invalid_video")),
          15_000,
        );
      }),
    ]);
  } catch {
    throw new ConsumerOriginalError("invalid_video");
  } finally {
    clearTimeout(timer);
    input.dispose();
  }
}

const sniff = {
  png: (b: Buffer) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  jpeg: (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b: Buffer) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  wav: (b: Buffer) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE",
  mp3: (b: Buffer) => b.length > 3 && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  ogg: (b: Buffer) => b.length > 4 && b.toString("latin1", 0, 4) === "OggS",
  flac: (b: Buffer) => b.length > 4 && b.toString("latin1", 0, 4) === "fLaC",
  m4a: (b: Buffer) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp",
  glb: (b: Buffer) => b.length > 12 && b.readUInt32LE(0) === 0x46546c67,
  zip: (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
};
/** Byte-level identification only; the served type is what the bytes are, not
 * what the provider's header claimed. GLB files must pass the Astra validator. */
export async function inspectConsumerOriginal(kind: ConsumerOriginalKind, bytes: Buffer): Promise<Metadata> {
  if (kind === "video") return { ...(await inspectConsumerVideoOriginal(bytes)), mime: "video/mp4" };
  if (!bytes.length || bytes.length > CONSUMER_VIDEO_BYTES) throw new ConsumerOriginalError("invalid_video");
  try {
    if (kind === "image") {
      const mime = sniff.png(bytes) ? "image/png" : sniff.jpeg(bytes) ? "image/jpeg" : sniff.webp(bytes) ? "image/webp" : null;
      if (!mime) throw new ConsumerOriginalError("invalid_video");
      const { width, height } = astraTextureDimensions(bytes, mime);
      return { width, height, mime };
    }
    if (kind === "audio") {
      const mime = sniff.wav(bytes) ? "audio/wav" : sniff.ogg(bytes) ? "audio/ogg" : sniff.flac(bytes) ? "audio/flac" : sniff.m4a(bytes) ? "audio/mp4" : sniff.mp3(bytes) ? "audio/mpeg" : null;
      if (!mime) throw new ConsumerOriginalError("invalid_video");
      return { mime };
    }
    if (sniff.glb(bytes)) {
      validateAstraGlb(bytes);
      return { mime: "model/gltf-binary" };
    }
    if (sniff.zip(bytes)) return { mime: "application/zip" };
  } catch {
    throw new ConsumerOriginalError("invalid_video");
  }
  throw new ConsumerOriginalError("invalid_video");
}

async function currentJob(tx: Transaction, job: ConsumerJob) {
  const row = (
    await tx.execute({
      sql: "SELECT * FROM higgsfield_consumer_jobs WHERE id=? AND user_id=? AND draft_id=?",
      args: [job.id, job.userId, job.draftId],
    })
  ).rows[0];
  if (
    !row ||
    !["accepted", "completed"].includes(String(row.status)) ||
    !row.provider_job_id ||
    row.provider_job_id !== job.providerJobId ||
    row.payload_hash !== job.payloadHash ||
    row.payload_json !== job.payloadJson ||
    Number(row.quote_credits) !== job.quoteCredits ||
    row.connection_generation !== job.connectionGeneration ||
    row.workflow !== job.workflow || !["marketing-video", "genjutsu", "generation", "marketing-template", "voice-tool", "shorts"].includes(job.workflow)
  )
    throw new ConsumerOriginalError("not_found");
  return row;
}
async function originalRow(tx: Transaction, jobId: string) {
  return (
    await tx.execute({
      sql: "SELECT * FROM consumer_video_originals WHERE job_id=?",
      args: [jobId],
    })
  ).rows[0];
}
async function generationExists(tx: Transaction, id: string) {
  return (
    await tx.execute({
      sql: "SELECT id,deleted,params,stored_url,bytes,provider,model,kind,status FROM generations WHERE id=?",
      args: [id],
    })
  ).rows[0];
}
function ownedGeneration(row: Row | undefined, job: ConsumerJob, key = job.id, providerJobId = job.providerJobId) {
  if (!row) return;
  if (Number(row.deleted)) throw new ConsumerOriginalError("deleted");
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(String(row.params));
  } catch {
    throw new ConsumerOriginalError("conflict");
  }
  if (
    params.consumerJobId !== key ||
    params.consumerProviderJobId !== providerJobId ||
    row.provider !== "higgsfield" ||
    row.model !== consumerVideoIdentity(job).model ||
    row.kind !== consumerVideoIdentity(job).kind ||
    row.status !== "succeeded"
  )
    throw new ConsumerOriginalError("conflict");
}

/** Uses a server-written receipt, not merely user-controllable generation params. */
export const RETAINED_CONSUMER_ORIGINAL_SQL = `g.status='succeeded' AND g.provider='higgsfield' AND (g.model IN ('marketing_studio_video','hf_mult_motion_control','hf_mult_replace_object') OR json_extract(g.params,'$.task')='connected-generation') AND g.kind IN ('video','image','audio','model') AND g.stored_url IS NOT NULL
  AND json_extract(g.params,'$.consumerCreditUnit')='higgsfield_credits'
  AND EXISTS(SELECT 1 FROM consumer_video_originals o WHERE o.generation_id=g.id AND o.state='stored' AND o.receipt_json IS NOT NULL
    AND o.owner_id=g.created_by AND o.bytes=g.bytes AND o.job_id=json_extract(g.params,'$.consumerJobId')
    AND o.provider_job_id=json_extract(g.params,'$.consumerProviderJobId') AND o.sha256=json_extract(g.params,'$.originalSha256'))`;
export async function hasRetainedConsumerOriginal(generationId: string) {
  await uploadReservationsReady();
  return (
    (
      await db().execute({
        sql: `SELECT 1 FROM generations g WHERE g.id=? AND (${RETAINED_CONSUMER_ORIGINAL_SQL})`,
        args: [generationId],
      })
    ).rows.length > 0
  );
}
function receipt(
  job: ConsumerJob,
  providerJobId: string,
  generationId: string,
  bytes: number,
  sha256: string,
  metadata: Metadata,
  kind: ConsumerOriginalKind,
): ConsumerVideoOriginal {
  const { mime, ...dimensions } = metadata;
  return {
    generationId,
    providerJobId,
    bytes,
    sha256,
    ...dimensions,
    ...(kind === "video" ? {} : { mime: mime! }),
    credits: job.quoteCredits,
    creditUnit: "higgsfield_credits",
    asset: {
      generationId,
      url: `/api/media/${generationId}`,
      kind,
      mime: kind === "video" ? "video/mp4" : mime!,
      ...(metadata.width !== undefined ? { width: metadata.width } : {}),
      ...(metadata.height !== undefined ? { height: metadata.height } : {}),
      ...(metadata.seconds !== undefined ? { durationS: metadata.seconds } : {}),
    },
  };
}

/**
 * The length in seconds to persist on the collected generation, so a per-second
 * tool (reframe, Shorts, dubbing) can price this original without re-uploading
 * it. Video is already measured by `inspectConsumerVideoOriginal`; audio is
 * measured here from the bytes in hand, under the shared audio inspection
 * budget (100 MB, 20 s, no decoder).
 *
 * BEST EFFORT BY CONSTRUCTION: a length that cannot be read is null and the job
 * still settles exactly as it did before this column existed.
 * `resolveStoredDuration` measures and persists it on first read instead.
 *
 * Exported so the property can be asserted directly; the collector is its only
 * caller.
 */
export async function collectedDurationSeconds(
  kind: ConsumerOriginalKind,
  metadata: Metadata,
  bytes: Buffer,
): Promise<number | null> {
  const round = (seconds: number) =>
    Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null;
  if (metadata.seconds !== undefined) return round(metadata.seconds);
  if (kind !== "audio") return null;
  try {
    return round((await inspectAudioBuffer(bytes)).seconds);
  } catch {
    return null;
  }
}

/** The service must match the provider status UUID before supplying its original
 * URL. This collector revalidates the immutable local job; it never polls, spends,
 * changes a draft, or frees ambiguous stored bytes on lease expiry. */
export async function collectConsumerVideoOriginal(
  job: ConsumerJob,
  verifiedOriginalUrl: string,
  options: {
    fetchDependencies?: Partial<ProductFetchDependencies>;
    store?: typeof storeVideoBytes;
    /** One clip of a multi-clip job: keyed and receipted by the clip's own
     * provider job, retained under the parent job's admission and quote. */
    clip?: ConsumerClip;
    /** The prompt the account says it rendered (already sanitised), kept on the generation as provenance. */
    enhancedPrompt?: string;
  } = {},
): Promise<ConsumerVideoOriginal> {
  const workspace = requireTenant();
  if (
    workspace.deletedAt ||
    (currentTenant()?.user && currentTenant()!.user!.id !== job.userId)
  )
    throw new ConsumerOriginalError("not_found");
  await consumerJobsReady();
  const identity = consumerVideoIdentity(job),
    kind = identity.kind;
  await workbenchReady();
  await uploadReservationsReady();
  const clip = options.clip;
  if (clip && (job.workflow !== "shorts" || !Number.isSafeInteger(clip.index) || clip.index < 0 || clip.index >= 20 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clip.providerJobId) || clip.providerJobId === job.providerJobId))
    throw new ConsumerOriginalError("not_found");
  if (!clip && job.workflow === "shorts") throw new ConsumerOriginalError("not_found");
  const key = clip ? consumerClipKey(job.id, clip.index) : job.id,
    providerJobId = clip ? clip.providerJobId : job.providerJobId!;
  const generationId = consumerOriginalGenerationId(workspace.id, key),
    lease = randomUUID();
  const deadline = performance.now() + CONSUMER_ORIGINAL_DEADLINE_MS;
  const bound = async <T>(work: () => Promise<T>): Promise<T> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ConsumerOriginalError("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ConsumerOriginalError("timeout")),
            remaining,
          );
        }),
      ]);
      if (performance.now() >= deadline)
        throw new ConsumerOriginalError("timeout");
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
  const prior = await workbenchTransaction(async (tx) => {
    await currentJob(tx, job);
    const generation = await generationExists(tx, generationId);
    ownedGeneration(generation, job, key, providerJobId);
    const row = await originalRow(tx, key);
    if (
      row &&
      (row.generation_id !== generationId ||
        row.owner_id !== job.userId ||
        row.draft_id !== job.draftId ||
        row.provider_job_id !== providerJobId)
    )
      throw new ConsumerOriginalError("conflict");
    if (row?.state === "stored") {
      if (
        !generation ||
        !row.receipt_json ||
        !generation.stored_url ||
        Number(generation.bytes) !== Number(row.bytes)
      )
        throw new ConsumerOriginalError("conflict");
      return {
        complete: JSON.parse(String(row.receipt_json)) as ConsumerVideoOriginal,
        row,
      };
    }
    if (generation) throw new ConsumerOriginalError("conflict");
    if (Number(row?.lease_until ?? 0) > Date.now())
      throw new ConsumerOriginalError("busy");
    await tx.execute({
      sql: `INSERT INTO consumer_video_originals(job_id,generation_id,owner_id,draft_id,provider_job_id,lease,lease_until,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until,updated_at=excluded.updated_at`,
      args: [
        key,
        generationId,
        job.userId,
        job.draftId,
        providerJobId,
        lease,
        Date.now() + CONSUMER_ORIGINAL_LEASE_MS,
        Date.now(),
      ],
    });
    return { complete: null, row };
  });
  if (prior.complete) return prior.complete;
  return withRecoveryActivity(
    "consumer-original",
    async () => {
      try {
        let bytes: Buffer | null = null,
          metadata: Metadata | undefined;
        if (
          prior.row?.sha256 &&
          prior.row.metadata_json &&
          Number(prior.row.bytes) > 0
        ) {
          bytes = await bound(() =>
            readOriginalBytesLimited(kind, generationId, Number(prior.row!.bytes)),
          );
          if (bytes) {
            if (
              bytes.length !== Number(prior.row.bytes) ||
              digest(bytes) !== prior.row.sha256
            )
              throw new ConsumerOriginalError("conflict");
            metadata = JSON.parse(String(prior.row.metadata_json));
          }
        }
        if (!bytes) {
          bytes = (
            await bound(() =>
              fetchPublicConsumerOriginalBytes(
                verifiedOriginalUrl,
                kind,
                options.fetchDependencies,
              ),
            )
          ).bytes;
          metadata = await bound(() => inspectConsumerOriginal(kind, bytes!));
        }
        const sha256 = digest(bytes),
          size = bytes.length,
          limit = (await workspaceLimits()).storageBytes;
        const result = receipt(job, providerJobId, generationId, size, sha256, metadata!, kind);
        await workbenchTransaction(async (tx) => {
          await currentJob(tx, job);
          const row = await originalRow(tx, key);
          if (
            !row ||
            row.lease !== lease ||
            Number(row.lease_until) <= Date.now()
          )
            throw new ConsumerOriginalError("busy");
          if (
            row.sha256 &&
            (row.sha256 !== sha256 || Number(row.bytes) !== size)
          )
            throw new ConsumerOriginalError("conflict");
          const total = (
            await tx.execute(
              `SELECT (SELECT COALESCE(SUM(bytes),0) FROM generations WHERE deleted=0) + (SELECT COALESCE(SUM(COALESCE(bytes,0)+COALESCE(derivative_bytes,0)),0) FROM uploads) + (SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_sessions) + (SELECT COALESCE(SUM(bytes),0) FROM consumer_video_originals WHERE state <> 'stored') AS n`,
            )
          ).rows[0].n;
          if (
            !quotaVerdict({
              usedBytes: Number(total),
              incomingBytes: Math.max(0, size - Number(row.bytes)),
              quotaBytes: limit,
            }).allow
          )
            throw new ConsumerOriginalError("quota");
          await tx.execute({
            sql: "UPDATE consumer_video_originals SET sha256=?,bytes=?,metadata_json=?,updated_at=? WHERE job_id=? AND lease=?",
            args: [
              sha256,
              size,
              JSON.stringify(metadata),
              Date.now(),
              key,
              lease,
            ],
          });
        });
        const stored = await bound(() =>
          (options.store ?? ((id: string, data: Buffer) => storeOriginalBytes(kind, id, data, result.asset.mime)))(generationId, bytes!),
        );
        if (
          stored.bytes !== size ||
          stored.sha256 !== sha256 ||
          stored.url !== result.asset.url
        )
          throw new ConsumerOriginalError("conflict");
        // Measured outside the write transaction and never allowed to fail it.
        const durationS = await collectedDurationSeconds(kind, metadata!, bytes);
        await workbenchTransaction(async (tx) => {
          await currentJob(tx, job);
          const row = await originalRow(tx, key);
          if (
            !row ||
            row.lease !== lease ||
            Number(row.lease_until) <= Date.now() ||
            row.sha256 !== sha256
          )
            throw new ConsumerOriginalError("busy");
          const generation = await generationExists(tx, generationId);
          ownedGeneration(generation, job, key, providerJobId);
          if (generation) throw new ConsumerOriginalError("conflict");
          const draft = (
            await tx.execute({
              sql: "SELECT body FROM workbench_projects WHERE owner=? AND project_id=?",
              args: [job.userId, job.draftId],
            })
          ).rows[0];
          let projectId: string | null = null;
          if (draft) {
            const body = JSON.parse(String(draft.body));
            if (
              typeof body.productionProjectId === "string" &&
              (
                await tx.execute({
                  sql: "SELECT id FROM projects WHERE id=?",
                  args: [body.productionProjectId],
                })
              ).rows.length
            )
              projectId = body.productionProjectId;
          }
          const params = {
            ...identity.params,
            ...(metadata!.seconds !== undefined ? { duration: metadata!.seconds } : {}),
            ...(job.workflow === "genjutsu" ? { ratio: `${metadata!.width}:${metadata!.height}` } : {}),
            consumerJobId: key,
            consumerProviderJobId: providerJobId,
            ...(clip ? { consumerParentJobId: job.id, consumerParentProviderJobId: job.providerJobId, clipIndex: clip.index } : {}),
            consumerCredits: job.quoteCredits,
            consumerCreditUnit: "higgsfield_credits",
            originalSha256: sha256,
            ...(options.enhancedPrompt ? { enhancedPrompt: options.enhancedPrompt } : {}),
            ...(metadata!.width !== undefined ? { width: metadata!.width } : {}),
            ...(metadata!.height !== undefined ? { height: metadata!.height } : {}),
            ...(job.workflow === "generation" || job.workflow === "marketing-template" || job.workflow === "voice-tool" || job.workflow === "shorts" ? { consumerOriginalMime: result.asset.mime } : {}),
          };
          await tx.execute({
            sql: `INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,kind,provider,bytes,duration_s,billed_to) VALUES(?,?,?,?,?,'succeeded',?,NULL,?,?,?,?,'higgsfield',?,?,'higgsfield')`,
            args: [
              generationId,
              projectId,
              identity.model,
              identity.prompt,
              JSON.stringify(params),
              stored.url,
              job.userId,
              job.createdAt,
              Date.now(),
              kind,
              size,
              durationS,
            ],
          });
          await tx.execute({
            sql: "UPDATE consumer_video_originals SET state='stored',receipt_json=?,lease=NULL,lease_until=NULL,updated_at=? WHERE job_id=? AND lease=?",
            args: [JSON.stringify(result), Date.now(), key, lease],
          });
        });
        return result;
      } catch (error) {
        // Before storage reservation there are no persistent bytes to reconcile.
        // Pinned reservations and leases remain after any ambiguous storage write.
        await workbenchTransaction(async (tx) => {
          await tx.execute({
            sql: "UPDATE consumer_video_originals SET lease=NULL,lease_until=NULL WHERE job_id=? AND lease=? AND bytes=0",
            args: [key, lease],
          });
        }).catch(() => {});
        if (error instanceof ConsumerOriginalError) throw error;
        throw new ConsumerOriginalError("storage_unavailable");
      }
    },
    { workspaceId: workspace.id },
  );
}
