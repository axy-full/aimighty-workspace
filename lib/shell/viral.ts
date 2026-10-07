import { GENJUTSU_LIMITS, GENJUTSU_MODELS, GENJUTSU_RESOLUTIONS, genjutsuVariantForModel, type GenjutsuVariant } from "@/lib/genjutsuTypes";
import type { Generation } from "@/lib/jobs";
import { failedChip } from "@/lib/errors";
import type { TakeFailure } from "@/lib/providerOutcome";
import type { MediaIdentity } from "@/lib/genjutsuRequest";
import type { DispatchRequest } from "@/lib/workspace/generate-submit";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { TakeStage, TakeStatus } from "@/lib/workspace/takes";
import { SAVING_NOW } from "../workbench/save-then-continue";

/**
 * Viral = Genjutsu, on Particl's API key for every
 * workspace and every member. Pure: the two variants behind the Motion
 * Transfer and Object Swap pages, the well's rule (exactly one source video
 * of 4–8 s, then 1–8 ordered reference images: the API's own limits), what
 * blocks the primary, and the request the shared dispatch sends
 * (lib/workspace/generate-submit.ts: POST /api/generate/quote, then POST
 * /api/generate with the approved ceiling). The price on the button is that
 * quote — the provider's live estimate through Particl's credit terms, shown
 * as an estimate ("about N cr") — and nothing else: a missing one blocks.
 *
 * The resolutions and the reference cap are the key route's own
 * (lib/genjutsuTypes.ts), so the page offers exactly what admission accepts.
 *
 * History is read from the project's Library only: the key's takes, and the
 * runs made earlier on the owner's connected account, which the Library keeps
 * as ordinary takes once collected (their `generations` rows). Nothing here
 * reads the account, and nothing starts a run there.
 */
export const VIRAL_PAGES = { motion: "motion-transfer", swap: "object-swap" } as const;
export type ViralPage = keyof typeof VIRAL_PAGES;
/** What the key route renders (lib/genjutsuTypes.ts): 480p, 720p and 1080p, each at the provider's live estimate. */
export const VIRAL_RESOLUTIONS: readonly string[] = GENJUTSU_RESOLUTIONS;
export type ViralResolution = string;
/** The source window (lib/genjutsuTypes.ts): at least 4 s, at most 8 s for now. Object Swap's pixel floor is admission's to say. */
export const SOURCE_SECONDS = { min: GENJUTSU_LIMITS.minSeconds, max: GENJUTSU_LIMITS.maxSeconds } as const;
/** Why a longer clip is not taken: said beside the refusal, never alone. */
export const SOURCE_WHY = `Motion transfer and Object swap take clips up to ${SOURCE_SECONDS.max} s for now; pick a shorter one or trim it first.`;
/** The API takes 1–8 reference images. */
export const REFERENCE_MAX = GENJUTSU_LIMITS.maxImages;
export const PROMPT_MAX = GENJUTSU_LIMITS.maxPromptChars;

export const VIRAL_COPY = {
  motion: {
    title: "Motion Transfer",
    intro: "Take the motion from a source video and recast it with your own cast, location and product. Anything you do not describe stays exactly as filmed.",
    promptLabel: "Creative direction · optional",
    promptPlaceholder: "Recast with @your cast in a new location at golden hour…",
    verb: "Transfer motion",
  },
  swap: {
    title: "Object Swap",
    intro: "Swap one element — a product, a garment, an object — and leave the rest of the shot exactly as filmed.",
    promptLabel: "What to replace · optional",
    promptPlaceholder: "Replace the bottle with the Glow serum; keep the hands as filmed.",
    verb: "Swap object",
  },
  mediaLabel: `Source video · ${SOURCE_SECONDS.min}–${SOURCE_SECONDS.max} s, then up to ${REFERENCE_MAX} ordered reference images`,
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
    if (media.seconds != null && (media.seconds < SOURCE_SECONDS.min || media.seconds > SOURCE_SECONDS.max)) return { state, note: `The source video must be ${SOURCE_SECONDS.min}–${SOURCE_SECONDS.max} s; this one is ${Math.round(media.seconds)} s. ${SOURCE_WHY}` };
    return { state: { ...state, source: media }, note: state.source ? `Source video replaced with ${media.name}.` : null };
  }
  if (state.references.some((r) => r.id === media.id)) return { state, note: `${media.name} is already a reference.` };
  if (state.references.length >= REFERENCE_MAX) return { state, note: `Up to ${REFERENCE_MAX} reference images.` };
  return { state: { ...state, references: [...state.references, media] }, note: null };
}
/** Drag a reference to a new place: it lands at `to` (0-based), the others keep their order. Same state back when nothing moves. */
export function moveReferenceTo(state: ViralState, id: string, to: number): ViralState {
  const from = state.references.findIndex((r) => r.id === id);
  const target = Math.max(0, Math.min(state.references.length - 1, Math.round(to)));
  if (from < 0 || from === target) return state;
  const next = [...state.references];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return { ...state, references: next };
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
 * Why the primary is off; null when the well is complete. A project whose
 * production is not linked yet cannot file a take (admission files every
 * transform to the saved project), so that is said before the well.
 */
export function viralBlock(state: ViralState, extra: { hasProject: boolean; saved: boolean }): string | null {
  if (!extra.hasProject) return "Open a project first.";
  if (!extra.saved) return SAVING_NOW;
  if (!state.source) return `Add one source video (${SOURCE_SECONDS.min}–${SOURCE_SECONDS.max} s).`;
  if (!state.references.length) return "Add at least one reference image.";
  if (state.references.length > REFERENCE_MAX) return `Up to ${REFERENCE_MAX} reference images: remove ${state.references.length - REFERENCE_MAX}.`;
  if (state.prompt.trim().length > PROMPT_MAX) return `Keep the direction under ${PROMPT_MAX.toLocaleString("en-US")} characters.`;
  if (!VIRAL_RESOLUTIONS.includes(state.resolution)) return `Choose ${VIRAL_RESOLUTIONS.join(", ")}.`;
  return null;
}

/** The composer's input: the source apart, then the stills in the order they are sent. Also the page's Atomik plan request. */
export type ViralInput = { variant: GenjutsuVariant; resolution: string; prompt: string; source: MediaIdentity; references: MediaIdentity[] };
const identity = (m: ViralMedia): MediaIdentity => (m.origin === "upload" ? { uploadId: m.sourceId } : { genId: m.sourceId });
export function genjutsuInput(page: ViralPage, state: ViralState): ViralInput | null {
  if (!state.source) return null;
  return { variant: VIRAL_PAGES[page], resolution: state.resolution, prompt: state.prompt.trim(), source: identity(state.source), references: state.references.map(identity) };
}

/**
 * The request the shared dispatch prices and sends: the key model for the
 * variant, filed to the saved project (no shot), the draft named so admission
 * can confirm it belongs to the person sending it.
 */
export function viralRequest(input: ViralInput, project: { id: string; productionProjectId: string }): DispatchRequest {
  return {
    endpoint: "/api/generate",
    input: {
      prompt: input.prompt,
      kind: "video",
      model: { id: GENJUTSU_MODELS[input.variant] },
      mapping: { productionProjectId: project.productionProjectId },
      ratio: "adaptive",
      resolution: input.resolution,
      duration: 0,
      references: input.references.map((reference) => ({ ...reference, role: "reference_image" })),
      genjutsu: { source: input.source, workbenchProjectId: project.id },
    },
  };
}

/* ── The estimate (lib/shell/key-estimate.ts: the same words on every key-route composer) ── */
export { aboutCredits, estimateLive, estimateReason, type KeyEstimate as ViralEstimate } from "./key-estimate";

/* ── Takes (this project's transforms, from its Library) ─────────────── */
export type RunTone = "idle" | "waiting" | "active" | "failed" | "done";
/**
 * Runs made earlier on the owner's connected account, as the Library keeps
 * them once collected: `generations` rows on the account's own model ids,
 * params.task "genjutsu" (the same source, stills and resolution as a key
 * take). Read-only history; the ids are data here, never a way to start one.
 */
const ACCOUNT_GENJUTSU_MODELS: Readonly<Record<string, GenjutsuVariant>> = { hf_mult_motion_control: "motion-transfer", hf_mult_replace_object: "object-swap" };
/** Which transform a take is, on the key or from the account; null for anything else. */
export function transformVariant(model: string, params?: Record<string, unknown> | null): GenjutsuVariant | null {
  const key = genjutsuVariantForModel(model);
  if (key) return key;
  const earlier = ACCOUNT_GENJUTSU_MODELS[model];
  return earlier && params?.task === "genjutsu" ? earlier : null;
}
/** One transform take, as the Library holds it. */
export type ViralTake = {
  id: string; variant: GenjutsuVariant; resolution: string; prompt: string; refs: number;
  /** Made earlier on the owner's connected account (read-only history). */
  account: boolean;
  status: TakeStatus; stage: TakeStage | null; cancelled: boolean; failedUnbilled: boolean; needs: number | null; reason: string | null;
  /** A failed take: what happened, what the provider did with the charge, and the next step (lib/errors.ts), when on record. */
  failure: TakeFailure | null; failureLine: string | null;
  /** Billed credits once settled; null in flight (the ledger has not settled it) and for account runs. */
  credits: number | null;
  /** The stored result, once it can be shown. */
  url: string | null;
  createdAt: number; createdBy: string; generation: Generation;
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** This project's transform takes, newest first; beside a composer, only its own variant. */
export function viralTakes(entries: readonly LibraryEntry[], variant: GenjutsuVariant | null = null): ViralTake[] {
  const out: ViralTake[] = [];
  for (const entry of entries) {
    if (entry.asset.origin !== "generation") continue;
    const g = entry.asset.value;
    const params = record(g.params) ? g.params : {};
    const kind = transformVariant(g.model, params);
    if (!kind || (variant && kind !== variant)) continue;
    const refs = Array.isArray(params.references) ? params.references.filter((r) => record(r) && r.role === "reference_image").length : 0;
    const t = entry.take;
    out.push({
      id: g.id, variant: kind, resolution: typeof params.resolution === "string" ? params.resolution : "", prompt: typeof params.rawPrompt === "string" ? params.rawPrompt : g.prompt ?? "",
      refs, account: !genjutsuVariantForModel(g.model),
      status: t.status, stage: t.stage ?? null, cancelled: Boolean(t.cancelled), failedUnbilled: Boolean(t.failedUnbilled), needs: t.needs ?? null, reason: t.reason ?? null,
      failure: t.failure ?? null, failureLine: t.failureLine ?? null,
      credits: t.credits, url: entry.media === "video" ? entry.url : null, createdAt: g.createdAt, createdBy: g.createdBy, generation: g,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
export const takeDone = (take: Pick<ViralTake, "status">) => take.status !== "rendering" && take.status !== "held" && take.status !== "failed";
export const takeInFlight = (take: Pick<ViralTake, "status">) => take.status === "rendering" || take.status === "held";
/**
 * A take's state in words. A failed take's chip says what became of the
 * charge only when that is on record — Particl's ledger, or the provider's
 * own word (lib/errors.ts failedChip): "Failed · not billed", "Failed ·
 * refunded", else just "Failed". Never a blanket promise.
 */
export function takeWords(take: Pick<ViralTake, "status" | "stage" | "cancelled" | "needs" | "failure">): { label: string; tone: RunTone } {
  if (take.status === "held") return { label: take.needs != null ? `Held · needs ${take.needs.toLocaleString("en-US")} cr` : "Held · needs credits", tone: "waiting" };
  if (take.status === "rendering") return take.stage === "queued" ? { label: "Queued", tone: "waiting" } : take.stage === "held" ? { label: "Held", tone: "waiting" } : { label: "Rendering", tone: "active" };
  if (take.status === "failed") return { label: failedChip(take.failure, take.cancelled), tone: take.cancelled ? "idle" : "failed" };
  return { label: "Done", tone: "done" };
}
/** Still waiting its turn at the provider, so it can be cancelled: a key take, by the person who sent it or an admin (the route decides). */
export function canCancel(take: Pick<ViralTake, "status" | "stage" | "createdBy" | "generation" | "account">, me: { userId?: string | null; role: string | null }): boolean {
  if (take.account || take.status !== "rendering" || take.stage !== "queued" || take.generation.status !== "queued") return false;
  return me.role === "owner" || me.role === "admin" || (Boolean(me.userId) && me.userId === take.createdBy);
}
/** The saved original of a take, as a download link (the media route names the file). */
export const downloadHref = (origin: "upload" | "generation", id: string) => `/api/${origin === "upload" ? "uploads" : "media"}/${encodeURIComponent(id)}?download=1`;

/** A take's recipe, for Recreate: its variant, source and ordered stills (Library ids), direction and resolution. */
export type TakeRecipe = { variant: GenjutsuVariant; source: string; references: string[]; prompt: string; resolution: string };
const saved = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const libraryId = (value: Record<string, unknown>): string | null =>
  saved(value.genId) === saved(value.uploadId) ? null : saved(value.genId) ? `generation:${value.genId}` : `upload:${value.uploadId}`;
/**
 * A take's own recipe as admission kept it — the key's takes and the account's
 * collected runs keep the same fields — or why it cannot be read. Library ids
 * (`upload:<id>` / `generation:<id>`), resolved against the project's Library
 * by the page, which also says what the key route cannot carry (more than
 * eight stills, a size it does not offer).
 */
export function takeRecipe(take: Pick<ViralTake, "generation">): TakeRecipe | { error: string } {
  const g = take.generation, params = record(g.params) ? g.params : null;
  const variant = transformVariant(g.model, params);
  if (!variant || !params || !Array.isArray(params.references) || typeof params.resolution !== "string")
    return { error: "The original source, reference order or quality settings were not kept for this take." };
  const sourceGenId = params.sourceGenId ?? g.sourceGenId, sourceUploadId = params.sourceUploadId;
  if (saved(sourceGenId) === saved(sourceUploadId)) return { error: "The original source was not kept for this take." };
  const source = saved(sourceGenId) ? `generation:${sourceGenId}` : `upload:${sourceUploadId}`;
  const references: string[] = [];
  for (const reference of params.references) {
    if (!record(reference)) return { error: "A saved reference is incomplete." };
    const id = libraryId(reference);
    if (!id) return { error: "A saved reference has an unclear identity." };
    /* The source rides among a key take's references as its video; it is the source, not a still. */
    if (reference.role === "reference_video" && id === source) continue;
    if (reference.role !== "reference_image" || references.includes(id)) return { error: "The saved reference order could not be read." };
    references.push(id);
  }
  const prompt = typeof params.rawPrompt === "string" ? params.rawPrompt : g.prompt;
  if (typeof prompt !== "string") return { error: "The original direction was not kept for this take." };
  return { variant, source, references, prompt, resolution: params.resolution };
}

export const HISTORY_ACTIONS = ["Recreate", "Compare", "Send to Edit"] as const;
export const VARIANT_NAME: Record<string, string> = { "motion-transfer": "Motion Transfer", "object-swap": "Object Swap" };

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
