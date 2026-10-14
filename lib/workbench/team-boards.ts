/**
 * Teammates' boards (owner, 12 Oct 2026): a member opens, view-only, the boards a teammate has SHARED with the workspace's team, and only those.
 *
 * A board is a private draft of its maker (`workbench_projects`, keyed by owner and project id, inside the workspace's own database). It stays
 * private unless its author shares it: `teamShared: true` in the draft's own saved JSON (lib/workbench/studio-schema.ts), set only by the author
 * and off for every board that exists. A private draft is never listed and never read by a teammate (a read answers `null`, as it always did, and
 * its uploads are named nowhere a teammate reads); a shared one is read whole, script and uploads included. Its productions, shots, takes and files
 * already belong to the whole workspace. Nothing a teammate does ever writes to someone else's draft (every write is keyed by the signed-in person).
 *
 * Tenancy: every read is on `db()`, the signed-in workspace's own database, and the people named are that workspace's own active members
 * (the platform's memberships for this workspace id). Another workspace's boards are in another database and never reachable from here.
 * The platform owner reads as "Particl support" with an opaque id outside the house (lib/platformOwnerPrivacy.ts), as on the Team page.
 */
import { db } from "@/lib/db";
import { boardDraftOf, boardOwnerRows, ownedDrafts, DRAFT_PROJECT_PREFIX, isWorkspaceAdmin, mappedId, mayEditSample, mayReachProject, sampleMarkNow, TEAM_EDIT_SQL, TEAM_SHARED_SQL, type Person } from "@/lib/draftProject";
import { platformDb, platformReady } from "@/lib/platform";
import { ownerMaskFor, resolveMemberId, storedActorMaskHere, supportMemberId } from "@/lib/platformOwnerPrivacy";
import type { TenantWorkspace } from "@/lib/tenant";
import { readDraft, workbenchReady } from "./records";
export { viewOnlyLine, viewOnlyRefusal } from "./view-only";

export type BoardOwner = { id: string; name: string; support?: true; /** An admin reads the board of someone who is no longer a member here. */ former?: true };
export type TeamBoard = { id: string; name: string; revision: number; updatedAt: number; kind?: string | null; owner: BoardOwner; mine: boolean };

type Member = { id: string; email: string; name: string };

/** The workspace's active members: not disabled, account not disabled or deleted. */
async function activeMembers(ws: Pick<TenantWorkspace, "id">): Promise<Map<string, Member>> {
  await platformReady();
  const rows = (await platformDb().execute({
    sql: `SELECT a.id, a.email, a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.disabled = 0 AND a.disabled = 0 AND a.deleted_at IS NULL`,
    args: [ws.id],
  })).rows as unknown as Member[];
  return new Map(rows.map((r) => [String(r.id), { id: String(r.id), email: String(r.email), name: String(r.name) }]));
}

async function ownerOf(ws: Pick<TenantWorkspace, "id">, people: Map<string, Member>, accountId: string): Promise<BoardOwner | null> {
  const person = people.get(accountId);
  if (!person) return null;
  const mask = await ownerMaskFor(ws);
  return mask.hides(person) ? { id: supportMemberId(ws.id, accountId), name: mask.name(person), support: true } : { id: accountId, name: person.name };
}

const KIND = "CASE WHEN json_valid(body) THEN COALESCE(NULLIF(json_extract(body,'$.boardKind'),''),CASE WHEN NULLIF(json_extract(body,'$.marketingBrief'),'') IS NOT NULL OR NULLIF(json_extract(body,'$.moleculr'),'') IS NOT NULL THEN 'ads' END) END AS kind";

/** Whose a stored draft is now: the person it was handed to, else the key it is stored under. Read once for a pass over many drafts. */
async function whoOwns(): Promise<(key: string, draftId: string) => string> {
  const handed = new Map((await boardOwnerRows()).map((h) => [`${h.draftOwner}\u0000${h.draftId}`, h.owner]));
  return (key, draftId) => handed.get(`${key}\u0000${draftId}`) ?? key;
}
/** The key a draft is stored under, from the owner a request names: a board handed to that person is stored under its first owner's key; otherwise the key is the name itself. */
async function storageKeyFor(ownerId: string, draftId: string): Promise<string> {
  const hit = (await boardOwnerRows()).find((h) => h.owner === ownerId && h.draftId === draftId && h.draftOwner !== ownerId);
  return hit ? hit.draftOwner : ownerId;
}

/** What makes a draft shared: the author's flag in its own JSON (and a draft whose JSON can't be read is private). The one definition, shared with the project gate (lib/draftProject.ts). */
const SHARED = TEAM_SHARED_SQL;

/** The boards shared with the team by the workspace's active members, newest first, the caller's own marked (a private draft is in no one's list). */
export async function listTeamBoards(ws: Pick<TenantWorkspace, "id">, me: string, options: { kinds?: boolean } = {}): Promise<TeamBoard[]> {
  await workbenchReady();
  const people = await activeMembers(ws);
  const rows = (await db().execute({ sql: `SELECT project_id AS id, owner, name, revision, updated_at AS updatedAt${options.kinds ? `, ${KIND}` : ""} FROM workbench_projects WHERE ${SHARED} ORDER BY updated_at DESC LIMIT 200` })).rows;
  const out: TeamBoard[] = [];
  const owns = await whoOwns();
  for (const row of rows) {
    const now = owns(String(row.owner), String(row.id));
    const owner = await ownerOf(ws, people, now);
    if (!owner) continue;
    out.push({ id: String(row.id), name: String(row.name), revision: Number(row.revision), updatedAt: Number(row.updatedAt), ...(options.kinds ? { kind: row.kind == null ? null : String(row.kind) } : {}), owner, mine: now === me });
  }
  return out;
}

/** A teammate's shared board, whole, to look at: null when that person is not an active member here, has no such board, or has not shared it. */
export async function readTeamBoard(ws: Pick<TenantWorkspace, "id">, me: string, ownerParam: string, id: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner; key: string } | null> {
  const accountId = await resolveMemberId(ws, ownerParam);
  if (accountId === me) return null;
  /* The key the draft is stored under: a board handed to the person named is stored under its first owner's key, and a first owner no longer owns what was handed away. */
  const key = await storageKeyFor(accountId, id);
  if ((await whoOwns())(key, id) !== accountId) return null;
  const people = await activeMembers(ws);
  const owner = await ownerOf(ws, people, accountId);
  if (!owner) return null;
  /* Shared is asked of the stored row first: a private draft (or one that can't be read) is never opened, however it is asked for. */
  await workbenchReady();
  if (!(await db().execute({ sql: `SELECT 1 FROM workbench_projects WHERE key=? AND ${SHARED}`, args: [`${key}:${id}`] })).rows.length) return null;
  const draft = await readDraft(key, id);
  return draft && draft.project.teamShared === true ? { ...draft, owner, key } : null;
}

/**
 * The maker of a SHARED board that is not the caller's, when the caller has no such board themselves: a save of it must not become a second copy.
 * A private draft is no one's to know of: it answers null, exactly as an id nobody has would, and names no one.
 */
export async function otherOwnersBoard(ws: Pick<TenantWorkspace, "id">, me: string, id: string): Promise<BoardOwner | null> {
  await workbenchReady();
  /* The caller's own board (the common save) is one primary-key read; only a new id looks further. */
  const owns = await whoOwns();
  if ((await db().execute({ sql: "SELECT 1 FROM workbench_projects WHERE key=?", args: [`${me}:${id}`] })).rows.length && owns(me, id) === me) return null;
  const rows = (await db().execute({ sql: `SELECT owner FROM workbench_projects WHERE project_id=? AND ${SHARED}`, args: [id] })).rows;
  if (!rows.length) return null;
  const people = await activeMembers(ws);
  for (const row of rows) { const owner = await ownerOf(ws, people, owns(String(row.owner), id)); if (owner) return owner; }
  return null;
}

/**
 * A teammate's shared board asked for by its id alone (a board link): the one board with that id in this workspace that belongs to an active member
 * other than the caller and is shared. A private draft is null here, whoever asks.
 */
export async function findTeamBoard(ws: Pick<TenantWorkspace, "id">, me: string, id: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner; key: string } | null> {
  await workbenchReady();
  const rows = (await db().execute({ sql: `SELECT owner FROM workbench_projects WHERE project_id=? AND ${SHARED} ORDER BY updated_at DESC`, args: [id] })).rows;
  const people = await activeMembers(ws);
  const owns = await whoOwns();
  for (const row of rows) {
    const now = owns(String(row.owner), id);
    if (now === me) continue;
    const owner = await ownerOf(ws, people, now);
    if (!owner) continue;
    const draft = await readDraft(String(row.owner), id);
    if (draft && draft.project.teamShared === true) return { ...draft, owner, key: String(row.owner) };
  }
  return null;
}

/** The SHARED board whose own production project is `productionId` (lib/draftProject.ts): its draft id and its maker as a teammate sees them; null when that board is not shared or its maker is not an active member. */
export async function sharedBoardOfProduction(ws: Pick<TenantWorkspace, "id">, productionId: string): Promise<{ draftId: string; owner: BoardOwner; key: string } | null> {
  await workbenchReady();
  const rows = (await db().execute({ sql: `SELECT owner, project_id FROM workbench_projects WHERE ${SHARED}`, args: [] })).rows;
  const hit = rows.find((row) => mappedId(DRAFT_PROJECT_PREFIX, ws.id, String(row.owner), String(row.project_id)) === productionId);
  if (!hit) return null;
  const owner = await ownerOf(ws, await activeMembers(ws), (await whoOwns())(String(hit.owner), String(hit.project_id)));
  return owner ? { draftId: String(hit.project_id), owner, key: String(hit.owner) } : null;
}

/** The maker of the SHARED board whose own production project is `productionId`, as a teammate sees them. */
export async function sharedBoardOwnerOf(ws: Pick<TenantWorkspace, "id">, productionId: string): Promise<BoardOwner | null> {
  return (await sharedBoardOfProduction(ws, productionId))?.owner ?? null;
}

/** The view-only owner the marked sample production names: the person who marked it, as a teammate sees them (the platform owner as "Particl support" outside the house); "Sample" when they are no longer an active member. */
export async function sampleViewOnly(ws: Pick<TenantWorkspace, "id">): Promise<{ owner: BoardOwner }> {
  const mark = await sampleMarkNow();
  const owner = mark?.markedBy ? await ownerOf(ws, await activeMembers(ws), mark.markedBy) : null;
  return { owner: owner ?? { id: "", name: "Sample" } };
}

/**
 * Whether `actor` may write the board `draftId` stored under `owner`'s key, who is not the actor: an EXPLICIT grant, never `mayReachProject`'s default alone.
 * That default answers yes for every production that is not a private board's own (the workspace's), and a draft can be linked to such a production (a
 * starter draft, one opened from a production or a take link). So all of these hold, decided from identifiers before the draft is read:
 *   1. the key is an active member of this workspace;
 *   2. a grant names this board: the marked sample's editors, for the sample's own draft (#694); or the board is shared with "Can edit" (`teamEdit`, set only
 *      by the team-share action); the admin rule adds its own line here;
 *   3. the board is the draft's own private production (`mappedId(prj_wb_, workspace, owner, draftId)`), which the draft is linked to, and the actor may
 *      write it (`mayReachProject`, asked after the grant, never instead of it).
 */
export async function mayWriteBoard(ws: Pick<TenantWorkspace, "id">, actor: Person, owner: string, draftId: string): Promise<boolean> {
  return writeGrant(ws, actor, owner, draftId, true);
}

/** `mayWriteBoard`, with the admin rule on or off: opening a board asks it OFF first (an admin looks, and edits only if they choose; `openingOf`). */
async function writeGrant(ws: Pick<TenantWorkspace, "id">, actor: Person, owner: string, draftId: string, admin: boolean): Promise<boolean> {
  /* `owner` is the key the draft is stored under; whose it is now may be someone else (a board handed over). */
  const now = (await whoOwns())(owner, draftId);
  const board = mappedId(DRAFT_PROJECT_PREFIX, ws.id, owner, draftId);
  /* One narrow read of the board's row (its production and whether it is shared for editing), not the board and not a scan of every shared board. */
  await workbenchReady();
  const row = (await db().execute({ sql: `SELECT CASE WHEN json_valid(body) THEN json_extract(body,'$.productionProjectId') END AS production, (${TEAM_EDIT_SQL}) AS edit FROM workbench_projects WHERE key=?`, args: [`${owner}:${draftId}`] })).rows[0];
  if (!row || row.production !== board) return false;
  /* Its owner now, who is not the key it is stored under: theirs to write, with nothing else asked (and the first owner having left changes nothing). */
  if (now === actor.id && owner !== actor.id) return mayReachProject(actor, board, "write");
  if (!(await activeMembers(ws)).has(now)) return false;
  const sampleGrant = async () => { const mark = await sampleMarkNow(); return !!mark && mark.draftOwner === owner && mark.draftId === draftId && mark.projectId === board && (await mayEditSample(actor.id)); };
  /* An admin of this workspace may write any board in it (owner, 13 Oct); `mayReachProject` below is where that is recorded in the workspace's history. */
  if (Number(row.edit) !== 1 && !(admin && isWorkspaceAdmin(actor)) && !(await sampleGrant())) return false;
  return mayReachProject(actor, board, "write");
}

/**
 * Acting on a board stored under someone else's key. A board is stored under its author's key (`workbench_projects.owner`); a person with an explicit
 * grant to write it (`mayWriteBoard`), who is not the author, saves, maps shots and publishes against that key, as themselves (the actor is recorded on
 * the row and on what the save implies for the team canvas).
 *
 * `claimed` is the owner a request names (`owner` in the body); absent, or the person's own id, is their own board and nothing is asked. Otherwise the
 * grant is asked, and anything else is `refused`: the caller answers it exactly as it answers a write to a board that is not theirs (`view-only` naming the
 * maker when the board is shared and visible, otherwise not found), reading and writing nothing, so a refusal never says whether a private board, a starter
 * draft or an opened production is there.
 *
 * Without `owner`, a person who has no draft of that id of their own and is asked to write exactly one board shared with "Can edit" under that id, which
 * they may write (`mayWriteBoard`), acts on that one: every editor of the board, the page editors and the composer included, reaches it by its draft id
 * alone. Their own draft of that id wins. Anything uncertain is refused as `ambiguous` (a clear 409), never settled by guessing and never by writing into
 * someone else's board: two such boards under that id, or one the person may not write. A board that is simply new (no edit-shared board has that id) is the
 * person's own.
 */
export async function boardKeyFor(
  ws: Pick<TenantWorkspace, "id">,
  actor: Person,
  claimed: string | undefined,
  draftId: string,
  options: { admin?: boolean } = {},
): Promise<{ owner: string } | { refused: true } | { ambiguous: true }> {
  if (claimed && claimed !== actor.id) {
    const named = await resolveMemberId(ws, claimed);
    if (named !== actor.id) {
      const owner = await storageKeyFor(named, draftId);
      return (await writeGrant(ws, actor, owner, draftId, options.admin !== false)) ? { owner } : { refused: true };
    }
  }
  await workbenchReady();
  /* The person's own board: stored under their key (unless they handed it away), or handed to them and stored under its first owner's. */
  const handed = await boardOwnerRows();
  const own = (await db().execute({ sql: "SELECT 1 FROM workbench_projects WHERE key=?", args: [`${actor.id}:${draftId}`] })).rows.length > 0;
  const away = own && handed.some((h) => h.draftOwner === actor.id && h.draftId === draftId && h.owner !== actor.id);
  if (own && !away) return { owner: actor.id };
  const toMe = handed.filter((h) => h.owner === actor.id && h.draftId === draftId && h.draftOwner !== actor.id);
  if (toMe.length === 1) return { owner: toMe[0].draftOwner };
  if (toMe.length > 1) return { ambiguous: true };
  /* A board the person handed away is a teammate's now: theirs to write only through a grant (shared with "Can edit"), else not theirs. */
  if (away) return (await writeGrant(ws, actor, actor.id, draftId, options.admin !== false)) ? { owner: actor.id } : { refused: true };
  const rows = (await db().execute({ sql: `SELECT owner FROM workbench_projects WHERE project_id=? AND owner<>? AND ${TEAM_EDIT_SQL}`, args: [draftId, actor.id] })).rows;
  if (!rows.length) return { owner: actor.id };
  if (rows.length > 1) return { ambiguous: true };
  const owner = String(rows[0].owner);
  return (await writeGrant(ws, actor, owner, draftId, true)) ? { owner } : { ambiguous: true };
}

/** The refusal a request gets when its board id cannot be settled (see boardKeyFor): say what to do, write nothing. */
export const AMBIGUOUS_BOARD = "That board id is in use by a board shared with the team. Open that board to edit it, or start a new board with its own id.";

/**
 * A shared board someone else made, opened by `actor`: to edit when it is shared with "Can edit" and they may write it (the answer then names whose board
 * they act on, `actingOn`, and the screens save with that owner), to look at otherwise (`viewOnly`). An admin who is not an editor of the board looks (view-only),
 * and edits when they choose (`edit`): the answer is then `actingOn` too.
 */
export async function openingOf(ws: Pick<TenantWorkspace, "id">, actor: Person, seen: { project: { id: string }; owner: BoardOwner; key: string }, options: { edit?: boolean } = {}): Promise<{ actingOn: { owner: BoardOwner } } | { viewOnly: { owner: BoardOwner } }> {
  if (await writeGrant(ws, actor, seen.key, seen.project.id, false)) return { actingOn: { owner: seen.owner } };
  if (options.edit && (await writeGrant(ws, actor, seen.key, seen.project.id, true))) return { actingOn: { owner: seen.owner } };
  return { viewOnly: { owner: seen.owner } };
}

/* ── An admin's reach (owner, 13 Oct: the work belongs to the workspace; members still cannot see each other's private boards; never across workspaces) ── */

/** The maker of a board as an admin reads them: a member as everyone sees them, or, once they have left, the account's name (or "A former member"). */
async function ownerForAdmin(ws: Pick<TenantWorkspace, "id">, people: Map<string, Member>, accountId: string): Promise<BoardOwner> {
  const active = await ownerOf(ws, people, accountId);
  if (active) return active;
  await platformReady();
  const account = (await platformDb().execute({ sql: "SELECT id, email, name FROM accounts WHERE id=? AND deleted_at IS NULL", args: [accountId] })).rows[0];
  const mask = await ownerMaskFor(ws);
  if (account && mask.hides({ id: account.id, email: account.email })) return { id: supportMemberId(ws.id, accountId), name: mask.name({ id: account.id, email: account.email, name: account.name }), support: true, former: true };
  return { id: accountId, name: account?.name ? String(account.name) : "A former member", former: true };
}

/**
 * A board of THIS workspace opened by one of its admins, private or not and whether or not its maker is still a member: the draft whole, with its maker. Null for anyone who is
 * not an admin here, and for a board no draft of this workspace holds (another workspace's boards are in another database and are never reachable from here). Reaching a board
 * that is not shared goes through `mayReachProject`, which writes the history line ("Viewed by") first.
 */
export async function readBoardAsAdmin(ws: Pick<TenantWorkspace, "id">, admin: Person, ownerParam: string, id: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner; key: string } | null> {
  if (!isWorkspaceAdmin(admin)) return null;
  const named = await resolveMemberId(ws, ownerParam);
  const accountId = await storageKeyFor(named, id);
  const now = (await whoOwns())(accountId, id);
  /* The admin's own board (the maker, or whom it was handed to) opens the ordinary way. */
  if (now === admin.id) return null;
  await workbenchReady();
  const draft = await readDraft(accountId, id);
  if (!draft) return null;
  const board = mappedId(DRAFT_PROJECT_PREFIX, ws.id, accountId, id);
  if (!(await mayReachProject(admin, board, "read"))) return null;
  return { ...draft, owner: await ownerForAdmin(ws, await activeMembers(ws), now), key: accountId };
}

/** Which draft holds the board whose own production project is `productionId`, and its maker, for an admin of this workspace: a lookup of ids, no contents, so no history line (reading the board writes it). */
export async function adminBoardOfProduction(ws: Pick<TenantWorkspace, "id">, admin: Person, productionId: string): Promise<{ draftId: string; owner: BoardOwner; key: string } | null> {
  if (!isWorkspaceAdmin(admin)) return null;
  await workbenchReady();
  const board = await boardDraftOf(productionId);
  return board ? { draftId: board.draftId, owner: await ownerForAdmin(ws, await activeMembers(ws), (await whoOwns())(board.owner, board.draftId)), key: board.owner } : null;
}

/** The draft behind a board's own production project, and its maker, for an admin: the same reach and the same history line as `readBoardAsAdmin`. */
export async function readBoardOfProductionAsAdmin(ws: Pick<TenantWorkspace, "id">, admin: Person, productionId: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner; key: string } | null> {
  if (!isWorkspaceAdmin(admin)) return null;
  const board = await boardDraftOf(productionId);
  const now = board ? (await whoOwns())(board.owner, board.draftId) : null;
  if (!board || now === admin.id) return null;
  return readBoardAsAdmin(ws, admin, now!, board.draftId);
}

export type WorkspaceBoard = TeamBoard & { /** Who it is open to besides its owner. */ sharing: "private" | "view" | "edit"; /** It has been handed to someone other than the person whose key holds it. */ transferred: boolean };

/**
 * Every board in the workspace, for an admin ("All boards"): private ones and those of members who have left included, each with its maker. Null for anyone who is not an admin
 * here. A list of names and times, no contents, so it writes no history line (opening a board does).
 */
export async function listWorkspaceBoards(ws: Pick<TenantWorkspace, "id">, admin: Person, options: { kinds?: boolean } = {}): Promise<WorkspaceBoard[] | null> {
  if (!isWorkspaceAdmin(admin)) return null;
  await workbenchReady();
  const people = await activeMembers(ws);
  const owns = await whoOwns();
  const rows = (await db().execute({ sql: `SELECT project_id AS id, owner, name, revision, updated_at AS updatedAt, CASE WHEN ${TEAM_EDIT_SQL} THEN 'edit' WHEN ${TEAM_SHARED_SQL} THEN 'view' ELSE 'private' END AS sharing${options.kinds ? `, ${KIND}` : ""} FROM workbench_projects ORDER BY updated_at DESC LIMIT 500` })).rows;
  const out: WorkspaceBoard[] = [];
  for (const row of rows) {
    const now = owns(String(row.owner), String(row.id));
    const owner = await ownerForAdmin(ws, people, now);
    out.push({ id: String(row.id), name: String(row.name), revision: Number(row.revision), updatedAt: Number(row.updatedAt), ...(options.kinds ? { kind: row.kind == null ? null : String(row.kind) } : {}), owner, mine: now === admin.id, transferred: now !== String(row.owner), sharing: row.sharing === "edit" ? "edit" : row.sharing === "view" ? "view" : "private" });
  }
  return out;
}

/** An admin's look at, or change to, a board of someone else's, as its maker is told: "Viewed by <admin>, <date>". */
export type BoardView = { boardId: string; by: { id: string; name: string; support?: true }; what: "viewed" | "edited"; at: number };

/**
 * Who has looked at or changed the caller's OWN boards as an admin, newest first (a board's id alone narrows it). Only the maker reads these: the boards asked about are the ones
 * `me` owns, so nobody else's lines are ever returned, and an admin is told nothing about other people's boards here. The workspace's history holds the lines; nothing notifies anyone.
 */
export async function boardViews(ws: Pick<TenantWorkspace, "id">, me: string, onlyBoard?: string): Promise<BoardView[]> {
  await workbenchReady();
  const mine = (await ownedDrafts(me)).filter((d) => !onlyBoard || d.draftId === onlyBoard);
  if (!mine.length) return [];
  const byProject = new Map(mine.map((d) => [d.projectId, d.draftId]));
  const ids = [...byProject.keys()];
  const rows = (await db().execute({
    sql: `SELECT actor_id, action, target_id, created_at FROM security_audit WHERE workspace_id=? AND action IN ('board.opened_by_admin','board.edited_by_admin') AND target_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC, id DESC LIMIT 100`,
    args: [ws.id, ...ids],
  })).rows;
  const admins = [...new Set(rows.map((row) => String(row.actor_id)))];
  const names = new Map<string, { id: string; name: string; support?: true }>();
  if (admins.length) {
    await platformReady();
    const mask = await ownerMaskFor(ws);
    const found = (await platformDb().execute({ sql: `SELECT id, email, name FROM accounts WHERE id IN (${admins.map(() => "?").join(",")})`, args: admins })).rows;
    for (const row of found) names.set(String(row.id), mask.hides({ id: row.id, email: row.email }) ? { id: supportMemberId(ws.id, String(row.id)), name: mask.name({ id: row.id, email: row.email, name: row.name }), support: true } : { id: String(row.id), name: String(row.name) });
  }
  return rows.map((row) => ({
    boardId: byProject.get(String(row.target_id))!,
    by: names.get(String(row.actor_id)) ?? { id: String(row.actor_id), name: "An admin" },
    what: row.action === "board.edited_by_admin" ? "edited" as const : "viewed" as const,
    at: Number(row.created_at),
  }));
}

/**
 * Who may change a board's sharing, its mode included (none, view, edit): its author (admins join with the admin rule, one line here). Not a teammate who
 * may edit its cards, and not anyone through a save: the flags are the server's (lib/workbench/records.ts › setBoardSharing).
 */
export async function maySetSharing(actor: { id: string; role?: string }, storageOwner: string, draftId: string): Promise<boolean> {
  return (await whoOwns())(storageOwner, draftId) === actor.id;
}


/**
 * Every client link of the caller's OWN boards ("Client link created by <name>", for the board's history): which board, who made it (the name this workspace may read: the
 * platform owner reads "Particl support" outside the house), when, and whether it is live, for BOTH kinds of link (the Crew review link and the older Approved-takes link), so
 * the owner sees and can withdraw every active link on the board. Only the caller's own boards are asked about, so only the owner reads these; nobody is notified.
 */
export type ClientLinkEvent = { boardId: string; linkId: string; kind: "review" | "approved"; by: string; at: number; expiresAt: number; revokedAt: number | null; live: boolean };
export async function clientLinks(ws: Pick<TenantWorkspace, "id">, me: string, onlyBoard?: string): Promise<ClientLinkEvent[]> {
  await workbenchReady();
  const mine = (await ownedDrafts(me)).filter((d) => !onlyBoard || d.draftId === onlyBoard);
  if (!mine.length) return [];
  const byProject = new Map(mine.map((d) => [d.projectId, d.draftId]));
  await platformReady();
  const rows = (await platformDb().execute({
    sql: `SELECT id, project_id, created_by, created_at, expires_at, revoked_at FROM p_shares WHERE workspace_id=? AND project_id IN (${[...byProject.keys()].map(() => "?").join(",")}) ORDER BY created_at DESC, id DESC LIMIT 200`,
    args: [ws.id, ...byProject.keys()],
  })).rows;
  if (!rows.length) return [];
  const scopes = new Map<string, string>();
  try {
    const found = (await db().execute({ sql: `SELECT share_id, scope FROM review_link_scopes WHERE share_id IN (${rows.map(() => "?").join(",")})`, args: rows.map((r) => String(r.id)) })).rows;
    for (const r of found) scopes.set(String(r.share_id), String(r.scope));
  } catch { /* no client link was ever made in this workspace: every link is the older kind */ }
  const shown = await storedActorMaskHere();
  const at = Date.now();
  return rows.map((r) => ({
    boardId: byProject.get(String(r.project_id))!, linkId: String(r.id), kind: scopes.get(String(r.id)) === "review" ? "review" as const : "approved" as const,
    by: String(shown(String(r.created_by ?? ""))), at: Number(r.created_at), expiresAt: Number(r.expires_at), revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
    live: r.revoked_at == null && Number(r.expires_at) > at,
  }));
}
