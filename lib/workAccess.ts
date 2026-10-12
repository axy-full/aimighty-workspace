import { db } from "./db";
import { requireTenant } from "./tenant";
import { mappedId, workbenchReady } from "./workbench/records";

/**
 * Who may change work that is not theirs (owner, 12 Oct 2026): only the board's owner or a workspace admin may rename, move, pick, approve,
 * send back, trash, restore or delete a take, a shot or a project. An owner of the workspace is an admin. An API token acts as the person who
 * made it, with that person's role (the request's user is that person), and an agent run acts as the run's owner and never gains admin.
 * Reading, rendering and everything on one's own work are unchanged.
 *
 * "The board's owner", from the code:
 *  - A project's maker is the person whose private draft the project was made for: a draft's own project has an id made from the workspace,
 *    the draft's owner and the draft's id (lib/workbench/records.ts linkProduction), so a draft that links the project AND whose own id comes
 *    to the project's id is the maker's. A project with no such draft (made through POST /api/projects, or the starter) records no creator, so
 *    only an admin changes it.
 *  - A shot's owner is its `created_by`; the project's maker may also change it.
 *  - A take's owner is its `created_by` (the person who made it); the maker of the project it is in may also change it.
 * Nothing here decides who may SEE an item: every route answers a missing id as an unknown one and keeps its own reads.
 */
export type Actor = { id: string; role: "admin" | "member"; owner?: boolean };

export const isAdmin = (actor: Actor) => actor.role === "admin" || actor.owner === true;

/** The words a refusal says. The caller answers 403 with them. */
export const NOT_YOURS = {
  take: "This take is someone else's work. Only its maker, the board's owner or an admin can change it.",
  shot: "This shot is someone else's work. Only its maker, the board's owner or an admin can change it.",
  project: "This project is someone else's work. Only its owner or an admin can change it.",
} as const;

/** The maker of a project (see above), or null when none is recorded. */
export async function projectMaker(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  await workbenchReady();
  const ws = requireTenant();
  const rows = (await db().execute({
    sql: `SELECT owner, project_id FROM workbench_projects WHERE json_valid(body) AND json_extract(body,'$.productionProjectId') = ?`,
    args: [projectId],
  })).rows;
  for (const row of rows) if (mappedId("prj_wb_", ws.id, String(row.owner), String(row.project_id)) === projectId) return String(row.owner);
  return null;
}

/** Whether `actor` may change a project: its maker, or an admin. */
export async function mayChangeProject(actor: Actor, projectId: string | null | undefined): Promise<boolean> {
  if (isAdmin(actor)) return true;
  return (await projectMaker(projectId)) === actor.id;
}

/** Whether `actor` may change a take or a shot: its own maker, the maker of its project, or an admin. */
export async function mayChangeWork(actor: Actor, work: { createdBy: string | null | undefined; projectId: string | null | undefined }): Promise<boolean> {
  if (isAdmin(actor)) return true;
  if (work.createdBy && work.createdBy === actor.id) return true;
  return (await projectMaker(work.projectId)) === actor.id;
}
