import { isCinemaStudioModel } from "../cinemaStudioTypes";
import { cinemaPriceParts } from "../cinemaHold";
import type { ComposerQuote } from "../workspace/composer";
import { shownTotal } from "../workspace/composer";
import { exact, priceWords, type PriceValue } from "./price-words";

/**
 * What Make shows beside a paid control (the button, the engine line, a sheet row, Again): the server's
 * figure, worded by lib/shell/price-words.ts. Nothing is worked out or typed here; a figure is the quote's
 * (the composer's live quote, the engines route's priced list) or nothing.
 *
 * Cinema Studio is the one engine whose quote is approximate, and it has its own wording (decision 18):
 * "about N cr, at most 3N cr", from `cinemaPriceParts` in lib/cinemaHold.ts, the one wording every screen
 * that approves a Cinema Studio take uses (button, engine line, sheet row, Again).
 */

/**
 * THE FLAG: whether Make offers Cinema Studio 4.0 at all. On: its 3N hold is in (lib/cinemaHold.ts; admission holds 3N,
 * every cap reads the hold, settlement never passes it), so "about N cr, at most 3N cr" is a real bound. Off, Make's
 * engine list, sheet, default, recipes and Again would not include the engine.
 */
export const MAKE_SHOWS_CINEMA = true;

/** The engines Make does not offer (passed to the composer as `hide`). */
export const hiddenInMake = (modelId: string): boolean => !MAKE_SHOWS_CINEMA && isCinemaStudioModel(modelId);

/** Cinema Studio's price as its runs of words; a screen that wraps it breaks only between runs, never inside a figure. */
export function cinemaParts(credits: number): string[] {
  return cinemaPriceParts(credits);
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
