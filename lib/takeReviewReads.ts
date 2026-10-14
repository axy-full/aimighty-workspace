import { db } from "./db";
import { storedActorMaskHere } from "./platformOwnerPrivacy";
import { isDriftDetail, isRejectReason, type DriftDetail, type RejectReason } from "./rejectReasons";
import type { ReviewVia } from "./takeReview";

/**
 * Who picked, approved or sent back a take, read from the history (`take_review_events`, lib/takeReview.ts; owner, 14 Oct 2026; docs/plans/step-0-data.md item 3).
 *
 * A reply never carries an account id. The person is a NAME, read through the workspace's own `users` row (the platform owner is stored there as "Particl support" outside the
 * house) and through the same stored-actor mask every other read uses; someone with no row (an agent, a person who has gone) has no name, and the channel says how it was done. A mark
 * with no event (everything made before the history, and a take marked by something that wrote none) reads `null`: "not recorded", never a guess from the name columns.
 * The reasons are codes only (lib/rejectReasons.ts): the person's own words stay in the take's notes.
 */
export type ReviewMark = { by: string | null; via: ReviewVia; at: number };
export type ReviewReject = ReviewMark & { reasons: RejectReason[]; drift: DriftDetail | null };
export type ReviewRead = { picked: ReviewMark | null; approved: ReviewMark | null; changes: ReviewReject | null };

export const NO_REVIEW: ReviewRead = Object.freeze({ picked: null, approved: null, changes: null });

const VIA = new Set<ReviewVia>(["person", "token", "agent", "system"]);
const CHUNK = 400;

/** The latest event of each kind for each take (the history is read oldest first, so a later one replaces an earlier one). */
export async function reviewReadsFor(ids: readonly string[]): Promise<Map<string, ReviewRead>> {
  const out = new Map<string, ReviewRead>();
  if (!ids.length) return out;
  const mask = await storedActorMaskHere();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rs = await db().execute({
      sql: `SELECT e.gen_id, e.action, e.via, e.reasons, e.drift, e.created_at, u.name AS actor_name
            FROM take_review_events e LEFT JOIN users u ON u.id = e.actor_id
            WHERE e.gen_id IN (${part.map(() => "?").join(",")}) AND e.action IN ('picked','approved','changes') ORDER BY e.created_at, e.rowid`,
      args: [...part],
    });
    for (const r of rs.rows as unknown as { gen_id: string; action: string; via: string; reasons: string | null; drift: string | null; created_at: number; actor_name: string | null }[]) {
      const current = out.get(String(r.gen_id)) ?? { picked: null, approved: null, changes: null };
      const via = VIA.has(r.via as ReviewVia) ? (r.via as ReviewVia) : "person";
      const name = r.actor_name == null || String(r.actor_name).trim() === "" ? null : String(mask(String(r.actor_name)));
      const mark: ReviewMark = { by: name, via, at: Number(r.created_at) };
      if (r.action === "picked") current.picked = mark;
      else if (r.action === "approved") current.approved = mark;
      else {
        let codes: unknown = [];
        try { codes = JSON.parse(String(r.reasons ?? "[]")); } catch { /* unreadable: no codes */ }
        current.changes = { ...mark, reasons: Array.isArray(codes) ? codes.filter(isRejectReason) : [], drift: isDriftDetail(r.drift) ? r.drift : null };
      }
      out.set(String(r.gen_id), current);
    }
  }
  return out;
}
