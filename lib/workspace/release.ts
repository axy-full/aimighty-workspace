import { ceilDeci, fromDeci } from "../creditTerms";
/**
 * Releasing a take held for credits (lib/held.ts), as rules both sides read:
 * the route (app/api/jobs/[id]/release) decides with them, the Suites show
 * the Release button with them, so a button is never offered that the route
 * would refuse.
 */

/** The owner and admins read as "admin" on the server (lib/auth.ts roleOf); the browser's session says which. */
export type ReleaseViewer = { id: string | null | undefined; role: string | null | undefined };

/** A held take is released by the person who made it, or by the owner or an admin. */
export function mayRelease(viewer: ReleaseViewer, createdBy: string | null | undefined): boolean {
  if (viewer.role === "owner" || viewer.role === "admin") return true;
  return Boolean(viewer.id) && viewer.id === createdBy;
}

/**
 * The credits a take held at zero was quoted (lib/held.ts heldInfo, carried
 * to the browser as `params.held.needs` for a workspace that pays in
 * credits), to a tenth; null when it waits for a slot or no figure was kept.
 */
export function heldNeeds(params: Record<string, unknown> | null | undefined): number | null {
  const held = (params as { held?: { why?: unknown; needs?: unknown } } | null | undefined)?.held;
  if (!held || held.why === "slots") return null;
  return typeof held.needs === "number" && Number.isFinite(held.needs) && held.needs > 0 ? fromDeci(ceilDeci(held.needs)) : null;
}
