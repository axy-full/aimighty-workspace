import { test, expect } from "@playwright/test";
import { FREE_QUOTE, IDLE, LOADING, NO_DOLLAR_PRICE, QUOTE_FAULT, knownQuote, priceDisplay, quoteFromResponse, quoteRequest, type MoneyTerms, type Quote, type QuoteSource } from "../../lib/v12/quote";
import { UNPRICED, isUnpricedId } from "../../lib/v12/unpriced";
import { exact, upTo } from "../../lib/shell/price-words";
import { creditUsd } from "../../lib/creditTerms";
import { usd } from "../../lib/format";
import { PriceView } from "../../components/v12/ui/Price";

/**
 * The new interface's price (docs/redesign-plan.md, item B1; lib/v12/quote.ts, components/v12/ui/Price.tsx):
 * "N cr", "up to N cr" or "free", with dollars on hover at the public price of a credit; dollars for the house workspace,
 * worded as lib/price.ts words them; "quoted" only with a listed reason; and a loading or failed price is never a number.
 * The figures below stand for what a quote route answered: they are test inputs, not prices.
 */

const RATE = creditUsd();
const CREDITS: MoneyTerms = { paysInDollars: false, creditUsd: RATE };
const HOUSE: MoneyTerms = { paysInDollars: true, creditUsd: RATE };
/** The house's dollar wording: lib/price.ts useMoney().price on a dollar table. */
const houseDollars = (n: number) => (n > 0 && n < 0.005 ? "<1¢" : usd(n, 2));
const env = { creditUsd: RATE, dollars: houseDollars };
const show = (quote: Quote | null, reason?: keyof typeof UNPRICED) => priceDisplay(quote, reason, env);
const dollarsOf = (credits: number, up = false) => {
  const cents = up ? Math.ceil(credits * RATE * 100 - 1e-6) : Math.round(credits * RATE * 100);
  return `$${(cents / 100).toFixed(2)}`;
};

test("the three forms: N cr, up to N cr and free, each with its dollars on hover at the price of a credit", () => {
  expect(show(knownQuote(exact(43)))).toEqual({ text: "43 cr", title: dollarsOf(43), state: "ready", kind: "exact" });
  expect(show(knownQuote(upTo(11.2)))).toEqual({ text: "up to 12 cr", title: `up to ${dollarsOf(12, true)}`, state: "ready", kind: "up-to" });
  expect(show(knownQuote(exact(1240)))!.text).toBe("1,240 cr");
  expect(show(FREE_QUOTE)).toEqual({ text: "free", title: null, state: "ready", kind: "free" });
  /* A quote of nothing is free, never "0 cr". */
  expect(show(knownQuote(exact(0)))).toMatchObject({ text: "free", kind: "free" });
  /* No known rate: the price still shows, with no guessed dollars. */
  expect(priceDisplay(knownQuote(exact(43)), undefined, { creditUsd: null, dollars: houseDollars })).toMatchObject({ text: "43 cr", title: null });
});

test("loading and errors never show a number; idle shows nothing", () => {
  expect(show(IDLE)).toBeNull();
  const loading = show(LOADING)!;
  expect(loading).toMatchObject({ state: "loading", text: "…" });
  const failed = show({ state: "error", message: "Choose a size this engine supports." })!;
  expect(failed).toEqual({ text: "—", title: "Choose a size this engine supports.", state: "error" });
  expect(show(knownQuote(null))).toMatchObject({ state: "error", text: "—", title: QUOTE_FAULT });
  for (const d of [loading, failed]) expect(/\d/.test(d.text), d.text).toBe(false);
});

test("an action with no quote path reads \"quoted\", only with a reason from lib/v12/unpriced.ts", () => {
  expect(show(null, "lipSync")).toEqual({ text: "quoted", title: UNPRICED.lipSync.hover, state: "quoted" });
  for (const [id, entry] of Object.entries(UNPRICED)) {
    expect(isUnpricedId(id)).toBe(true);
    expect(entry.action.trim().length, id).toBeGreaterThan(0);
    expect(entry.why.trim().length, `${id} says why`).toBeGreaterThanOrEqual(30);
    expect(entry.hover.trim().length, id).toBeGreaterThan(0);
    expect(/\d\s*cr\b/.test(entry.hover), `${id}'s hover names no figure`).toBe(false);
  }
  expect(isUnpricedId("toString")).toBe(false);
  expect(isUnpricedId("nope")).toBe(false);
});

test("the house workspace sees dollars as today's screens word them, and no credit figure", () => {
  const generate: QuoteSource = { route: "generate", body: {} };
  const house = quoteFromResponse(generate, true, { fingerprint: "f", estimatedCredits: 43, price: 2.87, unit: "usd" }, HOUSE);
  expect(show(house)).toEqual({ text: "$2.87", title: null, state: "ready", kind: "exact" });
  const approximate = quoteFromResponse(generate, true, { estimatedCredits: 43, price: 2.87, unit: "usd", approximate: true }, HOUSE);
  expect(show(approximate)!.text).toBe("up to $2.87");
  expect(show(quoteFromResponse(generate, true, { estimatedCredits: 0, price: 0.001, unit: "usd" }, HOUSE))!.text).toBe("<1¢");
  /* A credit answer in the house, or a dollar answer in a credit workspace, is refused rather than relabelled. */
  expect(quoteFromResponse(generate, true, { estimatedCredits: 43, price: 43, unit: "cr" }, HOUSE).state).toBe("error");
  expect(quoteFromResponse(generate, true, { estimatedCredits: 43, price: 2.87, unit: "usd" }, CREDITS).state).toBe("error");
  /* The engine route answers credits at the platform's margin only: no dollar price for the house. */
  expect(quoteFromResponse({ route: "engine", model: "m", resolution: "1080p", ratio: "16:9" }, true, { credits: 43 }, HOUSE)).toEqual({ state: "error", message: NO_DOLLAR_PRICE });
  /* Atomik keeps the house's dollars; the planner's credits for the house are its dollars at the price of a credit. */
  expect(show(quoteFromResponse({ route: "atomik", body: {} }, true, { model: "x", effort: "low", estimateCredits: 9, estimateUsd: 0.4 }, HOUSE))!.text).toBe("up to $0.40");
  expect(show(quoteFromResponse({ route: "board-start" }, true, { agent: { enabled: true, ask: { planning: 4 } } }, HOUSE))!.text).toBe(`up to ${houseDollars(4 * RATE)}`);
});

test("each quote route's answer becomes the right form", () => {
  const generate: QuoteSource = { route: "generate", body: {} };
  expect(quoteFromResponse(generate, true, { fingerprint: "f", estimatedCredits: 43, price: 43, unit: "cr" }, CREDITS)).toEqual(knownQuote(exact(43)));
  expect(quoteFromResponse(generate, true, { estimatedCredits: 31, price: 31, unit: "cr", approximate: true }, CREDITS)).toEqual(knownQuote(upTo(31)));
  /* A take that holds its ceiling is shown at the ceiling: the charge cannot pass it. */
  expect(quoteFromResponse(generate, true, { estimatedCredits: 31, price: 31, unit: "cr", approximate: true, ceilingCredits: 93 }, CREDITS)).toEqual(knownQuote(upTo(93)));
  expect(quoteFromResponse(generate, false, { error: "Out of credits." }, CREDITS)).toEqual({ state: "error", message: "Out of credits." });
  expect(quoteFromResponse(generate, true, null, CREDITS)).toEqual({ state: "error", message: QUOTE_FAULT });
  expect(quoteFromResponse(generate, true, { estimatedCredits: Number.NaN, unit: "cr" }, CREDITS).state).toBe("error");

  const engine: QuoteSource = { route: "engine", model: "m", resolution: "1080p", ratio: "16:9", duration: 5 };
  expect(quoteFromResponse(engine, true, { models: [], credits: 7 }, CREDITS)).toEqual(knownQuote(exact(7)));
  expect(quoteFromResponse(engine, true, { models: [], credits: 7, approximate: true }, CREDITS)).toEqual(knownQuote(upTo(7)));
  expect(quoteFromResponse(engine, true, { models: [], credits: null }, CREDITS).state).toBe("error");

  /* Sound is a live estimate: "up to". */
  expect(quoteFromResponse({ route: "audio", body: { task: "sound" } }, true, { estimatedCredits: 1, price: 1, unit: "cr" }, CREDITS)).toEqual(knownQuote(upTo(1)));
  expect(quoteFromResponse({ route: "atomik", body: {} }, true, { model: "x", effort: "low", estimateCredits: 9 }, CREDITS)).toEqual(knownQuote(upTo(9)));
  expect(quoteFromResponse({ route: "board-start" }, true, { agent: { enabled: true, ask: { planning: 4 } } }, CREDITS)).toEqual(knownQuote(upTo(4)));
  expect(quoteFromResponse({ route: "board-start" }, true, { agent: { enabled: false } }, CREDITS).state).toBe("error");
  expect(quoteFromResponse({ route: "board-start" }, true, { agent: { enabled: true, ask: { planning: null } } }, CREDITS).state).toBe("error");
});

test("each source asks its existing quote route, and reserves nothing", () => {
  expect(quoteRequest({ route: "generate", body: { model: "m" } })).toMatchObject({ url: "/api/generate/quote", init: { method: "POST", body: JSON.stringify({ model: "m" }) } });
  expect(JSON.parse(String(quoteRequest({ route: "audio", body: { task: "music" } }).init.body))).toEqual({ task: "music", quoteOnly: true });
  expect(JSON.parse(String(quoteRequest({ route: "atomik", body: { text: "hi" } }).init.body))).toEqual({ text: "hi", quoteOnly: true });
  expect(quoteRequest({ route: "board-start" }).url).toBe("/api/workbench/team-canvas?agent=1&board=new");
  expect(quoteRequest({ route: "engine", model: "a/b", resolution: "1080p", ratio: "16:9", duration: 5, audio: true }).url)
    .toBe("/api/workbench/engines?model=a%2Fb&resolution=1080p&ratio=16%3A9&duration=5&audio=1");
});

test("Price draws one unbreakable run with its dollars as the hover, and marks its state", () => {
  const view = (quote: Quote | null, reason?: keyof typeof UNPRICED) =>
    PriceView({ display: show(quote, reason) }) as unknown as { type: string; props: Record<string, unknown> } | null;
  const ready = view(knownQuote(exact(43)))!;
  expect(ready.type).toBe("span");
  expect(ready.props.children).toBe("43 cr");
  expect(ready.props.title).toBe(dollarsOf(43));
  expect(ready.props["data-price-state"]).toBe("ready");
  expect(ready.props["data-price"]).toBe("exact");
  expect((ready.props.style as Record<string, unknown>).whiteSpace).toBe("nowrap");
  const loading = view(LOADING)!;
  expect(loading.props["aria-busy"]).toBe(true);
  expect(loading.props["data-price-state"]).toBe("loading");
  const quoted = view(null, "makeTurnaround")!;
  expect(quoted.props.children).toBe("quoted");
  expect(quoted.props.title).toBe(UNPRICED.makeTurnaround.hover);
  expect(view(IDLE)).toBeNull();
});
