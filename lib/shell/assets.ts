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
      ? "A generation has one copy. Use Retry generation for a new take from its prompt and model."
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

  filed: (name: string, shot: string) => `${name} filed on ${shot}`,
};

/**
 * What Retry hands to Gen: the render's own prompt (as typed, before any
 * enhancement), its model and its kind — no references or other settings,
 * so the note says exactly that. Priced again before anything runs.
 */
export type GenPreset = { prompt: string; model?: string; type?: "image" | "video" | "audio"; note?: string };
export function retryPreset(generation: { prompt: string; model: string; kind: string; params?: Record<string, unknown>; title?: string | null }): GenPreset {
  const raw = typeof generation.params?.rawPrompt === "string" ? generation.params.rawPrompt : "";
  const type = generation.kind === "image" || generation.kind === "video" || generation.kind === "audio" ? generation.kind : undefined;
  return { prompt: raw || generation.prompt, model: generation.model, type, note: `Retry · ${generation.title || generation.prompt.slice(0, 40)} · same prompt and model` };
}
export const GEN_PRESET_KEY = "particl-gen-preset";
export function readGenPreset(raw: string | null): GenPreset | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GenPreset;
    return parsed && typeof parsed === "object" && typeof parsed.prompt === "string" ? parsed : { prompt: raw };
  } catch { return { prompt: raw }; }
}
