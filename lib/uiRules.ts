import { suggestEngine, ENGINE_MODEL } from "./shotBuilder";

/**
 * Two platform rules that live in the interface (brief 2.5).
 *
 * The first is the engine rule, surfaced where the choice is made: when a
 * prompt names water, cloth, hair, smoke or physics and the engine in hand
 * is not Kling, the composer suggests the switch in one tap. The second is
 * the plateau: relative edits on a still — "make him smaller", "a notch
 * warmer" — stop landing after a couple of passes, so after two the
 * composer offers a fresh render with the full final look written out,
 * rather than a third edit. Pure; the composer reads both.
 */
export type Suggestion = { modelId: string; label: string; why: string };

export function engineSuggestion(o: { prompt: string; kind: "video" | "image"; family: string | null | undefined; task: string | null }): Suggestion | null {
  if (o.kind !== "video" || (o.task && o.task !== "generate")) return null;
  const s = suggestEngine(o.prompt);
  if (s.engine !== "kling" || (o.family ?? "").startsWith("kling")) return null;
  const word = s.why.split(":")[0];
  return { modelId: ENGINE_MODEL.kling, label: `Kling for ${word} — switch`, why: s.why };
}

export type Lineage = { id: string; kind?: string; prompt?: string; params?: Record<string, unknown> };

/** The still a still was edited from, when it was made from exactly one earlier still. */
export function parentOf(row: Lineage, rows: Lineage[]): Lineage | null {
  const refs = (row.params?.references as { genId?: string; kind?: string }[] | undefined) ?? [];
  const gens = refs.filter((r) => r.genId);
  if (gens.length !== 1) return null;
  const parent = rows.find((r) => r.id === gens[0].genId);
  return parent && (parent.kind ?? "image") === "image" ? parent : null;
}

/** The chain of stills this one was edited from, oldest first, this one last. */
export function lineageOf(row: Lineage, rows: Lineage[], max = 8): Lineage[] {
  const chain: Lineage[] = [row]; const seen = new Set([row.id]);
  let cur: Lineage | null = row;
  while (chain.length < max && (cur = parentOf(cur, rows)) && !seen.has(cur.id)) { seen.add(cur.id); chain.unshift(cur); }
  return chain;
}

/** How many edit passes a still is already: the stills behind it. */
export const editDepth = (row: Lineage, rows: Lineage[]): number => lineageOf(row, rows).length - 1;

export const PLATEAU_AFTER = 2;

/** What a person actually typed for a take: the compiled prompt carries the rule library's own lines, which must not be repeated back. */
export function typedWords(r: Lineage): string {
  const raw = r.params?.rawPrompt as string | undefined;
  if (raw) return raw.trim();
  /* A take made before the raw prompt was recorded keeps only the compiled
     text, whose appended rule lines follow a blank line: take what came
     first, which is what the person wrote. */
  return String(r.prompt ?? "").split(/\n\s*\n/)[0].trim();
}

/** The full final look, written out: the first still's description with every edit since, in order. */
export function freshPrompt(chain: Lineage[]): string {
  const words = chain.map(typedWords).filter(Boolean);
  if (!words.length) return "";
  const [root, ...edits] = words;
  return edits.length ? `${root.replace(/[.\s]+$/, "")}. Then: ${edits.join("; ")}.` : root;
}
