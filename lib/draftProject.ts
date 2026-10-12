import type { InStatement, ResultSet } from "@libsql/client";
import { createHash } from "node:crypto";
import { db } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { isAgentId } from "./security/people-only";
import { parseSampleMark, SAMPLE_SETTING_KEY } from "./demo/sample";

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
 * The marked sample production (lib/demo/mark.server.ts) is the marker's own `prj_wb_…` board, and it is meant for everyone: each viewer opens a copy of it
 * (lib/demo/open.server.ts) linked to it and reads and writes its canvas. So it is shared for both, as it was before private boards were gated. An undone
 * mark (`hiddenAt`) reads as none.
 */
export async function isMarkedSample(projectId: string, ex: Exec = db()): Promise<boolean> {
  if (!isDraftProject(projectId)) return false;
  const row = (await ex.execute({ sql: "SELECT value FROM settings WHERE key=? LIMIT 1", args: [SAMPLE_SETTING_KEY] })).rows[0];
  if (!row) return false;
  let raw: unknown = row.value;
  try { raw = JSON.parse(String(row.value)); } catch { /* an unreadable mark marks nothing */ return false; }
  return parseSampleMark(raw)?.projectId === projectId;
}

/** The serialized form of the flag the author sets on a shared board; a plain substring test on it keeps a workspace with no shared boards at one cheap pass. */
const SHARED_FLAG = '"teamShared":true';
/**
 * What makes a draft shared with the team: the author's flag in its own saved JSON (a draft whose JSON can't be read is private). The one definition:
 * lib/workbench/team-boards.ts lists and reads shared boards with it, and this file's gate and project lists ask the same question with it.
 */
export const TEAM_SHARED_SQL = "json_valid(body) AND json_extract(body,'$.teamShared') = 1";
const SHARED_BOARDS = `SELECT owner, project_id FROM workbench_projects WHERE instr(body, '${SHARED_FLAG}')>0 AND ${TEAM_SHARED_SQL}`;

/**
 * Whether the author has shared this draft's board with the team: `teamShared: true` in the draft's saved body (set by the author, #667's `lib/workbench/team-boards.ts`). Nothing
 * writes the flag on release/1, so this answers false for every board until it exists; it is the one place the gate learns about sharing. A shared board is
 * for teammates to READ (view-only); writes stay the owner's.
 */
export async function draftIsTeamShared(projectId: string, ex: Exec = db()): Promise<boolean> {
  if (!isDraftProject(projectId)) return false;
  const workspace = requireTenant().id;
  const rows = (await ex.execute({ sql: SHARED_BOARDS, args: [] })).rows;
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

/**
 * Whether `person` may reach the draft project `projectId`: its owner, for reading and writing; the marked sample, for everyone, as before; a board the
 * author has shared (`teamShared`), for READING only. Any other project is the workspace's.
 */
export async function mayReachProject(person: { id: string } | null, projectId: string | null | undefined, access: "read" | "write" = "write", ex: Exec = db()): Promise<boolean> {
  if (!person || !isDraftProject(projectId)) return true;
  if (await ownsDraftProject(person.id, projectId!, ex)) return true;
  if (await isMarkedSample(projectId!, ex)) return true;
  return access === "read" && (await draftIsTeamShared(projectId!, ex));
}

/** A filter for lists of projects: what `person` may see among them (reading). One read of the person's drafts, of shared boards and of the sample mark, then a set lookup per row. */
export async function projectLister(person: { id: string } | null, ex: Exec = db()): Promise<(projectId: string | null | undefined) => boolean> {
  if (!person) return () => true;
  const workspace = requireTenant().id;
  const own = new Set((await ex.execute({ sql: "SELECT project_id FROM workbench_projects WHERE owner=?", args: [person.id] })).rows.map((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, person.id, String(row.project_id))));
  const shared = new Set((await ex.execute({ sql: SHARED_BOARDS, args: [] })).rows.map((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, String(row.owner), String(row.project_id))));
  const mark = (await ex.execute({ sql: "SELECT value FROM settings WHERE key=? LIMIT 1", args: [SAMPLE_SETTING_KEY] })).rows[0];
  let sample: string | null = null;
  if (mark) { try { sample = parseSampleMark(JSON.parse(String(mark.value)))?.projectId ?? null; } catch { sample = null; } }
  return (projectId) => !isDraftProject(projectId) || own.has(projectId!) || shared.has(projectId!) || projectId === sample;
}

/** An id that names no project: a route that must answer a private board exactly as it answers an unknown id runs on this in the board's place. */
export const NO_SUCH_PROJECT = "\u0000unknown";
/** `projectId` when `person` may reach it for `access`, else the id of no project: the one question, always asked, so the reads that follow are the same either way. */
export async function reachableOr(person: { id: string } | null, projectId: string, access: "read" | "write" = "write", ex: Exec = db()): Promise<string> {
  return (await mayReachProject(person, projectId, access, ex)) ? projectId : NO_SUCH_PROJECT;
}

/** Whether `projectId` names a project of this workspace: a write that goes to a project asks this before it inserts, so an unknown id and an unreachable one are refused the same way, here, and not by whatever a foreign key does. */
export async function projectExists(projectId: string, ex: Exec = db()): Promise<boolean> {
  if (projectId === NO_SUCH_PROJECT) return false;
  return (await ex.execute({ sql: "SELECT 1 AS found FROM projects WHERE id = ? LIMIT 1", args: [projectId] })).rows.length > 0;
}
