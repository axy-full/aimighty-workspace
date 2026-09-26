import type { LibraryEntry } from "@/lib/workspace/library";
import type { CtxCapabilities, CtxCommand } from "./context-menu";

/**
 * Assets on every page (FINAL_SPEC §1 step 1, README › Interactions). Pure:
 * what each right-click command means for a given asset, what it is called,
 * why it cannot run, and what the toasts say — the prototype's words.
 *
 * An asset is one of two things, and the two are not symmetrical:
 * - an UPLOAD is a workspace original *filed* into this project. Deleting it
 *   from a project unfiles it; the original stays in the workspace's All
 *   assets. Pasting it into another project files it there too.
 * - a GENERATION belongs to one project. Deleting it trashes it
 *   (`/api/jobs/:id` PATCH `{ trashed }`): hidden, never erased, restorable
 *   from the undo stack. It can be moved, never copied — a copy would be a new render.
 */
export type AssetRef = {
  id: string; sourceId: string; origin: "upload" | "generation"; name: string; media: "image" | "video" | "audio" | null;
  /** Why Gen cannot make this generation again from its own inputs; null when it can. */
  retryBlock?: string | null;
};

export function assetRef(entry: LibraryEntry): AssetRef {
  return {
    id: entry.take.id, sourceId: entry.take.sourceId, origin: entry.asset.origin, name: entry.take.name, media: entry.media,
    ...(entry.asset.origin === "generation" ? { retryBlock: retryBlock(entry.asset.value) } : {}),
  };
}

/** The reference role a dropped or `+`-ed asset takes in the Gen composer (per-model roles arrive in step 4). */
export function referenceRole(media: AssetRef["media"]): "Image" | "Video" | null {
  return media === "image" ? "Image" : media === "video" ? "Video" : null;
}

/** What the commands are called for an asset — the prototype's labels. */
export const ASSET_LABEL: Partial<Record<CtxCommand, string>> = { retry: "Retry generation" };

/**
 * Which commands this build carries out for an asset, and why the others
 * are blocked. Copy is always possible (it fills the clipboard); Paste needs
 * something copied and a project to paste into.
 */
export function assetCapabilities(input: {
  asset: AssetRef | null;
  clip: { mode: "copy" | "cut"; asset: AssetRef } | null;
  projectId: string | null;
  otherProjects: number;
  canUndo: boolean;
}): CtxCapabilities {
  const { asset, clip, projectId } = input;
  const can: CtxCapabilities["can"] = { copy: true, cut: true, "open-in-inspector": true, delete: true };
  const why: CtxCapabilities["why"] = {};
  if (asset) {
    if (asset.media === "image" || asset.media === "video") can["use-as-reference"] = true;
    else why["use-as-reference"] = "References are images and videos.";
    if (asset.origin === "generation" && !asset.retryBlock) can.retry = true;
    else why.retry = asset.retryBlock ?? "An upload was not generated; there is nothing to retry.";
    if (input.otherProjects > 0) can.move = true;
    else why.move = "This workspace has no other project to move it to.";
    why.duplicate = asset.origin === "generation"
      ? "A generation has one copy. Use Retry generation for a new take with the same inputs."
      : "An original has one copy. Copy it and paste it into another project to file it there too.";
  }
  if (clip && projectId) {
    if (clip.mode === "cut" || clip.asset.origin === "upload") can.paste = true;
    else why.paste = "A generation belongs to one project: cut it to move it, or Retry generation here.";
  } else if (clip) why.paste = "Open a project to paste into.";
  return { can, why, hasClipboard: Boolean(clip), canUndo: input.canUndo };
}

/** The toasts, in the prototype's words. */
export const SAY = {
  copied: (name: string) => `${name} copied`,
  cut: (name: string) => `Cut ${name} — paste to move it.`,
  pasted: (name: string, project: string) => `Pasted ${name} into ${project}`,
  moved: (name: string, project: string) => `Moved ${name} to ${project}`,
  deleted: (asset: AssetRef) => asset.origin === "generation"
    ? `Deleted ${asset.name} · ⌘Z to undo. The original stays on the server indefinitely.`
    : `Deleted ${asset.name} from this project · ⌘Z to undo. The original stays in All assets.`,
  restored: (name: string) => `${name} restored`,
  referenced: (name: string, role: string) => `${name} added as ${role}`,
  retry: (name: string) => `Retry ${name} — same inputs, new seed. Quoted before it runs.`,
  filed: (name: string, shot: string) => `${name} filed on ${shot}`,
};

/** A reference as Gen's composer takes it: the Library id (`generation:…` / `upload:…`) and, on the connected account, its role. */
export type GenPresetReference = { id: string; role?: string };
/** What Retry hands to Gen: the render's own inputs, priced again before anything runs. */
export type GenPreset = {
  prompt: string; model?: string; type?: "image" | "video" | "audio"; note?: string;
  /** Which wallet made it: a connected-account render is retried on the connected account, with its own model. */
  billing?: "workspace" | "connected";
  picks?: { ratio?: string; resolution?: string; duration?: number };
  references?: GenPresetReference[];
  /** Sound only: length, instrumental, voice. */
  sound?: { seconds?: number; instrumental?: boolean; voiceId?: string };
};
type RetrySource = { prompt: string; model: string; kind: string; params?: Record<string, unknown>; title?: string | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
/** Marketing Studio renders carry Business setup (products, avatars, styles) that Gen's composer has no place for. */
const BUSINESS_MODELS = new Set(["marketing_studio_video", "marketing_studio_image", "ms_image", "marketing_studio_v2"]);
/** A render the connected account made through the generation route (lib/higgsfield-consumer/original-identity). */
const connectedGeneration = (p: Record<string, unknown>) => p.task === "connected-generation" && p.consumerCreditUnit === "higgsfield_credits";

/**
 * The tasks that work on a source clip (lib/tasks.ts TaskId, lib/dubbing.ts,
 * the audio route's voiceChange). Every other task — generate, a connected
 * generation, speech, sound, music — is a plain generation Gen composes.
 */
const SOURCE_TASKS = new Set(["edit", "extend", "motion", "upscale", "reframe", "genjutsu", "dub", "voiceChange"]);

/**
 * Why Gen cannot make this take again from its own inputs, or null when it
 * can. Gen composes plain generations; a take made from a source clip (an
 * edit, an extend, a dub), by a connected tool or as a dialogue is run again
 * where it was made, not re-imagined here as something else.
 */
export function retryBlock(generation: RetrySource): string | null {
  const p = generation.params ?? {};
  if (generation.kind !== "image" && generation.kind !== "video" && generation.kind !== "audio") return "Gen makes pictures, videos and sound; this take is neither.";
  if (p.task === "dialogue" || Array.isArray(p.lines)) return "A dialogue is made in Edit & Sound, not Gen.";
  if (p.sourceGenId || p.sourceUploadId || (typeof p.task === "string" && SOURCE_TASKS.has(p.task)))
    return "This take was made from a source clip. Run that tool again from Takes.";
  if (connectedGeneration(p) && p.workflow) return "This take came from a connected tool, not Gen. Run that tool again.";
  if (BUSINESS_MODELS.has(generation.model)) return "This ad was made in Business, with its product and setup. Make it again from Ads.";
  return null;
}

export function retryPreset(generation: RetrySource): GenPreset {
  const p = generation.params ?? {};
  const raw = typeof p.rawPrompt === "string" ? p.rawPrompt : "";
  const type = generation.kind === "image" || generation.kind === "video" || generation.kind === "audio" ? generation.kind : undefined;
  const connected = connectedGeneration(p);
  const settings = connected && record(p.settings) ? p.settings : {};
  const picks = {
    ratio: text(p.ratio) ?? text(settings.aspect_ratio),
    resolution: text(p.resolution) ?? text(settings.resolution),
    duration: number(p.duration) ?? number(settings.duration),
  };
  const references = (Array.isArray(p.references) ? p.references : []).flatMap((ref): GenPresetReference[] => {
    if (!record(ref)) return [];
    const id = typeof ref.genId === "string" ? `generation:${ref.genId}` : typeof ref.uploadId === "string" ? `upload:${ref.uploadId}` : null;
    /* A workspace engine places references itself; only a connected model is told each one's role. */
    return id ? [{ id, ...(connected && typeof ref.role === "string" ? { role: ref.role } : {}) }] : [];
  });
  const lengthMs = number(p.lengthMs);
  const sound = type === "audio"
    ? { seconds: number(p.durationSeconds) ?? (lengthMs ? Math.round(lengthMs / 1000) : undefined), instrumental: typeof p.instrumental === "boolean" ? p.instrumental : undefined, voiceId: text(p.voiceId) }
    : undefined;
  return {
    prompt: raw || generation.prompt, model: generation.model, type,
    billing: connected ? "connected" : "workspace",
    ...(Object.values(picks).some((v) => v !== undefined) ? { picks: Object.fromEntries(Object.entries(picks).filter(([, v]) => v !== undefined)) as GenPreset["picks"] } : {}),
    ...(references.length ? { references } : {}),
    ...(sound && Object.values(sound).some((v) => v !== undefined) ? { sound: Object.fromEntries(Object.entries(sound).filter(([, v]) => v !== undefined)) as GenPreset["sound"] } : {}),
    note: `Retry · ${generation.title || generation.prompt.slice(0, 40)} · same inputs · new seed`,
  };
}
export const GEN_PRESET_KEY = "particl-gen-preset";
export function readGenPreset(raw: string | null): GenPreset | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GenPreset;
    return parsed && typeof parsed === "object" && typeof parsed.prompt === "string" ? parsed : { prompt: raw };
  } catch { return { prompt: raw }; }
}
