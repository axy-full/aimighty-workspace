import type { ConsumerGenjutsuInput } from "@/lib/higgsfield-consumer/genjutsu-contract";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3). Pure: the two variants behind the
 * Motion Transfer and Object Swap pages, the well's rule (exactly one source
 * video 4–30 s at index 0, then up to 30 ordered reference images), what
 * blocks the primary in the prototype's words, and the input the existing
 * `genjutsu-service` takes. The price is the account's live estimate and
 * nothing else — a stale or missing one blocks submit.
 */
export const VIRAL_PAGES = { motion: "motion-transfer", swap: "object-swap" } as const;
export type ViralPage = keyof typeof VIRAL_PAGES;
export const VIRAL_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type ViralResolution = (typeof VIRAL_RESOLUTIONS)[number];
export const SOURCE_SECONDS = { min: 4, max: 30 } as const;
export const REFERENCE_MAX = 30;
/** How long a quote may be leaned on (the service's own lifetime is five minutes). */
export const ESTIMATE_LIFETIME_MS = 5 * 60_000;

export const VIRAL_COPY = {
  motion: {
    title: "Motion Transfer",
    intro: "Take the motion from a source video and recast it with your own cast, location and product. Anything you do not describe stays exactly as filmed.",
    promptLabel: "Creative direction · optional",
    promptPlaceholder: "Recast with @Mira on the mirrored dunes at golden hour…",
    verb: "Transfer motion",
  },
  swap: {
    title: "Object Swap",
    intro: "Swap one element — a product, a garment, an object — and leave the rest of the shot exactly as filmed.",
    promptLabel: "What to replace · optional",
    promptPlaceholder: "Replace the bottle with the Glow serum; keep the hands as filmed.",
    verb: "Swap object",
  },
  mediaLabel: "Source video · 4–30 s, then up to 30 ordered reference images",
  mediaHint: "Drag one source video and your reference images from the Library",
} as const;

export type ViralMedia = { id: string; sourceId: string; origin: "upload" | "generation"; kind: "video" | "image"; name: string; url: string | null; seconds: number | null };
export type ViralState = { resolution: ViralResolution; prompt: string; source: ViralMedia | null; references: ViralMedia[] };
export const INITIAL_VIRAL: ViralState = { resolution: "720p", prompt: "", source: null, references: [] };

export function viralMedia(entry: LibraryEntry): ViralMedia | null {
  if (entry.media !== "video" && entry.media !== "image") return null;
  const value = entry.asset.value as { durationS?: number | null; seconds?: number | null };
  return { id: entry.take.id, sourceId: entry.take.sourceId, origin: entry.asset.origin, kind: entry.media, name: entry.take.name, url: entry.url, seconds: value.durationS ?? value.seconds ?? null };
}

/** What happens when a Library asset lands in the well. */
export function addMedia(state: ViralState, media: ViralMedia): { state: ViralState; note: string | null } {
  if (media.kind === "video") {
    if (media.seconds != null && (media.seconds < SOURCE_SECONDS.min || media.seconds > SOURCE_SECONDS.max)) return { state, note: `The source video must be ${SOURCE_SECONDS.min}–${SOURCE_SECONDS.max} s; this one is ${Math.round(media.seconds)} s.` };
    return { state: { ...state, source: media }, note: state.source ? `Source video replaced with ${media.name}.` : null };
  }
  if (state.references.some((r) => r.id === media.id)) return { state, note: `${media.name} is already a reference.` };
  if (state.references.length >= REFERENCE_MAX) return { state, note: `Up to ${REFERENCE_MAX} reference images.` };
  return { state: { ...state, references: [...state.references, media] }, note: null };
}
export function moveReference(state: ViralState, id: string, dir: -1 | 1): ViralState {
  const i = state.references.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.references.length) return state;
  const next = [...state.references];
  [next[i], next[j]] = [next[j], next[i]];
  return { ...state, references: next };
}

/**
 * Why the primary is off; null when the well is complete. Prototype copy
 * first, then the account's needs. `account` is set while the account has
 * not been read (being read, or the read failed) — then that is the reason,
 * never a connect hint the account may not need.
 */
export function viralBlock(state: ViralState, extra: { connected: boolean; owner: boolean; hasProject: boolean; account?: string | null }): string | null {
  if (!extra.hasProject) return "Open a project first.";
  if (extra.account) return extra.account;
  if (!extra.owner) return "Only the workspace owner can run the connected account.";
  if (!extra.connected) return "Connect the account in Workspace › Engines.";
  if (!state.source) return "Add one source video (4–30 s).";
  if (!state.references.length) return "Add at least one reference image.";
  return null;
}

export function genjutsuInput(page: ViralPage, state: ViralState): ConsumerGenjutsuInput | null {
  if (!state.source) return null;
  const identity = (m: ViralMedia) => (m.origin === "upload" ? { uploadId: m.sourceId } : { genId: m.sourceId });
  return { variant: VIRAL_PAGES[page], resolution: state.resolution, prompt: state.prompt.trim(), source: identity(state.source), references: state.references.map(identity) };
}

/** A live estimate is one for exactly this input, still inside its lifetime. */
export function estimateLive(estimate: { key: string; expiresAt: number } | null, key: string, now: number): boolean {
  return Boolean(estimate && estimate.key === key && estimate.expiresAt > now);
}
export function estimateReason(estimate: { key: string; expiresAt: number; credits: number | null; error: string | null } | null, key: string, now: number): string | null {
  if (!estimate || estimate.key !== key) return "Waiting for the account's estimate…";
  if (estimate.error) return estimate.error;
  if (estimate.credits == null) return "The account returned no estimate. Nothing was sent.";
  if (estimate.expiresAt <= now) return "The estimate expired. A fresh one is being read.";
  return null;
}

export const HISTORY_ACTIONS = ["Recreate", "Compare", "Send to Edit"] as const;

/* ── Runs ─────────────────────────────────────────────────────────────── */
export type RunStatus = "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
export type RunTone = "idle" | "waiting" | "active" | "failed" | "done";
/** Every state the account reports, in the words a person reads — never the raw code. */
export const RUN_STATUS: Record<RunStatus, { label: string; tone: RunTone }> = {
  quoted: { label: "Estimate", tone: "idle" },
  dispatching: { label: "Queued", tone: "waiting" },
  accepted: { label: "Rendering", tone: "active" },
  uncertain: { label: "Checking", tone: "waiting" },
  failed: { label: "Failed · not billed", tone: "failed" },
  completed: { label: "Done", tone: "done" },
};
export function runStatus(status: string): { label: string; tone: RunTone } {
  return RUN_STATUS[status as RunStatus] ?? RUN_STATUS.uncertain;
}
/** A job the account may still settle: never re-sent, only polled until it completes or fails. */
export const PENDING_STATUSES = ["dispatching", "accepted", "uncertain"] as const;
/** Sent and not settled yet: read again until the account settles it; never sent twice. */
export const runInFlight = (status: string) => (PENDING_STATUSES as readonly string[]).includes(status);
/**
 * In flight with nothing that can move it on its own: a dispatch the account
 * never acknowledged, or a check with no receipt to reconcile. Read a few
 * times, then left for the person to check again.
 */
export const runCannotSettle = (job: { status: string; providerReceipt?: unknown }) =>
  job.status === "dispatching" || (job.status === "uncertain" && job.providerReceipt == null);
/** The one visible line under an in-flight run (never only a tooltip). */
export const RUN_NOTE: Partial<Record<RunStatus, string>> = { dispatching: "Sending to the account", uncertain: "Confirming · never sent twice" };
export const STALLED_NOTE = { unconfirmed: "Not confirmed yet · never sent twice", gone: "Could not be read" } as const;
/** A finished run whose original is not in the project, in words. */
export function originalNote(job: { originalAvailable?: boolean; originalAvailability?: string }): string | null {
  if (job.originalAvailable) return null;
  return job.originalAvailability === "deleted" ? "Archived" : "Original unavailable";
}
export const VARIANT_NAME: Record<string, string> = { "motion-transfer": "Motion Transfer", "object-swap": "Object Swap" };

type Run = { id: string; status: string; createdAt: number; updatedAt?: number };
/* How far along a run is. A run only ever moves forward (dispatching → uncertain → accepted → settled). */
const RANK: Record<string, number> = { quoted: 0, dispatching: 1, uncertain: 2, accepted: 3, failed: 4, completed: 4 };
const fresher = (a: Run, b: Run) => {
  const ra = RANK[a.status] ?? 2, rb = RANK[b.status] ?? 2;
  return ra !== rb ? ra > rb : (a.updatedAt ?? 0) >= (b.updatedAt ?? 0);
};
/**
 * Fresh runs over the ones on hand: one row per job, the fresher copy wins —
 * the one further along, else the later-updated — so a read that started
 * before a run landed never sets it back. Newest first. An estimate is never
 * a run, so a quoted row never shows.
 */
export function mergeRuns<T extends Run>(fresh: T[], current: T[]): T[] {
  const byId = new Map<string, T>();
  for (const job of current) byId.set(job.id, job);
  for (const job of fresh) { const had = byId.get(job.id); if (!had || fresher(job, had)) byId.set(job.id, job); }
  return listedJobs([...byId.values()])
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

type Listed = { id: string; status: string };
/** History and Recent list what ran; a read-only estimate (`quoted`) is not a result. */
export function listedJobs<T extends Listed>(jobs: readonly T[]): T[] {
  return jobs.filter((job) => job.status !== "quoted");
}
/** The jobs to poll: the one submitted here first, then every listed job still pending. */
export function pendingJobIds(jobs: readonly Listed[], running: string | null): string[] {
  const ids = jobs.filter((job) => (PENDING_STATUSES as readonly string[]).includes(job.status)).map((job) => job.id);
  return running && !ids.includes(running) ? [running, ...ids] : ids;
}

/** The composer's run, as the page tracks it. */
export type ViralRun<J extends Listed> = { phase: "idle" } | { phase: "submitting"; job: J } | { phase: "running"; job: J } | { phase: "done"; job: J } | { phase: "failed"; job: J | null; error: string };
export const VIRAL_FAILED = "The connected account reported this job as failed. Failed renders are not billed.";
/**
 * Where a status read leaves the composer's run: the job submitted here, and
 * also one whose submit reply was lost (shown failed) that the list then
 * shows the account took — it is rendering after all.
 */
export function runAfterStatus<J extends Listed>(current: ViralRun<J>, job: J): ViralRun<J> {
  const mine = (current.phase === "running" || current.phase === "failed") && current.job?.id === job.id;
  if (!mine) return current;
  if (job.status === "completed") return { phase: "done", job };
  if (job.status === "failed") return { phase: "failed", job, error: VIRAL_FAILED };
  if ((PENDING_STATUSES as readonly string[]).includes(job.status)) return { phase: "running", job };
  return current;
}

/**
 * Compare's two players on one clock: a seek on one is mirrored onto the
 * other, and the `seeked` that mirrored seek fires is not mirrored back (that
 * ping-pong, with frame snapping, kept both players re-seeking). `last` marks
 * the player seeked on the other's behalf, to which time and when; only a
 * `seeked` that matches the mark, soon after, is that echo. A mirrored seek
 * that never fires (a player without its metadata yet) leaves a mark that
 * expires, so it cannot swallow the viewer's next real seek. True when it
 * seeked `to`.
 */
export type MirrorMark<T> = { player: T; time: number; at: number } | null;
export const MIRROR_ECHO_MS = 1000;
export function mirrorSeek<T extends { currentTime: number }>(from: T, to: T | null, last: { current: MirrorMark<T> }, now = Date.now()): boolean {
  const mark = last.current;
  if (mark && mark.player === from) {
    last.current = null;
    if (now - mark.at <= MIRROR_ECHO_MS && Math.abs(from.currentTime - mark.time) <= 0.1) return false;
  }
  if (!to || Math.abs(to.currentTime - from.currentTime) <= 0.05) return false;
  last.current = { player: to, time: from.currentTime, at: now };
  to.currentTime = from.currentTime;
  return true;
}
