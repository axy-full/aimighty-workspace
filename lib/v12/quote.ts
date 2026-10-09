/**
 * The new interface's price layer, pure part (docs/redesign-plan.md, item B1).
 *
 * Every price the new frame shows is the server's: one of the quote routes (docs/redesign/app-map.md § 3.2), read by
 * `useQuote` (lib/v12/useQuote.ts) and drawn by `<Price>` (components/v12/ui/Price.tsx). This file says what each route's
 * answer means as a price, and what a price looks like in each state. No figure is typed or worked out here: the wording
 * is lib/shell/price-words.ts ("N cr", "up to N cr", "free", with dollars on hover at the public price of a credit), and
 * the house workspace's dollars are worded by lib/price.ts (`useMoney().price`), as today's screens word them.
 *
 * States:
 *  - idle: nothing to ask yet (no request). Draws nothing.
 *  - loading: the route has not answered. Draws a placeholder, never a number.
 *  - ready: the server's figure.
 *  - error: the route refused or failed. Draws a dash with the reason on hover, never a number.
 *  - "quoted": an action with no quote path, given as `quote={null}` with a reason from lib/v12/unpriced.ts.
 */
import { FREE, exact, priceView, upTo, type PriceKind, type PriceValue } from "@/lib/shell/price-words";
import { thinkingFrom } from "@/components/graphite/home/use-thinking-price";
import { UNPRICED, type UnpricedId } from "./unpriced";

/** A price in the unit this workspace pays in: credits, or (the house workspace alone) dollars. */
export type QuotedPrice =
  | { unit: "cr"; value: PriceValue }
  | { unit: "usd"; usd: number; upTo: boolean };

export type Quote =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; price: QuotedPrice }
  | { state: "error"; message: string };

export const IDLE: Quote = Object.freeze({ state: "idle" });
export const LOADING: Quote = Object.freeze({ state: "loading" });
/** An action that costs nothing (Approve, Download): "free". */
export const FREE_QUOTE: Quote = Object.freeze({ state: "ready", price: Object.freeze({ unit: "cr", value: FREE }) });

/** A figure the server already gave (a stored run cost, a held amount on a job record), as a ready quote. Null value: error. */
export function knownQuote(value: PriceValue | null | undefined): Quote {
  return value ? { state: "ready", price: { unit: "cr", value } } : { state: "error", message: QUOTE_FAULT };
}

export const QUOTE_FAULT = "The price could not be read. Try again.";
export const NO_DOLLAR_PRICE = "This price is not available in dollars yet.";

/**
 * Where a price comes from: one of the existing quote routes. Each asks for a price and reserves nothing.
 *  - generate: POST /api/generate/quote, the same body as the send (stills, video, upscale, edits, variations).
 *  - engine: GET /api/workbench/engines?model=…: one engine at given settings, before anything is written.
 *  - audio: POST /api/audio {quoteOnly}: speech, sound, music, dialogue, voice change.
 *  - atomik: POST /api/atomik {quoteOnly}: one Atomik chat turn.
 *  - board-start: GET /api/workbench/team-canvas?agent=1&board=new: Atomik's planning ceiling for a new board.
 */
export type QuoteSource =
  | { route: "generate"; body: Record<string, unknown> }
  | { route: "engine"; model: string; resolution: string; ratio: string; duration?: number; audio?: boolean }
  | { route: "audio"; body: Record<string, unknown> }
  | { route: "atomik"; body: Record<string, unknown> }
  | { route: "board-start" };

/** The request for a source: what `useQuote` sends (through the session's scoped fetch). */
export function quoteRequest(source: QuoteSource): { url: string; init: RequestInit } {
  const post = (url: string, body: Record<string, unknown>) =>
    ({ url, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
  switch (source.route) {
    case "generate": return post("/api/generate/quote", source.body);
    case "audio": return post("/api/audio", { ...source.body, quoteOnly: true });
    case "atomik": return post("/api/atomik", { ...source.body, quoteOnly: true });
    case "board-start": return { url: "/api/workbench/team-canvas?agent=1&board=new", init: { cache: "no-store" } };
    case "engine": {
      const q = new URLSearchParams({ model: source.model, resolution: source.resolution, ratio: source.ratio });
      if (source.duration != null) q.set("duration", String(source.duration));
      if (source.audio) q.set("audio", "1");
      return { url: `/api/workbench/engines?${q}`, init: { cache: "no-store" } };
    }
  }
}

/** What the session says about money here: whether it pays in dollars (the house workspace), and a credit's price. */
export type MoneyTerms = { paysInDollars: boolean; creditUsd: number | null };

const figure = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const errorOf = (body: unknown, fallback = QUOTE_FAULT): Quote => {
  const said = (body as { error?: unknown } | null)?.error;
  return { state: "error", message: typeof said === "string" && said.trim() ? said : fallback };
};
const credits = (n: number, kind: Exclude<PriceKind, "free">): Quote => {
  const value = kind === "up-to" ? upTo(n) : exact(n);
  return value ? { state: "ready", price: { unit: "cr", value } } : { state: "error", message: QUOTE_FAULT };
};
const dollars = (usd: number, ceiling: boolean): Quote => ({ state: "ready", price: { unit: "usd", usd, upTo: ceiling } });

/**
 * A route's answer as a quote. `ok` is the response's status; `body` its JSON (null when it was not JSON).
 * The unit is the server's: a credit workspace is never shown dollars and the house is never shown credits.
 */
export function quoteFromResponse(source: QuoteSource, ok: boolean, body: unknown, terms: MoneyTerms): Quote {
  if (!ok || !body || typeof body !== "object") return errorOf(body);
  const b = body as Record<string, unknown>;
  switch (source.route) {
    case "generate":
    case "audio": {
      /* AdmissionQuote (lib/admissionTypes.ts) and the audio quote share these fields. Cinema Studio holds its
         ceiling (`ceilingCredits`); an approximate figure settles on what was delivered and cannot go over it. */
      const unit = b.unit;
      if (unit === "usd") {
        if (!terms.paysInDollars || !figure(b.price)) return errorOf(null);
        return dollars(b.price, b.approximate === true || source.route === "audio");
      }
      if (unit !== "cr" || terms.paysInDollars) return errorOf(null);
      if (figure(b.ceilingCredits)) return credits(b.ceilingCredits, "up-to");
      if (!figure(b.estimatedCredits)) return errorOf(null);
      /* Sound is a live estimate the charge cannot pass (lib/shell/make-price.ts makeQuoteValue). */
      return credits(b.estimatedCredits, b.approximate === true || source.route === "audio" ? "up-to" : "exact");
    }
    case "engine": {
      /* Credits only, at the platform's margin: the house reads its engines in dollars, which this route does not give. */
      if (terms.paysInDollars) return { state: "error", message: NO_DOLLAR_PRICE };
      if (!figure(b.credits)) return errorOf(b);
      return credits(b.credits, b.approximate === true ? "up-to" : "exact");
    }
    case "atomik": {
      /* A chat turn is reserved at its estimate and settled at what it used: a ceiling. The house keeps its dollars
         (lib/workbench/atomik-response.ts strips them for credit workspaces only). */
      if (terms.paysInDollars) return figure(b.estimateUsd) ? dollars(b.estimateUsd, true) : { state: "error", message: NO_DOLLAR_PRICE };
      return figure(b.estimateCredits) ? credits(b.estimateCredits, "up-to") : errorOf(b);
    }
    case "board-start": {
      const thinking = thinkingFrom(body);
      if (thinking.state === "error") return { state: "error", message: thinking.message };
      if (thinking.state !== "ready") return { state: "error", message: thinking.state === "off" ? "Building with Atomik is off in this workspace." : QUOTE_FAULT };
      /* For the house the planner's credits are its dollars counted in whole credits at the price of one, with no
         margin (lib/credits.ts quotedCredits), so their dollar value is the ceiling in dollars. */
      if (terms.paysInDollars) return terms.creditUsd ? dollars(thinking.credits * terms.creditUsd, true) : { state: "error", message: NO_DOLLAR_PRICE };
      return credits(thinking.credits, "up-to");
    }
  }
}

/** What `<Price>` draws: its text, its hover, and its state for tests and styling. Null: draw nothing. */
export type PriceDisplay = {
  text: string;
  title: string | null;
  state: "loading" | "ready" | "error" | "quoted";
  /** For a ready price: "exact", "up-to" or "free", as shown. */
  kind?: PriceKind;
};

/**
 * The drawing for a quote. `dollars` words a dollar amount the way the house workspace's screens do
 * (lib/price.ts `useMoney().price`); `creditUsd` is the public price of a credit (the session's `rates.creditUsd`,
 * filled from `creditUsd()`), for the hover.
 */
export function priceDisplay(
  quote: Quote | null,
  reason: UnpricedId | undefined,
  env: { creditUsd: number | null; dollars: (usd: number) => string },
): PriceDisplay | null {
  if (quote === null) {
    const unpriced = reason ? UNPRICED[reason] : undefined;
    return { text: "quoted", title: unpriced?.hover ?? null, state: "quoted" };
  }
  switch (quote.state) {
    case "idle": return null;
    case "loading": return { text: "…", title: "Reading the price", state: "loading" };
    case "error": return { text: "—", title: quote.message || QUOTE_FAULT, state: "error" };
    case "ready": {
      const price = quote.price;
      if (price.unit === "usd") {
        if (!figure(price.usd)) return { text: "—", title: QUOTE_FAULT, state: "error" };
        if (price.usd === 0) return { text: "free", title: null, state: "ready", kind: "free" };
        return { text: `${price.upTo ? "up to " : ""}${env.dollars(price.usd)}`, title: null, state: "ready", kind: price.upTo ? "up-to" : "exact" };
      }
      const view = priceView(price.value, env.creditUsd);
      if (!view) return { text: "—", title: QUOTE_FAULT, state: "error" };
      return { text: view.text, title: view.title, state: "ready", kind: view.kind };
    }
  }
}
