import type { InStatement, ResultSet } from "@libsql/client";
import { createHash } from "node:crypto";
import { db } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { isAgentId } from "./security/people-only";

type Exec = { execute(statement: InStatement): Promise<ResultSet> };

/** A stable id derived from its parts (a draft's production project, its production, a node's shot). */
export function mappedId(prefix: string, ...parts: string[]) {
  return prefix + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/**
 * A draft's own production project: one person's board, nothing in it is shared (lib/workbench/records.ts › linkProduction). Its team canvas, the
 * listing of the project and the uploads it holds are its owner's alone, until the author shares the board (`teamShared`, see below).
 */
export const DRAFT_PROJECT_PREFIX = "prj_wb_";
export const isDraftProject = (projectId: string | null | undefined): boolean => typeof projectId === "string" && projectId.startsWith(DRAFT_PROJECT_PREFIX);

/** Whether `userId` owns the draft whose own production project is `projectId`: the id is a hash of the workspace, the owner and the draft, so it is recomputed for each of the person's drafts (an indexed read). */
export async function ownsDraftProject(userId: string, projectId: string, ex: Exec = db()): Promise<boolean> {
  if (!isDraftProject(projectId)) return false;
  const workspace = requireTenant().id;
  const drafts = (await ex.execute({ sql: "SELECT project_id FROM workbench_projects WHERE owner=?", args: [userId] })).rows;
  return drafts.some((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, userId, String(row.project_id)) === projectId);
}

/**
 * Whether the author has shared this draft's board with the team: `teamShared: true` in the draft's saved body (set by the author, lane A's #667). Nothing
 * writes the flag on release/1, so this answers false for every board until it exists; it is the one place the gate learns about sharing. A shared board is
 * for teammates to read (view-only) as that PR decides; writes stay the owner's.
 */
export async function draftIsTeamShared(projectId: string, ex: Exec = db()): Promise<boolean> {
  if (!isDraftProject(projectId)) return false;
  const workspace = requireTenant().id;
  const rows = (await ex.execute({ sql: "SELECT owner, project_id FROM workbench_projects WHERE json_valid(body) AND json_extract(body,'$.teamShared')=1", args: [] })).rows;
  return rows.some((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, String(row.owner), String(row.project_id)) === projectId);
}

/**
 * The person making this request: the signed-in user of the workspace in scope (a token too), or nobody. Background work has no person, and an Atomik
 * run (`agent:…`) acts through the run's owner, who was asked when the run was started: neither is asked again here.
 */
export function currentPerson(): { id: string; role?: string } | null {
  const user = currentTenant()?.user;
  return user && !isAgentId(user.id) ? { id: user.id, role: user.role } : null;
}

/** Whether `person` may reach the draft project `projectId` (its team canvas, its listing): its owner; a teammate only once the author has shared it. Any other project is the workspace's. */
export async function mayReachProject(person: { id: string } | null, projectId: string | null | undefined, ex: Exec = db()): Promise<boolean> {
  if (!person || !isDraftProject(projectId)) return true;
  return (await ownsDraftProject(person.id, projectId!, ex)) || (await draftIsTeamShared(projectId!, ex));
}

/** A filter for lists of projects: what `person` may see among them. One read of the person's drafts (and of shared ones), then a set lookup per row. */
export async function projectLister(person: { id: string } | null, ex: Exec = db()): Promise<(projectId: string | null | undefined) => boolean> {
  if (!person) return () => true;
  const workspace = requireTenant().id;
  const own = new Set((await ex.execute({ sql: "SELECT project_id FROM workbench_projects WHERE owner=?", args: [person.id] })).rows.map((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, person.id, String(row.project_id))));
  const shared = new Set((await ex.execute({ sql: "SELECT owner, project_id FROM workbench_projects WHERE json_valid(body) AND json_extract(body,'$.teamShared')=1", args: [] })).rows
    .map((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, String(row.owner), String(row.project_id))));
  return (projectId) => !isDraftProject(projectId) || own.has(projectId!) || shared.has(projectId!);
}
