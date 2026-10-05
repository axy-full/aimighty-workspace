import type { Asset, Project } from "@/lib/workbench/studio";
import { runningTime, sheetLength } from "../doc/model";

/*
 * Atomik's questions before the looks (design/particl-graphite/README.md § 3.1 b): Format, Cast references, and
 * One direction or variations, each with chips and a field, then "Show me looks · N cr" or "Use your judgement".
 *
 * No agent asks questions today (S2 writes its own), so these are the design's three, built from the project as
 * it is: its aspect and running time, and the cast it already has. "Use your judgement" is free (lead decision
 * 28): it fills the defaults and spends nothing. The answers shape the looks' requests; the aspect is saved on
 * the project, the rest goes into the looks' words. Pure.
 */

export type QuestionId = "format" | "cast" | "direction";
export type Chip = { id: string; label: string };
export type Question = { id: QuestionId; text: string; chips: Chip[]; placeholder: string };
export type Answers = { chips: Partial<Record<QuestionId, string>>; words: Partial<Record<QuestionId, string>> };
export const NO_ANSWERS: Answers = { chips: {}, words: {} };

/** A cast member the looks can take as their reference: a character with a picture. */
export type CastPick = { id: string; name: string; assetId: string };

/** The production's characters that have a picture (their pick, else their reference), first two. */
export function castPicks(project: Project): CastPick[] {
  return (project.production?.cast?.entries ?? [])
    .filter((e) => e.kind === "character")
    .flatMap((e) => {
      const assetId = e.selected ?? e.takes[0]?.genId ?? e.referenceAssetId;
      return assetId && e.name.trim() ? [{ id: e.id, name: e.name.trim(), assetId }] : [];
    })
    .slice(0, 2);
}

export function questionsFor(project: Project): Question[] {
  const length = sheetLength(project.production?.beats);
  const at = length != null ? ` · ${runningTime(length)}` : "";
  return [
    { id: "format", text: "Format", placeholder: "Or say it", chips: [{ id: "16:9", label: `16:9${at}` }, { id: "9:16", label: `9:16${at}` }, { id: "both", label: "Both" }] },
    {
      id: "cast", text: "Cast references", placeholder: "A name, a link or a note",
      chips: [...castPicks(project).map((c) => ({ id: `cast:${c.id}`, label: `Use ${c.name}` })), { id: "upload", label: "I’ll upload" }, { id: "new", label: "Cast someone new" }],
    },
    { id: "direction", text: "One direction, or variations?", placeholder: "Which parts may vary?", chips: [{ id: "one", label: "One direction" }, { id: "two", label: "Two variations" }, { id: "three", label: "Three" }] },
  ];
}

/** "Use your judgement": the project's own aspect, its first cast member with a picture, one direction. Free. */
export function judgement(project: Project): Answers {
  const cast = castPicks(project)[0];
  const format = project.aspect === "9:16" ? "9:16" : project.aspect === "16:9" ? "16:9" : undefined;
  return { chips: { ...(format ? { format } : {}), ...(cast ? { cast: `cast:${cast.id}` } : {}), direction: "one" }, words: {} };
}

/** The aspect the answers set, or null to keep the project's. "Both" keeps 16:9: a project has one aspect today. */
export function aspectOf(answers: Answers): "16:9" | "9:16" | null {
  const chip = answers.chips.format;
  return chip === "16:9" || chip === "both" ? "16:9" : chip === "9:16" ? "9:16" : null;
}

/** The picture the looks take as a reference, from the cast answer; null for none. */
export function castReference(project: Project, answers: Answers): Asset | null {
  const chip = answers.chips.cast;
  if (!chip?.startsWith("cast:")) return null;
  const pick = castPicks(project).find((c) => `cast:${c.id}` === chip);
  if (!pick) return null;
  return [...project.assets, ...(project.sharedAssets ?? [])].find((a) => a.id === pick.assetId) ?? null;
}

/** What the answers add to the looks' words: the direction and anything typed, in plain sentences. */
export function lookWords(answers: Answers): string {
  const direction = answers.chips.direction === "two" ? "Two variations of the direction." : answers.chips.direction === "three" ? "Three variations of the direction." : "";
  const typed = (["format", "cast", "direction"] as const).map((id) => answers.words[id]?.trim()).filter(Boolean);
  return [direction, ...typed].filter(Boolean).join(" ").slice(0, 2000);
}

/** The answers with one chip chosen (choosing it again clears it). */
export function withChip(answers: Answers, id: QuestionId, chip: string): Answers {
  const chips = { ...answers.chips };
  if (chips[id] === chip) delete chips[id];
  else chips[id] = chip;
  return { ...answers, chips };
}

export function withWords(answers: Answers, id: QuestionId, text: string): Answers {
  return { ...answers, words: { ...answers.words, [id]: text.slice(0, 1000) } };
}
