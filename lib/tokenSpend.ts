import { creditsApply } from "./credits";
import { currentTenant } from "./tenant";
import { hasSpendingCeiling } from "./tokenCeiling";

/**
 * What an API token, or an MCP client (which calls the app's routes with its token, lib/mcp.ts), needs before it may start paid work.
 * Owner, 20 Oct 2026, Q1 "B": "An admin sets a ceiling per token in credits per month; every paid request from a token or an MCP
 * client carries its approved quote; a token with no ceiling can only prepare and price."
 *
 *  1. A monthly ceiling an admin set on the token (lib/tokenCeiling.ts › hasSpendingCeiling). The ceiling is the person's standing
 *     approval; a token without one only prepares and prices: its quotes still answer, and each paid request is refused here,
 *     before its Idempotency-Key is claimed and before any row, reservation or vendor call. The spend gate refuses it again at
 *     reservation (lib/generationRequests.ts), so a path that forgot to ask here still cannot spend.
 *  2. The approved quote, on every paid request: `maxCredits` (and the quote's fingerprint where the route issues one,
 *     `quoteFingerprint` on POST /api/generate). The server never fills one in for a token: a request without it is refused. A
 *     quote that went stale (a price above `maxCredits`, or a fingerprint that no longer matches) is refused by the route's own
 *     price check, before any row, reservation or vendor call.
 *  3. The month's ceiling itself is held at reservation, atomically, counting the token's reserved jobs (as before).
 *
 * A person in the browser (no token) is not asked anything here: their behaviour is unchanged.
 */
export const TOKEN_NO_CEILING = "token_no_ceiling";
export const TOKEN_QUOTE_REQUIRED = "quote_required";

/** The refusal for a token with no ceiling. It names what a person does: set the ceiling, or approve the prepared job. */
export function noCeilingMessage(name?: string | null): string {
  return `${name ? `The token "${name}"` : "This token"} has no monthly ceiling, so it can only prepare and price jobs. ` +
    "An admin can set its ceiling in credits in Settings › Connections, or a person can approve the job in Particl.";
}
/**
 * What is written on a take such a token made when it is not started (lib/held.ts): credits arriving never start it, and it stays held.
 * A person's own Release of it, at the figure they were shown, is their approval and starts it (owner, 20 Oct 2026, answer A).
 */
export const HELD_TAKE_NO_CEILING =
  "This take was made by an API token with no monthly ceiling. An admin sets the ceiling in Settings › Connections, then release it.";
export const QUOTE_REQUIRED_MESSAGE =
  "A paid request from an API token or an MCP client carries the quote it was approved at. Ask for the price first (quoteOnly, or POST /api/generate/quote) and send that figure as maxCredits.";
export const FINGERPRINT_REQUIRED_MESSAGE =
  "A paid request from an API token or an MCP client carries the quote it was approved at. Ask POST /api/generate/quote first and send its fingerprint as quoteFingerprint, with its price as maxCredits.";

type TokenLike = { name?: string | null; capUsd?: number | null; capCredits?: number | null } | null | undefined;
export type TokenSpendProblem = { status: number; body: { error: string; code: string; charged: 0 } };

/** Whether this token may start paid work in this workspace: it has a ceiling in the workspace's unit. */
export function tokenMaySpend(token: TokenLike): boolean {
  return token != null && hasSpendingCeiling(token, creditsApply(currentTenant()?.workspace));
}

const wholeCredits = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const quoteFingerprint = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/**
 * Why this token's paid request is refused, or null. `token` is the request's own (absent for a person in the browser, who is never
 * refused here). `quote`: what the request carries; `fingerprint` is asked only where the route issues one.
 */
export function tokenSpendProblem(token: TokenLike, quote: { maxCredits: unknown; fingerprint?: unknown; needsFingerprint?: boolean }): TokenSpendProblem | null {
  if (!token) return null;
  if (!tokenMaySpend(token)) return { status: 403, body: { error: noCeilingMessage(token.name), code: TOKEN_NO_CEILING, charged: 0 } };
  if (!wholeCredits(quote.maxCredits)) return { status: 400, body: { error: QUOTE_REQUIRED_MESSAGE, code: TOKEN_QUOTE_REQUIRED, charged: 0 } };
  if (quote.needsFingerprint && !quoteFingerprint(quote.fingerprint)) return { status: 400, body: { error: FINGERPRINT_REQUIRED_MESSAGE, code: TOKEN_QUOTE_REQUIRED, charged: 0 } };
  return null;
}

/** The same, as the route's reply. `token` defaults to the request's own (lib/tenant.ts). */
export function tokenSpendRefusal(quote: { maxCredits: unknown; fingerprint?: unknown; needsFingerprint?: boolean }, token: TokenLike = currentTenant()?.token): Response | null {
  const problem = tokenSpendProblem(token, quote);
  return problem ? Response.json(problem.body, { status: problem.status, headers: { "Cache-Control": "no-store" } }) : null;
}
