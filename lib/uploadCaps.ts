import { UPLOADS } from "./copy";

/**
 * The largest file each kind of upload takes, in one place for the browser and the server: the upload client refuses a
 * file over its cap before it hashes or sends a chunk (lib/uploadClient.ts, lib/uploadRecovery.ts, Home's Attach a brief),
 * and the finish refuses the same sizes (lib/uploadReservations.ts). No server imports: both sides read this file.
 * Uploads are free; nothing here prices or charges anything.
 */
export type UploadPurpose = "reference" | "chat";

export const MAX_REFERENCE_BYTES = 200 * 1024 * 1024;
export const MAX_CHAT_BYTES = 2 * 1024 * 1024 * 1024;

export function uploadCapBytes(purpose: UploadPurpose): number {
  return purpose === "chat" ? MAX_CHAT_BYTES : MAX_REFERENCE_BYTES;
}

/** The browser's chunk size (lib/uploadRecovery.ts slices every upload at it; the chunk route takes up to 4 MiB). */
export const UPLOAD_CHUNK_BYTES = 3_500_000;

/** How many of the browser's chunks a file at this kind's cap needs: a chunk index at or past this is over the cap. */
export function uploadChunkLimit(purpose: UploadPurpose): number {
  return Math.ceil(uploadCapBytes(purpose) / UPLOAD_CHUNK_BYTES);
}

/**
 * Why the chunk route refuses this chunk for the session's kind, or null. A chunk names its kind when the client says it
 * (the browser does); one that does not is held to the largest cap, as before. Refused when its index is at or past the
 * kind's chunk count, or when it would take the session's bytes past the cap, so nothing goes up that the finish refuses.
 */
export function uploadChunkProblem(chunk: { index: number; bytes: number; sessionBytes: number; purpose?: UploadPurpose | null }): string | null {
  const purpose = chunk.purpose ?? "chat";
  if (chunk.index >= uploadChunkLimit(purpose) || chunk.sessionBytes + chunk.bytes > uploadCapBytes(purpose)) return uploadCapWords(purpose);
  return null;
}

/** A chunk form's `purpose` field: the kind it names, or null for anything else. */
export function uploadPurposeOf(value: unknown): UploadPurpose | null {
  return value === "chat" || value === "reference" ? value : null;
}

/** A cap in words: whole gigabytes as GB, anything smaller in MB (binary units, as the caps are). */
export function capSizeWords(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 && Number.isInteger(gb) ? `${gb} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** The refusal of a file over its cap, naming the cap. */
export function uploadCapWords(purpose: UploadPurpose): string {
  return (purpose === "chat" ? UPLOADS.fileCap : UPLOADS.referenceCap).replace("{cap}", capSizeWords(uploadCapBytes(purpose)));
}

/** Why this file cannot go up as this kind of upload, or null when it can. Read from the size alone: no byte is read. */
export function uploadCapProblem(file: { size: number }, purpose: UploadPurpose): string | null {
  if (!Number.isFinite(file.size) || file.size < 1) return UPLOADS.empty;
  return file.size > uploadCapBytes(purpose) ? uploadCapWords(purpose) : null;
}
