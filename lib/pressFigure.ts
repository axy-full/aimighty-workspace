/**
 * A person's sound or dub press carries the figure that was on its button (owner, 21 Oct 2026, 22:15 IST: "a person's audio or
 * dubbing press carries the figure that was on its button, like the Director press (#860)"). Every job is approved on its quote by
 * the person pressing it.
 *
 *  - The figure is `maxCredits`: the credits the button showed (the route's own quote, `estimatedCredits`). The audio and dubbing
 *    routes issue no quote fingerprint, so the figure is the whole approval; the server prices the press itself and never reads a
 *    total from the client.
 *  - A press without it (or with something that is not a whole number of credits) is refused before its Idempotency-Key is claimed,
 *    and again in admission before anything is filed, held, reserved or sent: 409, `figure_required`, nothing charged.
 *  - A press whose figure is under today's price is a moved price: refused before anything is filed, with the new figure
 *    (`quoteChanged`, `estimatedCredits`, `price`, `unit`), and never admitted above what was shown.
 *  - A token or an MCP client is held first by lib/tokenSpend.ts (#854), unchanged: a ceiling and its approved quote.
 *
 * No price, margin or rate is read or written here.
 */
export const FIGURE_REQUIRED = "figure_required";
export const PRICE_MOVED = "price_moved";
export const PRESS_WITHOUT_FIGURE =
  "Press again at the price shown. This press did not carry the price on its button, so nothing was started or charged.";

/** The figure a press carries, when it carries one: a whole number of credits. */
export function pressFigure(maxCredits: unknown): number | null {
  return typeof maxCredits === "number" && Number.isInteger(maxCredits) && maxCredits >= 0 ? maxCredits : null;
}

/** The refusal of a press that carries no figure, as a body and status (admission) or a response (the route, before its key is claimed). */
export function pressFigureProblem(maxCredits: unknown): { status: 409; body: { error: string; code: string; charged: 0 } } | null {
  return pressFigure(maxCredits) == null ? { status: 409, body: { error: PRESS_WITHOUT_FIGURE, code: FIGURE_REQUIRED, charged: 0 } } : null;
}
export function pressFigureRefusal(maxCredits: unknown): Response | null {
  const problem = pressFigureProblem(maxCredits);
  return problem ? Response.json(problem.body, { status: problem.status, headers: { "Cache-Control": "no-store" } }) : null;
}

/** The price a moved press is told, in the unit the workspace's quote is in (credits, or a workspace's own dollars on its own keys). */
const priceWords = (price: number, unit: "cr" | "usd") =>
  unit === "cr" ? `${price.toLocaleString("en-US")} cr` : `US$${price.toFixed(2)}`;

/** The refusal of a press whose figure is under today's price: the new figure, to be shown and pressed again. */
export function movedPriceBody(quote: { estimatedCredits: number; price: number; unit: "cr" | "usd" }) {
  return {
    error: `The price is now ${priceWords(quote.price, quote.unit)}. Press again to approve it.`,
    code: PRICE_MOVED,
    quoteChanged: true,
    estimatedCredits: quote.estimatedCredits,
    price: quote.price,
    unit: quote.unit,
    charged: 0 as const,
  };
}
