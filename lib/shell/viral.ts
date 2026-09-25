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

/** Why the primary is off; null when the well is complete. Prototype copy first, then the account's needs. */
export function viralBlock(state: ViralState, extra: { connected: boolean; owner: boolean; hasProject: boolean }): string | null {
  if (!extra.hasProject) return "Open a project first.";
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

/** A job the account may still settle: never re-sent, only polled until it completes or fails. */
export const PENDING_STATUSES = ["dispatching", "accepted", "uncertain"] as const;
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

/**
 * Compare's two players on one clock: a seek on one is mirrored onto the
 * other, and the `seeked` that mirrored seek fires is not mirrored back (that
 * ping-pong, with frame snapping, kept both players re-seeking). `last` holds
 * the player last seeked on the other's behalf. True when it seeked `to`.
 */
export function mirrorSeek<T extends { currentTime: number }>(from: T, to: T | null, last: { current: T | null }): boolean {
  if (last.current === from) { last.current = null; return false; }
  if (!to || Math.abs(to.currentTime - from.currentTime) <= 0.05) return false;
  last.current = to;
  to.currentTime = from.currentTime;
  return true;
}
