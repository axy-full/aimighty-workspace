import { test, expect } from "@playwright/test";
import { aboutWords, goFigure, madeValue, makePriceTitle, makePriceWords, makeQuoteValue, shownDollars, shownValue, type MakeShown } from "../../lib/shell/make-price";
import { cinemaPriceDollars, cinemaPriceWords } from "../../lib/cinemaHold";
import { CREDITS_MODE, exact, FREE, modeOf, NO_AT_COST_FIGURE, NO_AT_COST_TITLE, PAYS_AT_COST_TITLE, priceTitle, priceWords, upTo } from "../../lib/shell/price-words";

/**
 * Make's price in the unit the workspace pays in. The house workspace (lib/houseWorkspace.ts) pays at cost and reads every price in the
 * engine's own dollars; Make holds those dollars beside its figure (MakePrice.usd, from the live quote), and drew the figure without them,
 * so the house read "Make · —". A workspace that pays in credits reads exactly what it read before. Every figure here is an input, as the
 * server would send it; none is a rate.
 */
const HOUSE = modeOf({ unit: "usd", creditUsd: 0.1 });
const CUSTOMER = modeOf({ unit: "cr", creditUsd: 0.1 });

/* A take's price as Make builds it (components/graphite/make/use-make.ts): the line, the button through goFigure, and Cinema Studio's. */
const take = (credits: number, usd: number | null, type: "video" | "image" | "audio" = "video"): MakeShown => ({ value: makeQuoteValue(credits, type), about: null, usd });
const button = (o: Partial<Parameters<typeof goFigure>[0]>): MakeShown =>
  ({ ...goFigure({ total: 7, count: 1, type: "video", takeUsd: null, batchRequoted: false, enhanceCredits: null, enhanceUsd: null, ...o }), about: null });
const cinema = (credits: number, usd: number | null): MakeShown => ({ value: null, about: cinemaPriceWords(credits), credits, usd });

/** Every shape Make draws, with and without the house's dollars. */
const SHAPES: MakeShown[] = [
  take(43, null), take(43, 0.5), take(7, 0.5, "audio"), take(0, null), take(0, 0),
  button({ takeUsd: 0.5 }), button({ total: 21, count: 3, takeUsd: 0.5 }), button({ total: 21, count: 3, takeUsd: 0.5, batchRequoted: true }),
  button({ takeUsd: 0.5, enhanceCredits: 1, enhanceUsd: 0.02 }), button({ enhanceCredits: 1 }), button({ takeUsd: 0.5, enhanceCredits: 0, enhanceUsd: 0.02 }),
  cinema(31, null), cinema(31, 0.42), { value: FREE, about: null, usd: 0.5 }, { value: null, about: null, usd: 0.5 },
];

test("the cause: Make's figure carried no dollars, so the house read '—' for a take whose dollars Make had", () => {
  const go = button({ takeUsd: 0.5 });
  expect(go.usd).toBe(0.5);
  expect(priceWords(go.value, HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(makePriceWords(go, HOUSE)).toBe("$0.50");
});

test("the house reads the take's own dollars: the line, the button, a sound's estimate, a batch, an enhancement added", () => {
  expect(makePriceWords(take(43, 0.5), HOUSE)).toBe("$0.50");
  expect(makePriceTitle(take(43, 0.5), HOUSE, 0.1)).toBe(PAYS_AT_COST_TITLE);
  expect(makePriceWords(take(7, 0.5, "audio"), HOUSE)).toBe("up to $0.50");
  expect(makePriceWords(button({ takeUsd: 0.5 }), HOUSE)).toBe("$0.50");
  /* A batch is the take's dollars times its takes (goFigure). */
  expect(makePriceWords(button({ total: 21, count: 3, takeUsd: 0.5 }), HOUSE)).toBe("$1.50");
  /* The enhancement's estimate is added, and the total reads "up to". */
  expect(makePriceWords(button({ takeUsd: 0.5, enhanceCredits: 1, enhanceUsd: 0.02 }), HOUSE)).toBe("up to $0.52");
  expect(makePriceWords(button({ takeUsd: 0.5, enhanceCredits: 0, enhanceUsd: 0.02 }), HOUSE)).toBe("up to $0.52");
  expect(makePriceWords(take(0, 0), HOUSE)).toBe("free");
});

test("the house reads Cinema Studio's approximate price in dollars: about the take's, at most three times it", () => {
  expect(aboutWords(cinema(31, 0.42), HOUSE)).toBe("about $0.42, at most $1.26");
  expect(makePriceWords(cinema(31, 0.42), HOUSE)).toBe("about $0.42, at most $1.26");
  expect(makePriceTitle(cinema(31, 0.42), HOUSE, 0.1)).toBe(PAYS_AT_COST_TITLE);
});

test("a figure the house has no dollars for stays '—', never the customer price turned into dollars", () => {
  expect(makePriceWords(take(43, null), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(makePriceTitle(take(43, null), HOUSE, 0.1)).toBe(NO_AT_COST_TITLE);
  /* A batch re-quoted take by take has no one figure in dollars (goFigure's rule), nor has an enhancement with no dollars. */
  expect(makePriceWords(button({ total: 21, count: 3, takeUsd: 0.5, batchRequoted: true }), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(makePriceWords(button({ takeUsd: 0.5, enhanceCredits: 1, enhanceUsd: null }), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(makePriceWords(cinema(31, null), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(makePriceTitle(cinema(31, null), HOUSE, 0.1)).toBe(NO_AT_COST_TITLE);
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(makePriceWords(take(43, bad), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(makePriceWords(null, HOUSE)).toBeNull();
  expect(makePriceWords({ value: null, about: null, usd: 0.5 }, HOUSE)).toBeNull();
});

test("a workspace that pays in credits reads exactly what it read before, words and hover, whatever dollars the price carries", () => {
  expect(CUSTOMER).toEqual(CREDITS_MODE);
  for (const price of SHAPES) {
    /* Before: the marker read `about ?? priceWords(value)`, Price drew `priceWords(value)`, the hover was the value's or Cinema Studio's at a credit's price. */
    const words = price.about ?? priceWords(price.value, CUSTOMER);
    const title = price.value ? priceTitle(price.value, 0.1, CUSTOMER) : price.about && typeof price.credits === "number" ? cinemaPriceDollars(price.credits, 0.1) : null;
    expect(makePriceWords(price, CUSTOMER), JSON.stringify(price)).toBe(words);
    expect(makePriceTitle(price, CUSTOMER, 0.1), JSON.stringify(price)).toBe(title);
    expect(priceWords(shownValue(price), CUSTOMER), JSON.stringify(price)).toBe(priceWords(price.value, CUSTOMER));
    if (price.about) expect(aboutWords(price, CUSTOMER)).toBe(price.about);
  }
  expect(makePriceWords(take(43, 0.5), CUSTOMER)).toBe("43 cr");
  expect(makePriceWords(button({ total: 21, count: 3, takeUsd: 0.5 }), CUSTOMER)).toBe("21 cr");
  expect(makePriceWords(button({ takeUsd: 0.5, enhanceCredits: 1, enhanceUsd: 0.02 }), CUSTOMER)).toBe("up to 8 cr");
  expect(makePriceWords(take(7, null, "audio"), CUSTOMER)).toBe("up to 7 cr");
  expect(makePriceWords(cinema(31, 0.42), CUSTOMER)).toBe("about 31 cr, at most 93 cr");
});

test("the drawn value only gains the dollars Make already holds: same kind, same credits, nothing on free or a missing figure", () => {
  expect(shownValue(take(43, 0.5))).toEqual(exact(43, 0.5));
  expect(shownValue(take(7, 0.5, "audio"))).toEqual(upTo(7, 0.5));
  expect(shownValue(take(43, null))).toEqual(exact(43));
  expect(shownValue({ value: FREE, about: null, usd: 0.5 })).toEqual(FREE);
  expect(shownValue(cinema(31, 0.42))).toBeNull();
  expect(shownValue(null)).toBeNull();
});

/* The toast after a press (components/graphite/make/use-make.ts › sent): the accepted credits, worded in the dollars Make showed for that figure. */
test("the toast after a press: the house reads the dollars Make showed for that figure, '—' for one it never showed in dollars", () => {
  const shown = shownDollars({ credits: 7, usd: 0.5 }, { credits: 21, usd: 1.5 });
  expect(priceWords(madeValue(7, shown), HOUSE)).toBe("$0.50");
  expect(priceWords(madeValue(21, shown), HOUSE)).toBe("$1.50");
  expect(priceWords(madeValue(9, shown), HOUSE)).toBe(NO_AT_COST_FIGURE);
  /* No dollars shown (a batch re-quoted take by take): "—", as the button read. */
  expect(priceWords(madeValue(21, shownDollars({ credits: 7, usd: 0.5 }, { credits: 21, usd: null })), HOUSE)).toBe(NO_AT_COST_FIGURE);
  /* The button's figure wins where both are the same credits (an enhancement the house pays in dollars only). */
  expect(shownDollars({ credits: 7, usd: 0.5 }, { credits: 7, usd: 0.52 }).get(7)).toBe(0.52);
});

test("the toast after a press: a workspace that pays in credits reads the credits, whatever dollars were on hand", () => {
  const shown = shownDollars({ credits: 7, usd: 0.5 }, { credits: 21, usd: 1.5 });
  for (const credits of [7, 21, 9]) {
    expect(priceWords(madeValue(credits, shown), CUSTOMER)).toBe(priceWords(exact(credits), CUSTOMER));
    expect(priceWords(madeValue(credits, shown), CUSTOMER)).not.toContain("$");
  }
  expect(priceWords(madeValue(0, new Map()), CUSTOMER)).toBe("free");
  expect(shownDollars({ credits: null, usd: 0.5 }, { credits: 7, usd: Number.NaN }).size).toBe(0);
});
