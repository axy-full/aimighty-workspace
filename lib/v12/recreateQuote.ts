/**
 * Redraw's price in the new interface's menus: today's Recreate price (lib/shell/recreate-price.ts, the same figure
 * Make's button then shows for the take's recipe) as a quote for <Price> (lib/v12/quote.ts). Pure. A figure is never
 * worked out here: the server's credits are worded as the quote layer words them.
 *
 *  - reading: loading ("…").
 *  - unavailable: an error, with the server's reason on hover ("—").
 *  - a sound's live estimate: "up to N cr".
 *  - Cinema Studio (held): up to the hold it approves, N times its band (lib/cinemaHold.ts).
 *  - otherwise: "N cr".
 *  - the house workspace, which pays in dollars: no figure ("—"), as the quote layer does for the engines route.
 */
import { STATED_CHARGE_BAND, fromTenths, toTenths } from "@/lib/runLimit";
import type { RecreatePrice } from "@/lib/shell/recreate-price";
import { exact, upTo } from "@/lib/shell/price-words";
import { IDLE, LOADING, NO_DOLLAR_PRICE, QUOTE_FAULT, type Quote } from "./quote";

/** `paysInDollars`: the house workspace, which is never shown credits; the engines route gives no dollars. */
export function recreateQuote(price: RecreatePrice | null, paysInDollars = false): Quote {
  if (!price) return IDLE;
  if (paysInDollars) return { state: "error", message: NO_DOLLAR_PRICE };
  if (price.state === "reading") return LOADING;
  if (price.state === "unavailable") return { state: "error", message: price.reason || QUOTE_FAULT };
  const value = price.held ? upTo(fromTenths(toTenths(price.credits) * STATED_CHARGE_BAND)) : price.estimate ? upTo(price.credits) : exact(price.credits);
  return value ? { state: "ready", price: { unit: "cr", value } } : { state: "error", message: QUOTE_FAULT };
}
