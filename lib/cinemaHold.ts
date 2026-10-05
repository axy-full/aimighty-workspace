import { isCinemaStudioModel } from "./cinemaStudioTypes";
import { STATED_CHARGE_BAND, fromTenths, toTenths } from "./runLimit";

/**
 * Cinema Studio's hold (owner's decision, 5 October 2026). Its quote is
 * approximate and its cost is known only when the take finishes, so a person
 * approves "about N cr, at most 3N cr", and approving holds the 3N:
 *
 *  - admission checks the balance, the approval (`maxCredits`) and a held
 *    take's `needs` at the hold, and reserves the hold on the take's meter row
 *    (lib/generationAdmission.ts, lib/generationRequests.ts `holdBand`);
 *  - the take settles at its actual cost and the rest of the hold is released
 *    at once; with no cost figure it is charged N (lib/meter.ts);
 *  - a take the engine charged more for is shown, charged the hold and no
 *    more, never into debt, and marked (OVER_HOLD_MARK); the platform absorbs
 *    the rest and its admin desk counts it (lib/meter.ts holdOverrunsSince).
 *
 * The band is STATED_CHARGE_BAND (lib/runLimit.ts), the figure the settlement
 * was already clamped to, so "at most" is a true bound. Browser-safe: the
 * composers, the canvas dialog and the server all read the same figures here.
 */

/** The multiple of its quote a take holds and a person approves: the band for Cinema Studio, 1 for any other engine. */
export function holdBandOf(model: string | null | undefined): number {
  return model && isCinemaStudioModel(model) ? STATED_CHARGE_BAND : 1;
}

/** What a person approves, and admission holds, for a take quoted at `credits`: the quote times its band. */
export function heldCredits(credits: number, model: string | null | undefined): number {
  return credits * holdBandOf(model);
}

/**
 * A Cinema Studio price quoted at `credits` (one take, or a batch's total), in
 * its two runs: ["about 31 cr,", "at most 93 cr"]. A screen that wraps the
 * price breaks it only between them, never inside a figure.
 */
export function cinemaPriceParts(credits: number, ceiling = fromTenths(toTenths(credits) * STATED_CHARGE_BAND)): [string, string] {
  return [`about ${credits.toLocaleString("en-US")} cr,`, `at most ${ceiling.toLocaleString("en-US")} cr`];
}

/**
 * "about 31 cr, at most 93 cr": the one wording of a Cinema Studio price, for
 * every place that approves a take (Make, the canvas dialog, Gen, the Rig, an
 * Atomik step or run, a held take's Release). Pure: the same words everywhere.
 * `ceiling` is given only for a total that mixes held takes with others (a
 * plan's): the sum of what each part may charge.
 */
export function cinemaPriceWords(credits: number, ceiling?: number): string {
  return cinemaPriceParts(credits, ceiling).join(" ");
}

/**
 * Written on a finished take whose engine charged more than the person
 * approved: the take is kept and shown, charged the hold, nothing above it.
 */
export const OVER_HOLD_MARK = "The engine charged more than you approved; nothing above that was charged.";

/** An Atomik run writing as itself (`agent:<runId>`), not a person: it may prepare a hold, never approve one. */
export function isAgentApprover(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("agent:");
}

/** Why a hold was refused to an outside agent (an API token, an MCP client) or an Atomik run's own id. */
export const HOLD_NEEDS_A_PERSON = "Only a person signed in to Particl approves a Cinema Studio take's hold. Nothing was reserved or sent.";

/** The mark a finished take carries when its engine charged past its hold (`params.overHold`, words only), or null. */
export function overHoldMark(params: Record<string, unknown> | null | undefined): string | null {
  return params?.overHold === true ? OVER_HOLD_MARK : null;
}
