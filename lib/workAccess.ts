import { db } from "./db";
import { requireTenant } from "./tenant";
import { mappedId, workbenchReady } from "./workbench/records";
import { boardOwnerRows } from "./draftProject";

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
 *  - A production's name, client and status are an admin's, or the one person who made every board in it. A move needs the right over the item moved AND over where it goes.
 * Nothing here decides who may SEE an item: every route answers a missing id as an unknown one and keeps its own reads.
 */
export type Actor = { id: string; role: "admin" | "member"; owner?: boolean };

export const isAdmin = (actor: Actor) => actor.role === "admin" || actor.owner === true;

/** The words a refusal says. The caller answers 403 with them. */
export const NOT_YOURS = {
  take: "This take is someone else's work. Only its maker, the board's owner or an admin can change it.",
  shot: "This shot is someone else's work. Only its maker, the board's owner or an admin can change it.",
  project: "This project is someone else's work. Only its owner or an admin can change it.",
  production: "This production belongs to someone else's board. Only that board's owner or an admin can change it.",
  moveToProject: "That project is someone else's work. Only its owner or an admin can move work into it.",
  moveToShot: "That shot is someone else's work. Only its maker, the board's owner or an admin can file work against it.",
} as const;

/** The maker of a project (see above), or null when none is recorded. */
export async function projectMaker(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  await workbenchReady();
  const ws = requireTenant();
  /* A board handed over has the owner its row names, whoever's key holds the draft (board sharing, PR 4). */
  const handed = (await boardOwnerRows()).find((h) => h.projectId === projectId);
  if (handed) return handed.owner;
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

/**
 * Whether `actor` may change a production's name, client or status: an admin, or the one person who made every board in it. A production holding
 * boards of two or more people, or no board of anyone's, is an admin's (each person manages their own boards, not the production over them);
 * a project with no recorded maker is no one's board and does not count (owner, 12 Oct 2026).
 */
export async function mayChangeProduction(actor: Actor, productionId: string): Promise<boolean> {
  if (isAdmin(actor)) return true;
  const projects = (await db().execute({ sql: "SELECT id FROM projects WHERE production_id = ?", args: [productionId] })).rows;
  const makers = new Set<string>();
  for (const row of projects) { const maker = await projectMaker(String(row.id)); if (maker) makers.add(maker); }
  return makers.size === 1 && makers.has(actor.id);
}

/** Whether `actor` may change a take or a shot: its own maker, the maker of its project, or an admin. */
export async function mayChangeWork(actor: Actor, work: { createdBy: string | null | undefined; projectId: string | null | undefined }): Promise<boolean> {
  if (isAdmin(actor)) return true;
  if (work.createdBy && work.createdBy === actor.id) return true;
  return (await projectMaker(work.projectId)) === actor.id;
}
