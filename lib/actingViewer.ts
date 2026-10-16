import { db } from "./db";
import { currentTenant } from "./tenant";
import { currentViewer, type Viewer } from "./uploadAccess";
import { isAgentId } from "./security/people-only";

/**
 * The person a request acts for, or null: the signed-in person (or the token's owner), or, for an Atomik run's own identity (`agent:<runId>`), the person who
 * started that run (`rig_agent_runs.owner`), as a member. A background caller with no person behind it, or a run that names none, has no viewer.
 *
 * An engine door that reads an upload asks this first and refuses without a viewer, before it reads anything: `currentViewer()` alone answers null for an agent,
 * and a check that is skipped for null would let an agent reach another person's private upload. Fails closed on any read error.
 */
export async function actingViewer(): Promise<Viewer | null> {
  const viewer = currentViewer();
  if (viewer) return viewer;
  const user = currentTenant()?.user;
  if (!user || !user.id.startsWith("agent:") || !isAgentId(user.id)) return null;
  try {
    const owner = (await db().execute({ sql: "SELECT owner FROM rig_agent_runs WHERE id = ? LIMIT 1", args: [user.id.slice("agent:".length)] })).rows[0]?.owner;
    return typeof owner === "string" && owner && !isAgentId(owner) ? { id: owner, role: "member" } : null;
  } catch { return null; }
}

/** What a door says when no person stands behind a request that would read an upload. */
export const NO_ACTING_PERSON = "A person must be behind this request to use their uploads.";
