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
 * TODO(owner decision, asked 12 Oct): who may CLAIM and approve such a step (app/api/atomik/steps/[id]/claim) is unchanged here, as is what the claim returns to
 * an admin. Until the owner decides, the queue offers an admin no Approve, Open or Not now on another person's step: it shows the title and the price.
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
          WHERE s.id = ? AND s.status = 'proposed' AND s.model NOT LIKE 'connected:%' AND c.deleted = 0 AND c.archived_at IS NULL AND c.status <> 'running' LIMIT 1`,
    args: [stepId],
  }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  if (!row || String(row.chat_owner ?? "") === viewer.id || ownerIsAdmin(row.chat_owner, row.owner_role)) return null;
  const credits = stepCredits(row, creditsApply(workspace));
  if (credits === null || !needsAdminTap(credits, await shotCap())) return null;
  const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
  return { stepId: String(row.id), title: title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title || "A step", credits };
}

/** The chat a step is in, and whether it is the viewer's own: null when the step is not there. */
export async function stepIsMine(stepId: string, viewer: ChatViewer): Promise<boolean | null> {
  await ready();
  const row = (await db().execute({ sql: "SELECT c.created_by AS owner FROM atomik_steps s JOIN atomik_chats c ON c.id = s.chat_id WHERE s.id=? LIMIT 1", args: [stepId] }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return !!viewer.id && String(row.owner ?? "") === viewer.id;
}
