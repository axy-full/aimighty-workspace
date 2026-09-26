import type { Reference } from "./ark";
import { db, ready, now } from "./db";
import { INSPECTABLE_AUDIO_EXTS, isAudioMime } from "./audioMeta";
import { isDemoMediaUrl } from "./demoProduction";
import { openUploadStream, readOriginalBytesLimited, readUploadBytes } from "./storage";
import { inspectOriginalVideo, VIDEO_INSPECTION_LIMIT } from "./videoMetadata.server";

/**
 * Stored originals as the sound tools see them: one audio or video file the
 * workspace already keeps — an upload or one of its own generations — with a
 * length in seconds that the vendor's per-minute prices need.
 *
 * Two rules, both bounded:
 *
 *   inspection   — the length is read from the file's own header/frames with
 *                  mediabunny, the way lib/videoMetadata.server.ts reads a
 *                  video: a byte budget, a read-count budget and a deadline,
 *                  never a decoder. Audio files up to 100 MB; at most 32 MB of
 *                  them are read (an MP3 states its length in its Xing/VBRI
 *                  header or its frames; a WAV in its data chunk).
 *   persistence  — a measured length is written back to the row
 *                  (uploads.duration_s / generations.duration_s) once, so the
 *                  next quote is a column read. Missing lengths are backfilled
 *                  lazily on first read, here.
 *
 * A length that cannot be read is null WITH A REASON, and the admissions
 * refuse to quote rather than guess: a per-minute price from a guessed
 * minute is a wrong bill.
 *
 * DEMO TAKES ARE THE ONE SOURCE THAT IS NEVER MEASURED OR PERSISTED. The
 * starter production's takes (lib/starter.ts) are inserted already succeeded
 * with a `stored_url` of `demoMediaUrl(...)`: a shared platform preview or the
 * shipped `public/fixtures/clip.mp4`. Neither is a tenant original, so neither
 * inspector can open one — they resolve a generation's bytes under the
 * workspace's own Blob prefix. The rows carry a `params.duration` from
 * `DEMO_TAKES`, but that is a fixture number, and pricing a per-second job from
 * it is exactly the guessed minute the rules forbid. So a demo take is
 * NON-QUOTABLE, with a reason, ahead of both the column read and the inspection
 * — the guard holds even if something later writes a length onto the row.
 */

export type StoredSource = {
  kind: "upload" | "generation";
  id: string;
  mediaKind: "audio" | "video";
  name: string;
  mime: string;
  ext: string;
  bytes: number;
  storedUrl: string | null;
  seconds: number | null;
  /** Demo media (a platform preview or the shipped fixture clip), not a stored original of this workspace: never measured, never priced. */
  demo: boolean;
};
export type SourceRef = { uploadId?: string | null; genId?: string | null };

export const AUDIO_INSPECTION_LIMIT = 100 * 1024 * 1024;
const AUDIO_READ_LIMIT = 32 * 1024 * 1024;
const AUDIO_MAX_SECONDS = 4 * 3600;
export const SOURCE_BYTES_LIMIT = 100 * 1024 * 1024;
/** Extensions of MPEG-4 containers that hold sound only. */
const AUDIO_ONLY_EXTS = new Set(["m4a", "m4b"]);

/** The Reference-shaped handle the video inspector reads through. */
function videoReference(src: StoredSource): Reference {
  return {
    id: src.id,
    mime: src.mime,
    ext: src.ext,
    storedUrl: src.storedUrl ?? "",
    role: "reference_image",
    kind: "video",
    fromGeneration: src.kind === "generation",
  };
}

/** One bounded byte range from wherever the original lives. */
async function readRange(
  src: Pick<StoredSource, "kind" | "id" | "ext" | "storedUrl" | "mediaKind">,
  start: number,
  end: number,
  total: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const range = { start, end: end - 1, total };
  let stream: ReadableStream<Uint8Array>;
  if (src.kind === "upload") {
    stream = (await openUploadStream(src.id, src.ext, range, src.storedUrl ?? undefined, signal)).stream as ReadableStream<Uint8Array>;
  } else {
    // Generated audio is small by construction; it is read whole and sliced.
    const whole = await readOriginalBytesLimited("audio", src.id, AUDIO_INSPECTION_LIMIT);
    if (!whole) throw new Error("The stored original is missing.");
    return new Uint8Array(whole.subarray(start, end));
  }
  const reader = stream.getReader(), result = new Uint8Array(end - start);
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.byteLength > result.length) throw new Error("The original source returned an oversized range.");
      result.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== result.length) throw new Error("The original source returned an incomplete range.");
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type AudioMetadata = { seconds: number; sampleRate: number; channels: number };

async function durationOfInput(input: { getPrimaryAudioTrack(): Promise<{ computeDuration(): Promise<number>; getFirstTimestamp(): Promise<number>; sampleRate: number; numberOfChannels: number } | null>; dispose(): void }, signal: AbortSignal): Promise<AudioMetadata> {
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("The file has no audio track.");
  const [first, end] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()]);
  signal.throwIfAborted();
  const seconds = end - Math.min(0, first);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > AUDIO_MAX_SECONDS)
    throw new Error("The audio length could not be read from the file, or it is longer than four hours.");
  return { seconds, sampleRate: track.sampleRate, channels: track.numberOfChannels };
}

/** Length of an audio file already in memory (a vendor's MP3, a generated track). */
export async function inspectAudioBuffer(bytes: Buffer | Uint8Array): Promise<AudioMetadata> {
  if (!bytes.byteLength || bytes.byteLength > AUDIO_INSPECTION_LIMIT) throw new Error("Use an audio file up to 100 MB.");
  const { Input, BufferSource, MP3, WAVE, MP4, QTFF, ADTS } = await import("mediabunny");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Audio inspection timed out.")), 20_000);
  const input = new Input({ formats: [MP3, WAVE, MP4, QTFF, ADTS], source: new BufferSource(bytes) });
  try {
    return await durationOfInput(input, abort.signal);
  } finally {
    clearTimeout(timer);
    abort.abort();
    input.dispose();
  }
}

/** Length of a stored audio original, read through the storage backend under the inspection budget. */
export async function inspectOriginalAudio(src: Pick<StoredSource, "kind" | "id" | "ext" | "storedUrl" | "mediaKind" | "bytes">): Promise<AudioMetadata> {
  const bytes = src.bytes;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > AUDIO_INSPECTION_LIMIT)
    throw new Error("Use an audio original up to 100 MB with a known stored length.");
  const { Input, CustomSource, MP3, WAVE, MP4, QTFF, ADTS } = await import("mediabunny");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Audio inspection timed out.")), 20_000);
  let readBytes = 0, reads = 0;
  const input = new Input({
    formats: [MP3, WAVE, MP4, QTFF, ADTS],
    source: new CustomSource({
      getSize: () => bytes,
      maxCacheSize: 4 * 1024 * 1024,
      prefetchProfile: "none",
      read: async (start, end) => {
        abort.signal.throwIfAborted();
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes ||
            (readBytes += end - start) > AUDIO_READ_LIMIT || ++reads > 512)
          throw new Error("This file's length exceeds the inspection budget (32 MB read). Re-encode it as a constant-bitrate MP3 or a WAV.");
        return readRange(src, start, end, bytes, abort.signal);
      },
    }),
  });
  try {
    return await durationOfInput(input, abort.signal);
  } finally {
    clearTimeout(timer);
    abort.abort();
    input.dispose();
  }
}

/** The upload finish route's best-effort measurement of a freshly stored file. */
export async function inspectStoredUploadSeconds(upload: { id: string; ext: string; kind: string; storedUrl: string; bytes: number }): Promise<number | null> {
  const src: StoredSource = { kind: "upload", id: upload.id, ext: upload.ext, storedUrl: upload.storedUrl, bytes: upload.bytes, mediaKind: upload.kind === "video" ? "video" : "audio", name: "", mime: "", seconds: null, demo: false };
  return (await measure(src)).seconds;
}

function extOf(mime: string): string {
  return /wav/.test(mime) ? "wav" : mime === "audio/ogg" ? "ogg" : mime === "audio/flac" ? "flac" : mime === "audio/mp4" || mime === "audio/aac" ? "m4a" : "mp3";
}

/** The audio or video original a source reference names, or null when the workspace has no such file. */
export async function findStoredSource(ref: SourceRef): Promise<StoredSource | null> {
  await ready();
  if (ref.uploadId) {
    const row = (await db().execute({
      sql: "SELECT id, filename, mime, ext, bytes, kind, duration_s, stored_url FROM uploads WHERE id=? LIMIT 1",
      args: [String(ref.uploadId)],
    })).rows[0] as unknown as { id: string; filename: string; mime: string; ext: string; bytes: number; kind: string; duration_s: number | null; stored_url: string } | undefined;
    if (!row) return null;
    const ext = String(row.ext ?? "").toLowerCase();
    // An .m4a/.m4b stored before its ftyp brand was read as audio carries
    // kind 'video' (lib/imagemeta.ts); the container says it is sound. A
    // reference upload stored ext 'mp4', so its own name is read too.
    const nameExt = String(row.filename ?? "").match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
    const misfiled = row.kind === "video" && (AUDIO_ONLY_EXTS.has(ext) || AUDIO_ONLY_EXTS.has(nameExt));
    const mediaKind: StoredSource["mediaKind"] | null =
      row.kind === "video" && !misfiled ? "video"
      : misfiled || row.kind === "audio" || isAudioMime(row.mime) || (row.kind !== "image" && INSPECTABLE_AUDIO_EXTS.has(ext)) ? "audio"
      : null;
    if (!mediaKind) return null;
    return { kind: "upload", id: row.id, mediaKind, name: String(row.filename ?? row.id), mime: misfiled ? "audio/mp4" : String(row.mime ?? ""), ext, bytes: Number(row.bytes ?? 0), storedUrl: String(row.stored_url ?? ""), seconds: row.duration_s == null ? null : Number(row.duration_s), demo: false };
  }
  if (ref.genId) {
    const row = (await db().execute({
      sql: "SELECT id, kind, title, prompt, stored_url, bytes, duration_s, params FROM generations WHERE id=? AND deleted=0 AND status='succeeded' AND stored_url IS NOT NULL LIMIT 1",
      args: [String(ref.genId)],
    })).rows[0] as unknown as { id: string; kind: string; title: string | null; prompt: string; stored_url: string; bytes: number | null; duration_s: number | null; params: string } | undefined;
    if (!row || (row.kind !== "audio" && row.kind !== "video")) return null;
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(row.params || "{}"); } catch { /* unreadable params still name a stored file */ }
    const mime = row.kind === "video" ? "video/mp4" : typeof params.consumerOriginalMime === "string" ? params.consumerOriginalMime : "audio/mpeg";
    return {
      kind: "generation", id: row.id, mediaKind: row.kind, name: row.title || String(row.prompt ?? "").slice(0, 80) || row.id,
      mime, ext: row.kind === "video" ? "mp4" : extOf(mime), bytes: Number(row.bytes ?? 0), storedUrl: row.stored_url,
      seconds: row.duration_s == null ? null : Number(row.duration_s),
      demo: params.demo === true || isDemoMediaUrl(row.stored_url),
    };
  }
  return null;
}

/** The one refusal both the column read and the inspection are behind. */
export const DEMO_SOURCE_REASON =
  "This is a demo take. Its picture is a shared sample clip, not a stored original in this workspace, so its length cannot be measured and it cannot be priced per second. Render or upload your own take to use it here.";

async function measure(src: StoredSource): Promise<{ seconds: number | null; reason?: string }> {
  if (src.demo) return { seconds: null, reason: DEMO_SOURCE_REASON };
  try {
    if (src.mediaKind === "video") {
      if (src.bytes > VIDEO_INSPECTION_LIMIT) return { seconds: null, reason: "Video originals over 200 MB cannot be measured." };
      // The sound tools' own ceiling, not the video tools' five minutes.
      return { seconds: (await inspectOriginalVideo(videoReference(src), src.bytes, false, { maxSeconds: AUDIO_MAX_SECONDS })).seconds };
    }
    if (src.kind === "generation") {
      const bytes = await readOriginalBytesLimited("audio", src.id, AUDIO_INSPECTION_LIMIT);
      if (!bytes) return { seconds: null, reason: "The stored original is missing." };
      return { seconds: (await inspectAudioBuffer(bytes)).seconds };
    }
    return { seconds: (await inspectOriginalAudio(src)).seconds };
  } catch (error) {
    return { seconds: null, reason: error instanceof Error ? error.message : "The length could not be read." };
  }
}

/**
 * The source's length in seconds: the stored column when it is there,
 * otherwise measured now and written back. Null carries the reason.
 */
export async function resolveStoredDuration(src: StoredSource): Promise<{ seconds: number | null; reason?: string }> {
  // Ahead of the column: a demo take's length is a fixture, whatever is in the row.
  if (src.demo) return { seconds: null, reason: DEMO_SOURCE_REASON };
  if (src.seconds != null && Number.isFinite(src.seconds) && src.seconds > 0) return { seconds: src.seconds };
  const measured = await measure(src);
  if (measured.seconds == null) return measured;
  const seconds = Math.round(measured.seconds * 1000) / 1000;
  await db().execute(
    src.kind === "upload"
      ? { sql: "UPDATE uploads SET duration_s=? WHERE id=? AND duration_s IS NULL", args: [seconds, src.id] }
      : { sql: "UPDATE generations SET duration_s=?, updated_at=? WHERE id=? AND duration_s IS NULL", args: [seconds, now(), src.id] },
  ).catch(() => { /* a lost write is measured again next time */ });
  src.seconds = seconds;
  return { seconds };
}

/** The whole original, for a multipart upload to a vendor; refused above the limit rather than truncated. */
export async function readStoredSourceBytes(src: StoredSource, maxBytes = SOURCE_BYTES_LIMIT): Promise<Buffer> {
  if (!Number.isSafeInteger(src.bytes) || src.bytes <= 0 || src.bytes > maxBytes)
    throw new Error(`The source must be a stored original up to ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  if (src.kind === "upload") {
    const bytes = await readUploadBytes(src.id, src.ext, src.storedUrl ?? "");
    if (bytes.length > maxBytes) throw new Error("The stored original exceeds its recorded length.");
    return bytes;
  }
  const bytes = await readOriginalBytesLimited(src.mediaKind, src.id, maxBytes);
  if (!bytes) throw new Error("The stored original is missing.");
  return bytes;
}

/** Whole minutes, rounded up, the way both per-minute prices are charged. */
export const billableMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60 - 1e-9));
