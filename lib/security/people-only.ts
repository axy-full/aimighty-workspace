/**
 * People-only actions (owner rule): approving spend, setting limits and the budget, top-ups, approving a post and
 * recording consent are done by a signed-in person and nothing else. Atomik (`agent:<runId>` identities), an MCP
 * client and every API token prepare at most.
 *
 * Pure: the routes put a session check in front (lib/auth.ts › requireSession refuses a token), and the libraries
 * that write a people-only record ask this again, so code that reaches them without a route (an agent's tool, a
 * script) is refused too.
 */
export type Caller = {
  user: { id: string; disabled?: boolean } | null | undefined;
  /** Present when the request came with an API or MCP token, of any scope. */
  token?: unknown;
};

export const PEOPLE_ONLY = "Only a signed-in person can do this. Atomik, an MCP client and API tokens can prepare it, never do it.";

/** An Atomik identity (lib/workbench/rig-agent.ts › agentAuthor), or any other machine author. */
export const isAgentId = (id: string | null | undefined): boolean => typeof id === "string" && (id.startsWith("agent:") || id === "server");

/** A person at a browser: a user, not disabled, not an agent identity, and not a token. */
export function isPerson(caller: Caller): boolean {
  const user = caller.user;
  if (!user || typeof user.id !== "string" || !user.id) return false;
  if (user.disabled) return false;
  if (isAgentId(user.id)) return false;
  return caller.token == null;
}

export class PeopleOnlyError extends Error {
  readonly status = 403;
  constructor(message = PEOPLE_ONLY) { super(message); this.name = "PeopleOnlyError"; }
}

/** Throws unless the caller is a person. */
export function assertPerson(caller: Caller): void {
  if (!isPerson(caller)) throw new PeopleOnlyError();
}
