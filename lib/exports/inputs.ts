import { db } from "../db";
import { openMediaStream, openUploadStream } from "../storage";
import { inspectOriginalVideo } from "../videoMetadata.server";
import { mayReadTake } from "../draftProject";
import { uploadOpenableBy } from "../uploadAccess";
import type { Reference } from "../ark";
import { ExportError, type ExportComposition } from "./contract";

/**
 * The media of an export: handles in the request, files in the worker.
 *
 * A request names media by handle (`{ "upload": id }` or `{ "take": id }`), never by path or URL. Each handle is
 * resolved inside the caller's own workspace (the tenant database is the boundary: an id from another workspace is
 * simply not found), its real length and size are read from the stored original, and the template's props are
 * rewritten to plain file names (`m1.mp4`, `logo1.png`, `music1.mp3`) that exist only inside one worker session.
 * Nothing about a take that is still being made is exported: its paid step runs through its own path first.
 */

export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
export const MAX_SOURCE_SECONDS = 1800;
const VIDEO_EXT = ["mp4", "mov", "webm", "m4v"];
const IMAGE_MIMES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg"];

export type BoundMedia = {
  /** The file name inside the worker's `input/` folder. */
  file: string;
  origin: "upload" | "take";
  /** What a take is: absent means a video (jobs stored before audio takes could be named). */
  kind?: "video" | "audio";
  id: string;
  ext: string;
  storedUrl: string;
  bytes: number;
};

type VideoFacts = { durationSeconds: number; width: number; height: number };

/** Who is asking: a person, or the person a token acts as. Their reach decides which takes and uploads they may export. */
export type ExportViewer = { id: string; role?: string };

/** What the server knows about one stored file; the real one reads the tenant database and storage. */
export type MediaResolver = {
  video(handle: { upload?: string; take?: string }): Promise<{ origin: "upload" | "take"; id: string; ext: string; storedUrl: string; bytes: number } & VideoFacts>;
  image(handle: { upload?: string }): Promise<{ id: string; ext: string; storedUrl: string; bytes: number }>;
  audio(handle: { upload?: string; take?: string }): Promise<{ origin?: "upload" | "take"; id: string; ext: string; storedUrl: string; bytes: number; durationSeconds: number }>;
};

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const ID = /^[A-Za-z0-9_-]{1,120}$/;

function handleOf(value: unknown, path: string, allowed: string[]): Rec {
  if (!isRec(value)) throw new ExportError(`${path} must name a take or an upload, like { "take": "<id>" }.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ExportError(`${path}.${key} is not allowed here.`);
  const named = ["upload", "take"].filter((key) => value[key] !== undefined);
  if (named.length !== 1) throw new ExportError(`${path} must name exactly one of "upload" or "take".`);
  const id = value[named[0]];
  if (typeof id !== "string" || !ID.test(id)) throw new ExportError(`${path}.${named[0]} is not a valid id.`);
  return value;
}

/**
 * Rewrite a request's props, replacing every media handle with the file it resolves to. The result goes to the
 * template's own validation next; this function only knows where media may appear in each template.
 */
export async function bindMedia(
  composition: ExportComposition,
  props: Rec,
  resolver: MediaResolver,
): Promise<{ props: Rec; media: BoundMedia[] }> {
  const out = structuredClone(props) as Rec;
  const media = new Map<string, BoundMedia>();
  const counters = { m: 0, logo: 0, music: 0, voice: 0 };
  const own = (origin: "upload" | "take", id: string, ext: string, storedUrl: string, bytes: number, prefix: "m" | "logo" | "music" | "voice", kind?: "audio"): BoundMedia => {
    const key = `${origin}:${id}`;
    const known = media.get(key);
    if (known) return known;
    counters[prefix] += 1;
    const bound: BoundMedia = { file: `${prefix}${counters[prefix]}.${ext}`, origin, id, ext, storedUrl, bytes, ...(kind ? { kind } : {}) };
    media.set(key, bound);
    return bound;
  };

  const clip = async (slot: Rec, key: string, path: string) => {
    const handle = handleOf(slot[key], `${path}.${key}`, ["upload", "take", "hasAudio"]);
    if (handle.hasAudio !== undefined && typeof handle.hasAudio !== "boolean") throw new ExportError(`${path}.${key}.hasAudio must be true or false.`);
    const found = await resolver.video(handle as { upload?: string; take?: string });
    const bound = own(found.origin, found.id, found.ext, found.storedUrl, found.bytes, "m");
    // A clip is muted unless the request asks for its sound; a file with no sound that is asked for is refused by the worker.
    slot[key] = { file: bound.file, durationSeconds: found.durationSeconds, width: found.width, height: found.height, hasAudio: handle.hasAudio === true };
  };
  const logo = async (slot: Rec, path: string) => {
    if (slot.logo === undefined || slot.logo === null) return;
    const handle = handleOf(slot.logo, `${path}.logo`, ["upload"]);
    const found = await resolver.image(handle as { upload?: string });
    slot.logo = { file: own("upload", found.id, found.ext, found.storedUrl, found.bytes, "logo").file };
  };
  const child = (value: unknown, path: string): Rec => {
    if (!isRec(value)) throw new ExportError(`${path} is required.`);
    return value;
  };

  switch (composition) {
    case "cutdown":
      await clip(out, "source", "props");
      break;
    case "captions":
    case "reframe":
      await clip(child(out.clip, "props.clip"), "source", "props.clip");
      break;
    case "title-card":
    case "end-card":
      await logo(child(out.card, "props.card"), "props.card");
      break;
    case "final": {
      if (!Array.isArray(out.clips)) throw new ExportError("props.clips must be a list of clips.");
      for (const [index, item] of out.clips.entries()) await clip(child(item, `props.clips[${index}]`), "source", `props.clips[${index}]`);
      if (isRec(out.title)) await logo(out.title, "props.title");
      if (isRec(out.end)) await logo(out.end, "props.end");
      if (out.music !== undefined && out.music !== null) {
        const m = child(out.music, "props.music");
        const handle = handleOf(m, "props.music", ["upload", "take", "volume"]);
        const found = await resolver.audio(handle as { upload?: string; take?: string });
        const bound = own(found.origin ?? "upload", found.id, found.ext, found.storedUrl, found.bytes, "music", found.origin === "take" ? "audio" : undefined);
        out.music = { file: bound.file, durationSeconds: found.durationSeconds, ...(handle.volume !== undefined ? { volume: handle.volume } : {}) };
      }
      /* Spoken lines of a narrated cut: each names an upload (a voice-over made or recorded earlier; its own paid step ran on its own path) and where it starts. */
      if (out.voiceover !== undefined && out.voiceover !== null) {
        if (!Array.isArray(out.voiceover)) throw new ExportError("props.voiceover must be a list of voice lines.");
        if (out.voiceover.length > 24) throw new ExportError("props.voiceover can have at most 24 voice lines.");
        const lines: Rec[] = [];
        for (const [index, item] of out.voiceover.entries()) {
          const at = `props.voiceover[${index}]`;
          const handle = handleOf(child(item, at), at, ["upload", "take", "startSeconds", "volume", "text"]);
          const found = await resolver.audio(handle as { upload?: string; take?: string });
          const bound = own(found.origin ?? "upload", found.id, found.ext, found.storedUrl, found.bytes, "voice", found.origin === "take" ? "audio" : undefined);
          lines.push({ file: bound.file, durationSeconds: found.durationSeconds, ...(handle.startSeconds !== undefined ? { startSeconds: handle.startSeconds } : {}), ...(handle.volume !== undefined ? { volume: handle.volume } : {}), ...(handle.text !== undefined ? { text: handle.text } : {}) });
        }
        out.voiceover = lines;
      }
      break;
    }
  }
  return { props: out, media: [...media.values()] };
}

/* ---- the real resolver: this workspace's database and storage ---- */

const gone = (what: string) => new ExportError(`${what} isn't available in this workspace.`, 404);

/**
 * The caller's own reach decides what resolves. A take filed under a private board is the board's owner's (and, once
 * the board is shared, the team's; an admin of the workspace sees every board); an upload opens for its uploader, or
 * once shared work holds it (lib/uploadAccess.ts). Anything the caller cannot reach answers exactly as an id that
 * does not exist: the same 404, before anything about the file (its state, size or length) is read or said.
 */
export function createMediaResolver(viewer: ExportViewer, options: { facts?: typeof facts } = {}): MediaResolver {
  const read = options.facts ?? facts;
  return {
    async video(handle) {
      if (handle.take) {
        const row = (await db().execute({ sql: "SELECT id,kind,status,stored_url,bytes,project_id FROM generations WHERE id=? AND deleted=0", args: [handle.take] })).rows[0];
        if (!row || row.kind !== "video" || !(await mayReadTake(viewer, row.project_id == null ? null : String(row.project_id)))) throw gone("That take");
        if (row.status === "queued" || row.status === "running") throw new ExportError("That take is still being made. Export it when it is ready.", 409);
        if (row.status !== "succeeded" || !row.stored_url) throw gone("That take");
        const bytes = Number(row.bytes);
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MEDIA_BYTES) throw new ExportError("That take's file is too large to export (200 MB at most).", 413);
        const ref: Reference = { id: String(row.id), mime: "video/mp4", ext: "mp4", storedUrl: String(row.stored_url), role: "reference_video", kind: "video", fromGeneration: true };
        return { origin: "take", id: String(row.id), ext: "mp4", storedUrl: String(row.stored_url), bytes, ...(await read(ref, bytes)) };
      }
      const row = await uploadRow(handle.upload!, viewer);
      const ext = String(row.ext).toLowerCase();
      if (!String(row.mime).startsWith("video/") || !VIDEO_EXT.includes(ext)) throw new ExportError("That file is not a video the export can use (MP4, MOV or WebM).", 415);
      const bytes = Number(row.bytes);
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MEDIA_BYTES) throw new ExportError("That video is too large to export (200 MB at most).", 413);
      const ref: Reference = { id: String(row.id), mime: String(row.mime), ext, storedUrl: String(row.stored_url), role: "reference_video", kind: "video" };
      return { origin: "upload", id: String(row.id), ext, storedUrl: String(row.stored_url), bytes, ...(await read(ref, bytes)) };
    },
    async image(handle) {
      const row = await uploadRow(handle.upload!, viewer);
      const ext = IMAGE_MIMES[String(row.mime)];
      if (!ext) throw new ExportError("A logo must be a PNG, JPEG or WebP image.", 415);
      const bytes = Number(row.bytes);
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 20 * 1024 * 1024) throw new ExportError("A logo must be 20 MB or less.", 413);
      return { id: String(row.id), ext, storedUrl: String(row.stored_url), bytes };
    },
    async audio(handle) {
      if (handle.take) {
        const row = (await db().execute({ sql: "SELECT id,kind,status,stored_url,bytes,duration_s,project_id FROM generations WHERE id=? AND deleted=0", args: [handle.take] })).rows[0];
        if (!row || row.kind !== "audio" || !(await mayReadTake(viewer, row.project_id == null ? null : String(row.project_id)))) throw gone("That take");
        if (row.status === "queued" || row.status === "running") throw new ExportError("That take is still being made. Export it when it is ready.", 409);
        if (row.status !== "succeeded" || !row.stored_url) throw gone("That take");
        const bytes = Number(row.bytes);
        const seconds = row.duration_s == null ? NaN : Number(row.duration_s);
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MEDIA_BYTES) throw new ExportError("That audio take is too large to export.", 413);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new ExportError("That audio take has no recorded length, so it cannot be used.", 422);
        return { origin: "take", id: String(row.id), ext: "mp3", storedUrl: String(row.stored_url), bytes, durationSeconds: seconds };
      }
      const row = await uploadRow(handle.upload!, viewer);
      const ext = String(row.ext).toLowerCase();
      if (!String(row.mime).startsWith("audio/") || !AUDIO_EXT.includes(ext)) throw new ExportError("Music must be an MP3, WAV, M4A, AAC or OGG file.", 415);
      const bytes = Number(row.bytes);
      const seconds = row.duration_s == null ? NaN : Number(row.duration_s);
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MEDIA_BYTES) throw new ExportError("That music file is too large to export.", 413);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new ExportError("That music file has no recorded length, so it cannot be used.", 422);
      return { origin: "upload", id: String(row.id), ext, storedUrl: String(row.stored_url), bytes, durationSeconds: seconds };
    },
  };
}

async function uploadRow(id: string, viewer: ExportViewer) {
  const row = (await db().execute({ sql: "SELECT id,mime,ext,bytes,duration_s,stored_url FROM uploads WHERE id=?", args: [id] })).rows[0];
  if (!row || !(await uploadOpenableBy(id, viewer))) throw gone("That upload");
  return row;
}

/**
 * Asked again when the job runs (the request bound its media earlier): the file still exists, is not deleted, and the
 * person who asked can still reach it (their role and the board's sharing are read afresh). A person who is gone or
 * disabled reaches nothing.
 */
export async function mediaStillReachable(ownerId: string, media: BoundMedia): Promise<boolean> {
  /* A database error is not an answer: it throws, and the caller says the files could not be checked (not that they are gone). */
  const person = (await db().execute({ sql: "SELECT role, disabled FROM users WHERE id=?", args: [ownerId] })).rows[0];
  // Someone missing from this workspace's people (removed, or never mirrored) reaches nothing, and so does a disabled one.
  if (!person || Number(person.disabled) === 1) return false;
  const viewer: ExportViewer = { id: ownerId, ...(person.role ? { role: String(person.role) } : {}) };
  if (media.origin === "take") {
    const row = (await db().execute({ sql: "SELECT status,project_id FROM generations WHERE id=? AND deleted=0 AND kind=?", args: [media.id, media.kind === "audio" ? "audio" : "video"] })).rows[0];
    return Boolean(row && row.status === "succeeded" && (await mayReadTake(viewer, row.project_id == null ? null : String(row.project_id))));
  }
  const row = (await db().execute({ sql: "SELECT id FROM uploads WHERE id=?", args: [media.id] })).rows[0];
  return Boolean(row && (await uploadOpenableBy(media.id, viewer)));
}

async function facts(ref: Reference, bytes: number): Promise<VideoFacts> {
  try {
    const found = await inspectOriginalVideo(ref, bytes, false, { maxSeconds: MAX_SOURCE_SECONDS });
    return { durationSeconds: found.seconds, width: found.width, height: found.height };
  } catch (error) {
    throw new ExportError(error instanceof Error ? error.message : "That video could not be read.", 422);
  }
}

/* ---- loading the bytes at run time ---- */

async function toBuffer(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("An export input exceeds its size limit.");
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** The bytes of one bound file, read from this workspace's storage. */
export type MediaLoader = (media: BoundMedia) => Promise<Buffer>;
export const loadMedia: MediaLoader = async (media) => {
  const limit = media.bytes + 1024;
  if (media.origin === "take") return toBuffer(await openMediaStream(media.id, media.kind === "audio" ? "audio" : "video"), limit);
  return toBuffer((await openUploadStream(media.id, media.ext, null, media.storedUrl)).stream as ReadableStream<Uint8Array>, limit);
};
