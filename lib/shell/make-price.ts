import { isCinemaStudioModel } from "../cinemaStudioTypes";
import { cinemaPriceDollars, cinemaPriceParts } from "../cinemaHold";
import { dollars } from "../format";
import { STATED_CHARGE_BAND } from "../runLimit";
import type { ComposerModel, ComposerPicks, ComposerQuote, ComposerType, ModelPreference } from "../workspace/composer";
import { composerSettings, DEFAULT_MODEL_PREFERENCE, shownTotal } from "../workspace/composer";
import { exact, NO_AT_COST_FIGURE, NO_AT_COST_TITLE, PAYS_AT_COST_TITLE, priceTitle, priceWords, upTo, type DollarMode, type PriceValue } from "./price-words";
import { NANO_BANANA_PRO_ID } from "../models";

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

/**
 * Make's defaults (design/particl-graphite/README.md § 0 rule 2, § 4 "Make · 43 cr / 3 cr / up to 1 cr"): video opens on
 * Seedance 2.5 at 1080p and 5 s, a still on Nano Banana Pro, a sound on a voice (speech). Each is only a default: an engine
 * the workspace does not offer falls through to the composer's own order, and the person's pick, a recipe or Draft replaces
 * it. The figures are never here; they are the server's quote at these settings. The shot's own stage (a draft take on a
 * board) arrives as a recipe, which carries its own engine and settings.
 */
export const MAKE_MODEL_PREFERENCE: ModelPreference = {
  video: ["dreamina-seedance-2-5-260628", ...DEFAULT_MODEL_PREFERENCE.video],
  image: [NANO_BANANA_PRO_ID, ...DEFAULT_MODEL_PREFERENCE.image],
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

/**
 * The figure on Make's button when the press may carry an enhancement (Enhance On, lib/v12/enhance.ts): the take plus the
 * enhancement, ONE total, from the quote routes' own figures.
 *  - A credit workspace: the credits of both, exact (no dollars, the quote routes send it none).
 *  - The house workspace, which pays at cost (lib/houseWorkspace.ts): the engine's dollars for the take (`takeUsd`, per take, as the
 *    composer's live quote gives them) plus the text model's own estimate in dollars for the enhancement (`enhanceUsd`), "up to":
 *    the real cost of the enhancement cannot pass its estimate. Only when both are known in dollars, and the take's own figure
 *    is not a batch re-quoted take by take; otherwise it has no dollar figure and the price layer shows none (never the customer
 *    price turned into dollars).
 * `total` is the takes' credits (as the composer totals a batch); `enhanceCredits` the enhancement's, null or 0 when there is none.
 */
export function goFigure(o: { total: number; count: number; type: ComposerType; takeUsd: number | null; batchRequoted: boolean; enhanceCredits: number | null; enhanceUsd: number | null }): { value: PriceValue | null; usd: number | null } {
  const added = o.enhanceCredits ?? 0;
  /* The house's enhancement may be 0 credits (nothing is billed in credits there) and still cost dollars. */
  if (added > 0 || (o.enhanceUsd ?? 0) > 0) {
    const house = o.enhanceUsd != null;
    return {
      value: (house ? upTo(o.total + added) : null) ?? makeQuoteValue(o.total + added, o.type),
      usd: o.takeUsd != null && o.enhanceUsd != null && !o.batchRequoted ? o.takeUsd * o.count + o.enhanceUsd : null,
    };
  }
  return { value: makeQuoteValue(o.total, o.type), usd: o.takeUsd != null && !o.batchRequoted ? o.takeUsd * o.count : null };
}

/**
 * The house's dollars for the figures Make showed before a press, by their credits: one take's (the line), and the button's whole figure,
 * which wins where both are the same credits. Only figures shown with dollars are kept.
 */
export function shownDollars(take: { credits: number | null; usd: number | null }, go: { credits: number | null; usd: number | null }): Map<number, number> {
  const known = new Map<number, number>();
  for (const f of [take, go]) if (f.credits != null && f.usd != null && Number.isFinite(f.usd) && f.usd >= 0) known.set(f.credits, f.usd);
  return known;
}

/**
 * What the toast says a press cost (lib/shell/make.ts › madeLine): the accepted credits, carrying the dollars Make showed for that same
 * figure. In the house that reads the dollars, or "—" for a figure Make never showed in dollars (never credits turned into dollars); a
 * workspace that pays in credits reads the credits, as before.
 */
export const madeValue = (credits: number, shown: ReadonlyMap<number, number>): PriceValue | null => exact(credits, shown.get(credits));

/* ── What Make draws, in the unit the workspace pays in ───────────────────── */

/**
 * A price as Make holds it (components/graphite/make/use-make.ts › MakePrice): an exact or "up to" figure (`value`), or Cinema Studio's
 * approximate words (`about`, for the `credits` they are about), and beside either the same figure in the engine's own dollars (`usd`),
 * which only the house workspace is sent (the quote routes strip it for every other workspace).
 */
export type MakeShown = { value: PriceValue | null; about: string | null; credits?: number | null; usd?: number | null };

const usableUsd = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;

/**
 * The value Make draws: its figure, carrying the price's dollars where it has them. The price layer words a value's own `usd` in dollar
 * mode (lib/shell/price-words.ts › priceWords), and Make keeps the house's dollars beside the figure (the live quote's, times the takes, plus
 * an enhancement's, by goFigure's rule), so they go on the value it draws. A workspace that pays in credits reads the credits whatever the
 * value carries, so its words are unchanged; a price with no dollars is drawn as it was, and the house reads "—" for it (never the customer
 * price turned into dollars).
 */
export function shownValue(price: MakeShown | null | undefined): PriceValue | null {
  const value = price?.value ?? null;
  const usd = price?.usd;
  if (!value || value.kind === "free" || !usableUsd(usd)) return value;
  return { ...value, usd };
}

/** Cinema Studio's approximate price in the house's own dollars: "about $0.42, at most $1.26" (its ceiling at the same band as the credits wording, lib/cinemaHold.ts). */
export const aboutDollars = (usd: number): string => `about ${dollars(usd)}, at most ${dollars(usd * STATED_CHARGE_BAND)}`;

/** Cinema Studio's approximate words in `mode`: the credits wording as it was, or in dollar mode the dollars, or "—" while there are none. */
export function aboutWords(price: MakeShown, mode: DollarMode): string | null {
  if (!price.about) return null;
  if (!mode.on) return price.about;
  return usableUsd(price.usd) ? aboutDollars(price.usd) : NO_AT_COST_FIGURE;
}

/** The words Make draws for a price in `mode` ("43 cr", "$0.43", "about 31 cr, at most 93 cr", "—"), or null for none. */
export function makePriceWords(price: MakeShown | null | undefined, mode: DollarMode): string | null {
  if (!price) return null;
  const value = shownValue(price);
  return value ? priceWords(value, mode) : aboutWords(price, mode);
}

/**
 * A Make price's hover: an exact one's (lib/shell/price-words.ts › priceTitle), or Cinema Studio's: in credits its dollars at the price of a
 * credit (lib/cinemaHold.ts › cinemaPriceDollars), in dollar mode what the house's figure is ("Pays at cost", or why there is none yet).
 */
export function makePriceTitle(price: MakeShown | null | undefined, mode: DollarMode, creditUsd: number | null): string | null {
  const value = shownValue(price);
  if (value) return priceTitle(value, creditUsd, mode);
  if (!price?.about) return null;
  if (mode.on) return !usableUsd(price.usd) ? NO_AT_COST_TITLE : price.usd === 0 ? null : PAYS_AT_COST_TITLE;
  return typeof price.credits === "number" ? cinemaPriceDollars(price.credits, creditUsd) : null;
}
