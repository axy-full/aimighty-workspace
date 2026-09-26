/**
 * xAI's failures, typed so the meter can tell a request xAI refused from one
 * whose outcome is unknown. Only a refusal releases its reservation: after a
 * timeout, a dropped connection or a 5xx, xAI may already be making — and
 * billing — the thing. A failure before the request left is a PreflightError
 * (lib/preflight.ts). Shared by Grok Imagine Video and Grok Voice.
 */

/** A reply xAI actually sent: its status says whether the request was refused or its fate is unknown. */
export class XaiHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "XaiHttpError"; }
}

/** A definite refusal of the request itself: nothing was accepted, so nothing is charged. */
export function xaiSubmissionRejected(error: unknown): boolean {
  return error instanceof XaiHttpError && [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(error.status);
}
