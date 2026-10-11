"use client";

import { lockedClaim } from "./usePaidAction";
import type { UploadedFile } from "./uploadClient";

export const UPLOAD_CHUNK_BYTES = 3_500_000;
const prefix = "particl:upload:v1:";
const event = "particl-upload-recovery";
export type UploadEnvelope = {
  version: 1;
  scope: string;
  session: string;
  identity: string;
  file: { name: string; type: string; size: number; lastModified: number };
  purpose: "reference" | "chat";
  chunkBytes: number;
  count: number;
  storedChunks: number[];
  state: "pending" | "uploading" | "finishing" | "complete" | "blocked";
  started?: boolean;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** When the server refused this file outright (its bytes, for this purpose). */
  refusedAt?: number;
  result?: UploadedFile;
  /** The project this upload is for, when it was picked into one; a resumed upload is filed there once it completes. */
  projectId?: string;
  /** When it was filed into `projectId` — so a resume, a status check or another tab never files it twice. */
  filedAt?: number;
};
export const uploadEnvelopeKey = (scope: string, identity: string) =>
  prefix + JSON.stringify([scope, identity]);
export const uploadRunLock = (entry: UploadEnvelope) =>
  "particl-upload-run:" + entry.scope + ":" + entry.session;
export { lockedClaim as withUploadLock };

const unreadable =
  "Saved upload recovery data cannot be read. Keep the original file and review the reference library.";
export function isUploadReceipt(value: unknown): value is UploadedFile {
  if (!value || typeof value !== "object") return false;
  const result = value as UploadedFile;
  return (
    typeof result.id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(result.id) &&
    result.url === `/api/uploads/${encodeURIComponent(result.id)}` &&
    ["image", "video", "audio", "file"].includes(result.kind)
  );
}
function validate(key: string, value: UploadEnvelope): UploadEnvelope {
  if (
    value?.version !== 1 ||
    typeof value.scope !== "string" ||
    !value.scope.startsWith("particl-active-") ||
    typeof value.session !== "string" ||
    !/^[a-f0-9-]{16,64}$/.test(value.session) ||
    typeof value.identity !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.identity) ||
    uploadEnvelopeKey(value.scope, value.identity) !== key ||
    !value.file ||
    typeof value.file.name !== "string" ||
    typeof value.file.type !== "string" ||
    !Number.isInteger(value.file.size) ||
    value.file.size < 1 ||
    !Number.isFinite(value.file.lastModified) ||
    value.file.lastModified < 0 ||
    !["reference", "chat"].includes(value.purpose) ||
    value.file.size > (value.purpose === "chat" ? 2048 : 200) * 1024 * 1024 ||
    value.chunkBytes !== UPLOAD_CHUNK_BYTES ||
    value.count !== Math.ceil(value.file.size / value.chunkBytes) ||
    !Array.isArray(value.storedChunks) ||
    value.storedChunks.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= value.count,
    ) ||
    new Set(value.storedChunks).size !== value.storedChunks.length ||
    !["pending", "uploading", "finishing", "complete", "blocked"].includes(
      value.state,
    ) ||
    (value.started !== undefined && typeof value.started !== "boolean") ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0 ||
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.refusedAt !== undefined && !Number.isFinite(value.refusedAt)) ||
    (value.result !== undefined && !isUploadReceipt(value.result)) ||
    (value.state === "complete" && !value.result) ||
    (value.projectId !== undefined && (typeof value.projectId !== "string" || !value.projectId || value.projectId.length > 200)) ||
    (value.filedAt !== undefined && !Number.isFinite(value.filedAt))
  )
    throw new Error(unreadable);
  return value;
}
function read(key: string): UploadEnvelope | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  let value: UploadEnvelope;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(unreadable);
  }
  return validate(key, value);
}
function write(key: string, value: UploadEnvelope) {
  validate(key, value);
  const body = JSON.stringify(value);
  localStorage.setItem(key, body);
  if (localStorage.getItem(key) !== body)
    throw new Error("Enable browser storage to safely recover uploads.");
  window.dispatchEvent(new Event(event));
}
export function listUploadEnvelopes(scope: string): UploadEnvelope[] {
  const keys = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.key(i),
  ).filter((key): key is string =>
    Boolean(
      key?.startsWith(prefix + JSON.stringify([scope]).slice(0, -1) + ","),
    ),
  );
  return keys
    .map(read)
    .filter((entry): entry is UploadEnvelope => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
export function subscribeUploads(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(event, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(event, listener);
  };
}
export function readUploadEnvelope(entry: UploadEnvelope) {
  const current = read(uploadEnvelopeKey(entry.scope, entry.identity));
  if (!current || current.session !== entry.session)
    throw new Error(
      "This saved upload changed or was dismissed. Select the file again to review a new upload.",
    );
  return current;
}
export async function updateUploadEnvelope(
  entry: UploadEnvelope,
  patch: Partial<
    Pick<
      UploadEnvelope,
      "state" | "error" | "result" | "storedChunks" | "started" | "refusedAt" | "projectId" | "filedAt"
    >
  >,
) {
  const key = uploadEnvelopeKey(entry.scope, entry.identity);
  return lockedClaim(key, () => {
    const current = readUploadEnvelope(entry);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    write(key, next);
    return next;
  });
}
export async function removeUploadEnvelope(entry: UploadEnvelope) {
  const key = uploadEnvelopeKey(entry.scope, entry.identity);
  await lockedClaim(key, () => {
    readUploadEnvelope(entry);
    localStorage.removeItem(key);
    window.dispatchEvent(new Event(event));
  });
}

/** Chunked SHA-256 fingerprint proves every byte without buffering a 2GB file.
 * Only the final digest and metadata are stored, never the selected file bytes. */
export async function uploadIdentity(
  file: File,
  purpose: "reference" | "chat",
) {
  const hashes: string[] = [];
  const hex = (bytes: ArrayBuffer) =>
    [...new Uint8Array(bytes)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  for (let at = 0; at < file.size; at += UPLOAD_CHUNK_BYTES)
    hashes.push(
      hex(
        await crypto.subtle.digest(
          "SHA-256",
          await file.slice(at, at + UPLOAD_CHUNK_BYTES).arrayBuffer(),
        ),
      ),
    );
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          file.name,
          file.type,
          file.size,
          purpose,
          UPLOAD_CHUNK_BYTES,
          hashes,
        ]),
      ),
    ),
  );
}
export async function claimUploadEnvelope(
  scope: string,
  file: File,
  purpose: "reference" | "chat",
  projectId?: string,
) {
  if (!scope || !scope.startsWith("particl-active-"))
    throw new Error("Sign in to the intended workspace before uploading.");
  const maximum = (purpose === "chat" ? 2048 : 200) * 1024 * 1024;
  if (!file.size || file.size > maximum)
    throw new Error(
      purpose === "chat"
        ? "Chat files must be between 1 byte and 2 GB."
        : "Reference files must be between 1 byte and 200 MB.",
    );
  const identity = await uploadIdentity(file, purpose);
  const key = uploadEnvelopeKey(scope, identity);
  return lockedClaim(key, () => {
    const prior = read(key);
    if (prior) {
      /* The same bytes picked into another project: that project is the one it is for now. */
      if (!projectId || prior.projectId === projectId) return prior;
      const next: UploadEnvelope = { ...prior, projectId, filedAt: undefined, updatedAt: Date.now() };
      write(key, next);
      return next;
    }
    const entries = listUploadEnvelopes(scope);
    // Only live uploads hold a server session; a blocked one is already gone.
    if (entries.filter((entry) => entry.state !== "complete" && entry.state !== "blocked").length >= 32)
      throw new Error(
        "Resume or cancel an unfinished upload before starting another.",
      );
    // Completed receipts and ended (blocked) records are only a convenience:
    // the newest of each are kept. Pending identities are never evicted.
    for (const ended of ["complete", "blocked"] as const)
      entries
        .filter((entry) => entry.state === ended)
        .slice(9)
        .forEach((entry) =>
          localStorage.removeItem(uploadEnvelopeKey(scope, entry.identity)),
        );
    const value: UploadEnvelope = {
      version: 1,
      scope,
      session: crypto.randomUUID(),
      identity,
      file: {
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
      },
      purpose,
      chunkBytes: UPLOAD_CHUNK_BYTES,
      count: Math.ceil(file.size / UPLOAD_CHUNK_BYTES),
      storedChunks: [],
      state: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(projectId ? { projectId } : {}),
    };
    write(key, value);
    return value;
  });
}

/**
 * File a completed upload into the project it was picked for, once. A resume (or a status check) after a dropped
 * connection completes the upload away from the drop that would have filed it, so it is filed here; `filedAt`, set
 * under the envelope's own lock, keeps a second resume, a second tab or a repeated check from filing it again (and from
 * putting back a file someone has since taken out of the project). Answers the project it was filed into, or null.
 */
export async function fileCompletedUpload(
  entry: UploadEnvelope,
  file: (projectId: string, uploadId: string, scope: string) => Promise<void>,
): Promise<string | null> {
  return lockedClaim("particl-upload-file:" + entry.scope + ":" + entry.session, async () => {
    const current = readUploadEnvelope(entry);
    if (current.state !== "complete" || !current.result || !current.projectId || current.filedAt !== undefined) return null;
    await file(current.projectId, current.result.id, current.scope);
    await updateUploadEnvelope(current, { filedAt: Date.now() });
    return current.projectId;
  });
}

/** The drop that uploaded it filed it: say so on its saved record, so a later resume or check leaves it be. */
export async function markUploadFiled(scope: string, uploadId: string, projectId: string) {
  try {
    for (const entry of listUploadEnvelopes(scope))
      if (entry.result?.id === uploadId && entry.projectId === projectId && entry.filedAt === undefined)
        await updateUploadEnvelope(entry, { filedAt: Date.now() });
  } catch {
    /* Only a convenience: the filing itself is done, and the server files an upload into a project once. */
  }
}
