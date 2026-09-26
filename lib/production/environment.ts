import type { BeatSheet } from "./beats";
import { BOARD_MODELS, stillShape, type BoardModel } from "./boards";
import type { GenerationBodyInput, GenerationReference } from "../workbench/generation-request";
import { mediaReferenceIdentity } from "../workbench/media-reference-input";
import type { Asset, Project } from "../workbench/studio";
import { stableId } from "../workbench/stable-id";

/**
 * Production › Environment (owner, 24 September): where the film's world is
 * built, before Cast & Elements. Each place is a card: what it is, the world
 * notes that hold it together (era, weather, light, texture), and its plates.
 * A plate is a render made here or an upload; references for a render can be
 * any picture in the project, made or uploaded. Plates are filed in the
 * library as Environment, so the Rig and Gen use them like any element.
 */
export const ENVIRONMENT_CATEGORY = "Environment";
export const ENVIRONMENT_LIMITS = { entries: 100, name: 120, notes: 4000, prompt: 5000, references: 6, plates: 30, world: 6000 } as const;
/** The still engines Storyboards uses: the same quoted /api/generate path. */
export const ENVIRONMENT_MODELS = BOARD_MODELS;

/** A plate: a project asset — a render made here, one brought from the library, or an upload. */
export type EnvironmentPlate = { assetId: string; at: string; source: "render" | "upload" | "library" };
export type EnvironmentPending = { jobId: string; at: string };
export type EnvironmentEntry = {
  id: string;
  name: string;
  /** What the place is and where it appears. */
  notes: string;
  /** What a plate render is asked for. */
  prompt: string;
  /** Pictures a render follows (asset ids; made or uploaded). */
  references: string[];
  plates: EnvironmentPlate[];
  /** The plate that stands for this place (an asset id). */
  selected?: string;
  pending?: EnvironmentPending[];
};
/** `world`: rules every place shares — the period, the palette, the weather, the light. */
export type Environment = { world: string; model: BoardModel; entries: EnvironmentEntry[]; agentJobId?: string };

export const DEFAULT_ENVIRONMENT: Environment = { world: "", model: "gemini-3.1-flash-image", entries: [] };

const newId = () => `env-${crypto.randomUUID().slice(0, 8)}`;
/** `id`: a place made from a source (an agent run, the beat sheet) takes an id from it, so two windows taking the same source make it once. */
export function newEnvironmentEntry(name = "", notes = "", prompt = "", id = newId()): EnvironmentEntry {
  return { id, name: name.slice(0, ENVIRONMENT_LIMITS.name), notes: notes.slice(0, ENVIRONMENT_LIMITS.notes), prompt: prompt.slice(0, ENVIRONMENT_LIMITS.prompt), references: [], plates: [] };
}
/** The id of the place `name` an agent run (or the beat sheet, `source` "beats") made. */
export const sourcedPlaceId = (source: string, name: string) => stableId("env", source, name.trim().toLowerCase());

/** A plate prompt for a place: the place, then the world it belongs to, no people. */
export function platePrompt(entry: Pick<EnvironmentEntry, "prompt" | "name">, world: string): string {
  const place = entry.prompt.trim() || `${entry.name.trim()}: the place itself, wide, no people.`;
  const rules = world.trim();
  return [place, rules ? `The world of the film: ${rules}` : "", "An environment plate: no people, no text, no captions."].filter(Boolean).join("\n\n").slice(0, 8000);
}

/** The request one plate render sends: the place's prompt in the world, the film's ratio, its references. */
export function plateRequest(project: Project, environment: Environment, entry: EnvironmentEntry, model: { ratios: string[]; resolutions: string[] }): GenerationBodyInput | null {
  if (!project.productionProjectId || !(entry.prompt.trim() || entry.name.trim())) return null;
  const references: GenerationReference[] = [];
  for (const id of entry.references) {
    const asset = project.assets.find((a) => a.id === id);
    const identity = asset && asset.kind === "image" ? mediaReferenceIdentity(asset) : null;
    if (identity) references.push({ ...identity, role: "reference_image" });
  }
  return {
    prompt: platePrompt(entry, environment.world), kind: "image", model: { id: environment.model },
    mapping: { shotId: "", productionProjectId: project.productionProjectId }, ...stillShape(model, project.aspect), duration: 5,
    references, firstFrameAssetId: "",
  };
}

/** The beat sheet's locations, each once, with the scenes it is in — free, no agent. */
export function environmentsFromBeats(sheet: BeatSheet | null | undefined, existing: readonly EnvironmentEntry[] = []): EnvironmentEntry[] {
  const seen = new Set(existing.map((e) => e.name.trim().toLowerCase()));
  const found = new Map<string, { name: string; scenes: number[]; headings: string[] }>();
  (sheet?.scenes ?? []).forEach((scene, i) => {
    for (const raw of scene.locations) {
      const name = raw.trim(), key = name.toLowerCase();
      if (!key || seen.has(key)) continue;
      const entry = found.get(key) ?? { name, scenes: [], headings: [] };
      if (!entry.scenes.includes(i + 1)) { entry.scenes.push(i + 1); if (scene.heading) entry.headings.push(scene.heading); }
      found.set(key, entry);
    }
  });
  const taken = new Set(existing.map((e) => e.id));
  return [...found.values()].filter((f) => !taken.has(sourcedPlaceId("beats", f.name))).slice(0, Math.max(0, ENVIRONMENT_LIMITS.entries - existing.length)).map((f) => newEnvironmentEntry(
    f.name,
    `Scene${f.scenes.length > 1 ? "s" : ""} ${f.scenes.join(", ")}${f.headings.length ? ` · ${f.headings.slice(0, 3).join(" · ")}` : ""}`,
    `${f.name}: the place itself, wide, in the film's light, no people.`,
    sourcedPlaceId("beats", f.name),
  ));
}

/** A plate filed in the project library as Environment. */
export function plateAsset(entry: EnvironmentEntry, base: Pick<Asset, "id" | "url"> & Partial<Asset>, version: number): Asset {
  return {
    kind: "image", category: ENVIRONMENT_CATEGORY, name: entry.name.trim() || ENVIRONMENT_CATEGORY, description: entry.notes.slice(0, 500), prompt: entry.prompt,
    status: "Draft", locked: false, version, refs: [], ...base,
  };
}
