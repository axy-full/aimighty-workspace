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
export type AssetRef = { id: string; sourceId: string; origin: "upload" | "generation"; name: string; media: "image" | "video" | "audio" | null };

export function assetRef(entry: LibraryEntry): AssetRef {
  return { id: entry.take.id, sourceId: entry.take.sourceId, origin: entry.asset.origin, name: entry.take.name, media: entry.media };
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
  const why: CtxCapabilities["why"] = { bypass: "Open Rig to bypass a node.", unplug: "Open Rig to unplug a node." };
  if (asset) {
    if (asset.media === "image" || asset.media === "video") can["use-as-reference"] = true;
    else why["use-as-reference"] = "References are images and videos.";
    if (asset.origin === "generation") can.retry = true;
    else why.retry = "An upload was not generated; there is nothing to retry.";
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
  retry: (name: string, kept: RetryScope = "same inputs") => `Retry ${name} — ${kept}, new seed. Quoted before it runs.`,
  filed: (name: string, shot: string) => `${name} filed on ${shot}`,
};

/**
 * What Gen is handed from elsewhere in the shell (lib/shell/gen-preset): a
 * Retry carries the render's own inputs — its prompt, engine, catalogue,
 * settings, identity and references — priced again before anything runs;
 * Soul ID's Use in Gen carries the identity; Crew's Open in Gen only the
 * words.
 */
export type GenPresetReference = { genId: string; role?: string } | { uploadId: string; role?: string };
export type GenPreset = {
  prompt: string; model?: string; type?: "image" | "video" | "audio"; note?: string;
  /** Which catalogue the model is on; the composer switches to it before it picks the model. */
  billing?: "workspace" | "connected";
  /** A Soul model's trained identity (`soul_id`). */
  soulId?: string;
  /** Present on a Retry: the inputs replace whatever the composer held. */
  references?: GenPresetReference[];
  /** A Retry's ratio, resolution and length; the composer keeps only what the model offers. */
  picks?: { ratio?: string; resolution?: string; duration?: number };
};
/** How much of a render a Retry in Gen can bring back — said on the toast and on Gen's note. */
export type RetryScope = "same inputs" | "same inputs, frames as references" | "prompt only";
const REFERENCES_MAX = 10;
function presetReferences(value: unknown): GenPresetReference[] {
  if (!Array.isArray(value)) return [];
  const out: GenPresetReference[] = [];
  for (const item of value) {
    if (out.length >= REFERENCES_MAX) break;
    if (!item || typeof item !== "object") continue;
    const { genId, uploadId, role } = item as Record<string, unknown>;
    const named = typeof role === "string" && role ? { role } : {};
    if (typeof genId === "string" && genId) out.push({ genId, ...named });
    else if (typeof uploadId === "string" && uploadId) out.push({ uploadId, ...named });
  }
  return out;
}
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
function storedPicks(stored: Record<string, unknown>, ratioKey: "ratio" | "aspect_ratio"): GenPreset["picks"] {
  const ratio = stored[ratioKey], resolution = stored.resolution, duration = Number(stored.duration);
  const picks = {
    ...(typeof ratio === "string" && ratio ? { ratio } : {}),
    ...(typeof resolution === "string" && resolution ? { resolution } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
  };
  return Object.keys(picks).length ? picks : undefined;
}
export function retryPreset(generation: { prompt: string; model: string; kind: string; params?: Record<string, unknown>; title?: string | null; task?: string | null }): GenPreset & { kept: RetryScope } {
  const params = generation.params ?? {};
  const raw = typeof params.rawPrompt === "string" ? params.rawPrompt : "";
  const prompt = raw || generation.prompt;
  const type = generation.kind === "image" || generation.kind === "video" || generation.kind === "audio" ? generation.kind : undefined;
  const title = generation.title || generation.prompt.slice(0, 40);
  /* A catalogue render (lib/higgsfield-consumer/original-identity) keeps its settings, identity and media under params. */
  const connected = params.task === "connected-generation" && (params.workflow === undefined || params.workflow === "generation");
  const task = params.task ?? generation.task ?? undefined;
  const workspace = !connected && (task === undefined || task === "generate");
  /* Made by another tool (an edit, extend or upscale of a clip, an Ads template, a voice tool, Shorts,
     Viral): Gen takes its words and clears the well, and says it could not bring back the rest. */
  if (!connected && !workspace) return { prompt, type, references: [], kept: "prompt only", note: `Retry · ${title} · prompt only` };
  const settings = connected ? record(params.settings) : params;
  const soulId = connected && typeof settings.soul_id === "string" && settings.soul_id ? settings.soul_id : undefined;
  const references = presetReferences(params.references);
  const picks = storedPicks(settings, connected ? "aspect_ratio" : "ratio");
  /* This workspace's composer sets a reference's role from its kind, so a first or last frame comes back as a plain reference. */
  const kept: RetryScope = !connected && references.some((r) => r.role === "first_frame" || r.role === "last_frame") ? "same inputs, frames as references" : "same inputs";
  return {
    prompt, model: generation.model, type, billing: connected ? "connected" : "workspace",
    ...(soulId ? { soulId } : {}), references, ...(picks ? { picks } : {}), kept,
    note: `Retry · ${title} · ${kept} · new seed`,
  };
}
