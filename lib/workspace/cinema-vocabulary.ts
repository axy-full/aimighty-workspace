import {
  CINEMA_STUDIO_CONTROLS,
  cinemaControl,
  cinemaOptionLabel,
  cleanCinemaControls,
  type CinemaStudioControls,
} from "../cinemaStudioTypes";
import { rankHits, type FilmHit, type FilmOption, type FilmSetup, type VocabChip, type VocabularyBank } from "./film-vocabulary";

/**
 * Cinema Studio 4.0's documented creative controls as a chip bank, so Gen
 * offers them the way it offers the film vocabulary (lib/workspace/
 * film-vocabulary.ts): nine chips under Direction, each Auto until picked, a
 * grid per chip with search where it is long, and `#` in the words. The
 * difference is where a pick goes: into the request as the engine's own
 * parameter (`cinema`, checked again by admission), never into the words.
 *
 * Pure: nothing here fetches or renders.
 */

export const CINEMA_CHIPS: readonly VocabChip[] = CINEMA_STUDIO_CONTROLS.map((c) => ({ key: c.key, label: c.label, rows: [c.key] }));

/* Movement is drawn with the camera bank's move drawings; the other controls are names alone (a genre, an era,
   a palette known only by its name), since a picture of them would be invented. */
const DRAWN: ReadonlySet<string> = new Set(["camera_movement"]);

function cinemaOptions(chip: VocabChip): FilmOption[] {
  return (cinemaControl(chip.key)?.options ?? []).map((o) => ({
    row: chip.key, value: o.value, label: o.label, phrase: o.label, previewKey: null,
    ...(DRAWN.has(chip.key) ? {} : { plain: true as const }),
  }));
}

function cinemaValue(chip: VocabChip, setup: FilmSetup): { text: string; set: boolean } {
  const text = cinemaOptionLabel(chip.key, setup[chip.key]);
  return { text: text || "Auto", set: Boolean(text) };
}

/** Pick a value, or Auto (null) for the chip. Picking what is already held puts the chip back to Auto. */
function cinemaPick(setup: FilmSetup, chip: VocabChip, picked: Pick<FilmOption, "row" | "value"> | null): FilmSetup {
  const next: FilmSetup = { ...setup };
  if (!picked || next[chip.key] === picked.value) delete next[chip.key];
  else next[chip.key] = picked.value;
  return cleanCinemaControls(next) as FilmSetup;
}

/** Everything the chips offer, movement first (as the film vocabulary leads with camera moves). */
const ALL_HITS: readonly FilmHit[] = [
  ...CINEMA_CHIPS.filter((c) => c.key === "camera_movement"),
  ...CINEMA_CHIPS.filter((c) => c.key !== "camera_movement"),
].flatMap((chip) => cinemaOptions(chip).map((o) => ({ ...o, chip: chip.key, chipLabel: chip.label })));

export const CINEMA_BANK: VocabularyBank = {
  label: "Cinema Studio controls",
  chips: CINEMA_CHIPS,
  options: cinemaOptions,
  value: cinemaValue,
  pick: cinemaPick,
  /* Every control has its chip. */
  extras: () => [],
  matches: (query) => rankHits(ALL_HITS, query),
};

/** The picks as the request sends them: documented pairs only, in the documented order. */
export const cinemaForSend = (setup: FilmSetup | null | undefined): CinemaStudioControls => cleanCinemaControls(setup);

/** Each pick by its name, in the documented order ("35mm film · Dolly in · Noir"). */
export function cinemaLabels(setup: unknown): string[] {
  const clean = cleanCinemaControls(setup);
  return CINEMA_STUDIO_CONTROLS.flatMap((c) => (clean[c.key] ? [cinemaOptionLabel(c.key, clean[c.key])] : []));
}

/**
 * The Recreate card's controls: what the take was made with, and whether the
 * chips still hold exactly that. When they do not, the reason, the way the
 * card's other rows say it: Gen is on another engine now, or it was changed here.
 */
export function recipeCinema(taken: unknown, held: FilmSetup, onCinema: boolean): { labels: string[]; kept: boolean; why?: string } {
  const was = cleanCinemaControls(taken), now = cleanCinemaControls(held);
  const labels = cinemaLabels(was);
  if (!onCinema) return { labels, kept: false, why: "Only Cinema Studio takes these" };
  const same = Object.keys(was).length === Object.keys(now).length && (Object.keys(was) as (keyof CinemaStudioControls)[]).every((k) => now[k] === was[k]);
  return same ? { labels, kept: true } : { labels, kept: false, why: "Changed here" };
}
