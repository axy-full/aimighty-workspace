/**
 * The Higgsfield sign-in is retired. No Particl feature may need a sign-in to
 * a Higgsfield account; Particl works with the Higgsfield API key and with
 * offerings that need no sign-in.
 *
 * Nothing new starts on the connected account: every request that would
 * price, start or build work there, or read its catalogue, presets, voices,
 * recipes or diagnostics, answers 410 with one plain message. What stays is
 * what history and the jobs already running need: status reads and saved-job
 * lists (so a running job is still collected and filed), the credit history,
 * setting a stuck job aside, and Disconnect, which revokes Particl's access.
 *
 * Pure (no imports), so the shell shows the same words the routes answer.
 */

/** Always true now; the account code stays in place, switched off, until it is removed. */
export const SIGN_IN_RETIRED = true as boolean;
export const SIGN_IN_RETIRED_CODE = "retired";
/** The one sentence every refusal and every retired surface says. */
export const SIGN_IN_RETIRED_MESSAGE = "The connected account is no longer used. Past results stay in your Library.";

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
