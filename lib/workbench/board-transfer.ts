import { ownerMaskFor, resolveMemberId } from "@/lib/platformOwnerPrivacy";
import { boardDraftOf, boardOwnerRows, isActiveMember, isDraftProject, isMarkedSample, isWorkspaceAdmin, ownedDrafts, type Person } from "@/lib/draftProject";
import { securityAuditStatement } from "@/lib/securityAudit";
import { isAgentId } from "@/lib/security/people-only";
import type { TenantWorkspace } from "@/lib/tenant";
import { workbenchReady, workbenchTransaction } from "./records";

/**
 * Handing a board to someone else (board sharing, PR 4; owner, 13 Oct: "admins ... can transfer a board's ownership when a member leaves — the work belongs to the
 * workspace ... Never across workspaces").
 *
 * Nothing is moved or re-keyed. A board's draft stays stored under its first owner's key and its project id stays what it was; `workbench_board_owners` says whose it
 * is now (lib/draftProject.ts › boardOwnerOf), and every rule that asks "is this person the board's owner" asks that. Takes, shots, uploads, the canvas, billing rows
 * and caps are not touched: nothing is erased and nothing is charged. Only an admin of this workspace hands a board over, to an ACTIVE member of this workspace (the
 * admin themself included), and each handover, and each Undo, is a line in the workspace's security history in the same transaction as the change.
 *
 * Undo gives the board back to who it was just before (the row keeps `previous_owner`); it is itself audited and can be undone in turn. No row is ever deleted.
 */
export class TransferRefused extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) { super(message); }
}
export type Moved = { projectId: string; draftId: string; name: string; from: string; to: string };

const ONLY_ADMINS = "Only an admin can move a board to another owner.";
const NOT_A_MEMBER = "Choose someone who is a member of this workspace.";
const NO_BOARD = "That board is not in this workspace.";

function requireAdmin(admin: Person) {
  if (!isWorkspaceAdmin(admin)) throw new TransferRefused(ONLY_ADMINS, 403);
}

/** The person a board may be handed to: an active member of THIS workspace (not disabled, not removed), never an Atomik run, and never the platform's support row of a client workspace. */
async function target(ws: Pick<TenantWorkspace, "id">, to: unknown): Promise<string> {
  if (typeof to !== "string" || !to || to.length > 200) throw new TransferRefused(NOT_A_MEMBER, 400);
  const id = await resolveMemberId(ws, to);
  if (isAgentId(id) || (await ownerMaskFor(ws)).hides({ id }) || !(await isActiveMember(id))) throw new TransferRefused(NOT_A_MEMBER, 404);
  return id;
}

/** What each board is now, for the ones asked about: the draft that holds it, its name, and whose it is. Refused when a board is not this workspace's, or is the marked sample. */
async function boardsNow(projectIds: string[]) {
  await workbenchReady();
  const handed = new Map((await boardOwnerRows()).map((h) => [h.projectId, h]));
  const { db } = await import("@/lib/db");
  const out: { projectId: string; draftOwner: string; draftId: string; name: string; owner: string }[] = [];
  for (const projectId of [...new Set(projectIds)]) {
    if (!isDraftProject(projectId)) throw new TransferRefused(NO_BOARD, 404);
    const stored = await boardDraftOf(projectId);
    if (!stored) throw new TransferRefused(NO_BOARD, 404);
    /* The marked sample belongs to everyone and to its marker; it is not handed over. */
    if (await isMarkedSample(projectId)) throw new TransferRefused("The sample board cannot be moved.", 409);
    const row = (await db().execute({ sql: "SELECT name FROM workbench_projects WHERE key=?", args: [`${stored.owner}:${stored.draftId}`] })).rows[0];
    out.push({ projectId, draftOwner: stored.owner, draftId: stored.draftId, name: String(row?.name ?? ""), owner: handed.get(projectId)?.owner ?? stored.owner });
  }
  return out;
}

/** Hands each of these boards to `to`: all or none, with one line each in the workspace's history. */
export async function transferBoards(ws: Pick<TenantWorkspace, "id">, admin: Person, projectIds: string[], to: unknown): Promise<{ moved: Moved[] }> {
  requireAdmin(admin);
  if (!projectIds.length || projectIds.length > 500) throw new TransferRefused("Choose the boards to move.", 400);
  const toId = await target(ws, to);
  const boards = await boardsNow(projectIds);
  if (boards.some((b) => b.owner === toId) && boards.length === 1) throw new TransferRefused("That board is already theirs.", 409);
  const moving = boards.filter((b) => b.owner !== toId);
  const at = Date.now();
  await workbenchTransaction(async (tx) => {
    for (const b of moving) {
      await tx.execute({
        sql: `INSERT INTO workbench_board_owners (project_id, draft_owner, draft_id, owner, previous_owner, transferred_by, at) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(project_id) DO UPDATE SET owner=excluded.owner, previous_owner=workbench_board_owners.owner, transferred_by=excluded.transferred_by, at=excluded.at`,
        args: [b.projectId, b.draftOwner, b.draftId, toId, b.owner, admin.id, at],
      });
      await tx.execute(securityAuditStatement({ workspaceId: ws.id, actorId: admin.id, action: "board.transferred", targetType: "board", targetId: b.projectId, details: { from: b.owner, to: toId } }));
    }
  });
  return { moved: moving.map((b) => ({ projectId: b.projectId, draftId: b.draftId, name: b.name, from: b.owner, to: toId })) };
}

/** Every board `from` owns now (a member who is leaving, or has left) handed to `to`. */
export async function transferAllOf(ws: Pick<TenantWorkspace, "id">, admin: Person, from: unknown, to: unknown): Promise<{ moved: Moved[] }> {
  requireAdmin(admin);
  if (typeof from !== "string" || !from || from.length > 200) throw new TransferRefused("Choose whose boards to move.", 400);
  const fromId = await resolveMemberId(ws, from);
  const toId = await target(ws, to);
  if (fromId === toId) throw new TransferRefused("Choose someone else to move them to.", 409);
  await workbenchReady();
  const projectIds = (await ownedDrafts(fromId)).map((d) => d.projectId);
  if (!projectIds.length) return { moved: [] };
  /* The marked sample is nobody's to hand over: left where it is. */
  const handable: string[] = [];
  for (const id of projectIds) if (!(await isMarkedSample(id))) handable.push(id);
  return handable.length ? transferBoards(ws, admin, handable, toId) : { moved: [] };
}

/** Gives each board back to who it was just before its latest handover. Audited; the row stays, so this can be undone in turn. */
export async function undoTransfers(ws: Pick<TenantWorkspace, "id">, admin: Person, projectIds: string[]): Promise<{ restored: Moved[] }> {
  requireAdmin(admin);
  if (!projectIds.length || projectIds.length > 500) throw new TransferRefused("Choose the boards to give back.", 400);
  await workbenchReady();
  const handed = new Map((await boardOwnerRows()).map((h) => [h.projectId, h]));
  const names = new Map((await boardsNow(projectIds)).map((b) => [b.projectId, b.name]));
  const rows = [...new Set(projectIds)].map((id) => {
    const row = handed.get(id);
    if (!row || row.owner === row.previousOwner) throw new TransferRefused("That board has not been moved.", 409);
    return row;
  });
  const at = Date.now();
  await workbenchTransaction(async (tx) => {
    for (const r of rows) {
      await tx.execute({ sql: "UPDATE workbench_board_owners SET owner=previous_owner, previous_owner=owner, transferred_by=?, at=? WHERE project_id=?", args: [admin.id, at, r.projectId] });
      await tx.execute(securityAuditStatement({ workspaceId: ws.id, actorId: admin.id, action: "board.transfer_undone", targetType: "board", targetId: r.projectId, details: { from: r.owner, to: r.previousOwner } }));
    }
  });
  return { restored: rows.map((r) => ({ projectId: r.projectId, draftId: r.draftId, name: names.get(r.projectId) ?? "", from: r.owner, to: r.previousOwner })) };
}
