/**
 * Reference media for the catalogue-driven Generate workflows: tenant-owned
 * originals (uploads or completed generations) resolved by role, bounded like
 * Genjutsu sources (≤50 MB each, kind derived from the declared role), and
 * imported once per quote through media_import_url with a durable claim.
 */
import type { Transaction } from "@libsql/client";
import { createHash } from "node:crypto";
import { db, ready } from "@/lib/db";
import { workbenchTransaction } from "@/lib/workbench/records";
import { imagePath, videoPath, audioPath, uploadPath, presignedReadUrl, usingBlob } from "@/lib/storage";
import { engineMock } from "@/lib/mock";
import { withRecoveryActivity } from "@/lib/recovery";
import { consumerMediaKey } from "./genjutsu-contract";
import { ConsumerGenjutsuError, consumerMediaImportsReady } from "./genjutsu-sources";
import { mediaKindForRole, type ConnectedMediaKind } from "./catalogue";
import { parseConsumerGenerationInput, type ConsumerGenerationInput } from "./generation-contract";

export const GENERATION_SOURCE_BYTES = 50 * 1024 * 1024;
export type GenerationSource = {
  id: string;
  fromGeneration: boolean;
  kind: ConnectedMediaKind;
  role: string;
  storedUrl: string;
  ext: string;
  mime: string;
  bytes: number;
  /** Upload filename or generation title/prompt; labels tool results. */
  name: string;
  /** Stored duration in seconds (videos/audio), null when not recorded. */
  durationS: number | null;
};
const uploadKind = (row: Record<string, unknown>): ConnectedMediaKind | null => {
  if (row.kind === "image" || row.kind === "video") return row.kind;
  const mime = String(row.mime ?? "");
  if (mime.startsWith("audio/")) return "audio";
  return null;
};
/** Checked inside the job/dispatch write transaction, shared with deletion. */
export async function validateConsumerGenerationSources(
  tx: Pick<Transaction, "execute">,
  value: unknown,
): Promise<GenerationSource[]> {
  const input = parseConsumerGenerationInput(value);
  const sources: GenerationSource[] = [];
  for (const media of input.medias) {
    const fromGeneration = Boolean(media.source.genId),
      id = media.source.genId ?? media.source.uploadId!;
    const row = (
      await tx.execute({
        sql: fromGeneration ? "SELECT * FROM generations WHERE id=? AND deleted=0" : "SELECT * FROM uploads WHERE id=?",
        args: [id],
      })
    ).rows[0] as Record<string, unknown> | undefined;
    if (!row || !row.stored_url || (fromGeneration && row.status !== "succeeded"))
      throw new ConsumerGenjutsuError("source_unavailable");
    const kind = mediaKindForRole(media.role);
    const actual: ConnectedMediaKind | null = fromGeneration
      ? row.kind === "image" || row.kind === "audio" ? (row.kind as ConnectedMediaKind) : row.kind === "video" ? "video" : null
      : uploadKind(row);
    const bytes = Number(row.bytes);
    if (actual !== kind || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > GENERATION_SOURCE_BYTES)
      throw new ConsumerGenjutsuError("source_limits", 400);
    const ext = fromGeneration ? { video: "mp4", image: "png", audio: "mp3" }[kind] : String(row.ext);
    if (!/^[A-Za-z0-9]+$/.test(ext)) throw new ConsumerGenjutsuError("source_unavailable");
    sources.push({
      id,
      fromGeneration,
      kind,
      role: media.role,
      storedUrl: String(row.stored_url),
      ext,
      mime: fromGeneration ? { video: "video/mp4", image: "image/png", audio: "audio/mpeg" }[kind] : String(row.mime),
      bytes,
      name: String((fromGeneration ? row.title || row.prompt : row.filename) || id).replace(/\p{Cc}/gu, "").trim().slice(0, 160) || id,
      durationS: typeof row.duration_s === "number" && Number.isFinite(row.duration_s) && row.duration_s > 0 ? row.duration_s : null,
    });
  }
  return sources;
}
/** Role, kind and display name of each validated source, for job snapshots. */
export async function describeConsumerGenerationSources(input: ConsumerGenerationInput) {
  await ready();
  return (await validateConsumerGenerationSources(db(), input)).map((source) => ({ role: source.role, kind: source.kind, name: source.name }));
}
export async function resolveConsumerGenerationSources(input: ConsumerGenerationInput) {
  await ready();
  const sources = await validateConsumerGenerationSources(db(), input);
  if (sources.length && !engineMock() && !usingBlob()) throw new ConsumerGenjutsuError("source_unavailable", 503);
  return Promise.all(
    sources.map(async (source) => {
      const path = source.fromGeneration
        ? source.kind === "video" ? videoPath(source.id) : source.kind === "audio" ? audioPath(source.id) : imagePath(source.id)
        : uploadPath(source.id, source.ext);
      return {
        url: engineMock() ? `https://fixtures.particl.invalid/${path}` : await presignedReadUrl(path),
        type: source.kind,
        role: source.role,
      };
    }),
  );
}
/** Same durable claim table and semantics as Genjutsu imports: one attempt per
 * (quote, index); success is reused, an unconfirmed attempt is never repeated. */
export async function resolveConsumerGenerationImport(
  input: {
    userId: string;
    draftId: string;
    quoteKey: string;
    sourceIndex: number;
    request: ConsumerGenerationInput;
    workspaceId: string;
    connectionGeneration: string;
  },
  perform: () => Promise<string>,
) {
  await consumerMediaImportsReady();
  const media = input.request.medias[input.sourceIndex];
  if (!media) throw new ConsumerGenjutsuError("source_unavailable");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ request: parseConsumerGenerationInput(input.request), workspaceId: input.workspaceId, generation: input.connectionGeneration }))
    .digest("hex");
  const keys = [input.userId, input.draftId, input.quoteKey, input.sourceIndex];
  const previous = await workbenchTransaction(async (tx) => {
    const draft = (await tx.execute({ sql: "SELECT 1 FROM workbench_projects WHERE owner=? AND project_id=?", args: [input.userId, input.draftId] })).rows[0];
    if (!draft) throw new ConsumerGenjutsuError("source_unavailable");
    await validateConsumerGenerationSources(tx, input.request);
    const row = (await tx.execute({ sql: "SELECT * FROM higgsfield_consumer_media_imports WHERE user_id=? AND draft_id=? AND quote_key=? AND source_index=?", args: keys })).rows[0];
    if (row) {
      if (row.fingerprint !== fingerprint) throw new ConsumerGenjutsuError("import_changed");
      if (row.state === "ready" && typeof row.media_id === "string") return row.media_id;
      throw new ConsumerGenjutsuError("import_uncertain");
    }
    const now = Date.now();
    await tx.execute({
      sql: "INSERT INTO higgsfield_consumer_media_imports VALUES(?,?,?,?,?,?,?,?,'claimed',NULL,?,?)",
      args: [...keys, fingerprint, input.workspaceId, input.connectionGeneration, consumerMediaKey(media.source), now, now],
    });
    return null;
  });
  if (previous) return previous;
  return withRecoveryActivity(
    "consumer-media-import",
    async () => {
      const mediaId = await perform();
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(mediaId)) throw new ConsumerGenjutsuError("import_uncertain");
      const result = await db().execute({
        sql: "UPDATE higgsfield_consumer_media_imports SET state='ready',media_id=?,updated_at=? WHERE user_id=? AND draft_id=? AND quote_key=? AND source_index=? AND fingerprint=? AND state='claimed'",
        args: [mediaId, Date.now(), ...keys, fingerprint],
      });
      if (result.rowsAffected !== 1) throw new ConsumerGenjutsuError("import_uncertain");
      return mediaId;
    },
    { uncertainOnError: true },
  );
}
