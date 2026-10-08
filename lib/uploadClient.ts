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
  /** Why a finish ended the session (a background finish's failure), when it did. */
  failure?: { error: string; status: number };
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
const GONE_MESSAGE =
  "This upload expired, was cancelled or was deleted. Dismiss it before choosing a new upload.";
/** A large finish assembles on the server after it answers 202; its session is read 1 s on, then every 1.5x longer up to 5 s. */
const POLL_FIRST_MS = 1_000;
const POLL_MIN_MS = 100;
const POLL_MAX_MS = 5_000;
/** Status reads that may fail in a row (a network blip) before the wait gives up and leaves it to Check status. */
const POLL_MISSES = 5;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Answers that refuse the file itself, not the moment (quota, conflicts and outages are retried). */
const REFUSALS = new Set([400, 413, 415, 422]);
/** How long the same file is answered with its refusal instead of being sent again. */
const REFUSAL_MEMORY_MS = 10 * 60_000;
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
 *  server's own reason, so it stops holding one of the browser's slots. A
 *  refusal of the file itself is remembered for a while, so choosing the
 *  same file again answers at once instead of sending every byte again. */
async function settleRefusedFinish(entry: UploadEnvelope, response: Response): Promise<never> {
  const value = await response.json().catch(() => null);
  const message =
    value?.error ||
    `Upload request failed (${response.status}). Resume it from Uploads.`;
  const remote = await status(entry).catch(() => null);
  if (remote && GONE_STATES.includes(remote.state))
    await updateUploadEnvelope(entry, {
      state: "blocked",
      error: message,
      ...(REFUSALS.has(response.status) ? { refusedAt: Date.now() } : {}),
    });
  throw new Error(message);
}
async function markComplete(entry: UploadEnvelope, remote: UploadStatus) {
  const result = uploaded(remote.upload);
  await updateUploadEnvelope(entry, {
    state: "complete",
    result,
    error: undefined,
  });
  return result;
}
/** The session ended without an upload: the saved record says why (the finish's own failure when it
 *  left one) and stops holding a slot. A refusal of the file itself is remembered, as a refused finish
 *  is, from the first time it is read: `refused` is true only then. A record that already carries its
 *  refusal keeps that time, so once REFUSAL_MEMORY_MS has passed the same file starts a fresh upload. */
async function settleGone(entry: UploadEnvelope, remote: UploadStatus) {
  const failure = remote.failure;
  const refused =
    !!failure &&
    REFUSALS.has(failure.status) &&
    readUploadEnvelope(entry).refusedAt === undefined;
  const message = failure?.error || GONE_MESSAGE;
  await updateUploadEnvelope(entry, {
    state: "blocked",
    error: message,
    ...(refused ? { refusedAt: Date.now() } : {}),
  });
  return { message, refused };
}
/** Waits while the server assembles the upload in the background. Answers its receipt once the
 *  session is committed; `again` when the finish lease ended with nothing published (it was
 *  prepared, or the finishing process stopped), which an identical finish request completes. */
async function awaitFinish(
  entry: UploadEnvelope,
  firstDelayMs = POLL_FIRST_MS,
  following?: () => boolean,
): Promise<{ receipt: UploadedFile } | { again: true } | { stopped: true }> {
  let delay = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, firstDelayMs)),
    misses = 0;
  for (;;) {
    await sleep(delay);
    delay = Math.min(POLL_MAX_MS, delay * 1.5);
    if (following && !following()) return { stopped: true };
    let remote: UploadStatus;
    try {
      remote = await status(entry);
      misses = 0;
    } catch (error) {
      if (++misses >= POLL_MISSES) throw error;
      continue;
    }
    if (remote.state === "committed")
      return { receipt: await markComplete(entry, remote) };
    if (GONE_STATES.includes(remote.state))
      throw new Error((await settleGone(entry, remote)).message);
    if (remote.state === "assembling" && remote.retryAfterMs > 0) continue;
    return { again: true };
  }
}
/** Read-only status also makes a lost successful finish visible without selecting the file again. */
export async function checkUpload(entry: UploadEnvelope) {
  const current = readUploadEnvelope(entry);
  const remote = await status(current);
  if (remote.state === "committed") await markComplete(current, remote);
  else if (remote.failure && GONE_STATES.includes(remote.state))
    await settleGone(current, remote);
  return remote;
}
/** A record left `finishing` (the page reloaded while the server assembled it) follows the
 *  background finish to its end without sending anything. Answers the receipt once committed;
 *  "resume" when the finish ended with nothing published (the record turns `pending`, so Resume
 *  upload finishes it); null when there is nothing (left) to follow: the record is not
 *  finishing, it ended (blocked with its reason), or Resume or Cancel took it over.
 *  A finish still running in this or another tab holds the run lock, so this first waits for
 *  it; the lock is not held while polling, so Resume and Cancel stay at hand meanwhile. */
export async function followFinishing(entry: UploadEnvelope): Promise<UploadedFile | "resume" | null> {
  const finishing = () => {
    try {
      return readUploadEnvelope(entry).state === "finishing";
    } catch {
      return false; // Dismissed or replaced meanwhile.
    }
  };
  if (!(await withUploadLock(uploadRunLock(entry), async () => finishing()))) return null;
  const current = readUploadEnvelope(entry);
  const toResume = async () => {
    if (!finishing()) return null;
    await updateUploadEnvelope(current, { state: "pending" });
    return "resume" as const;
  };
  try {
    const remote = await status(current);
    if (remote.state === "committed") return await markComplete(current, remote);
    if (GONE_STATES.includes(remote.state)) {
      await settleGone(current, remote);
      return null;
    }
    if (remote.state !== "assembling" || remote.retryAfterMs <= 0) return await toResume();
    const outcome = await awaitFinish(current, POLL_FIRST_MS, finishing);
    if ("receipt" in outcome) return outcome.receipt;
    return "again" in outcome ? await toResume() : null;
  } catch (error) {
    // The status could not be read: leave it to Resume and Check status, saying why.
    if (finishing())
      await updateUploadEnvelope(current, {
        state: "pending",
        error: error instanceof Error ? error.message : undefined,
      }).catch(() => {});
    throw error;
  }
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
    if (
      current.state === "blocked" &&
      current.refusedAt !== undefined &&
      Date.now() - current.refusedAt < REFUSAL_MEMORY_MS
    )
      throw new Error(current.error || "This file was refused.");
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
        const { message, refused } = await settleGone(current, remote);
        // A file refused outright is answered with its refusal; anything else may start again.
        throw refused ? new Error(message) : new UploadGoneError(message);
      }
      // The server is still assembling an earlier finish of this upload: follow it.
      const assembling =
        remote.state === "assembling" && remote.retryAfterMs > 0;
      if (remote.retryAfterMs > 0 && !assembling)
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
      if (!assembling && remote.state !== "prepared" && stored.size < current.count) {
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
      /* A small file's finish answers its receipt. A large one answers 202
         and assembles in the background; the session is read until it is
         committed. A finish whose lease ended with nothing published is
         sent again, identically (at most twice). */
      let outcome: Awaited<ReturnType<typeof awaitFinish>> = assembling
          ? await awaitFinish(current)
          : { again: true },
        sent = 0;
      while (!("receipt" in outcome)) {
        if (sent++ > 2)
          throw new Error(
            "This upload is still being stored. Check status again shortly.",
          );
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
        if (finished.status === 202) {
          const accepted = await finished.json().catch(() => null);
          outcome = await awaitFinish(
            current,
            Number(accepted?.pollAfterMs) || POLL_FIRST_MS,
          );
        } else if (finished.ok)
          outcome = { receipt: uploaded(await responseJson(finished)) };
        else {
          // 409 while another request (or tab) is still finishing it: follow that one.
          const remote =
            finished.status === 409
              ? await status(current).catch(() => null)
              : null;
          if (remote?.state === "assembling" && remote.retryAfterMs > 0)
            outcome = await awaitFinish(current);
          else await settleRefusedFinish(current, finished);
        }
      }
      const result = outcome.receipt;
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
  options?: { scope?: string; projectId?: string },
): Promise<UploadedFile> {
  if (!options?.scope)
    throw new Error("Sign in to the intended workspace before uploading.");
  const entry = await claimUploadEnvelope(options.scope, file, purpose, options.projectId);
  try {
    return await resumeUpload(entry, file, onProgress);
  } catch (error) {
    if (!(error instanceof UploadGoneError)) throw error;
    /* The same file, saved from an earlier upload the server no longer has
       (deleted, purged, cancelled or refused). The person has the file in
       hand, so the stale record is replaced with a new upload, once. */
    await removeUploadEnvelope(entry);
    return resumeUpload(
      await claimUploadEnvelope(options.scope, file, purpose, options.projectId),
      file,
      onProgress,
    );
  }
}
