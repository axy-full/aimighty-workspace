import { isAgentId } from "./security/people-only";

/**
 * Where a take was made, for Make's own results grid (owner, 13 Oct: "Make's results grid: show only takes made in Make").
 *
 * The one marker is `params.madeIn = "make"`, written on the take by the server when a person's own session sends Make's composer's request with `madeIn: "make"`.
 * It is stored in the take's params JSON, so there is no schema change. The server accepts only that value, never from an API token or an Atomik run (they are not
 * Make's composer), and never from any other params key. A take with no marker (every take made before this) is not Make's: the one place to change if the owner would
 * rather old takes fell back to a guess is `MADE_IN_MAKE_SQL` below.
 */
export const MADE_IN_MAKE = "make";

/** What to store for a request: `"make"` only when the request is a person's own session asking for it. */
export function madeInOf(value: unknown, actor: { token?: unknown; user: { id: string } }): typeof MADE_IN_MAKE | undefined {
  if (value !== MADE_IN_MAKE) return undefined;
  if (actor.token || isAgentId(actor.user.id)) return undefined;
  return MADE_IN_MAKE;
}

/** The one predicate for "made in Make" over `generations g` (an unmarked take is not). */
export const MADE_IN_MAKE_SQL = `(json_valid(g.params) AND json_extract(g.params,'$.madeIn') = '${MADE_IN_MAKE}')`;
