import type { InStatement, ResultSet } from "@libsql/client";
import { createHash } from "node:crypto";
import { db } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { isAgentId } from "./security/people-only";
import { parseSampleMark, SAMPLE_SETTING_KEY } from "./demo/sample";
import { securityAuditStatement } from "./securityAudit";

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

/** Whoever is asking: their id and their role in THIS workspace (`owner` is the workspace's owner, who is an admin too). Without a role a person is a member. */
export type Person = { id: string; role?: string; owner?: boolean };

/**
 * Whether `person` is an admin of the workspace in scope (owner, 13 Oct: "admins CAN open any board in their own workspace ... the work belongs to the workspace.
 * Members still can't see each other's private boards. Never across workspaces."). The role is the one the request's membership carries in this workspace, and
 * every query behind a request runs on this workspace's own database, so the reach never leaves it. An Atomik run or the server is never an admin (it acts as
 * the person who asked, who is asked again where it matters).
 */
export const isWorkspaceAdmin = (person: Person | null | undefined): boolean =>
  /* A token (API or MCP, read-only or not) acts as a plain member whatever its creator's role (owner, 14 Oct): admin reach needs a signed-in admin. */
  !!person && !isAgentId(person.id) && !currentTenant()?.token && (person.role === "admin" || person.owner === true);

/**
 * Where a person's takes and identities go when they delete one of their private boards: a project of their own that nobody else can list or reach
 * (`prj_wb_…`, so nothing in it is shared). Without it the database would unfile them (`ON DELETE SET NULL`) into the shared pool, and the uploads they
 * name would open to the team. One per person; made the first time they delete a board.
 */
export const heldBoardsProjectId = (workspaceId: string, userId: string) => mappedId(DRAFT_PROJECT_PREFIX, workspaceId, userId, "deleted-boards");
export const heldBoardsProductionId = (workspaceId: string, userId: string) => mappedId("prod_wb_", workspaceId, userId, "deleted-boards");

/** Whether `userId` owns the draft whose own production project is `projectId`: the id is a hash of the workspace, the owner and the draft, so it is recomputed for each of the person's drafts (an indexed read). */
export async function ownsDraftProject(userId: string, projectId: string, ex: Exec = db()): Promise<boolean> {
  if (!isDraftProject(projectId)) return false;
  const workspace = requireTenant().id;
  if (projectId === heldBoardsProjectId(workspace, userId)) return true;
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

/**
 * The marked sample production (lib/demo/mark.server.ts), whatever kind of project it is: the explore-only production every viewer opens. It is READ-ONLY for
 * everyone, the workspace's owner and admins included (owner, 12 Oct): nothing is written into it, not its canvas, its saved board, its shots, takes or library;
 * undoing the mark (Settings) lifts it. Making one's own board from it is the one thing that stays.
 */
export async function sampleMarkNow(ex: Exec = db()): Promise<{ projectId: string; draftOwner: string; draftId: string; markedBy: string } | null> {
  let row;
  /* A workspace database not yet set up has no settings table and so no mark. */
  try { row = (await ex.execute({ sql: "SELECT value FROM settings WHERE key=? LIMIT 1", args: [SAMPLE_SETTING_KEY] })).rows[0]; }
  catch (error) { if (/no such table/i.test(String((error as { cause?: unknown; message?: unknown }).cause ?? (error as Error).message))) return null; throw error; }
  if (!row) return null;
  try { const mark = parseSampleMark(JSON.parse(String(row.value))); return mark ? { projectId: mark.projectId, draftOwner: mark.draftOwner, draftId: mark.draftId, markedBy: mark.markedBy } : null; } catch { return null; }
}
/**
 * Who may write the marked sample (owner, 13 Oct: "the sample stays editable for its owner/the platform owner, read-only only for other viewers"): the person whose board it
 * was marked from (the marker whose draft is marked), and the platform owner (`isPlatformOwner`, lib/auth.ts, by the deployment's own record, never a typed address). For
 * them the sample is their own board; for everyone else, admins included, it is read-only. Where there is no mark there is nothing to lock.
 */
export async function mayEditSample(personId: string | null | undefined, ex: Exec = db()): Promise<boolean> {
  if (!personId) return false;
  const mark = await sampleMarkNow(ex);
  if (!mark) return true;
  if (mark.draftOwner === personId) return true;
  return platformOwnerId(personId);
}
/** Whether this account is the platform owner: the check lib/auth.ts › isPlatformOwner makes (the configured address, or the owner of the studio's own workspace), by the address the session carries or, from an id alone, by the accounts the platform owner's identity names. */
async function platformOwnerId(personId: string): Promise<boolean> {
  const user = currentTenant()?.user;
  const { isPlatformOwner } = await import("./auth");
  if (user && user.id === personId && typeof user.email === "string") return isPlatformOwner({ id: user.id, email: user.email });
  const { isOwnerIdentity, platformOwnerIdentity } = await import("./platformOwnerPrivacy");
  return isOwnerIdentity(await platformOwnerIdentity(), { id: personId });
}
/** Whether `projectId` is the marked sample, whoever asks. */
export async function isSampleIdentity(projectId: string | null | undefined, ex: Exec = db()): Promise<boolean> {
  if (!projectId) return false;
  return (await sampleMarkNow(ex))?.projectId === projectId;
}
/**
 * Whether `projectId` is the marked sample AND locked against `person` (default: the person making this request): read-only for every person but those who may edit it
 * (`mayEditSample`), whatever lift is on. The one-run lift (lib/demo/lift.server.ts) lets the RUN spend, and a run writes as an agent or with no person, which is never asked
 * here; the lifter's own presses are not the run's work.
 */
export async function isSampleProject(projectId: string | null | undefined, ex: Exec = db(), person?: { id: string } | null): Promise<boolean> {
  if (!(await isSampleIdentity(projectId, ex))) return false;
  const who = person === undefined ? currentPerson() : person;
  return !(await mayEditSample(who?.id, ex));
}
/** Whether saving this draft would write the sample against `owner` (the key it is stored under; `actor` is the person saving, `owner` unless acting on another's board): a copy someone opened of it (`sample-…`), the marker's own board it was marked from, or any draft linked to it, unless `owner` may edit the sample. */
export async function isSampleDraft(owner: string, draftId: string, productionId: string | null | undefined, ex: Exec = db(), actor: string = owner): Promise<boolean> {
  const mark = await sampleMarkNow(ex);
  if (!mark) return false;
  if (await mayEditSample(actor, ex)) return false;
  return draftId.startsWith("sample-") || (mark.draftOwner === owner && mark.draftId === draftId) || (!!productionId && productionId === mark.projectId);
}

/** The serialized form of the flag the author sets on a shared board; a plain substring test on it keeps a workspace with no shared boards at one cheap pass. */
const SHARED_FLAG = '"teamShared":true';
/**
 * What makes a draft shared with the team: the author's flag in its own saved JSON (a draft whose JSON can't be read is private). The one definition:
 * lib/workbench/team-boards.ts lists and reads shared boards with it, and this file's gate and project lists ask the same question with it.
 * A shared board is either view-only for teammates or editable (`teamEdit`, which only counts together with `teamShared`): none, view, edit.
 */
export const TEAM_SHARED_SQL = "json_valid(body) AND json_extract(body,'$.teamShared') = 1";
/** Shared AND editable by teammates (the share mode "Can edit"). */
export const TEAM_EDIT_SQL = `${TEAM_SHARED_SQL} AND json_extract(body,'$.teamEdit') = 1`;
const SHARED_BOARDS = `SELECT owner, project_id, json_extract(body,'$.teamEdit') AS edit FROM workbench_projects WHERE instr(body, '${SHARED_FLAG}')>0 AND ${TEAM_SHARED_SQL}`;

/** How a board is shared with the team: not at all, to look at, or to edit. */
export type ShareMode = "none" | "view" | "edit";

/**
 * How the author has shared this draft's board: `teamShared: true` in the draft's saved body (set only by the `team-share` action, lib/workbench/records.ts ›
 * setBoardSharing), plus `teamEdit: true` for "Can edit". Anything but a shared board answers "none". Teammates READ a "view" board; they also WRITE an
 * "edit" board (mayReachProject).
 */
export async function draftShareMode(projectId: string, ex: Exec = db()): Promise<ShareMode> {
  return (await draftShare(projectId, ex)).mode;
}

/** The share mode and the key the shared board is stored under (null when it is not shared). */
export async function draftShare(projectId: string, ex: Exec = db()): Promise<{ mode: ShareMode; owner: string | null }> {
  if (!isDraftProject(projectId)) return { mode: "none", owner: null };
  const workspace = requireTenant().id;
  const rows = (await ex.execute({ sql: SHARED_BOARDS, args: [] })).rows;
  const hit = rows.find((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, String(row.owner), String(row.project_id)) === projectId);
  return !hit ? { mode: "none", owner: null } : { mode: Number(hit.edit) === 1 ? "edit" : "view", owner: String(hit.owner) };
}

/**
 * Whether `accountId` is an active member of this workspace: the membership and the account are not disabled, the account is not deleted. A board whose maker
 * is not one is read-only to everyone else (its "Can edit" mode lapses with its maker), and is not acted on.
 */
export async function isActiveMember(accountId: string): Promise<boolean> {
  const { platformDb, platformReady } = await import("./platform");
  await platformReady();
  const rows = (await platformDb().execute({
    sql: `SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.workspace_id = ? AND m.account_id = ? AND m.disabled = 0 AND a.disabled = 0 AND a.deleted_at IS NULL LIMIT 1`,
    args: [requireTenant().id, accountId],
  })).rows;
  return rows.length > 0;
}

/** Whether the author has shared this draft's board with the team (to look at, or to edit). */
export async function draftIsTeamShared(projectId: string, ex: Exec = db()): Promise<boolean> {
  return (await draftShareMode(projectId, ex)) !== "none";
}

/**
 * The person making this request: the signed-in user of the workspace in scope (a token too), or nobody. Background work has no person, and an Atomik
 * run (`agent:…`) acts through the run's owner, who was asked when the run was started: neither is asked again here.
 */
export function currentPerson(): Person | null {
  const user = currentTenant()?.user;
  return user && !isAgentId(user.id) ? { id: user.id, role: user.role, owner: user.owner } : null;
}

/**
 * Whether `person` may reach the draft project `projectId`: its owner, for reading and writing; the marked sample, for everyone, as before; a board the
 * author has shared (`teamShared`), for READING, or for writing too when shared with "Can edit" (`teamEdit`). Any other project is the workspace's.
 */
export async function mayReachProject(person: Person | null, projectId: string | null | undefined, access: "read" | "write" | "admit" = "write", ex: Exec = db(), options: { admin?: boolean } = {}): Promise<boolean> {
  if (!person) return true;
  /* The sample is nobody's to write: not its marker's, not the workspace owner's or an admin's. */
  if (access === "write" && (await isSampleProject(projectId, ex, person))) return false;
  if (!isDraftProject(projectId)) return true;
  if (await ownsDraftProject(person.id, projectId!, ex)) return true;
  if (await isMarkedSample(projectId!, ex)) return true;
  /* A shared board is the team's to read; one shared with "Can edit" is also theirs to write and to render on. Sharing settings, rename and delete are not
     this rule's: they stay the owner's or an admin's (lib/workAccess.ts, lib/workbench/team-boards.ts › maySetSharing). */
  const { mode, owner } = await draftShare(projectId!, ex);
  if (access === "read" && mode !== "none") return true;
  /* Can edit lapses with its maker: a disabled or removed owner's board refuses writes everywhere (the canvas, its rooms, a render's admission), and stays readable. */
  if (access !== "read" && mode === "edit" && !!owner && (await isActiveMember(owner))) return true;
  /* An admin of this workspace reaches any board in it, to look at and to write (not to render on: a render's admission is the board's owner's or an editor's, as
     before). Each such reach of a board that is not shared that way is written to the workspace's history first, and without that line there is no reach. */
  if (access === "admit" || options.admin === false || !isWorkspaceAdmin(person)) return false;
  return recordAdminReach(person.id, projectId!, access, ex);
}

/** The draft that holds the board whose own production project is `projectId`, by the one hash that names it: its owner's key and its draft id. Null when no draft of this workspace maps to it. */
export async function boardDraftOf(projectId: string, ex: Exec = db()): Promise<{ owner: string; draftId: string } | null> {
  if (!isDraftProject(projectId)) return null;
  const workspace = requireTenant().id;
  const rows = (await ex.execute({ sql: "SELECT owner, project_id FROM workbench_projects", args: [] })).rows;
  const hit = rows.find((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, String(row.owner), String(row.project_id)) === projectId);
  return hit ? { owner: String(hit.owner), draftId: String(hit.project_id) } : null;
}

/** An admin looks at (`board.opened_by_admin`) or changes (`board.edited_by_admin`) a member's private board: one line in the workspace's security history, the board's owner reads it as "Viewed by". */
const ADMIN_REACH_ACTIONS = { read: "board.opened_by_admin", write: "board.edited_by_admin" } as const;
/** An admin working on a board is one line for a while, not one for every save or request. */
export const ADMIN_REACH_LINE_MS = 15 * 60_000;

async function recordAdminReach(adminId: string, projectId: string, access: "read" | "write", ex: Exec): Promise<boolean> {
  /* Only a board that exists in this workspace: an id no draft maps to is nobody's. A READ of a board whose draft is gone (held or deleted: its takes remain) is audited the same way,
     against the board's id (owner, 14 Oct, 23:35: no exception); an id with neither a draft nor takes is nobody's. A write needs the draft. */
  const board = await boardDraftOf(projectId, ex);
  if (!board && (access !== "read" || !(await ex.execute({ sql: "SELECT 1 FROM generations WHERE project_id=? LIMIT 1", args: [projectId] })).rows.length)) return false;
  try {
    const action = ADMIN_REACH_ACTIONS[access], at = Date.now();
    const recent = (await ex.execute({
      sql: "SELECT 1 FROM security_audit WHERE workspace_id=? AND actor_id=? AND action=? AND target_id=? AND created_at>? LIMIT 1",
      args: [requireTenant().id, adminId, action, projectId, at - ADMIN_REACH_LINE_MS],
    })).rows.length > 0;
    if (!recent) await ex.execute(securityAuditStatement({ workspaceId: requireTenant().id, actorId: adminId, action, targetType: "board", targetId: projectId }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "board.admin_reach_unrecorded", message: error instanceof Error ? error.message : "unknown" }));
    return false;
  }
}

/** A filter for lists of projects: what `person` may see among them (reading). One read of the person's drafts, of shared boards and of the sample mark, then a set lookup per row. */
/**
 * The boards a teammate may look at, by the one definition: every draft its author has shared with the team (`teamShared`), and the marked sample
 * (lib/demo/mark.server.ts), for everyone. `projects` are those boards' own project ids (`prj_wb_…`); `drafts` the saved drafts behind them (owner and draft id),
 * whose bodies are what a teammate sees. Whoever opens the boards sees what these hold; the project filter and the upload rule both read this.
 */
export async function sharedBoards(ex: Exec = db()): Promise<{ projects: string[]; drafts: { owner: string; draftId: string }[] }> {
  const workspace = requireTenant().id;
  const rows = (await ex.execute({ sql: SHARED_BOARDS, args: [] })).rows;
  const projects = rows.map((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, String(row.owner), String(row.project_id)));
  const drafts = rows.map((row) => ({ owner: String(row.owner), draftId: String(row.project_id) }));
  /* The marked sample is one definition (sampleMarkNow above): shown to everyone, whatever its kind of project. */
  const sample = await sampleMarkNow(ex);
  if (sample) { projects.push(sample.projectId); drafts.push({ owner: sample.draftOwner, draftId: sample.draftId }); }
  return { projects, drafts };
}

export async function projectLister(person: Person | null, ex: Exec = db(), opts: { only?: string | null } = {}): Promise<(projectId: string | null | undefined) => boolean> {
  if (!person) return () => true;
  const workspace = requireTenant().id;
  const own = new Set((await ex.execute({ sql: "SELECT project_id FROM workbench_projects WHERE owner=?", args: [person.id] })).rows.map((row) => mappedId(DRAFT_PROJECT_PREFIX, workspace, person.id, String(row.project_id))));
  own.add(heldBoardsProjectId(workspace, person.id));
  const boards = await sharedBoards(ex);
  const shared = new Set(boards.projects);
  /* A list is the person's boards and the team's shared ones, an admin's too: it is a list, and a board's contents are not read board by board. When an admin asks for ONE board
     (`only`), that board is added through the gate that writes the workspace's history line (mayReachProject), so opening a member's private board is never unrecorded. */
  const everyone = isWorkspaceAdmin(person) && opts.only && isDraftProject(opts.only) && !own.has(opts.only) && !shared.has(opts.only) && (await mayReachProject(person, opts.only, "read", ex)) ? opts.only : null;
  return (projectId) => !isDraftProject(projectId) || own.has(projectId!) || shared.has(projectId!) || (!!everyone && projectId === everyone);
}

/** An id that names no project: a route that must answer a private board exactly as it answers an unknown id runs on this in the board's place. */
export const NO_SUCH_PROJECT = "\u0000unknown";
/** `projectId` when `person` may reach it for `access`, else the id of no project: the one question, always asked, so the reads that follow are the same either way. */
export async function reachableOr(person: Person | null, projectId: string, access: "read" | "write" = "write", ex: Exec = db()): Promise<string> {
  return (await mayReachProject(person, projectId, access, ex)) ? projectId : NO_SUCH_PROJECT;
}

/** Whether `projectId` names a project of this workspace: a write that goes to a project asks this before it inserts, so an unknown id and an unreachable one are refused the same way, here, and not by whatever a foreign key does. */
export async function projectExists(projectId: string, ex: Exec = db()): Promise<boolean> {
  if (projectId === NO_SUCH_PROJECT) return false;
  return (await ex.execute({ sql: "SELECT 1 AS found FROM projects WHERE id = ? LIMIT 1", args: [projectId] })).rows.length > 0;
}

/**
 * Whether `person` can see that a production is there: one whose every project is a private board of someone else's is, to them, a production that does not exist
 * (a production with no project of its own, or with any project they may read, is the workspace's). Asked before the rules about who may CHANGE a production
 * (lib/workAccess.ts), so a refusal never confirms that a private board's production exists.
 */
export async function productionReachable(person: Person | null, productionId: string, ex: Exec = db()): Promise<boolean> {
  if (!person) return true;
  const rows = (await ex.execute({ sql: "SELECT id FROM projects WHERE production_id = ?", args: [productionId] })).rows;
  if (!rows.length) return true;
  for (const row of rows) if (await mayReachProject(person, String(row.id), "read", ex)) return true;
  return false;
}

/* ── The takes of a private board ─────────────────────────────────────────────────────────────────────────────────── */

/** Whoever is asking: the signed-in person (a token acts as its person), or nobody (background work, which is not asked). */
export type Viewer = { id: string; role?: string } | null;

/**
 * Who may see the TAKES filed under a private board (a `prj_wb_…` project, lib/draftProject.ts). Owner decision: the board's owner always, a teammate
 * only once it is shared (to look at) or if it is the marked sample. A workspace admin sees none of another's private takes in a list (the Library, the jobs list, a board's
 * library, the usage screen's recent takes): the lists hide them, and the admin opens the board, which goes through `mayReachProject` (audited, failing closed: no history
 * line, no read). The one screen that needs them in a list, the approvals queue, asks that gate for each board it shows (lib/control-room/approvals.server.ts). A board whose
 * draft is gone (held or deleted) is no exception (owner, 14 Oct, 23:35): the same lists hide it, and a read of it is the same audited gate. Another workspace's people never reach these queries at all.
 */

/**
 * Who may make a client review link for `projectId` (owner, 14 Oct, 22:50: "the board's OWNER can create a client link for their own private board, admin or not. Nobody
 * else can make one on someone else's private board (admins included)"):
 *  - "owner": the person owns the board, whatever their role;
 *  - "none": a private board (a draft board that is not shared and not the marked sample) that is not theirs: the routes answer as for a production that is not saved;
 *  - "admin": anything else (an ordinary production, a shared board, the sample): today's rule, the routes ask for an admin.
 * A board that does not exist is not asked here: the routes check that first and answer the same.
 */
export type ClientLinkVerdict = "owner" | "admin" | "none";
export async function clientLinkVerdict(person: Person, projectId: string, ex: Exec = db()): Promise<ClientLinkVerdict> {
  if (!isDraftProject(projectId)) return "admin";
  if (await ownsDraftProject(person.id, projectId, ex)) return "owner";
  const isPrivate = !(await isMarkedSample(projectId, ex)) && (await draftShare(projectId, ex)).mode === "none";
  return isPrivate ? "none" : "admin";
}

/** Whether `viewer` may see a take filed under `projectId`: one read for a private board, none for anything else. */
export async function mayReadTake(viewer: Viewer, projectId: string | null | undefined, ex: Exec = db()): Promise<boolean> {
  if (!viewer || !isDraftProject(projectId)) return true;
  return mayReachProject(viewer, projectId, "read", ex);
}

/**
 * The private boards' project ids that hold takes AND that `viewer` may see, or null when nothing needs hiding (an admin, nobody, or no take is filed
 * under a private board). A list of takes keeps those takes of ordinary projects and of unfiled work, and of these boards only: counts, pages and
 * cursors are then the viewer's own, because the rows are left out in the query, not after it.
 */
export async function visibleBoardsOfTakes(viewer: Viewer, ex: Exec = db(), only?: string | null): Promise<string[] | null> {
  if (!viewer) return null;
  const held = (await ex.execute({ sql: "SELECT DISTINCT project_id FROM generations WHERE project_id GLOB 'prj_wb_*'", args: [] })).rows.map((row) => String(row.project_id));
  if (!held.length) return null;
  /* `only`: the one board this list was asked for (a board's own library): for an admin it is added through the audited gate, so opening it is never unrecorded. */
  const listed = await projectLister(viewer, ex, { only });
  return held.filter((id) => listed(id));
}

/** The SQL a list of takes adds: unfiled or ordinary takes, or those of a private board the viewer may see. Arguments follow the clause. */
export function visibleTakesClause(visible: string[]): { sql: string; args: unknown[] } {
  return {
    sql: "(g.project_id IS NULL OR g.project_id NOT GLOB 'prj_wb_*' OR g.project_id IN (SELECT value FROM json_each(?)))",
    args: [JSON.stringify(visible)],
  };
}

/** Which of the projects `viewer` may see the takes of, as a lookup: everything for nobody (background work), else `projectLister`'s (their own boards, shared ones, the sample, ordinary productions), an admin included. */
export async function takeLister(viewer: Viewer, ex: Exec = db(), only?: string | null): Promise<(projectId: string | null | undefined) => boolean> {
  if (!viewer) return () => true;
  /* `only`: the one board this view was asked for; for a signed-in admin it is added through the audited gate (a token is a plain member's). */
  return projectLister(viewer, ex, { only });
}

/** `projectId` when `viewer` may READ that project (its owner, an admin of the workspace, anyone for a shared board or the sample), else null, no project: what a route that feeds a project's takes, titles or prompts to a model runs on, so nothing of a private board is read and no record (a meter line, a reservation, a memory) is ever written against it or against a placeholder id. */
export async function readableProjectOr(viewer: Viewer, projectId: string | null | undefined, ex: Exec = db()): Promise<string | null> {
  if (projectId == null) return null;
  /* The audited gate, for every board an admin did not make, a held or deleted one too (owner, 14 Oct, 23:35). */
  return (await mayReachProject(viewer, projectId, "read", ex)) ? projectId : null;
}

/**
 * The private boards `person` may take the takes of into an EXPORT, as a set, or null when nothing needs hiding (nobody, background work, or no take is filed under a private board).
 * An export is the one place an admin takes every member's work out of the workspace at once, so it is complete, with its audit (owner, 15 Oct 2026: "Admin exports include
 * private boards, with one audit line per private board per export"): each private board that holds a take goes through the audited read once, `mayReachProject(..., "read")`, which
 * writes one history line for it (ids and action only) under the 15-minute rule, and a board whose line cannot be written is left out (no line, no read). The person's own boards and
 * shared ones need no line; a member gets only what they could see.
 */
export async function exportableBoards(person: Person | null, ex: Exec = db()): Promise<Set<string> | null> {
  if (!person) return null;
  const held = (await ex.execute({ sql: "SELECT DISTINCT project_id FROM generations WHERE project_id GLOB 'prj_wb_*'", args: [] })).rows.map((row) => String(row.project_id));
  if (!held.length) return null;
  const readable = new Set<string>();
  for (const id of held) if (await mayReachProject(person, id, "read", ex)) readable.add(id);
  return readable;
}
