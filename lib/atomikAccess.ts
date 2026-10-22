import { db, ready } from "./db";
import { billCredits, marginKeyOf } from "./creditTerms";

/**
 * Atomik chats are their person's (owner, 12 Oct): a chat, its steps, its plan and its threads are read, changed, deleted and planned in by the person who started
 * it, and by nobody else; to anyone else a chat is gone ("That chat is gone."), a step is gone ("That step is gone."), and a list leaves it out (so no `needs`
 * flag and no count of it leaks either). This is the one check, used by every door: the chat and thread lists, a chat's read, rename, archive, delete and turn,
 * a step's read and edit, the skills' run list, draft, save and run.
 *
 * Claiming a step (app/api/atomik/steps/[id]/claim: it marks the step running, which approves its spend, and returns its prompt) is the step's person's alone,
 * and tokens and agent identities are refused first (people only). An admin no longer sees, claims or approves another member's step: the admin approval rule
 * was retired on 21 Oct 2026 (owner: "every member approves their own spend with their own tap on the quote"). A claim an admin made before then and
 * that is already rendering finishes, and is settled by whoever claimed it (`stepClaimedBy`).
 */
export const CHAT_GONE = "That chat is gone.";
export const STEP_GONE = "That step is gone.";

export type ChatViewer = { id: string; role?: string; owner?: boolean };

/** Whether the chat `chatId` is `viewer`'s own. A chat that is not there is nobody's. */
export async function chatIsMine(chatId: string, viewer: ChatViewer): Promise<boolean> {
  await ready();
  const row = (await db().execute({ sql: "SELECT created_by FROM atomik_chats WHERE id=? LIMIT 1", args: [chatId] }).catch(missing)).rows[0] as Record<string, unknown> | undefined;
  return !!row && !!viewer.id && String(row.created_by ?? "") === viewer.id;
}

const missing = (error: unknown) => { if (/no such table/i.test(String(error))) return { rows: [] as Record<string, unknown>[] }; throw error; };

/** A step's price in credits, as the queue words it (up to its estimate), or null where nothing is priced or the workspace is not billed in credits. */
export function stepCredits(row: { est_cost_usd?: unknown; kind?: unknown; model?: unknown }, inCredits: boolean): number | null {
  const est = row.est_cost_usd == null ? null : Number(row.est_cost_usd);
  const text = (v: unknown) => (v == null || v === "" ? null : String(v));
  return inCredits && est !== null && Number.isFinite(est) ? billCredits(est, marginKeyOf(text(row.kind), text(row.model))) : null;
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
