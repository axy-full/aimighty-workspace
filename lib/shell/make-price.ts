import { isCinemaStudioModel } from "../cinemaStudioTypes";
import type { ComposerModel, ComposerPicks, ComposerQuote, ComposerType, ModelPreference } from "../workspace/composer";
import { composerSettings, DEFAULT_MODEL_PREFERENCE, shownTotal } from "../workspace/composer";
import { exact, priceWords, upTo, type PriceValue } from "./price-words";

/**
 * What Make shows beside a paid control (the button, the engine line, a sheet row, Again): the server's
 * figure, worded by lib/shell/price-words.ts. Nothing is worked out or typed here; a figure is the quote's
 * (the composer's live quote, the engines route's priced list) or nothing.
 *
 * Cinema Studio is the one engine whose quote is approximate, and it has its own wording (decision 18):
 * "about N cr, at most 3N cr", from #523's `cinemaPriceParts` in lib/cinemaHold.ts. That file is not on
 * this branch, so the wording sits behind `cinemaParts` below: it says what main says today
 * ("about N cr"). When #523 is merged, `cinemaParts` returns `cinemaPriceParts(credits)` and every
 * screen below (button, engine line, sheet row, Again) follows; nothing else changes.
 */

/**
 * THE FLAG: whether Make offers Cinema Studio 4.0 at all. Off until #523 (Cinema Studio holds 3N) is merged and money-reviewed:
 * Make may say "about N cr, at most 3N cr" only when that bound is real, and it is real only once the hold is. While it is
 * off, Make's engine list, sheet, default, recipes and Again do not include the engine (a take recreated from a Cinema take
 * lands on Make's own default engine, and says so). To turn it on: set this to true AND swap `cinemaParts` below to
 * `cinemaPriceParts(credits)` in the same change.
 */
export const MAKE_SHOWS_CINEMA = false;

/** The engines Make does not offer (passed to the composer as `hide`). */
export const hiddenInMake = (modelId: string): boolean => !MAKE_SHOWS_CINEMA && isCinemaStudioModel(modelId);

/**
 * Make's defaults (design/particl-graphite/README.md § 0 rule 2, § 4 "Make · 43 cr / 3 cr / up to 1 cr"): video opens on
 * Seedance 2.5 at 1080p and 5 s, a still on Nano Banana Pro, a sound on a voice (speech). Each is only a default: an engine
 * the workspace does not offer falls through to the composer's own order, and the person's pick, a recipe or Draft replaces
 * it. The figures are never here; they are the server's quote at these settings. The shot's own stage (a draft take on a
 * board) arrives as a recipe, which carries its own engine and settings.
 */
export const MAKE_MODEL_PREFERENCE: ModelPreference = {
  video: ["dreamina-seedance-2-5-260628", ...DEFAULT_MODEL_PREFERENCE.video],
  image: ["gemini-3-pro-image", ...DEFAULT_MODEL_PREFERENCE.image],
  audio: [(model) => model.audioTask === "speech", ...DEFAULT_MODEL_PREFERENCE.audio],
};
/** Make opens at 1080p (an engine that has no 1080p renders at its own first size, and the line says which). */
export const MAKE_PICKS: ComposerPicks = Object.freeze({ resolution: "1080p" });

/**
 * The settings a sheet row's figure is at, in the engine line's order ("1080p · 5 s"): the size and length this engine
 * renders with where the composer stands (lib/workspace/composer.ts › composerSettings, the same settings the row was priced
 * at), so a row for an engine without the picked size names its own. A sound row keeps the detail its rate came with.
 */
export function rowSettings(model: ComposerModel, at: { aspect?: string; picks: ComposerPicks }, soundDetail?: string | null): string | null {
  if (model.type === "audio") return soundDetail || null;
  const settings = composerSettings(model, at.aspect, at.picks);
  return [settings.resolution !== "adaptive" ? settings.resolution : null, model.type === "video" && model.durations?.length ? `${settings.duration} s` : null]
    .filter(Boolean).join(" · ") || null;
}

/** Make's sound is priced by a live estimate, never a card row: it reads "up to N cr" (README § 4: estimate ElevenLabs). */
export const makeQuoteValue = (credits: number | null | undefined, type: ComposerType): PriceValue | null =>
  type === "audio" ? upTo(credits) : exact(credits);

/** Cinema Studio's price as its runs of words; a screen that wraps it breaks only between runs, never inside a figure. */
export function cinemaParts(credits: number): string[] {
  /* TODO(#523): `return cinemaPriceParts(credits);` from "../cinemaHold" once that PR is on this branch. */
  return [`about ${credits.toLocaleString("en-US")} cr`];
}

/** A figure as Make draws it: an exact one (Price draws it, dollars on hover), or Cinema Studio's approximate one. */
export type MakeFigure = { kind: "exact"; value: PriceValue } | { kind: "approximate"; credits: number; parts: string[] };

/** The figure for a quoted `credits`, or null when there is none (never a zero or a guess). */
export function makeFigure(credits: number | null | undefined, approximate = false): MakeFigure | null {
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return null;
  if (approximate) return { kind: "approximate", credits, parts: cinemaParts(credits) };
  const value = exact(credits);
  return value ? { kind: "exact", value } : null;
}

/** The figure on the button, which is what a press approves: one take's price, or the batch's total. Null until a live quote is in. */
export function buttonFigure(quote: ComposerQuote | null, quoteKey: string, count: number): MakeFigure | null {
  return makeFigure(shownTotal(quote, quoteKey, count), Boolean(quote?.approximate));
}

/** The figure as plain words, for a name a screen reader hears or a test reads: "43 cr", "about 31 cr". */
export function figureWords(figure: MakeFigure | null): string | null {
  if (!figure) return null;
  if (figure.kind === "approximate") return figure.parts.join(" ");
  return priceWords(figure.value);
}
