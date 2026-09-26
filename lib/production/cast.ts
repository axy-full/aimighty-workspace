import type { BeatSheet } from "./beats";
import { stableId } from "../workbench/stable-id";

/**
 * Production › Cast & Elements (owner's brief, 23 September): the film's
 * characters and elements, each built with Soul Cinema on the connected
 * account and saved in the library as Cast or Elements.
 */
export type CastKind = "character" | "element";
/** Soul Studio's models on the connected account: cinema stills, Soul 2, scenes without people, and personas from text. */
export const SOUL_MODELS = [
  { id: "soul_cinematic", label: "Soul Cinema", line: "Cinema-grade stills of a person or a thing." },
  { id: "soul_2", label: "Soul 2", line: "Realistic, editorial stills." },
  { id: "soul_location", label: "Soul Location", line: "Places and scenes, no people." },
  { id: "soul_cast", label: "Soul Cast", line: "A new persona from words alone." },
] as const;
export type SoulModelId = (typeof SOUL_MODELS)[number]["id"];
export type ElementCategory = "character" | "environment" | "prop";
export type CastTake = { genId: string; at: string };
export type CastEntry = {
  id: string; name: string; kind: CastKind; description: string; prompt: string;
  /** A Particl-built Soul ID the character renders with. */
  soulId?: string;
  /** An uploaded reference image (a project asset). */
  referenceAssetId?: string;
  takes: CastTake[]; selected?: string;
  /** The connected job in flight, so a reload keeps following it. */
  job?: { id: string; status: "quoted" | "submitted" };
  /** Which Soul model builds it (by kind when unset), its quality, and Soul Cast's budget. */
  model?: SoulModelId; quality?: "1.5k" | "2k"; budget?: number;
  /** What sort of element it is — and the reference element the account keeps for it, once saved. */
  category?: ElementCategory; elementId?: string;
};
export type Cast = { entries: CastEntry[]; agentJobId?: string };

export const CAST_LIMITS = { entries: 100, name: 120, description: 2000, prompt: 5000, takes: 20 } as const;
export const SOUL_CINEMA = "soul_cinematic";
export const CAST_CATEGORY: Record<CastKind, string> = { character: "Character", element: "Element" };

const id = () => `cast-${crypto.randomUUID().slice(0, 8)}`;
/** `entryId`: an entry made from a source (an agent run, the beat sheet) takes an id from it, so two windows taking the same source make it once. */
export function newEntry(kind: CastKind, name = "", description = "", prompt = "", extra: Partial<Pick<CastEntry, "model" | "category">> = {}, entryId = id()): CastEntry {
  return { id: entryId, name: name.slice(0, CAST_LIMITS.name), kind, description: description.slice(0, CAST_LIMITS.description), prompt: prompt.slice(0, CAST_LIMITS.prompt), takes: [], ...extra };
}
/** The id of the entry `name` an agent run (or the beat sheet, `source` "beats") made. */
export const sourcedCastId = (source: string, name: string) => stableId("cast", source, name.trim().toLowerCase());
/** An entry's category: what it says, else a character for the cast and a prop otherwise. */
export const entryCategory = (e: Pick<CastEntry, "kind" | "category">): ElementCategory => e.category ?? (e.kind === "character" ? "character" : "prop");
/** An entry's Soul model: what it says, else Soul Location for a place, Soul Cinema for everything else. */
export const entryModel = (e: Pick<CastEntry, "kind" | "category" | "model">): SoulModelId => e.model ?? (entryCategory(e) === "environment" ? "soul_location" : "soul_cinematic");

type ModelShape = { parameters: { name: string; options?: (string | number)[]; default?: unknown; min?: number; max?: number }[]; aspectRatios: string[]; medias: unknown[] };
/** Only the settings the account's model declares: quality, Soul ID, Soul Cast's budget, and the ratio it offers. */
export function soulParameters(model: ModelShape, entry: CastEntry, ratio: string): Record<string, string | number> {
  const declared = new Map(model.parameters.map((p) => [p.name, p]));
  const out: Record<string, string | number> = {};
  const quality = declared.get("quality");
  if (quality) { const want = entry.quality ?? (typeof quality.default === "string" ? quality.default : "2k"); if (!quality.options || quality.options.includes(want)) out.quality = want; }
  if (declared.has("soul_id") && entry.kind === "character" && entry.soulId) out.soul_id = entry.soulId;
  const budget = declared.get("budget");
  if (budget) out.budget = Math.min(budget.max ?? 500, Math.max(budget.min ?? 10, Math.round(entry.budget ?? (typeof budget.default === "number" ? budget.default : 50))));
  if (model.aspectRatios.length) out.aspect_ratio = model.aspectRatios.includes(ratio) ? ratio : model.aspectRatios[0];
  return out;
}

/** The beat sheet's characters and props, each once, with the scenes it appears in — free, no agent.
 *  Locations are built in the Environment stage (owner, 24 September). */
export function castFromBeats(sheet: BeatSheet | null | undefined, existing: readonly CastEntry[] = []): CastEntry[] {
  const seen = new Set(existing.map((e) => e.name.trim().toLowerCase()));
  const found = new Map<string, { kind: CastKind; scenes: number[]; label: string }>();
  (sheet?.scenes ?? []).forEach((scene, i) => {
    const add = (name: string, kind: CastKind, label: string) => {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      const entry = found.get(key) ?? { kind, scenes: [], label };
      if (!entry.scenes.includes(i + 1)) entry.scenes.push(i + 1);
      found.set(key, entry);
    };
    scene.characters.forEach((n) => add(n, "character", "Character"));
    scene.props.forEach((n) => add(n, "element", "Prop"));
  });
  const names = new Map<string, string>();
  (sheet?.scenes ?? []).forEach((s) => [...s.characters, ...s.locations, ...s.props].forEach((n) => names.set(n.trim().toLowerCase(), n.trim())));
  const taken = new Set(existing.map((e) => e.id));
  return [...found.entries()].filter(([key]) => !taken.has(sourcedCastId("beats", key))).slice(0, CAST_LIMITS.entries - existing.length).map(([key, f]) => {
    const name = names.get(key) ?? key;
    const where = `${f.label} · scene${f.scenes.length > 1 ? "s" : ""} ${f.scenes.join(", ")}`;
    const prompt = f.kind === "character"
      ? `Character reference of ${name}: full body and three-quarter views on a neutral grey background, even soft light, consistent face, hair and wardrobe.`
      : f.label === "Prop" ? `Prop reference of ${name}: a clean, well-lit plate that shows its shape, material and scale.` : `${name}: the place itself, wide, in the film's light, no people.`;
    return newEntry(f.kind, name, where, prompt, { category: f.kind === "character" ? "character" : f.label === "Location" ? "environment" : "prop" }, sourcedCastId("beats", key));
  });
}
