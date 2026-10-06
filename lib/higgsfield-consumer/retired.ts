/**
 * The Higgsfield sign-in is off. No Particl feature may need a sign-in to a
 * Higgsfield account; Particl works with the Higgsfield API key and with
 * offerings that need no sign-in.
 *
 * Nothing starts, prices, reads or collects on the connected account: every
 * route that would (new work since R1; for Release 1 also the status reads,
 * saved-job lists and the credit history) answers 410 with one plain message,
 * through `signInOff` below. The old sign-in return address lands on Settings.
 * A grant already stored stays where it is, unused.
 *
 * Pure (no imports), so the shell shows the same words the routes answer.
 */

/** Always true now; the account code stays in place, switched off, until it is removed. */
export const SIGN_IN_RETIRED = true as boolean;
export const SIGN_IN_RETIRED_CODE = "retired";
/** The one sentence every refusal and every retired surface says. */
export const SIGN_IN_RETIRED_MESSAGE = "The connected account is no longer used. Past results stay in your Library.";

/**
 * Release 1: no Particl feature needs a Higgsfield sign-in, so nothing uses a
 * stored grant either. A route wrapped in `signInOff` answers 410 for every
 * method, before auth, a body read or any service. The heartbeat's collection
 * stage (app/api/cron/sync) and the shell's collector
 * (lib/shell/use-connected-collector.ts) are off on the same switch. No row is
 * changed or deleted.
 */
export const SIGN_IN_OFF = true as boolean;

/**
 * A route handler switched off with the sign-in. The handler it wraps stays in
 * its file, unreachable, so it can be read and removed in its own change.
 */
export function signInOff(kept: unknown): (request?: Request) => Promise<Response> {
  if (!SIGN_IN_OFF && typeof kept === "function") return kept as (request?: Request) => Promise<Response>;
  return async () => retiredResponse();
}

/** The answer to any request for new work on the connected account. */
export function retiredResponse(): Response {
  return Response.json(
    { code: SIGN_IN_RETIRED_CODE, error: SIGN_IN_RETIRED_MESSAGE },
    { status: 410, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

/**
 * A request body's `action`, read before the route validates the rest, so a
 * tab left open from before gets the plain answer rather than "review the
 * request" when its body no longer matches.
 */
export function requestedAction(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const action = (body as { action?: unknown }).action;
  return typeof action === "string" ? action : null;
}

/** True when this body asks a route for one of its retired actions. */
export function asksRetired(body: unknown, retired: ReadonlySet<string>): boolean {
  const action = requestedAction(body);
  return action !== null && retired.has(action);
}
