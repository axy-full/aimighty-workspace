import { dollars } from "../format";
import { isRunLimitAmount } from "../runLimit";
import type { DollarMode } from "./price-words";

/**
 * The run-limit box ("New limit", components/graphite/board/agent/AgentLines.tsx) in the unit its screen reads (owner, 13 Oct: one screen, one unit). A customer workspace types
 * credits, as ever. The house is never billed in credits and reads dollars, so it types dollars: what is typed becomes the house's credits (whole credits, rounded UP, so the
 * limit never reads below what was typed) before it is saved, and the stored limit is shown back in dollars with the shared formatter. Display and entry only: what the server
 * keeps is still credits.
 */

/** The box's text for a stored limit of `credits`: dollars to the cent, rounded up (no symbol: the box's own label carries it), or the credits as they are. */
export function limitBoxText(credits: number, mode: DollarMode): string {
  if (!mode.on || mode.creditUsd === null) return String(credits);
  return dollars(credits * mode.creditUsd).replace(/^\$/, "").replace(/,/g, "");
}

/** The credits a typed box means, or null when it is not an amount a person may approve. */
export function limitFromBox(text: string, mode: DollarMode): number | null {
  const typed = Number(text);
  if (!text.trim() || !Number.isFinite(typed) || typed <= 0) return null;
  if (!mode.on || mode.creditUsd === null) return isRunLimitAmount(typed) ? typed : null;
  /* Whole credits, rounded up: 0.743 dollars at 0.10 is 8 credits, never 7. */
  const credits = Math.ceil(typed / mode.creditUsd - 1e-9);
  return isRunLimitAmount(credits) ? credits : null;
}
