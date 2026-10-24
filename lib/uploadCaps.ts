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
