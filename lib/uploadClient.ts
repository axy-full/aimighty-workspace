"use client";

import {
  claimUploadEnvelope,
  readUploadEnvelope,
  updateUploadEnvelope,
  removeUploadEnvelope,
  uploadIdentity,
  uploadRunLock,
  withUploadLock,
  isUploadReceipt,
  type UploadEnvelope,
} from "./uploadRecovery";

export type UploadedFile = {
  id: string;
  filename: string;
  mime: string;
  kind: "image" | "video" | "audio" | "file";
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  sha256: string;
  url: string;
  base64Bytes?: number;
};
export async function sha256OfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
type UploadStatus = {
  state:
    | "open"
    | "assembling"
    | "prepared"
    | "committed"
    | "aborting"
    | "aborted"
    | "expired"
    | "removed";
  storedChunks: number[];
  retryAfterMs: number;
  upload?: UploadedFile;
};
/** The server no longer has this saved upload's session: it expired, was
 *  cancelled or refused, or the upload it made was deleted. */
export class UploadGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadGoneError";
  }
}
const GONE_STATES: UploadStatus["state"][] = ["expired", "aborting", "aborted", "removed"];
const headers = (entry: UploadEnvelope) => ({
  "X-Workbench-Scope": entry.scope,
});
async function responseJson(response: Response) {
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      value?.error ||
        `Upload request failed (${response.status}). Resume it from Uploads.`,
    );
  if (!value || typeof value !== "object")
    throw new Error(
      "The upload response was incomplete. Resume the saved upload to check its status.",
    );
  return value;
}
function uploaded(value: unknown): UploadedFile {
  if (!isUploadReceipt(value))
    throw new Error(
      "The upload response was incomplete. Resume the saved upload to check its status.",
    );
  return value;
}
async function status(entry: UploadEnvelope): Promise<UploadStatus> {
  const response = await fetch(
    `/api/uploads/session?session=${encodeURIComponent(entry.session)}`,
    { headers: headers(entry), cache: "no-store" },
  );
  if (response.status === 404)
    return {
      state:
        entry.result || Date.now() - entry.createdAt > 24 * 3600_000
          ? "expired"
          : "open",
      storedChunks: [],
      retryAfterMs: 0,
    };
  const value = await responseJson(response);
  if (
    ![
      "open",
      "assembling",
      "prepared",
      "committed",
      "aborting",
      "aborted",
      "expired",
      "removed",
    ].includes(value.state) ||
    !Array.isArray(value.storedChunks)
  )
    throw new Error(
      "The saved upload status could not be read. Keep the original file and try again.",
    );
  return value;
}
/** A refused finish ends the server session (the route abandons it). Once
 *  status confirms that, the saved upload is marked unavailable with the
 *  server's own reason, so it stops holding one of the browser's slots. */
async function settleRefusedFinish(entry: UploadEnvelope, response: Response): Promise<never> {
  const value = await response.json().catch(() => null);
  const message =
    value?.error ||
    `Upload request failed (${response.status}). Resume it from Uploads.`;
  const remote = await status(entry).catch(() => null);
  if (remote && GONE_STATES.includes(remote.state))
    await updateUploadEnvelope(entry, { state: "blocked", error: message });
  throw new Error(message);
}
/** Read-only status also makes a lost successful finish visible without selecting the file again. */
export async function checkUpload(entry: UploadEnvelope) {
  const current = readUploadEnvelope(entry);
  const remote = await status(current);
  if (remote.state === "committed") {
    const result = uploaded(remote.upload);
    await updateUploadEnvelope(current, {
      state: "complete",
      result,
      error: undefined,
    });
  }
  return remote;
}

/** Replays only the captured session and finish metadata. Missing chunks require
 * the exact original file; a new account or file can never adopt this session. */
export async function resumeUpload(
  entry: UploadEnvelope,
  file?: File,
  onProgress?: (pct: number) => void,
): Promise<UploadedFile> {
  if (file && (await uploadIdentity(file, entry.purpose)) !== entry.identity)
    throw new Error(
      "Choose the same file with its original name and type. These bytes do not match the saved upload.",
    );
  return withUploadLock(uploadRunLock(entry), async () => {
    let current = readUploadEnvelope(entry);
    try {
      const remote: UploadStatus = current.started
        ? await status(current)
        : { state: "open", storedChunks: [], retryAfterMs: 0 };
      if (!current.started)
        current = await updateUploadEnvelope(current, { started: true });
      if (remote.state === "committed") {
        const result = uploaded(remote.upload);
        await updateUploadEnvelope(current, {
          state: "complete",
          result,
          error: undefined,
        });
        onProgress?.(100);
        return result;
      }
      if (GONE_STATES.includes(remote.state)) {
        await updateUploadEnvelope(current, {
          state: "blocked",
          error:
            "This upload expired, was cancelled or was deleted. Dismiss it before choosing a new upload.",
        });
        throw new UploadGoneError(
          "This upload expired, was cancelled or was deleted. Dismiss it before choosing a new upload.",
        );
      }
      if (remote.retryAfterMs > 0)
        throw new Error(
          "This upload is still being stored. Check status again shortly.",
        );
      const stored = new Set(
        remote.storedChunks.filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < current.count,
        ),
      );
      current = await updateUploadEnvelope(current, {
        storedChunks: [...stored],
        error: undefined,
      });
      if (remote.state !== "prepared" && stored.size < current.count) {
        if (!file)
          throw new Error(
            "Choose the original file to resume this interrupted upload.",
          );
        await updateUploadEnvelope(current, { state: "uploading" });
        let next = 0,
          failure: unknown;
        const workers = Array.from(
          { length: Math.min(3, current.count) },
          async () => {
            while (!failure && next < current.count) {
              const index = next++;
              if (stored.has(index)) continue;
              try {
                const form = new FormData();
                form.append("session", current.session);
                form.append("index", String(index));
                form.append(
                  "chunk",
                  file.slice(
                    index * current.chunkBytes,
                    (index + 1) * current.chunkBytes,
                  ),
                );
                await responseJson(
                  await fetch("/api/uploads/chunk", {
                    method: "POST",
                    headers: headers(current),
                    body: form,
                  }),
                );
                stored.add(index);
                await updateUploadEnvelope(current, {
                  storedChunks: [...stored].sort((a, b) => a - b),
                });
                onProgress?.(Math.round((stored.size / current.count) * 95));
              } catch (error) {
                failure = error;
              }
            }
          },
        );
        await Promise.all(workers);
        if (failure) throw failure;
      }
      await updateUploadEnvelope(current, { state: "finishing" });
      const finished = await fetch("/api/uploads/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers(current),
        },
        body: JSON.stringify({
          session: current.session,
          count: current.count,
          filename: current.file.name.slice(0, 200),
          purpose: current.purpose,
          mime: current.file.type || undefined,
        }),
      });
      if (!finished.ok) await settleRefusedFinish(current, finished);
      const result = uploaded(await responseJson(finished));
      await updateUploadEnvelope(current, {
        state: "complete",
        result,
        error: undefined,
      });
      onProgress?.(100);
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The upload was interrupted. Resume it from Uploads.";
      current = readUploadEnvelope(entry);
      if (current.state !== "complete")
        await updateUploadEnvelope(current, {
          state: current.state === "blocked" ? "blocked" : "pending",
          error: message,
        });
      throw error;
    }
  });
}

/** Cancellation retains the identity if the server could not confirm it. */
export async function dismissUpload(entry: UploadEnvelope) {
  return withUploadLock(uploadRunLock(entry), async () => {
    const current = readUploadEnvelope(entry);
    if (current.state !== "complete" && current.state !== "blocked")
      await responseJson(
        await fetch("/api/uploads/chunk", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...headers(current) },
          body: JSON.stringify({ session: current.session }),
        }),
      );
    await removeUploadEnvelope(current);
  });
}

/** Small and large files share one resumable protocol; no server-generated
 * direct-upload identity can disappear with a lost response. */
export async function uploadFile(
  file: File,
  purpose: "reference" | "chat",
  onProgress?: (pct: number) => void,
  options?: { scope?: string },
): Promise<UploadedFile> {
  if (!options?.scope)
    throw new Error("Sign in to the intended workspace before uploading.");
  const entry = await claimUploadEnvelope(options.scope, file, purpose);
  try {
    return await resumeUpload(entry, file, onProgress);
  } catch (error) {
    if (!(error instanceof UploadGoneError)) throw error;
    /* The same file, saved from an earlier upload the server no longer has
       (deleted, purged, cancelled or refused). The person has the file in
       hand, so the stale record is replaced with a new upload, once. */
    await removeUploadEnvelope(entry);
    return resumeUpload(
      await claimUploadEnvelope(options.scope, file, purpose),
      file,
      onProgress,
    );
  }
}
