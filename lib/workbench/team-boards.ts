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
import { DRAFT_PROJECT_PREFIX, mappedId, mayReachProject, sampleMarkNow, TEAM_EDIT_SQL, TEAM_SHARED_SQL } from "@/lib/draftProject";
import { platformDb, platformReady } from "@/lib/platform";
import { ownerMaskFor, resolveMemberId, supportMemberId } from "@/lib/platformOwnerPrivacy";
import type { TenantWorkspace } from "@/lib/tenant";
import { readDraft, workbenchReady } from "./records";
export { viewOnlyLine, viewOnlyRefusal } from "./view-only";

export type BoardOwner = { id: string; name: string; support?: true };
export type TeamBoard = { id: string; name: string; revision: number; updatedAt: number; kind?: string | null; owner: BoardOwner; mine: boolean };

type Person = { id: string; email: string; name: string };

/** The workspace's active members: not disabled, account not disabled or deleted. */
async function activeMembers(ws: Pick<TenantWorkspace, "id">): Promise<Map<string, Person>> {
  await platformReady();
  const rows = (await platformDb().execute({
    sql: `SELECT a.id, a.email, a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.disabled = 0 AND a.disabled = 0 AND a.deleted_at IS NULL`,
    args: [ws.id],
  })).rows as unknown as Person[];
  return new Map(rows.map((r) => [String(r.id), { id: String(r.id), email: String(r.email), name: String(r.name) }]));
}

async function ownerOf(ws: Pick<TenantWorkspace, "id">, people: Map<string, Person>, accountId: string): Promise<BoardOwner | null> {
  const person = people.get(accountId);
  if (!person) return null;
  const mask = await ownerMaskFor(ws);
  return mask.hides(person) ? { id: supportMemberId(ws.id, accountId), name: mask.name(person), support: true } : { id: accountId, name: person.name };
}

const KIND = "CASE WHEN json_valid(body) THEN COALESCE(NULLIF(json_extract(body,'$.boardKind'),''),CASE WHEN NULLIF(json_extract(body,'$.marketingBrief'),'') IS NOT NULL OR NULLIF(json_extract(body,'$.moleculr'),'') IS NOT NULL THEN 'ads' END) END AS kind";

/** What makes a draft shared: the author's flag in its own JSON (and a draft whose JSON can't be read is private). The one definition, shared with the project gate (lib/draftProject.ts). */
const SHARED = TEAM_SHARED_SQL;

/** The boards shared with the team by the workspace's active members, newest first, the caller's own marked (a private draft is in no one's list). */
export async function listTeamBoards(ws: Pick<TenantWorkspace, "id">, me: string, options: { kinds?: boolean } = {}): Promise<TeamBoard[]> {
  await workbenchReady();
  const people = await activeMembers(ws);
  const rows = (await db().execute({ sql: `SELECT project_id AS id, owner, name, revision, updated_at AS updatedAt${options.kinds ? `, ${KIND}` : ""} FROM workbench_projects WHERE ${SHARED} ORDER BY updated_at DESC LIMIT 200` })).rows;
  const out: TeamBoard[] = [];
  for (const row of rows) {
    const owner = await ownerOf(ws, people, String(row.owner));
    if (!owner) continue;
    out.push({ id: String(row.id), name: String(row.name), revision: Number(row.revision), updatedAt: Number(row.updatedAt), ...(options.kinds ? { kind: row.kind == null ? null : String(row.kind) } : {}), owner, mine: String(row.owner) === me });
  }
  return out;
}

/** A teammate's shared board, whole, to look at: null when that person is not an active member here, has no such board, or has not shared it. */
export async function readTeamBoard(ws: Pick<TenantWorkspace, "id">, me: string, ownerParam: string, id: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner } | null> {
  const accountId = await resolveMemberId(ws, ownerParam);
  if (accountId === me) return null;
  const people = await activeMembers(ws);
  const owner = await ownerOf(ws, people, accountId);
  if (!owner) return null;
  /* Shared is asked of the stored row first: a private draft (or one that can't be read) is never opened, however it is asked for. */
  await workbenchReady();
  if (!(await db().execute({ sql: `SELECT 1 FROM workbench_projects WHERE key=? AND ${SHARED}`, args: [`${accountId}:${id}`] })).rows.length) return null;
  const draft = await readDraft(accountId, id);
  return draft && draft.project.teamShared === true ? { ...draft, owner } : null;
}

/**
 * The maker of a SHARED board that is not the caller's, when the caller has no such board themselves: a save of it must not become a second copy.
 * A private draft is no one's to know of: it answers null, exactly as an id nobody has would, and names no one.
 */
export async function otherOwnersBoard(ws: Pick<TenantWorkspace, "id">, me: string, id: string): Promise<BoardOwner | null> {
  await workbenchReady();
  /* The caller's own board (the common save) is one primary-key read; only a new id looks further. */
  if ((await db().execute({ sql: "SELECT 1 FROM workbench_projects WHERE key=?", args: [`${me}:${id}`] })).rows.length) return null;
  const rows = (await db().execute({ sql: `SELECT owner FROM workbench_projects WHERE project_id=? AND ${SHARED}`, args: [id] })).rows;
  if (!rows.length) return null;
  const people = await activeMembers(ws);
  for (const row of rows) { const owner = await ownerOf(ws, people, String(row.owner)); if (owner) return owner; }
  return null;
}

/**
 * A teammate's shared board asked for by its id alone (a board link): the one board with that id in this workspace that belongs to an active member
 * other than the caller and is shared. A private draft is null here, whoever asks.
 */
export async function findTeamBoard(ws: Pick<TenantWorkspace, "id">, me: string, id: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner } | null> {
  await workbenchReady();
  const rows = (await db().execute({ sql: `SELECT owner FROM workbench_projects WHERE project_id=? AND owner<>? AND ${SHARED} ORDER BY updated_at DESC`, args: [id, me] })).rows;
  const people = await activeMembers(ws);
  for (const row of rows) {
    const owner = await ownerOf(ws, people, String(row.owner));
    if (!owner) continue;
    const draft = await readDraft(String(row.owner), id);
    if (draft && draft.project.teamShared === true) return { ...draft, owner };
  }
  return null;
}

/** The SHARED board whose own production project is `productionId` (lib/draftProject.ts): its draft id and its maker as a teammate sees them; null when that board is not shared or its maker is not an active member. */
export async function sharedBoardOfProduction(ws: Pick<TenantWorkspace, "id">, productionId: string): Promise<{ draftId: string; owner: BoardOwner; key: string } | null> {
  await workbenchReady();
  const rows = (await db().execute({ sql: `SELECT owner, project_id FROM workbench_projects WHERE ${SHARED}`, args: [] })).rows;
  const hit = rows.find((row) => mappedId(DRAFT_PROJECT_PREFIX, ws.id, String(row.owner), String(row.project_id)) === productionId);
  if (!hit) return null;
  const owner = await ownerOf(ws, await activeMembers(ws), String(hit.owner));
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
 * Acting on a board stored under someone else's key. A board is stored under its author's key (`workbench_projects.owner`); a person with write reach to
 * it, who is not the author, saves, maps shots and publishes against that key, as themselves (the actor is recorded on the row and on what the save
 * implies for the team canvas). The reach is the one rule (`mayReachProject` with "write": the author; the marked sample's editors; a teammate when the
 * board is shared with "Can edit"; and, with the admin rule, an admin), never a rule of this file's own.
 *
 * `claimed` is the owner a request names (`owner` in the body); absent, or the person's own id, is their own board and nothing is asked. Otherwise the
 * board must exist under that key and be writable for the person; anything else is `refused`, and the caller answers it exactly as it answers a
 * write to a board that is not theirs (`view-only` naming the maker when the board is shared and visible, otherwise not found), so a refusal never
 * says whether a private board is there.
 *
 * Without `owner`, a person who has no draft of that id of their own and is asked to write exactly one board shared with "Can edit" under that id, which
 * they may write, acts on that one (every editor of the board, the page editors and the composer included, reaches it by its draft id alone). Their own
 * draft of that id wins; two such boards, or none writable, mean the person's own board (a new one).
 */
export async function boardKeyFor(
  ws: Pick<TenantWorkspace, "id">,
  actor: { id: string; role?: string },
  claimed: string | undefined,
  draftId: string,
): Promise<{ owner: string } | { refused: true }> {
  if (claimed && claimed !== actor.id) {
    const owner = await resolveMemberId(ws, claimed);
    if (owner === actor.id) return { owner: actor.id };
    const draft = await readDraft(owner, draftId);
    const production = draft?.project.productionProjectId;
    if (!production || !(await mayReachProject(actor, production, "write"))) return { refused: true };
    return { owner };
  }
  await workbenchReady();
  if ((await db().execute({ sql: "SELECT 1 FROM workbench_projects WHERE key=?", args: [`${actor.id}:${draftId}`] })).rows.length) return { owner: actor.id };
  const rows = (await db().execute({ sql: `SELECT owner, json_extract(body,'$.productionProjectId') AS production FROM workbench_projects WHERE project_id=? AND owner<>? AND ${TEAM_EDIT_SQL}`, args: [draftId, actor.id] })).rows;
  if (rows.length !== 1 || !rows[0].production) return { owner: actor.id };
  return (await mayReachProject(actor, String(rows[0].production), "write")) ? { owner: String(rows[0].owner) } : { owner: actor.id };
}

/**
 * A shared board someone else made, opened by `actor`: to edit when it is shared with "Can edit" and they may write it (the answer then names whose board
 * they act on, `actingOn`, and the screens save with that owner), to look at otherwise (`viewOnly`).
 */
export async function openingOf(actor: { id: string; role?: string }, seen: { project: { productionProjectId?: string | null }; owner: BoardOwner }): Promise<{ actingOn: { owner: BoardOwner } } | { viewOnly: { owner: BoardOwner } }> {
  const production = seen.project.productionProjectId;
  return production && (await mayReachProject(actor, production, "write")) ? { actingOn: { owner: seen.owner } } : { viewOnly: { owner: seen.owner } };
}

/**
 * Who may change a board's sharing, its mode included (none, view, edit): its author (admins join with the admin rule, one line here). Not a teammate who
 * may edit its cards, and not anyone through a save: the flags are the server's (lib/workbench/records.ts › setBoardSharing).
 */
export function maySetSharing(actor: { id: string; role?: string }, storageOwner: string): boolean {
  return actor.id === storageOwner;
}
