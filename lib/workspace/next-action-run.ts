import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { toDeci } from "../creditTerms";
import { failureLine } from "../errors";
import type { Generation } from "../jobs";
import { movedOn, poll, type Poller } from "../poll";
import { repricedNote } from "../shell/next-actions";
import { activeMediaJob } from "../workbench/job-recovery";
import { sendClaimedGeneration, settlePendingGeneration } from "./generate-submit";
import { refreshProjectLibrary } from "./library";
import { neutralCopy } from "./rig";

/**
 * A priced Next action (lib/shell/next-actions.ts), from its estimate to its
 * new take, on the one paid path every Studio tool uses:
 *
 *   quote   — POST /api/generate/quote with the exact request: admission's own
 *             validation and pricing, stopped before anything is reserved, so
 *             asking is free. The estimate is shown as "about N cr".
 *   press   — any earlier press whose reply was lost is settled first, by its
 *             own Idempotency-Key (followed if it landed, never sent again);
 *             then the request is quoted once more, and if the estimate moved,
 *             nothing is sent and the new one is asked for again. Otherwise it
 *             is claimed in recovery storage and sent once, with the estimate
 *             as its ceiling and the quote's fingerprint (generate-submit's
 *             sendClaimedGeneration). What it is charged is the render's
 *             actual cost, settled by the server as for any take.
 *   follow  — the new take's job is read at lib/poll's pace until it lands or
 *             fails; a failure says what happened and what its provider did
 *             with the charge (lib/errors.ts failureLine), never a guess.
 *
 * Nothing here writes to the source take: the new take is its own row.
 */

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type NextQuote = { credits: number; fingerprint: string };
/** What a refusal asks for: a reason to render past an approved take, or an admin (a shot's cost cap). */
export type NextRefusalDetail = { needsReason?: { title: string; line: string }; needsAdmin?: true };

/** The server answered, and will answer the same way until something changes: its words, and what it asks for. */
export class NextRefusal extends Error {
  constructor(message: string, public detail: NextRefusalDetail = {}) {
    super(message);
    this.name = "NextRefusal";
  }
}

const FINGERPRINT = /^[a-f0-9]{64}$/;
export const QUOTE_UNREAD = "The estimate could not be read.";
/** A figure the credit terms can charge: whole credits, or whole tenths of one where the terms charge in tenths. */
const chargeable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && Math.abs(n * 10 - Math.round(n * 10)) < 1e-6;

/**
 * The estimate for exactly `body`, from the server. A refusal (a request the
 * server will not take as it stands) throws NextRefusal with its own words; a
 * reply that never came or cannot be read throws an ordinary Error — asking
 * again may help.
 */
export async function quoteNext(scope: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<NextQuote> {
  let reply: { estimatedCredits?: unknown; fingerprint?: unknown };
  try {
    reply = await studioRequest("/api/generate/quote", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof StudioRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      const data = error.data;
      const detail: NextRefusalDetail = data.needsReason === true ? { needsReason: { title: error.message, line: typeof data.line === "string" ? data.line : "" } }
        : data.needsAdmin === true ? { needsAdmin: true } : {};
      throw new NextRefusal(neutralCopy(error.message, "This can't be priced here."), detail);
    }
    throw error;
  }
  const credits = reply.estimatedCredits;
  if (!chargeable(credits) || typeof reply.fingerprint !== "string" || !FINGERPRINT.test(reply.fingerprint))
    throw new Error(QUOTE_UNREAD);
  return { credits, fingerprint: reply.fingerprint };
}

export type NextPress =
  /** Sent (or an earlier press that landed, `followed`): the new take's job to follow. `status` is its own ("held" waits for credits or a slot). */
  | { state: "queued"; jobId: string; credits: number; status: string; followed: boolean; note: string | null }
  /** The estimate moved since it was shown: nothing was sent, and this is the one to ask about now. */
  | { state: "repriced"; credits: number; note: string }
  /** Refused, with nothing sent or made: the server's words, and what it asks for. */
  | { state: "refused"; note: string; detail?: NextRefusalDetail }
  /** Not known: an earlier press is still being accepted, the server could not be asked, or this press's reply was lost. Nothing more was sent. */
  | { state: "unknown"; note: string };

/**
 * One press of an action's priced button, whose `shown` estimate is what the
 * person approved. `storageId` is this action's recovery slot for this source
 * (pendingGenerationKey), so a second press after a lost reply checks the first.
 */
export async function pressNext(options: {
  scope: string; storageId: string; body: Record<string, unknown>; shown: number; label: string; storage?: Storage;
}): Promise<NextPress> {
  const { scope, storageId, body, shown, label, storage } = options;
  const earlier = await settlePendingGeneration({ scope, storageId, storage });
  if (earlier.state === "landed")
    return { state: "queued", jobId: earlier.jobId, credits: earlier.credits, status: earlier.status, followed: true, note: `Your last press of ${label} reached the server, and that one is followed. Nothing new was sent.` };
  if (earlier.state === "unknown") return { state: "unknown", note: earlier.reason };
  /* It never arrived (and is set aside now), or it was refused: no job, so nothing was charged for it, and this press goes. */
  const before = earlier.state === "lost" ? `Your last press of ${label} never went through, so nothing was charged for it. ` : "";
  let fresh: NextQuote;
  try {
    fresh = await quoteNext(scope, body);
  } catch (error) {
    if (error instanceof NextRefusal) return { state: "refused", note: `${before}${error.message}`, detail: error.detail };
    return { state: "unknown", note: `${before}The price could not be checked. Nothing was sent; try again in a moment.` };
  }
  /* Compared in whole tenths: the shown figure came back from the page as a number. */
  if (toDeci(fresh.credits) !== toDeci(shown)) return { state: "repriced", credits: fresh.credits, note: `${before}${repricedNote(label, fresh.credits)}` };
  const out = await sendClaimedGeneration({
    scope, storageId, storage, credits: fresh.credits,
    body: { ...body, maxCredits: fresh.credits, quoteFingerprint: fresh.fingerprint },
  });
  if (out.state === "queued")
    return {
      state: "queued", jobId: out.jobId, credits: out.credits, status: out.status, followed: out.followed,
      note: out.followed ? `Your last press of ${label} reached the server, and that one is followed. Nothing new was sent.`
        : out.status === "held" ? `${before}It is held until credits or a render slot free up. Nothing is charged until it runs.`
        : before.trim() || null,
    };
  if (out.state === "refused") return { state: "refused", note: `${before}${out.reason}` };
  return { state: "unknown", note: `${before}${out.reason}` };
}

/** A failed action's line: what happened, what its provider did with the charge, and the next step — the take card's own words. */
export function nextFailureLine(g: Pick<Generation, "status" | "error" | "failure">): string {
  if (g.failure) return failureLine(g.failure, { cancelled: g.status === "cancelled" }).text;
  return g.error?.trim() || "It did not render.";
}

/* ── Following a sent action ────────────────────────────────────────────── */

/**
 * One action on one take, once sent: shared by every place that shows that
 * take's Next row (the Inspector and the Takes desk can both be open), and
 * kept while the row is closed, so a job is followed once and its end is seen
 * wherever the take is shown next.
 */
export type NextRun =
  | { phase: "following"; jobId: string; credits: number; status: string; note: string | null; checking: string | null }
  | { phase: "landed"; jobId: string; generation: Generation; note: string | null }
  | { phase: "failed"; jobId: string; line: string }
  | { phase: "lost"; jobId: string; note: string };

export const NEXT_LOST = "This can no longer be checked from here. If it renders, it lands in Takes.";

const runs = new Map<string, NextRun>();
const pollers = new Map<string, Poller>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const nextRunKey = (scope: string, takeId: string, action: string) => JSON.stringify([scope, takeId, action]);
export function subscribeNextRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const readNextRun = (key: string): NextRun | null => runs.get(key) ?? null;

/** Let a finished run go (the person starts another, or retries): its job is not followed any more. */
export function clearNextRun(key: string) {
  pollers.get(key)?.stop();
  pollers.delete(key);
  if (runs.delete(key)) emit();
}

/** Follow a sent action's job until it ends; the project's library is read again when it is sent and when it lands. */
export function followNextRun(key: string, job: { scope: string; projectId: string; jobId: string; credits: number; status: string; note: string | null }) {
  pollers.get(key)?.stop();
  runs.set(key, { phase: "following", jobId: job.jobId, credits: job.credits, status: job.status, note: job.note, checking: null });
  emit();
  void refreshProjectLibrary(job.scope, job.projectId);
  const mine = () => runs.get(key)?.jobId === job.jobId;
  const moved = movedOn();
  const poller = poll<{ generation: Generation }>({
    immediate: true,
    read: (signal) => studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(job.jobId)}`, { signal, headers: { "X-Workbench-Scope": job.scope }, cache: "no-store" }),
    moved: ({ generation }) => moved(job.jobId, generation.status),
    done: ({ generation }) => !activeMediaJob(generation),
    onValue: ({ generation }) => {
      if (!mine()) return;
      const now = runs.get(key);
      if (activeMediaJob(generation)) {
        if (now?.phase === "following") { runs.set(key, { ...now, status: generation.status, checking: null }); emit(); }
        return;
      }
      pollers.delete(key);
      runs.set(key, generation.status === "succeeded"
        ? { phase: "landed", jobId: job.jobId, generation, note: now?.phase === "following" ? now.note : null }
        : { phase: "failed", jobId: job.jobId, line: nextFailureLine(generation) });
      emit();
      void refreshProjectLibrary(job.scope, job.projectId);
    },
    /* No longer on record for this person: asking again cannot help. Anything else is asked again, later. */
    onError: (cause) => {
      if (!mine()) return "stop";
      if (cause instanceof StudioRequestError && (cause.status === 404 || cause.status === 403)) {
        pollers.delete(key);
        runs.set(key, { phase: "lost", jobId: job.jobId, note: NEXT_LOST });
        emit();
        return "stop";
      }
      const now = runs.get(key);
      if (now?.phase === "following") {
        runs.set(key, { ...now, checking: cause instanceof StudioRequestError ? "It could not be checked just now. Checking again shortly." : "The connection dropped. Checking again shortly." });
        emit();
      }
    },
  });
  pollers.set(key, poller);
}
