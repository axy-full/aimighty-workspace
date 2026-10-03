import type { BeatSheet } from "./beats";
import { stableId } from "../workbench/stable-id";

/**
 * Production › Cast & Elements (owner's brief, 23 September): the film's
 * characters and elements, saved in the library as Cast or Elements. A
 * character's identity is built in this workspace (Cast › Build identity).
 * The stills engines Cast used to render with are no longer offered (D0.2):
 * every field an earlier build saved is still read here — `soulId`,
 * `elementId`, `model`, the render settings — so a saved draft parses and its
 * stills stay in the Library; nothing new is written to them.
 */
export type CastKind = "character" | "element";
/** The earlier account's stills models an entry may name (`model`). Ids are stored; the labels are what a person reads. */
export const SOUL_MODELS = [
  { id: "soul_cinematic", label: "Identity still · Cinema", line: "Cinema-grade stills of a person or a thing." },
  { id: "soul_2", label: "Identity still · 2", line: "Realistic, editorial stills." },
  { id: "soul_location", label: "Location still", line: "Places and scenes, no people." },
  { id: "soul_cast", label: "Persona still", line: "A new persona from words alone." },
] as const;
export type SoulModelId = (typeof SOUL_MODELS)[number]["id"];
export type ElementCategory = "character" | "environment" | "prop";
export type CastTake = { genId: string; at: string };
export type CastEntry = {
  id: string; name: string; kind: CastKind; description: string; prompt: string;
  /** An identity trained on the earlier account (read only; kept so the draft parses). */
  soulId?: string;
  /** An uploaded reference image (a project asset). */
  referenceAssetId?: string;
  takes: CastTake[]; selected?: string;
  /** The connected job in flight, so a reload keeps following it. */
  job?: { id: string; status: "quoted" | "submitted" };
  /** The earlier stills model that built it (SOUL_MODELS, or another id an older project saved), its quality and budget. Read only. */
  model?: string; quality?: "1.5k" | "2k"; budget?: number;
  /** What sort of element it is — and the reference element the earlier account kept for it (read only; not shown). */
  category?: ElementCategory; elementId?: string;
  /** The character's identity in this workspace. */
  identityId?: string;
  /** An earlier render's settings: likeness strength, stills per request, size. Read only. */
  soulStrength?: number; soulBatch?: 1 | 4; soulResolution?: "720p" | "1080p";
  /** Its renders in flight, so a reload keeps following them. */
  pending?: CastRender[];
};
export type CastRender = { jobId: string; at: string; batch: 1 | 4 };
export type Cast = { entries: CastEntry[]; agentJobId?: string };
/** A character renders as a 3:4 character sheet. */
export const CAST_RENDER_RATIO = "3:4";

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
/** The earlier models whose entries stay editable (`soul_2`, `soul_cinematic`): a character or a prop, like any other. */
const KEY_FAMILY: Readonly<Record<string, true>> = { soul_2: true, soul_cinematic: true };
/**
 * An entry built earlier with a stills model that made something Cast no
 * longer does (a place, a persona from words): what it was, for a read-only
 * card (its stills stay in the Library), else null. An entry never built is
 * not old: it stays editable whatever model it names.
 */
export function retiredModelOf(entry: Pick<CastEntry, "model" | "takes" | "job" | "elementId">): string | null {
  const model = entry.model;
  if (!model || KEY_FAMILY[model]) return null;
  if (!entry.takes.length && !entry.job && !entry.elementId) return null;
  return SOUL_MODELS.find((m) => m.id === model)?.label ?? "an earlier engine";
}
/** An identity trained on the earlier account, with none built here since: the character needs its identity built again. */
export const accountSoulIdOf = (entry: Pick<CastEntry, "kind" | "soulId" | "identityId">): string | null =>
  entry.kind === "character" && entry.soulId && !entry.identityId ? entry.soulId : null;
/** An entry's category: what it says, else a character for the cast and a prop otherwise. */
export const entryCategory = (e: Pick<CastEntry, "kind" | "category">): ElementCategory => e.category ?? (e.kind === "character" ? "character" : "prop");
/** The earlier stills model an entry names, or the one its kind used to default to (read by older tooling and its tests). */
export const entryModel = (e: Pick<CastEntry, "kind" | "category" | "model">): string => e.model ?? (entryCategory(e) === "environment" ? "soul_location" : "soul_cinematic");

type ModelShape = { parameters: { name: string; options?: (string | number)[]; default?: unknown; min?: number; max?: number }[]; aspectRatios: string[]; medias: unknown[] };
/** Only the settings the earlier account's model declared: quality, identity, budget, and the ratio it offered. */
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

/** One entry of the agent's proposed cast list. */
export type CastProposal = { kind: CastKind; name: string; description: string; prompt: string; model?: SoulModelId; category?: ElementCategory };

/**
 * The agent's cast list, taken once: names not yet listed are added (each
 * once, however often the agent repeats it), names already here are kept as
 * they are, and what does not fit under the list's limit is left out. The
 * counts are what the confirmation says — what was added, not what was
 * proposed. Each entry takes an id from this run and its name
 * (sourcedCastId): another tab taking the same run makes the same entries,
 * which the merge of the two saves holds once, and an entry already here
 * under that id (renamed since) counts as listed.
 */
export function mergeAgentCast(cast: Cast, proposals: readonly CastProposal[], jobId: string): { cast: Cast; added: number; known: number; overLimit: number } {
  const listed = new Set(cast.entries.map((e) => e.name.trim().toLowerCase()));
  const ids = new Set(cast.entries.map((e) => e.id));
  const seen = new Set<string>();
  const room = Math.max(0, CAST_LIMITS.entries - cast.entries.length);
  const fresh: CastEntry[] = [];
  let known = 0, overLimit = 0;
  for (const p of proposals) {
    const key = p.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entryId = sourcedCastId(jobId, p.name);
    if (listed.has(key) || ids.has(entryId)) { known++; continue; }
    if (fresh.length >= room) { overLimit++; continue; }
    fresh.push(newEntry(p.kind, p.name, p.description, p.prompt, { model: p.model, category: p.category }, entryId));
  }
  return { cast: { ...cast, entries: [...cast.entries, ...fresh], agentJobId: jobId }, added: fresh.length, known, overLimit };
}
