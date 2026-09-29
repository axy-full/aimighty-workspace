import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import {
  claimPendingGeneration,
  clearPendingGeneration,
  pendingGenerationKey,
  readPendingGeneration,
  type PendingGeneration,
} from "./pending-generation";

/**
 * A paid transcription from the browser, claimed before it is sent and never
 * sent twice (the Takes page's Transcribe).
 *
 * One recovery slot per source and settings (transcriptionSlot): the exact
 * request — its body with the price shown as `maxCredits`, and a fresh
 * Idempotency-Key — is written there before the POST. A reply that never came
 * back is never replayed: the server is asked what became of that key
 * (POST /api/generate/check). Finished, its saved transcript comes back and
 * nothing is sent; never arrived, the server sets the key aside and the slot
 * is let go; no answer yet, nothing is sent and it is checked again shortly.
 *
 * A request is never asked about while it is on its way. The window sending
 * it holds the slot's send lock (Web Locks) from before its claim is written
 * until its reply is in, and every other window asks about a claim only once
 * that lock is free (sendingElsewhere): asked sooner, the check could set the
 * key aside before the POST reached the server, and that press would be lost.
 * Where Web Locks are missing, the claim's stamp stands in: another window
 * leaves a claim younger than FRESH_CLAIM_MS to the window that made it.
 */

export const TRANSCRIBE_ENDPOINT = "/api/audio/transcribe" as const;
export type TranscriptWord = { text: string; start: number; end: number; speaker?: number };
export type TranscriptResult = { text: string; language: string | null; seconds: number; words: TranscriptWord[]; srt: string; credits: number };
export type TranscriptionSource = { genId?: string; uploadId?: string };
export type TranscriptionSettings = { diarize: boolean; language?: string };

/** What became of a transcription press, or of an earlier one asked about (settlePendingTranscription). */
export type TranscriptionOutcome =
  /** The transcript: this press's own, or (`recovered`) the one an earlier request made — nothing was sent again. */
  | { state: "done"; result: TranscriptResult; recovered: boolean; note: string }
  /**
   * Answered for good without a transcript, and let go: a new press is a new request at the price then shown.
   * `failed`: it was refused or failed (not merely never sent). `repriced`: refused because the estimate moved past
   * the price shown — the server's new estimate, for the button to show before anything else is pressed.
   */
  | { state: "released"; reason: string; failed: boolean; repriced?: number }
  /**
   * Not known yet: the claim stays and nothing is sent. `waiting`: the server has no answer for it yet, or another window is
   * still sending it, so ask again shortly — after `retryInMs` when given.
   */
  | { state: "unknown"; reason: string; waiting: boolean; retryInMs?: number };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/** The browser's own storage, or null where reading it throws (storage blocked). */
function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The part of Web Locks (navigator.locks) used here. Injected only by tests. */
export type SendLocks = Pick<LockManager, "request">;
/** The browser's Web Locks, or null where they are missing or refused to this page. */
function webLocks(): SendLocks | null {
  try { return typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function" ? navigator.locks : null; } catch { return null; }
}

/**
 * Where Web Locks are missing: how long a claim is left to the window that
 * made it before another window asks about it. The POST that follows a claim
 * reaches the server well inside this.
 */
export const FRESH_CLAIM_MS = 10_000;
/** How soon a window waiting on another window's send tries the lock again. */
const SENDING_RECHECK_MS = 1_000;

/** The lock a window holds while it sends from `slot`: from before its claim is written until its reply is in. */
export function transcriptionSendLock(slot: string): string {
  return `${slot}:sending`;
}

const NEVER_ARRIVED = "Your last transcription never reached the server. Nothing was charged for it.";
/* The server has no answer for it yet: it may still be running, or it stopped and its answer is not final yet. Never "still running". */
const CHECKING = "Your last transcription has no answer yet and is being checked. Nothing new was sent.";
const UNCHECKED = "Your last transcription could not be checked. Nothing new was sent.";
const UNREADABLE = "The saved transcription request cannot be read. Check Activity before starting another.";
const LOST_REPLY = "The connection dropped before the server answered. Asking what became of it; it is never sent twice.";
const ANOTHER = "Another transcription of this is already on its way. Nothing new was sent.";
const NO_STORAGE = "Enable local storage to safely recover this transcription. Nothing was sent.";

/** The recovery slot for one source with one set of settings, in this scope and production. */
export function transcriptionSlot(scope: string, projectId: string | null | undefined, source: TranscriptionSource, settings: TranscriptionSettings): string {
  const origin = source.genId ? `generation:${source.genId}` : `upload:${source.uploadId ?? ""}`;
  return pendingGenerationKey(scope, projectId ?? "", `transcribe:${origin}:${settings.diarize ? "speakers" : "plain"}:${settings.language ?? "auto"}`);
}

/** The request body for a source and its settings, as quoted (with `quoteOnly`) and sent (with `maxCredits`). */
export function transcriptionBody(source: TranscriptionSource, projectId: string | null | undefined, settings: TranscriptionSettings): Record<string, unknown> {
  return {
    ...(source.genId ? { sourceGenId: source.genId } : { sourceUploadId: source.uploadId }),
    ...(projectId ? { projectId } : {}),
    diarize: settings.diarize,
    ...(settings.language ? { language: settings.language } : {}),
  };
}

/** A transcript reply as the route answers it, or null when it is not one. */
export function transcriptResult(value: unknown): TranscriptResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.text !== "string" || !Array.isArray(reply.words) || typeof reply.srt !== "string") return null;
  const seconds = Number(reply.seconds), credits = Number(reply.credits);
  if (!Number.isFinite(seconds) || !Number.isFinite(credits)) return null;
  const words = reply.words.filter((w): w is TranscriptWord => Boolean(w) && typeof (w as TranscriptWord).text === "string"
    && Number.isFinite((w as TranscriptWord).start) && Number.isFinite((w as TranscriptWord).end));
  return { text: reply.text, language: typeof reply.language === "string" ? reply.language : null, seconds, words, srt: reply.srt, credits };
}

const creditWord = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;

/**
 * Whether another window is still sending the request claimed in `slot`, so
 * this one must not ask about it yet: null when it may ask now; otherwise what
 * to show meanwhile and when to try again. With Web Locks, the slot's send lock
 * is taken only if it is free (`ifAvailable`) and let go at once: nothing is
 * held while asking. Without them, a claim younger than FRESH_CLAIM_MS is left
 * to the window that made it; an older one, or one with no stamp, may be asked
 * about now. Nothing here spends or writes.
 */
export async function sendingElsewhere(
  slot: string, attempt: PendingGeneration, options: { locks?: SendLocks | null; now?: number } = {},
): Promise<Extract<TranscriptionOutcome, { state: "unknown" }> | null> {
  const locks = options.locks === undefined ? webLocks() : options.locks;
  if (locks) {
    try {
      const free = await locks.request(transcriptionSendLock(slot), { ifAvailable: true }, (lock) => lock !== null);
      return free ? null : { state: "unknown", reason: ANOTHER, waiting: true, retryInMs: SENDING_RECHECK_MS };
    } catch {
      /* A page refused the lock falls back on the claim's stamp. */
    }
  }
  const stamp = typeof attempt.claimedAt === "number" && Number.isFinite(attempt.claimedAt) ? attempt.claimedAt : null;
  const age = stamp == null ? Infinity : (options.now ?? Date.now()) - stamp;
  return age >= 0 && age < FRESH_CLAIM_MS ? { state: "unknown", reason: ANOTHER, waiting: true, retryInMs: FRESH_CLAIM_MS - age } : null;
}

/**
 * Before anything else is sent from `slot`, the request claimed there earlier
 * (if any) is asked about by its own key, route and body. Nothing here spends.
 * `attempt`: the claim as the caller last read it, asked about even when
 * another check has let it go meanwhile — the server answers a key the same
 * way every time, so its transcript still comes back.
 */
export async function settlePendingTranscription(options: { scope: string; slot: string; storage?: Storage; attempt?: PendingGeneration | null }): Promise<TranscriptionOutcome | { state: "none" }> {
  const storage = options.storage ?? browserStorage();
  let attempt: PendingGeneration | null;
  try {
    if (!storage) throw new Error("Storage unavailable");
    attempt = options.attempt ?? readPendingGeneration(storage, options.slot);
  } catch {
    /* Unreadable recovery storage never becomes a new paid attempt. */
    return { state: "unknown", reason: UNREADABLE, waiting: false };
  }
  if (!attempt) return { state: "none" };
  let found: { state?: unknown; reply?: unknown; error?: unknown };
  try {
    found = await studioRequest("/api/generate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": options.scope },
      body: JSON.stringify({ key: attempt.key, endpoint: attempt.endpoint ?? TRANSCRIBE_ENDPOINT, body: attempt.body }),
    });
  } catch {
    return { state: "unknown", reason: UNCHECKED, waiting: false };
  }
  if (found.state === "answered") {
    const result = transcriptResult(found.reply);
    if (!result) return { state: "unknown", reason: UNCHECKED, waiting: false };
    clearPendingGeneration(storage, options.slot, attempt.key);
    return {
      state: "done", result, recovered: true,
      note: `Your last transcription finished${result.credits > 0 ? ` and was charged ${creditWord(result.credits)}` : ""}. Nothing was sent again.`,
    };
  }
  if (found.state === "absent") {
    clearPendingGeneration(storage, options.slot, attempt.key);
    return { state: "released", reason: NEVER_ARRIVED, failed: false };
  }
  if (found.state === "refused" || found.state === "unknown") {
    /* Its final answer: what it is charged stands as the server records it, and it is never sent again. */
    clearPendingGeneration(storage, options.slot, attempt.key);
    const said = typeof found.error === "string" && found.error ? found.error : "";
    return { state: "released", reason: found.state === "refused" ? `Your last transcription did not complete. ${said}`.trim() : said || UNCHECKED, failed: true };
  }
  if (found.state === "pending") return { state: "unknown", reason: CHECKING, waiting: true };
  return { state: "unknown", reason: UNCHECKED, waiting: false };
}

type SendOptions = {
  scope: string; slot: string;
  /** The exact body to send, `maxCredits` included. */
  body: Record<string, unknown>;
  /** The credits shown on the button, kept with the claim. */
  credits: number;
  /** Injected only by tests; the browser's own storage otherwise. */
  storage?: Storage;
  /** Injected only by tests; the browser's Web Locks otherwise (null: none). */
  locks?: SendLocks | null;
  /** Told the key this press sent once its POST is over, answered or not: asking about it can no longer overtake it. */
  onSent?: (key: string) => void;
};

/**
 * The paid press: an earlier request of this slot is settled first (and never
 * re-sent); then this exact body — its `maxCredits` the approximate price
 * shown when it was pressed — is claimed in the slot and sent once under a
 * new key. All of it under the slot's send lock, taken only if no other
 * window holds it: one that does is sending from this slot now, and this
 * press sends nothing.
 */
export async function sendTranscription(options: SendOptions): Promise<TranscriptionOutcome> {
  const locks = options.locks === undefined ? webLocks() : options.locks;
  if (!locks) return sendClaimed(options);
  let granted = false;
  try {
    return await locks.request(transcriptionSendLock(options.slot), { ifAvailable: true }, async (lock): Promise<TranscriptionOutcome> => {
      granted = true;
      /* Another window's request is on its way from this slot: it is its own to send, never this one's. */
      if (!lock) return { state: "unknown", reason: ANOTHER, waiting: true };
      return sendClaimed(options);
    });
  } catch (error) {
    if (granted) throw error;
    /* The page was refused the lock: sent without it, its claim's stamp keeps other windows' checks off it (sendingElsewhere). */
    return sendClaimed(options);
  }
}

async function sendClaimed(options: SendOptions): Promise<TranscriptionOutcome> {
  const { scope, slot } = options;
  const storage = options.storage ?? browserStorage();
  if (!storage) return { state: "released", reason: NO_STORAGE, failed: true };
  const earlier = await settlePendingTranscription({ scope, slot, storage });
  if (earlier.state === "done" || earlier.state === "unknown") return earlier;
  const before = earlier.state === "released" ? `${earlier.reason} ` : "";
  let attempt: PendingGeneration;
  try {
    const proposed: PendingGeneration = { key: crypto.randomUUID(), body: JSON.stringify(options.body), credits: options.credits, endpoint: TRANSCRIBE_ENDPOINT, claimedAt: Date.now() };
    attempt = claimPendingGeneration(storage, slot, proposed);
    /* Another window claimed this slot meanwhile: its request is its own to send, never this one's to replay. */
    if (attempt.key !== proposed.key) return { state: "unknown", reason: `${before}${ANOTHER}`, waiting: true };
  } catch {
    /* No recovery storage, no paid request: a lost reply could not be told from a new press. */
    return { state: "released", reason: `${before}${NO_STORAGE}`, failed: true };
  }
  try {
    const reply = await studioRequest<unknown>(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": attempt.key },
      body: attempt.body,
    }).finally(() => options.onSent?.(attempt.key));
    const result = transcriptResult(reply);
    if (!result) return { state: "unknown", reason: `${before}${UNCHECKED}`, waiting: false };
    clearPendingGeneration(storage, slot, attempt.key);
    return { state: "done", result, recovered: false, note: before.trim() };
  } catch (error) {
    if (!(error instanceof StudioRequestError)) return { state: "unknown", reason: `${before}${LOST_REPLY}`, waiting: false };
    /* A completed answer is final: the server keeps it under this key, and the slot is let go. */
    if (error.resolved) {
      clearPendingGeneration(storage, slot, attempt.key);
      const repriced = error.status === 409 ? error.data.estimatedCredits : undefined;
      return { state: "released", reason: `${before}${error.message}`, failed: true, ...(typeof repriced === "number" && Number.isFinite(repriced) && repriced >= 0 ? { repriced } : {}) };
    }
    if (error.data.pending === true) return { state: "unknown", reason: `${before}${CHECKING}`, waiting: true };
    return { state: "unknown", reason: `${before}${error.status >= 500 ? LOST_REPLY : error.message}`, waiting: false };
  }
}
