import type { BeatSheet } from "./beats";

/**
 * Production › Cast & Elements (owner's brief, 23 September): the film's
 * characters and elements, each built with Soul Cinema on the connected
 * account and saved in the library as Cast or Elements.
 */
export type CastKind = "character" | "element";
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
};
export type Cast = { entries: CastEntry[]; agentJobId?: string };

export const CAST_LIMITS = { entries: 100, name: 120, description: 2000, prompt: 5000, takes: 20 } as const;
export const SOUL_CINEMA = "soul_cinematic";
export const CAST_CATEGORY: Record<CastKind, string> = { character: "Character", element: "Element" };

const id = () => `cast-${crypto.randomUUID().slice(0, 8)}`;
export function newEntry(kind: CastKind, name = "", description = "", prompt = ""): CastEntry {
  return { id: id(), name: name.slice(0, CAST_LIMITS.name), kind, description: description.slice(0, CAST_LIMITS.description), prompt: prompt.slice(0, CAST_LIMITS.prompt), takes: [] };
}

/** The beat sheet's characters, locations and props, each once, with the scenes it appears in — free, no agent. */
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
    scene.locations.forEach((n) => add(n, "element", "Location"));
    scene.props.forEach((n) => add(n, "element", "Prop"));
  });
  const names = new Map<string, string>();
  (sheet?.scenes ?? []).forEach((s) => [...s.characters, ...s.locations, ...s.props].forEach((n) => names.set(n.trim().toLowerCase(), n.trim())));
  return [...found.entries()].slice(0, CAST_LIMITS.entries - existing.length).map(([key, f]) => {
    const name = names.get(key) ?? key;
    const where = `${f.label} · scene${f.scenes.length > 1 ? "s" : ""} ${f.scenes.join(", ")}`;
    const prompt = f.kind === "character"
      ? `Character reference of ${name}: full body and three-quarter views on a neutral grey background, even soft light, consistent face, hair and wardrobe.`
      : `${f.label === "Prop" ? "Prop" : "Environment"} reference of ${name}: a clean, well-lit plate that shows its shape, material and scale, no people.`;
    return newEntry(f.kind, name, where, prompt);
  });
}
