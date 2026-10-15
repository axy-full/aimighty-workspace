import { db, ready } from "./db";
import { currentTenant } from "./tenant";
import { creditsApply } from "./credits";
import { getSetting } from "./settings";
import { cleanRule, cleanShotCap, jobApprovalLineCredits } from "./approvalRule";
import { billCredits, creditUsd, marginKeyOf } from "./creditTerms";
import { isAgentId } from "./security/people-only";

/**
 * Atomik chats are their person's (owner, 12 Oct): a chat, its steps, its plan and its threads are read, changed, deleted and planned in by the person who started
 * it, and by nobody else; to anyone else a chat is gone ("That chat is gone."), a step is gone ("That step is gone."), and a list leaves it out (so no `needs`
 * flag and no count of it leaks either). This is the one check, used by every door: the chat and thread lists, a chat's read, rename, archive, delete and turn,
 * a step's read and edit, the skills' run list, draft, save and run.
 *
 * The one exception: an admin, for another MEMBER's step that is over the workspace's per-shot cap or over guardrail 4's line right now (so it needs an admin's tap),
 * who is shown its id, title and price and nothing else (`adminStepSheet`). Once it needs no admin it is gone for them too. Another admin's step needs only its owner.
 *
 * Claiming a step (app/api/atomik/steps/[id]/claim: it marks the step running, which approves its spend, and returns its prompt) is the step's person's, and an admin's
 * for another member's step only while it needs an admin's tap (owner, 13 Oct: "admins may approve another member's over-line step and see its prompt, not the chat").
 * The claim then returns the step's own fields (no chat, message or position) and nothing of its chat; the admin who claimed it settles it (`stepClaimedBy`). Steps
 * under the line, or not proposed, stay gone to an admin, and tokens and agent identities are refused first (people only).
 */
export const CHAT_GONE = "That chat is gone.";
export const STEP_GONE = "That step is gone.";

export type ChatViewer = { id: string; role?: string; owner?: boolean };

const isAdmin = (viewer: ChatViewer) => !isAgentId(viewer.id) && (viewer.owner === true || viewer.role === "admin" || viewer.role === "owner");

/** Whether the chat `chatId` is `viewer`'s own. A chat that is not there is nobody's. */
export async function chatIsMine(chatId: string, viewer: ChatViewer): Promise<boolean> {
  await ready();
  const row = (await db().execute({ sql: "SELECT created_by FROM atomik_chats WHERE id=? LIMIT 1", args: [chatId] }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  return !!row && !!viewer.id && String(row.created_by ?? "") === viewer.id;
}

const missing = (error: unknown) => { if (/no such table/i.test(String(error))) return { rows: [] as Record<string, unknown>[] }; throw error; };

/** The workspace's per-shot cap in credits when its rule is `cap`, else null (lib/approvalRule.ts). */
export async function shotCap(): Promise<number | null> {
  const [rule, cap] = await Promise.all([getSetting("approvalRule").catch(() => "anyone"), getSetting("shotCapCredits").catch(() => "50")]);
  return cleanRule(rule) === "cap" ? cleanShotCap(cap) : null;
}

/** A step's price in credits, as the queue words it (up to its estimate), or null where nothing is priced or the workspace is not billed in credits. */
export function stepCredits(row: { est_cost_usd?: unknown; kind?: unknown; model?: unknown }, inCredits: boolean): number | null {
  const est = row.est_cost_usd == null ? null : Number(row.est_cost_usd);
  const text = (v: unknown) => (v == null || v === "" ? null : String(v));
  return inCredits && est !== null && Number.isFinite(est) ? billCredits(est, marginKeyOf(text(row.kind), text(row.model))) : null;
}

/** Whether a step priced at `credits` needs an admin's tap: over the per-shot cap, or over guardrail 4's line. The one definition. */
export function needsAdminTap(credits: number | null, cap: number | null): boolean {
  if (credits === null) return false;
  const line = jobApprovalLineCredits(creditUsd());
  return (cap !== null && credits > cap) || (line > 0 && credits > line);
}

/** Whether the owner of a chat is an admin (their step needs only them): the workspace's owner, or a user whose role is admin. */
export function ownerIsAdmin(chatOwner: unknown, ownerRole: unknown): boolean {
  return String(ownerRole ?? "") === "admin" || (!!chatOwner && String(chatOwner) === (currentTenant()?.workspace?.ownerId ?? null));
}

export type AdminStepSheet = { stepId: string; title: string; credits: number };

/** What an admin may know of another member's step: its id, title and price, while it needs an admin's tap; null otherwise (and for anyone who is not an admin). */
export async function adminStepSheet(stepId: string, viewer: ChatViewer): Promise<AdminStepSheet | null> {
  if (!isAdmin(viewer)) return null;
  await ready();
  const workspace = currentTenant()?.workspace;
  if (!workspace) return null;
  const row = (await db().execute({
    sql: `SELECT s.id, s.title, s.kind, s.model, s.est_cost_usd, c.created_by AS chat_owner, o.role AS owner_role
          FROM atomik_steps s JOIN atomik_chats c ON c.id = s.chat_id LEFT JOIN users o ON o.id = c.created_by
          WHERE s.id = ? AND s.status = 'proposed' AND s.kind <> 'audio' AND s.model NOT LIKE 'connected:%' AND c.deleted = 0 AND c.archived_at IS NULL AND c.status <> 'running' LIMIT 1`,
    args: [stepId],
  }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  if (!row || String(row.chat_owner ?? "") === viewer.id || ownerIsAdmin(row.chat_owner, row.owner_role)) return null;
  const credits = stepCredits(row, creditsApply(workspace));
  if (credits === null || !needsAdminTap(credits, await shotCap())) return null;
  const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
  return { stepId: String(row.id), title: title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title || "A step", credits };
}

/**
 * Where the render of a step the viewer has claimed files: its own chat's project, resolved here and never named by the client. The step must be running, claimed by the
 * viewer, with nothing sent yet. Admission uses this (lib/generationAdmission.ts), so an admin's approval of another member's step lands in that member's project, under its
 * caps and the 200 cr line, and the admin never reads the board. Null when the step is not the viewer's to render.
 */
export type ClaimedStep = {
  projectId: string | null;
  /** Who made the chat the step is in: the person whose reach the render's filing target is checked against (an approver's own reach never decides it). */
  createdBy: string;
  /** The key this claim's one render goes under (set by the claim): admission accepts a render only under it, so release and reconcile can fence it. */
  requestKey: string | null;
  /** The step's own "up to" price in credits (what the queue showed the admin), or null where the workspace is not billed in credits: a render may not be admitted above it. */
  ceilingCredits: number | null;
  /** What the render is made from: the step's own, never the client's. */
  step: { kind: string; title: string; prompt: string; model: string; params: Record<string, unknown>; refs: unknown[] };
};
export async function claimedStepFiling(stepId: string, viewer: ChatViewer): Promise<ClaimedStep | null> {
  if (!viewer.id || !stepId) return null;
  await ready();
  const row = (await db().execute({
    sql: `SELECT c.project_id, c.created_by, s.request_key, s.kind, s.title, s.prompt, s.model, s.params, s.refs, s.est_cost_usd FROM atomik_steps s JOIN atomik_chats c ON c.id = s.chat_id
          WHERE s.id = ? AND s.status = 'running' AND s.claimed_by = ? AND s.gen_id IS NULL AND s.kind <> 'audio' AND c.deleted = 0 LIMIT 1`,
    args: [stepId, viewer.id],
  }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const json = <T,>(value: unknown, fallback: T): T => { try { const v = JSON.parse(String(value ?? "")); return v == null ? fallback : v as T; } catch { return fallback; } };
  const params = json<Record<string, unknown>>(row.params, {});
  return {
    projectId: row.project_id == null || row.project_id === "" ? null : String(row.project_id),
    createdBy: row.created_by == null ? "" : String(row.created_by),
    requestKey: row.request_key == null ? null : String(row.request_key),
    ceilingCredits: stepCredits(row, creditsApply(currentTenant()?.workspace)),
    step: { kind: String(row.kind), title: String(row.title ?? ""), prompt: String(row.prompt ?? ""), model: String(row.model), params: params && typeof params === "object" && !Array.isArray(params) ? params : {}, refs: json<unknown[]>(row.refs, []) },
  };
}

/** Who claimed a step (the person who pressed Continue), or null. */
export async function stepClaimedBy(stepId: string): Promise<string | null> {
  await ready();
  const row = (await db().execute({ sql: "SELECT claimed_by FROM atomik_steps WHERE id=? LIMIT 1", args: [stepId] }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  return row?.claimed_by ? String(row.claimed_by) : null;
}

/** The chat a step is in, and whether it is the viewer's own: null when the step is not there. */
export async function stepIsMine(stepId: string, viewer: ChatViewer): Promise<boolean | null> {
  await ready();
  const row = (await db().execute({ sql: "SELECT c.created_by AS owner FROM atomik_steps s JOIN atomik_chats c ON c.id = s.chat_id WHERE s.id=? LIMIT 1", args: [stepId] }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return !!viewer.id && String(row.owner ?? "") === viewer.id;
}
