/**
 * The Cast step of a Film board in the new interface (design/particl-prototype-25 step "cast"; demo plan PR 14 + 15): AI-made characters,
 * each a card with its portrait, look, wardrobe, a character sheet of eight angles, and a voice. Owner, 16 Oct: AI-made characters only, no
 * consent record on this path. Pure: no React, no fetch (tests/unit/v12-cast-step.spec.ts).
 *
 * The data is the draft's own cast list (`production.cast.entries`, lib/production/cast.ts) read through today's Cast region
 * (components/graphite/board/cards/cast/cast-model.ts), so a character the canvas already draws is drawn once, and an old board's cast shows
 * as it did. Nothing is invented; what the step adds to an entry (look, wardrobe, sheet, voice) is optional draft JSON.
 */
import { deriveCast } from "@/components/graphite/board/cards/cast/cast-model";
import type { CardStatus } from "@/components/v12/board/card-model";
import { CAST_LIMITS, newEntry, type CastEntry } from "@/lib/production/cast";
import { statusOf, type Marks } from "@/lib/v12/board/text-steps";
import type { Project } from "@/lib/workbench/studio";

/** The eight angles of a character sheet, in the prototype's order. */
export const ANGLES = [
  { id: "front", label: "Front" }, { id: "three-quarter-left", label: "¾ left" }, { id: "profile-left", label: "Profile left" }, { id: "back", label: "Back" },
  { id: "three-quarter-right", label: "¾ right" }, { id: "profile-right", label: "Profile right" }, { id: "close-up", label: "Close-up" }, { id: "full-body", label: "Full body" },
] as const;
export type AngleId = (typeof ANGLES)[number]["id"];

/** The looks a character can be made in. */
export const LOOKS = ["Photoreal", "Cinematic", "Illustrated"] as const;
export const DEFAULT_LOOK = LOOKS[0];

/** ✕'s reasons on a character. */
export const CAST_REASONS = ["Face", "Look", "Age", "Wardrobe", "Pose"] as const;

export type Character = {
  /** The id the screen keys by: the production entry's id, else the canvas card's. */
  id: string;
  cardId: string;
  /** The production entry behind it; null for a character only the canvas draws, until something is made for it. */
  entryId: string | null;
  name: string;
  description: string;
  /** The portrait: the entry's chosen take, else what the canvas shows. */
  still: string | null;
  takes: string[];
  selected: string | null;
  look: string;
  wardrobe: string[];
  /** The sheet's stills by angle id. */
  sheet: Partial<Record<AngleId, string>>;
  voice: { id: string; name: string } | null;
  voiceLine: string;
  status: CardStatus;
  reason?: string;
  version?: number;
  shots: number[];
};

const asAngle = (id: string): id is AngleId => ANGLES.some((a) => a.id === id);

/** The film's characters, in cast order. A character with no portrait yet is "Not started". */
export function characters(project: Project): Character[] {
  const entries = project.production?.cast?.entries ?? [];
  const cards = deriveCast({ kind: "studio", project, masters: new Set<string>() });
  return cards.flatMap((card) => {
    if (card.kind !== "cast") return [];
    const data = card.data as { variant: string; title: string; description: string; still: { url: string } | null; entryId: string | null; shots: number[] };
    if (data.variant !== "cast") return [];
    const entry = data.entryId ? entries.find((e) => e.id === data.entryId) ?? null : null;
    const selected = entry?.selected ?? entry?.takes[entry.takes.length - 1]?.genId ?? null;
    const still = selected ? `/api/media/${selected}` : data.still?.url ?? null;
    const id = entry?.id ?? card.id;
    const sheet: Character["sheet"] = {};
    for (const shot of entry?.sheet ?? []) if (asAngle(shot.angle)) sheet[shot.angle] = shot.genId;
    const verdict = statusOf(project.boardMarks, id, selected ?? still ?? "");
    return [{
      id, cardId: card.id, entryId: entry?.id ?? null, name: data.title.trim() || "Character", description: data.description,
      still, takes: entry?.takes.map((t) => t.genId) ?? [], selected, look: entry?.look ?? DEFAULT_LOOK, wardrobe: entry?.wardrobe ?? [], sheet,
      voice: entry?.voice ?? null, voiceLine: entry?.voiceLine ?? "", status: still ? verdict.status : "none",
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(entry && entry.takes.length > 1 ? { version: entry.takes.length } : {}), shots: data.shots,
    }];
  });
}

/** What a portrait is asked for, in words: the look, the person, what they wear, on a plain ground so the sheet can follow. */
export function portraitPrompt(c: Pick<Character, "name" | "description" | "look" | "wardrobe">): string {
  const wearing = c.wardrobe[0]?.trim();
  return [
    `${c.look} character portrait of ${c.name.trim() || "a character"}.`,
    c.description.trim(),
    wearing ? `Wearing ${wearing}.` : "",
    "Head and shoulders, neutral light, plain background, a clear reference of the face.",
  ].filter(Boolean).join(" ").slice(0, 2000);
}

/** What one angle of the sheet is asked for: the same person, only the view changes. */
export function anglePrompt(c: Pick<Character, "name" | "description" | "look" | "wardrobe">, angle: AngleId): string {
  const label = ANGLES.find((a) => a.id === angle)?.label.toLowerCase() ?? angle;
  const wearing = c.wardrobe[0]?.trim();
  return [
    `${c.look} character sheet of ${c.name.trim() || "a character"}, ${label} view, the same person as the portrait.`,
    c.description.trim(), wearing ? `Wearing ${wearing}.` : "",
    "Plain background, even light, full consistency of face, hair and clothes.",
  ].filter(Boolean).join(" ").slice(0, 2000);
}

/* ── Edits: each returns the whole draft ───────────────────────────────────────────────────────── */

const MAX_TAKES = CAST_LIMITS.takes;

/** A new AI-made character (free): a name and a few words. */
export function withCharacter(project: Project, name: string, description: string, makeId?: () => string): { project: Project; id: string } | { error: string } {
  const entries = project.production?.cast?.entries ?? [];
  if (entries.length >= 100) return { error: "A board holds up to 100 cast entries." };
  const label = name.trim().slice(0, CAST_LIMITS.name);
  if (!label) return { error: "Name the character." };
  const entry = newEntry("character", label, description.trim().slice(0, CAST_LIMITS.description), "", {}, makeId ? `cast-${makeId()}` : undefined);
  return { id: entry.id, project: { ...project, production: { ...project.production, cast: { ...project.production?.cast, entries: [...entries, entry] } } } };
}

/** An edit to one entry, by id. A missing entry changes nothing. */
export function withEntry(project: Project, entryId: string, change: (entry: CastEntry) => CastEntry): Project {
  const cast = project.production?.cast;
  if (!cast?.entries.some((e) => e.id === entryId)) return project;
  return { ...project, production: { ...project.production, cast: { ...cast, entries: cast.entries.map((e) => (e.id === entryId ? change(e) : e)) } } };
}

/** A made portrait joins the entry's takes and is the one shown; the oldest go past the limit. */
export const withPortrait = (entry: CastEntry, genId: string, at: string): CastEntry => {
  const takes = [...entry.takes.filter((t) => t.genId !== genId), { genId, at }].slice(-MAX_TAKES);
  return { ...entry, takes, selected: genId };
};

/** A made sheet replaces the angles it holds and keeps the rest. */
export function withSheet(entry: CastEntry, shots: readonly { angle: string; genId: string }[]): CastEntry {
  const next = new Map((entry.sheet ?? []).map((s) => [s.angle, s.genId]));
  for (const s of shots) if (asAngle(s.angle)) next.set(s.angle, s.genId);
  return { ...entry, sheet: ANGLES.flatMap((a) => (next.has(a.id) ? [{ angle: a.id, genId: next.get(a.id)! }] : [])) };
}

/** The wardrobe, one look per line, trimmed, at most twelve. */
export const wardrobeFrom = (text: string): string[] => text.split("\n").map((l) => l.trim().slice(0, 120)).filter(Boolean).slice(0, 12);
