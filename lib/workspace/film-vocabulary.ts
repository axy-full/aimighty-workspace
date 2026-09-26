import { CATEGORIES, MOVEMENT_TECHNIQUES, composePrompt, craftModules, sceneLine } from "../studio";
import { previewKey } from "../previews";
import type { ComposerType } from "./composer";

/**
 * Gen's film vocabulary: the camera bank (lib/studio.ts › CATEGORIES) as six
 * chips under Direction — Shot · Angle · Camera · Lens · Light · Look — each
 * Auto until picked. A pick is kept as data (the composer's `shot`), sent as
 * `shotSpec`, and written into the words the way the shot composer always
 * wrote it (lib/studio.ts › composePrompt), so the engine reads a camera
 * module rather than a bare word. Recreate hands the data back to the chips
 * and takes the written setup back out of the words.
 *
 * Pure: nothing here fetches or renders.
 */

/** A setup as the composer holds it: one value per bank row; a row that is absent is Auto. */
export type FilmSetup = Record<string, string>;

export type FilmChipKey = "shot" | "angle" | "camera" | "lens" | "light" | "look";
export type FilmChip = { key: FilmChipKey; label: string; /** The bank rows the chip writes. */ rows: readonly string[] };

export const FILM_CHIPS: readonly FilmChip[] = [
  { key: "shot", label: "Shot", rows: ["shot"] },
  { key: "angle", label: "Angle", rows: ["angle"] },
  { key: "camera", label: "Camera", rows: ["move", "technique"] },
  { key: "lens", label: "Lens", rows: ["lens"] },
  { key: "light", label: "Light", rows: ["light"] },
  { key: "look", label: "Look", rows: ["look"] },
];

/** The rows a still can use: it has no camera travel, pace or soundtrack. */
const STILL_ROWS: ReadonlySet<string> = new Set(["shot", "angle", "lens", "light", "time", "look", "mood"]);
const BANK_ROWS: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.key));

/** The chips an output takes: a still has no camera move; sound has none at all. */
export function chipsFor(type: ComposerType): FilmChip[] {
  if (type === "audio") return [];
  return FILM_CHIPS.filter((chip) => type === "video" || chip.rows.every((row) => STILL_ROWS.has(row)));
}

/** One bank entry as a tile or a typeahead row shows it. */
export type FilmOption = {
  row: string; value: string; label: string; phrase: string; aka?: string;
  /** The platform's neutral loop for it (lib/previews.ts), where the bank makes one: moves and techniques. */
  previewKey: string | null;
};

const option = (row: string, o: (typeof CATEGORIES)[number]["options"][number]): FilmOption => ({
  row, value: o.value, label: o.label, phrase: o.phrase,
  ...(o.aka ? { aka: o.aka } : {}),
  previewKey: row === "move" || row === "technique" ? previewKey(row, o.value) : null,
});

/** Every entry a chip offers, in the bank's order (Camera: the moves, then the named techniques). */
export function chipOptions(chip: FilmChip): FilmOption[] {
  return chip.rows.flatMap((row) => (CATEGORIES.find((c) => c.key === row)?.options ?? []).map((o) => option(row, o)));
}

const labelOf = (row: string, value: string | undefined) =>
  value ? CATEGORIES.find((c) => c.key === row)?.options.find((o) => o.value === value)?.label ?? value : "";

/**
 * The chip's face: "Auto", or what is picked. A technique that travels
 * replaces the move (lib/studio.ts › cameraModule drops it), so the face names
 * the technique alone; one that does not ("Rack focus") rides with the move.
 */
export function chipValue(chip: FilmChip, setup: FilmSetup): { text: string; set: boolean } {
  if (chip.key === "camera") {
    const technique = labelOf("technique", setup.technique);
    const move = MOVEMENT_TECHNIQUES.has(setup.technique ?? "") ? "" : labelOf("move", setup.move);
    const text = [move, technique].filter(Boolean).join(" + ");
    return { text: text || "Auto", set: Boolean(text) };
  }
  const text = labelOf(chip.rows[0], setup[chip.rows[0]]);
  return { text: text || "Auto", set: Boolean(text) };
}

/** True when this entry is what the setup holds. */
export const isPicked = (setup: FilmSetup, o: Pick<FilmOption, "row" | "value">) => setup[o.row] === o.value;

/**
 * Pick an entry, or Auto (null) for the whole chip. Picking what is already
 * held puts that row back to Auto. On Camera a travelling technique and a
 * move exclude each other, the way the bank composes them.
 */
export function pickOption(setup: FilmSetup, chip: FilmChip, picked: Pick<FilmOption, "row" | "value"> | null): FilmSetup {
  const next = { ...setup };
  if (!picked) { for (const row of chip.rows) delete next[row]; return next; }
  if (next[picked.row] === picked.value) { delete next[picked.row]; return next; }
  next[picked.row] = picked.value;
  if (chip.key === "camera") {
    if (picked.row === "technique" && MOVEMENT_TECHNIQUES.has(picked.value)) delete next.move;
    if (picked.row === "move" && MOVEMENT_TECHNIQUES.has(next.technique ?? "")) delete next.technique;
  }
  return next;
}

/** A setup as it arrives from anywhere (a take's params, a stored state): string values only, twenty rows at most. */
export function cleanSetup(value: unknown): FilmSetup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0)
    .slice(0, 20));
}

/** The rows this output uses: all of them for video, the still's rows for a picture (and any row the bank does not know, kept as data), none for sound. */
export function applicableSetup(setup: FilmSetup, type: ComposerType): FilmSetup {
  if (type === "audio") return {};
  const clean = cleanSetup(setup);
  if (type === "video") return clean;
  return Object.fromEntries(Object.entries(clean).filter(([row]) => STILL_ROWS.has(row) || !BANK_ROWS.has(row)));
}

/** Rows a recreated take carried that no chip shows (time of day, mood, pace…): named, so each can be seen and removed. */
export function extraRows(setup: FilmSetup, type: ComposerType): { row: string; label: string; value: string }[] {
  const shown = new Set(chipsFor(type).flatMap((chip) => chip.rows));
  return Object.entries(applicableSetup(setup, type))
    .filter(([row]) => !shown.has(row))
    .map(([row, value]) => ({ row, label: CATEGORIES.find((c) => c.key === row)?.label ?? row, value: labelOf(row, value) }));
}

/** Each picked row by its bank label, in the bank's order; a row the bank does not know reads as its value. */
export function setupLabels(setup: FilmSetup): string[] {
  const clean = cleanSetup(setup);
  const known = CATEGORIES.flatMap((c) => (clean[c.key] ? [labelOf(c.key, clean[c.key])] : []));
  const other = Object.entries(clean).filter(([row]) => !BANK_ROWS.has(row)).map(([, value]) => value);
  return [...known, ...other];
}

/** The setup's words (the scene line and the craft modules), when the bank has any for it. */
function setupWords(setup: FilmSetup): string[] {
  return [sceneLine(setup), craftModules(setup)].filter(Boolean);
}

/** True when the words already carry the setup (a take composed by the shot composer, or a paste). */
export function setupInWords(prompt: string, setup: FilmSetup): boolean {
  const words = setupWords(setup);
  return words.length > 0 && words.every((w) => prompt.includes(w));
}

/**
 * What Generate sends: the words with the setup written in (never twice),
 * and the setup itself as data. No setup, no change.
 */
export function composeForSend(prompt: string, setup: FilmSetup, type: ComposerType): { prompt: string; shotSpec: FilmSetup | null } {
  const used = applicableSetup(setup, type);
  if (!Object.keys(used).length) return { prompt, shotSpec: null };
  if (!setupWords(used).length || setupInWords(prompt, used)) return { prompt, shotSpec: used };
  return { prompt: composePrompt(prompt, used), shotSpec: used };
}

/**
 * A recreated take's words without the setup that was written into them, so
 * the box holds the person's words and the chips hold the setup. Only an
 * intact setup comes out: words edited after composing are left as they are.
 */
export function withoutSetup(prompt: string, setup: FilmSetup): string {
  const clean = cleanSetup(setup);
  if (!setupWords(clean).length) return prompt;
  const scene = sceneLine(clean), camera = craftModules(clean);
  let rest = prompt;
  if (camera) {
    if (rest === camera) rest = "";
    else if (rest.endsWith(`\n\n${camera}`)) rest = rest.slice(0, -(camera.length + 2));
    else return prompt;
  }
  if (scene) {
    if (rest === `${scene}.`) rest = "";
    else if (rest.endsWith(` ${scene}.`)) rest = rest.slice(0, -(scene.length + 2));
    else return prompt;
  }
  return composePrompt(rest, clean) === prompt ? rest : prompt;
}

/* ── # in the words: a typeahead of the bank ─────────────────────────────── */

/** The `#word` being typed at the caret: where it starts and ends, and what it says so far. */
export type HashToken = { start: number; end: number; query: string };

/** A `#` that opens a word (not the one in "C#"), and the letters after it up to the caret. */
export function hashToken(text: string, caret: number): HashToken | null {
  const before = text.slice(0, caret);
  const found = /(^|[\s([{"'“‘])#([A-Za-z0-9-]{0,24})$/.exec(before);
  if (!found) return null;
  const tail = /^[A-Za-z0-9-]*/.exec(text.slice(caret))?.[0] ?? "";
  return { start: caret - found[2].length - 1, end: caret + tail.length, query: `${found[2]}${tail}`.toLowerCase() };
}

/** The words with the token taken out, and where the caret goes. */
export function dropToken(text: string, token: HashToken): { text: string; caret: number } {
  const before = text.slice(0, token.start).replace(/[ \t]+$/, "");
  const after = text.slice(token.end).replace(/^[ \t]+/, "");
  const joiner = before && after && !before.endsWith("\n") && !/^[\n,.;:!?]/.test(after) ? " " : "";
  return { text: `${before}${joiner}${after}`, caret: before.length + joiner.length };
}

export type FilmHit = FilmOption & { chip: FilmChipKey; chipLabel: string };

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").trim();

/** A grid's search: every typed word appears in the entry's name, other name or phrase. */
export function optionMatches(o: Pick<FilmOption, "label" | "aka" | "phrase">, query: string): boolean {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = norm([o.label, o.aka ?? "", o.phrase].join(" "));
  return terms.every((t) => hay.includes(t));
}

/**
 * Entries whose name, other name or words begin with what was typed — a
 * name's start first, then a word's, then anywhere in its phrase. With
 * nothing typed yet, the camera moves (video) or shot sizes (a still).
 */
export function vocabularyMatches(query: string, type: ComposerType, limit = 8): FilmHit[] {
  const chips = chipsFor(type);
  const ordered = [...chips.filter((c) => c.key === "camera"), ...chips.filter((c) => c.key !== "camera")];
  const all = ordered.flatMap((chip) => chipOptions(chip).map((o) => ({ ...o, chip: chip.key, chipLabel: chip.label })));
  const q = norm(query);
  if (!q) return all.slice(0, limit);
  const words = (s: string) => norm(s).split(/[\s,/]+/).filter(Boolean);
  const score = (o: FilmHit) => {
    const label = norm(o.label);
    if (label.startsWith(q)) return 0;
    if (words(o.label).some((w) => w.startsWith(q)) || (o.aka && (norm(o.aka).startsWith(q) || words(o.aka).some((w) => w.startsWith(q))))) return 1;
    if (norm(o.phrase).includes(q) || (o.aka && norm(o.aka).includes(q))) return 2;
    return -1;
  };
  return all
    .map((o, i) => ({ o, i, s: score(o) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.o);
}
