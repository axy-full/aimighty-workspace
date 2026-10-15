import type { InStatement } from "@libsql/client";
import { id as newId } from "./db";
import { isAgentId } from "./security/people-only";
import type { DriftDetail, RejectReason } from "./rejectReasons";

/**
 * The history of who judged a take and why (owner, 14 Oct 2026; docs/plans/step-0-data.md items 2 and 3): `take_review_events`, one append-only row for every pick, approval,
 * send-back and clear, in the workspace's own database. It holds the account id of the person (an agent's own id for an agent), the channel they came by (a person at a browser,
 * an API or MCP token, an agent, or the system), the reason codes of a send-back, and the id of the note that carries the person's own words, which stay in `notes`. Rows are
 * only ever added. The take keeps its latest-mark columns exactly as before (names, for older screens and exports); this is the part that keeps the whole story.
 *
 * Ids stay inside the workspace's database and the platform. What is shown or exported from here is a name read through the usual masks, never a raw account id.
 */
export type ReviewAction = "picked" | "approved" | "changes" | "cleared";
export type ReviewVia = "person" | "token" | "agent" | "system";

/** The event a review state is: "" is a clear. */
export const reviewActionOf = (state: string): ReviewAction | null =>
  state === "picked" || state === "approved" || state === "changes" ? state : state === "" ? "cleared" : null;

/** The channel a caller came by. A token (an MCP client is one) is a token whoever it acts for; an agent identity is an agent. */
export function reviewViaOf(caller: { user: { id: string }; token?: unknown }): Exclude<ReviewVia, "system"> {
  if (caller.token != null) return "token";
  return isAgentId(caller.user.id) ? "agent" : "person";
}

export type ReviewEvent = {
  genId: string;
  action: ReviewAction;
  /** The person's account id; the person who caused it for a system clear; "" when nobody. */
  actorId: string;
  via: ReviewVia;
  tokenId?: string | null;
  reasons?: readonly RejectReason[];
  drift?: DriftDetail | null;
  noteId?: string | null;
  /** For a system clear: why (`master_changed`). */
  cause?: string | null;
  at: number;
};

/** The statement that appends one event. Run it in the same batch as the mark it records. */
export function reviewEventStatement(e: ReviewEvent): InStatement {
  return {
    sql: `INSERT INTO take_review_events (id, gen_id, action, actor_id, via, token_id, reasons, drift, note_id, cause, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [newId("tre"), e.genId, e.action, e.actorId, e.via, e.tokenId ?? null, e.reasons?.length ? JSON.stringify(e.reasons) : null, e.drift ?? null, e.noteId ?? null, e.cause ?? null, e.at],
  };
}

/**
 * A locked master changed, so the approved takes of the shots it reaches go back to review (app/api/rig/attributes/[id]/current/route.ts). One batch: a `cleared` event for each take
 * actually returned (read in the same write as the update, so it names exactly those), then the update. approved_by and approved_at stay: who signed a take off is a record.
 * `kinds` are the kinds the attribute could have changed. Returns how many takes were returned.
 */
export async function clearApprovalsForMasterChange(
  client: { batch(statements: InStatement[], mode?: "write"): Promise<{ rowsAffected: number }[]> },
  input: { shotIds: readonly string[]; kinds: readonly string[]; actorId: string; at: number },
): Promise<number> {
  if (!input.shotIds.length) return 0;
  const shots = input.shotIds.map(() => "?").join(","), kinds = input.kinds.map(() => "?").join(",");
  const where = `shot_id IN (${shots}) AND review_state = 'approved' AND deleted = 0 AND kind IN (${kinds})`;
  const results = await client.batch([
    {
      sql: `INSERT INTO take_review_events (id, gen_id, action, actor_id, via, token_id, reasons, drift, note_id, cause, created_at)
            SELECT 'tre_' || lower(hex(randomblob(12))), id, 'cleared', ?, 'system', NULL, NULL, NULL, NULL, 'master_changed', ? FROM generations WHERE ${where}`,
      args: [input.actorId, input.at, ...input.shotIds, ...input.kinds],
    },
    { sql: `UPDATE generations SET review_state = '', updated_at = ? WHERE ${where}`, args: [input.at, ...input.shotIds, ...input.kinds] },
  ], "write");
  return results[1].rowsAffected;
}

/** The most a send-back's own words may run to (the board asks for 3 to 500). */
export const REASON_TEXT_MAX = 500;
/** A send-back's words as they are kept: one line, trimmed; "" when there are none. */
export const cleanReasonText = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
