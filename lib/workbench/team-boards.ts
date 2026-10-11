/**
 * Teammates' boards (owner, 11 Oct 2026): every member sees every board in their own workspace, and opens a teammate's view-only.
 *
 * A board is a private draft of its maker (`workbench_projects`, keyed by owner and project id, inside the workspace's own database), and
 * its productions, shots, takes and files already belong to the whole workspace. Only the draft's list and read widen here; nothing a
 * teammate does ever writes to someone else's draft (every write is keyed by the signed-in person).
 *
 * Tenancy: every read is on `db()`, the signed-in workspace's own database, and the people named are that workspace's own active members
 * (the platform's memberships for this workspace id). Another workspace's boards are in another database and never reachable from here.
 * The platform owner reads as "Particl support" with an opaque id outside the house (lib/platformOwnerPrivacy.ts), as on the Team page.
 */
import { db } from "@/lib/db";
import { platformDb, platformReady } from "@/lib/platform";
import { ownerMaskFor, resolveMemberId, supportMemberId } from "@/lib/platformOwnerPrivacy";
import type { TenantWorkspace } from "@/lib/tenant";
import { readDraft, workbenchReady } from "./records";

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

/** Every active member's boards in this workspace, newest first, the caller's own marked. */
export async function listTeamBoards(ws: Pick<TenantWorkspace, "id">, me: string, options: { kinds?: boolean } = {}): Promise<TeamBoard[]> {
  await workbenchReady();
  const people = await activeMembers(ws);
  const rows = (await db().execute(`SELECT project_id AS id, owner, name, revision, updated_at AS updatedAt${options.kinds ? `, ${KIND}` : ""} FROM workbench_projects ORDER BY updated_at DESC LIMIT 200`)).rows;
  const out: TeamBoard[] = [];
  for (const row of rows) {
    const owner = await ownerOf(ws, people, String(row.owner));
    if (!owner) continue;
    out.push({ id: String(row.id), name: String(row.name), revision: Number(row.revision), updatedAt: Number(row.updatedAt), ...(options.kinds ? { kind: row.kind == null ? null : String(row.kind) } : {}), owner, mine: String(row.owner) === me });
  }
  return out;
}

/** A teammate's board, whole, to look at: null when that person is not an active member here or has no such board. */
export async function readTeamBoard(ws: Pick<TenantWorkspace, "id">, me: string, ownerParam: string, id: string): Promise<{ project: NonNullable<Awaited<ReturnType<typeof readDraft>>>["project"]; revision: number; owner: BoardOwner } | null> {
  const accountId = await resolveMemberId(ws, ownerParam);
  if (accountId === me) return null;
  const people = await activeMembers(ws);
  const owner = await ownerOf(ws, people, accountId);
  if (!owner) return null;
  const draft = await readDraft(accountId, id);
  return draft ? { ...draft, owner } : null;
}

/** The maker of a board that is not the caller's, when the caller has no such board themselves: a save of it must not become a second copy. */
export async function otherOwnersBoard(ws: Pick<TenantWorkspace, "id">, me: string, id: string): Promise<BoardOwner | null> {
  await workbenchReady();
  /* The caller's own board (the common save) is one primary-key read; only a new id looks further. */
  if ((await db().execute({ sql: "SELECT 1 FROM workbench_projects WHERE key=?", args: [`${me}:${id}`] })).rows.length) return null;
  const rows = (await db().execute({ sql: "SELECT owner FROM workbench_projects WHERE project_id=?", args: [id] })).rows;
  if (!rows.length) return null;
  const people = await activeMembers(ws);
  for (const row of rows) { const owner = await ownerOf(ws, people, String(row.owner)); if (owner) return owner; }
  return { id: "", name: "a teammate" };
}

/** What a view-only board says in the stage header. */
export const viewOnlyLine = (ownerName: string) => `${ownerName}’s board · view only`;
export const viewOnlyRefusal = (ownerName: string) => `This is ${ownerName}’s board; it opens view-only here, so it was not saved.`;
