import { z } from "zod";
import { ExportError } from "./contract";
import { exportsEnabled } from "./switch";

const noStore = { "Cache-Control": "private, no-store" };
export const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { ...noStore, ...headers } });

/** An error as the route answers it: a refusal says why; a failure we did not expect says nothing about itself. */
export function failure(error: unknown): Response {
  if (error instanceof ExportError) {
    return reply({ error: error.message }, error.status, error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return reply({ error: "The export request is not valid." }, 400);
  const status = Number((error as { status?: number })?.status) || 500;
  return reply({ error: status >= 500 ? "The export request could not finish. Check its saved status before trying again." : (error as Error).message }, status);
}

/**
 * A route that exists only while the switch is on. Off, it answers 404 before the session is read, the body is read,
 * or anything is written, dispatched or counted. The switch is read on every request.
 */
export function whenOn<A extends unknown[]>(handler: (...args: A) => Promise<Response>, enabled: () => boolean = exportsEnabled) {
  return (...args: A): Promise<Response> => (enabled() ? handler(...args) : Promise.resolve(reply({ error: "Not found." }, 404)));
}
