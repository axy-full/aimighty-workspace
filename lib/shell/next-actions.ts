import { entryFace, entryKind, type LibraryEntry } from "@/lib/workspace/library";
import type { Generation } from "@/lib/jobs";
import { MODELS, type ModelDef } from "@/lib/models";
import { EXTEND_MOVES, TASKS, getTask, sourceProblem, type TaskId } from "@/lib/tasks";
import { STILL_TOOLS, stillToolFor, stillToolModel } from "@/lib/stillTools";
import { DEFAULT_TOPAZ_IMAGE, TOPAZ_IMAGE_MODEL, topazImageOutput, type TopazImageSettings } from "@/lib/topaz";
import { ASTRA_MODEL, DEFAULT_ASTRA } from "@/lib/astra";
import { resolutionOfHeight } from "@/lib/sourceClip";
import { clipDoubt } from "@/lib/clipTrust";
import { cleanReason } from "@/lib/approval";
import { isDraft } from "@/lib/draftFinal";

/**
 * Idea 12, first slice: what a take can go on to next, as a way INTO the
 * existing tool that does it — the Takes desk's Re-edit for a still, Seedance
 * Edit for a clip, Edit & Sound for a sound. Navigation only: nothing here
 * quotes, prices or sends; the tool's own button is the only paid control,
 * after its own quote. No price is ever attached to one of these. Pure.
 *
 * A still or a clip opens its tool only once its original is stored here (a
 * take that is rendering, held, failed, stopped or whose copy has not landed
 * has nothing to edit yet), and only in a saved project (the tools file their
 * result to its production). A sound opens the project's Edit & Sound, which
 * does not take the sound as an input yet — so the label says what opens, not
 * "add to the mix".
 */
export type NextActionId = "re-edit" | "edit" | "edit-sound";
export type NextAction = { id: NextActionId; label: string; opens: string; enabled: boolean; why: string | null };

type Entry = Pick<LibraryEntry, "take" | "asset" | "url" | "media">;

function gate(entry: Entry, saved: boolean): Pick<NextAction, "enabled" | "why"> {
  const face = entryFace(entry);
  if (face === "live" || face === "held") return { enabled: false, why: "It opens once it has rendered." };
  if (face === "failed" || face === "stopped") return { enabled: false, why: "It did not render, so there is nothing to edit." };
  if (face === "unavailable") return { enabled: false, why: "Its stored copy is not here yet." };
  if (!entry.url) return { enabled: false, why: "This file type cannot be edited here." };
  if (!saved) return { enabled: false, why: "Save the project first." };
  return { enabled: true, why: null };
}

export function nextActions(entry: Entry, context: { saved: boolean }): NextAction[] {
  const kind = entryKind(entry);
  if (kind === "image") return [{ id: "re-edit", label: "Re-edit", opens: "the re-edit form in Takes", ...gate(entry, context.saved) }];
  if (kind === "video") return [{ id: "edit", label: "Edit", opens: "Seedance Edit in Takes", ...gate(entry, context.saved) }];
  if (kind === "audio") return [{ id: "edit-sound", label: "Edit & Sound", opens: "Edit & Sound", enabled: true, why: null }];
  return [];
}

/** The section of the Takes desk each tool is (components/graphite/production/EditStage.tsx). */
export const NEXT_SECTION: Partial<Record<NextActionId, string>> = { "re-edit": "image", edit: "video" };

/* ── Idea 12, second slice: the priced Next actions ─────────────────────── */

/**
 * The actions that make something new from a take, each on an engine Particl
 * already calls directly (lib/models.ts): a still is upscaled (Topaz Image
 * Upscale), outpainted to another aspect (Bria Expand) or animated from its
 * first frame (Seedance 2.5); a clip is upscaled (Topaz Astra 2), reframed
 * (Luma Ray 2) or extended forward or back (Seedance 2.5). Cut out comes with
 * the Rig's own cut-out path, not from here.
 *
 * Each is priced before it spends: the exact request below is quoted by POST
 * /api/generate/quote (an estimate, shown as "about N cr"), and only a press of
 * the button carrying that estimate sends it, claimed first so a lost reply is
 * never sent twice (lib/workspace/next-action-run.ts). The result is a NEW
 * take — filed under its source's shot when the source is a take of this
 * production, as its next version — and the source stays as it is: nothing
 * here edits, replaces or deletes it. An action no engine here does for a
 * kind of take is listed as not offered, with why; it is never faked.
 *
 * Pure: the Inspector's and the Takes desk's Next row read it, and the unit
 * tests read the bodies it builds.
 */
export type PricedActionId = "upscale" | "outpaint" | "animate" | "reframe" | "extend";
export type PricedAction = {
  id: PricedActionId;
  label: string;
  /** The engine that does it, by the name Gen shows; null when no engine here does it for this kind of take. */
  engine: string | null;
  /** An engine Particl calls directly does this for this kind of take. */
  offered: boolean;
  enabled: boolean;
  why: string | null;
};

export const PRICED_LABEL: Record<PricedActionId, string> = { upscale: "Upscale", outpaint: "Outpaint", animate: "Animate", reframe: "Reframe", extend: "Extend" };

/** What each kind of take is offered, in the row's order. A sound is listed only to say what it cannot have. */
const MEDIA_ACTIONS: Record<"image" | "video" | "audio", PricedActionId[]> = {
  image: ["upscale", "outpaint", "animate"],
  video: ["upscale", "reframe", "extend"],
  audio: ["upscale", "extend"],
};
/** Why a kind of take has none of its listed actions. */
const NOT_OFFERED: Record<"audio", string> = { audio: "no engine Particl uses upscales or extends sound." };

/** Seedance 2.5 (ModelArk): animates a still from its first frame, and extends a clip. */
export const SEEDANCE_25 = "dreamina-seedance-2-5-260628";
const video = (task: TaskId): ModelDef | null => MODELS.find((m) => m.kind === "video" && (m.supportsTasks ?? []).includes(task)) ?? null;
const ANIMATE_ENGINE: ModelDef | null = MODELS.find((m) => m.id === SEEDANCE_25 && m.kind === "video") ?? null;

/** The engine an action runs on for a kind of take, or null when none here does it. */
export function nextEngine(media: "image" | "video" | "audio", action: PricedActionId): ModelDef | null {
  if (media === "image") return action === "upscale" ? stillToolModel("upscale") : action === "outpaint" ? stillToolModel("outpaint") : action === "animate" ? ANIMATE_ENGINE : null;
  if (media === "video") return action === "upscale" ? video("upscale") : action === "reframe" ? video("reframe") : action === "extend" ? video("extend") : null;
  return null;
}

/** What the take is, as the engines' limits read it: an upload's own header, or a render's recorded settings. */
export type SourceFacts = {
  origin: "render" | "upload";
  width: number | null; height: number | null;
  seconds: number | null; resolution: string | null; ratio: string | null; bytes: number | null;
};
const RATIO = /^[1-9]\d*:[1-9]\d*$/;
export function sourceFacts(entry: Pick<LibraryEntry, "asset">): SourceFacts {
  if (entry.asset.origin === "upload") {
    const u = entry.asset.value;
    const width = u.width && u.width > 0 ? u.width : null, height = u.height && u.height > 0 ? u.height : null;
    return {
      origin: "upload", width, height,
      /* As admission reads an upload (lib/sourceClip.ts uploadSourceParams): a tenth of a second, the short side's label. */
      seconds: typeof u.durationS === "number" ? Math.round(u.durationS * 10) / 10 : null,
      resolution: resolutionOfHeight(width && height ? Math.min(width, height) : height) ?? null,
      ratio: width && height ? `${width}:${height}` : null,
      bytes: typeof u.bytes === "number" ? u.bytes : null,
    };
  }
  const g = entry.asset.value;
  const p = (g.params ?? {}) as Record<string, unknown>;
  return {
    origin: "render", width: null, height: null,
    seconds: typeof p.duration === "number" ? p.duration : g.durationS ?? null,
    resolution: typeof p.resolution === "string" ? p.resolution : null,
    ratio: typeof p.ratio === "string" && RATIO.test(p.ratio) ? p.ratio : null,
    bytes: null,
  };
}

/** Extend's own words for the vendor's source limits: sourceProblem decides, this only says it for Extend. */
function extendProblem(facts: SourceFacts): string | null {
  const sp = { resolution: facts.resolution ?? undefined, duration: facts.seconds ?? undefined };
  if (!sourceProblem(getTask("extend"), sp, facts.origin)) return null;
  const res = (facts.resolution ?? "").toLowerCase();
  /* Sizes as the app writes them: "1080p", and "4K". */
  if (res && res !== "480p" && res !== "720p") return `Extend takes a 480p or 720p clip; this one is ${res === "4k" ? "4K" : res}.`;
  if (facts.seconds != null && facts.seconds < 4) return `Extend takes a clip of 4 seconds or more; this one is ${facts.seconds}s.`;
  return `Extend takes a clip of 30 seconds or less; this one is ${facts.seconds}s.`;
}

/** What a draft says in place of its actions (lib/draftFinal.ts): it carries the engine's watermark, and its final does not. */
export const DRAFT_WHY = "A draft is a watermarked preview: make its final, then go on from that.";

/** Why this take cannot go through one action now; null when it can. The take's own state first (as the navigation row says it), then the engine's limits on this source. */
function pricedGate(entry: Entry, saved: boolean, action: PricedActionId, media: "image" | "video"): Pick<PricedAction, "enabled" | "why"> {
  const base = gate(entry, saved);
  if (!base.enabled) return base;
  /* A paid upscale, reframe or extension of a draft would carry its watermark: the final is the take to go on from. */
  if (entry.asset.origin === "generation" && isDraft(entry.asset.value.params)) return { enabled: false, why: DRAFT_WHY };
  const facts = sourceFacts(entry);
  if (media === "video") {
    /* A locked task priced by the source's seconds needs a length it can believe (lib/clipTrust.ts); Astra reads the original itself. */
    if (facts.origin === "upload" && action !== "upscale" && clipDoubt(facts.seconds, facts.bytes))
      return { enabled: false, why: `${PRICED_LABEL[action]}: this clip's length could not be read. Re-export it as an MP4 and upload it again.` };
    const problem = action === "extend" ? extendProblem(facts)
      : sourceProblem(getTask(action), { resolution: facts.resolution ?? undefined, duration: facts.seconds ?? undefined }, facts.origin);
    if (problem) return { enabled: false, why: problem };
  }
  if (media === "image" && action === "upscale" && facts.width && facts.height) {
    try { topazImageOutput(facts.width, facts.height, 1); }
    catch { return { enabled: false, why: "Upscale: this still is already over the 48-megapixel limit." }; }
  }
  return { enabled: true, why: null };
}

/** The priced actions for a take, offered or not, each enabled or saying why not. A file with no picture or sound has none. */
export function pricedActions(entry: Entry, context: { saved: boolean }): PricedAction[] {
  const kind = entryKind(entry);
  if (kind !== "image" && kind !== "video" && kind !== "audio") return [];
  return MEDIA_ACTIONS[kind].map((id): PricedAction => {
    const engine = nextEngine(kind, id);
    if (!engine || kind === "audio") return { id, label: PRICED_LABEL[id], engine: null, offered: false, enabled: false, why: NOT_OFFERED.audio };
    return { id, label: PRICED_LABEL[id], engine: engine.label, offered: true, ...pricedGate(entry, context.saved, id, kind) };
  });
}

/** One line for the actions no engine here does for this take: "Upscale and Extend are not offered: …". */
export function notOfferedLine(actions: readonly PricedAction[]): string | null {
  const none = actions.filter((a) => !a.offered);
  if (!none.length) return null;
  const names = none.map((a) => a.label);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "is" : "are"} not offered: ${none[0].why ?? "no engine Particl uses does it."}`;
}

/* ── Settings, and the request each one sends ───────────────────────────── */

export type ExtendDirection = "forward" | "backward";
export type NextSettings =
  | { action: "upscale"; media: "image"; topaz: TopazImageSettings }
  | { action: "upscale"; media: "video"; fps: 30 | 60 }
  | { action: "outpaint"; ratio: string; prompt: string }
  | { action: "animate"; prompt: string; ratio: string; resolution: string; duration: number; audio: boolean }
  | { action: "reframe"; ratio: string; prompt: string }
  | { action: "extend"; direction: ExtendDirection; prompt: string; resolution: string; duration: number; audio: boolean };

const ratioValue = (ratio: string | null) => {
  if (!ratio || !RATIO.test(ratio)) return null;
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
};
/** The option closest to a source's shape (by how far apart the two aspects are, either way), or null when its shape is unknown. */
export function nearestRatio(ratio: string | null, options: readonly string[]): string | null {
  const want = ratioValue(ratio);
  if (want == null) return null;
  let best: string | null = null, gap = Infinity;
  for (const option of options) {
    const value = ratioValue(option);
    if (value == null) continue;
    const d = Math.abs(Math.log(value / want));
    if (d < gap) { gap = d; best = option; }
  }
  return best;
}
/** A new shape for a source: tall, unless it is tall already. */
const otherShape = (ratio: string | null, options: readonly string[]) => (nearestRatio(ratio, options) === "9:16" ? "16:9" : "9:16");

/** The aspects each action can make (the engine's own list; a first frame needs a real shape to be priced, so not "adaptive"). */
export function nextRatios(action: "outpaint" | "animate" | "reframe"): string[] {
  const engine = action === "outpaint" ? stillToolModel("outpaint") : action === "animate" ? ANIMATE_ENGINE : video("reframe");
  return (engine?.ratios ?? []).filter((r) => r !== "adaptive");
}
/** The lengths and sizes a Seedance action can render. */
export const nextDurations = (): number[] => ANIMATE_ENGINE?.durations ?? [];
export const nextResolutions = (): string[] => (ANIMATE_ENGINE?.resolutions ?? []).filter((r) => ["480p", "720p", "1080p"].includes(r));

/** Topaz's scales, and which of them this still can take (an upload's own size; a render's is read by the server). */
export function topazScales(facts: SourceFacts): { factor: 1 | 2 | 4; why: string | null }[] {
  return ([1, 2, 4] as const).map((factor) => {
    if (!facts.width || !facts.height) return { factor, why: null };
    try { topazImageOutput(facts.width, facts.height, factor); return { factor, why: null }; }
    catch { return { factor, why: "Over the 48-megapixel limit for this still" }; }
  });
}

/** Where each action starts: the engine's usual settings, shaped to the source where its shape is known. */
export function nextDefaults(action: PricedActionId, entry: Pick<LibraryEntry, "asset">): NextSettings {
  const facts = sourceFacts(entry);
  const media = entry.asset.value.kind;
  switch (action) {
    case "upscale": {
      if (media === "video") return { action, media: "video", fps: 30 };
      const fits = topazScales(facts).filter((s) => !s.why).map((s) => s.factor);
      const factor = fits.includes(DEFAULT_TOPAZ_IMAGE.factor) ? DEFAULT_TOPAZ_IMAGE.factor : (fits[fits.length - 1] ?? 1);
      return { action, media: "image", topaz: { ...DEFAULT_TOPAZ_IMAGE, factor } };
    }
    case "outpaint": return { action, ratio: otherShape(facts.ratio, nextRatios("outpaint")), prompt: "" };
    case "animate": return { action, prompt: "", ratio: nearestRatio(facts.ratio, nextRatios("animate")) ?? "16:9", resolution: "720p", duration: 5, audio: false };
    case "reframe": return { action, ratio: otherShape(facts.ratio, nextRatios("reframe")), prompt: "" };
    case "extend": return { action, direction: "forward", prompt: "", resolution: facts.resolution === "480p" ? "480p" : "720p", duration: 5, audio: true };
  }
}

/** What the settings still need before they can be priced; null when they are complete. */
export function nextProblem(settings: NextSettings): string | null {
  if (settings.action === "animate" && !settings.prompt.trim()) return "Write what moves.";
  if (settings.action === "extend" && !settings.prompt.trim()) return "Write what happens next.";
  return null;
}

/** Extend's words carry the vendor's own trigger (lib/tasks.ts EXTEND_MOVES): it reads the intent from them. */
export function extendPrompt(direction: ExtendDirection, words: string): string {
  const move = EXTEND_MOVES.find((m) => m.id === direction) ?? EXTEND_MOVES[0];
  return move.template.replace("{}", words.trim());
}

export type NextSource = { genId: string } | { uploadId: string };
/** The take as the source: a render by its generation, an upload by its upload — never re-uploaded. */
export const nextSourceOf = (entry: Pick<LibraryEntry, "asset" | "take">): NextSource =>
  entry.asset.origin === "generation" ? { genId: entry.take.sourceId } : { uploadId: entry.take.sourceId };
/** The shot the new take is filed under: its source's, when the source is a take of this production. An upload has none. */
export function nextShotOf(entry: Pick<LibraryEntry, "asset">, productionProjectId: string): string {
  if (entry.asset.origin !== "generation") return "";
  const g = entry.asset.value;
  return g.shotId && g.projectId === productionProjectId ? g.shotId : "";
}

/**
 * The exact request an action sends to POST /api/generate/quote and then to
 * POST /api/generate: the engine, the source by its stored identity, the
 * settings, and where the new take is filed. `reason` is the approved shot's
 * question answered (lib/approval.ts); `maxCredits` and `quoteFingerprint` are
 * the approval of a fresh quote, added only when it is sent.
 */
export function nextActionBody(input: {
  settings: NextSettings; source: NextSource; productionProjectId: string; shotId: string;
  reason?: string; maxCredits?: number; quoteFingerprint?: string;
}): Record<string, unknown> {
  const { settings: s, source } = input;
  const base = { projectId: input.productionProjectId, shotId: input.shotId, refine: false };
  const still = (role: "reference_image" | "first_frame") => [{ ...source, role }];
  const clip = "genId" in source ? { sourceGenId: source.genId } : { sourceUploadId: source.uploadId };
  let body: Record<string, unknown>;
  switch (s.action) {
    case "upscale":
      body = s.media === "image"
        ? { ...base, model: TOPAZ_IMAGE_MODEL, task: "generate", prompt: "", resolution: "24MP", ratio: "adaptive", topaz: s.topaz, references: still("reference_image") }
        : { ...base, model: ASTRA_MODEL, task: "upscale", prompt: "", resolution: "4k", fps60: s.fps === 60, astra: { ...DEFAULT_ASTRA, fps: s.fps }, ...clip, references: [] };
      break;
    case "outpaint":
      body = { ...base, model: stillToolModel("outpaint").id, prompt: s.prompt.trim(), ratio: s.ratio, resolution: "adaptive", references: still("reference_image") };
      break;
    case "animate":
      body = { ...base, model: SEEDANCE_25, task: "generate", prompt: s.prompt.trim(), ratio: s.ratio, resolution: s.resolution, duration: s.duration, generateAudio: s.audio, references: still("first_frame") };
      break;
    case "reframe":
      body = { ...base, model: video("reframe")?.id ?? "", task: "reframe", prompt: s.prompt.trim(), ratio: s.ratio, resolution: "adaptive", ...clip, references: [] };
      break;
    case "extend":
      body = { ...base, model: video("extend")?.id ?? SEEDANCE_25, task: "extend", prompt: extendPrompt(s.direction, s.prompt), ratio: "adaptive", resolution: s.resolution, duration: s.duration, generateAudio: s.audio, ...clip, references: [] };
      break;
  }
  const reason = cleanReason(input.reason);
  return {
    ...body,
    ...(reason ? { reason } : {}),
    ...(input.maxCredits === undefined ? {} : { maxCredits: input.maxCredits }),
    ...(input.quoteFingerprint ? { quoteFingerprint: input.quoteFingerprint } : {}),
  };
}

/* ── Where a take came from ─────────────────────────────────────────────── */

const SOURCE_TASKS = new Set<string>(TASKS.filter((t) => t.locked).map((t) => t.id));
const libraryKey = (ref: Record<string, unknown> | undefined): string | null =>
  typeof ref?.genId === "string" && ref.genId ? `generation:${ref.genId}` : typeof ref?.uploadId === "string" && ref.uploadId ? `upload:${ref.uploadId}` : null;

/**
 * The take a tool made this one from, as the take records it — a still tool's
 * one still, a clip task's source, a clip's first frame — with the tool, or
 * null for a take made from words. `source` is its library id.
 */
export function madeFrom(g: Pick<Generation, "kind" | "model" | "task" | "sourceGenId" | "params">): { source: string; action: string } | null {
  const p = (g.params ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(p.references) ? (p.references as Record<string, unknown>[]) : [];
  const tool = stillToolFor(g.model);
  if (tool) {
    const source = libraryKey(refs[0]);
    return source ? { source, action: (STILL_TOOLS.find((t) => t.id === tool)?.label ?? tool).toLowerCase() } : null;
  }
  const task = typeof p.task === "string" ? p.task : g.task;
  if (task && SOURCE_TASKS.has(task)) {
    const gen = g.sourceGenId ?? (typeof p.sourceGenId === "string" && p.sourceGenId ? p.sourceGenId : null);
    const upload = typeof p.sourceUploadId === "string" && p.sourceUploadId ? p.sourceUploadId : null;
    const source = gen ? `generation:${gen}` : upload ? `upload:${upload}` : null;
    return source ? { source, action: getTask(task).label.toLowerCase() } : null;
  }
  if (g.kind === "video") {
    const source = libraryKey(refs.find((r) => r.role === "first_frame"));
    if (source) return { source, action: "first frame" };
  }
  return null;
}

/* ── Money words ────────────────────────────────────────────────────────── */

/** An estimate, as every Next action shows it: "about 12 cr" (a tenth shown where the credit terms charge in tenths). */
export const aboutCredits = (credits: number) => `about ${credits.toLocaleString("en-US", { maximumFractionDigits: 1 })} cr`;
/** A price that moved between the button and the press: nothing was sent, and the new estimate is asked for again. */
export const repricedNote = (label: string, credits: number) => `The estimate is now ${aboutCredits(credits)}. Press ${label} again to approve it.`;
