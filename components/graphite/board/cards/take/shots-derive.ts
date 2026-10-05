import { STUDIO_GROUP } from "@/lib/board/regions";
import type { BoardCard, BoardSource, GroupData } from "@/lib/board/types";
import { needsReview, shotTakes, shotsHeader, shotState, type ShotTakes } from "./take-model";

/*
 * Which cards the Shots region holds (frames f and g), in production order. Pure and cheap: stream 3's canvas
 * calls it on every change and lays the cards out; nothing here positions anything.
 *
 * - "group:shots": the Shots group frame, its header, cost line and Stop.
 * - One `take` card per Rig shot card (it draws that node), showing the shot's current version.
 * - "group:review": frame g's group for the earliest shot whose take waits for a person (DECISIONS 20), with the
 *   large `take-review` card and the shot's `versions` card. Every other waiting take waits in review mode.
 *
 * Every Rig shot card is drawn here (stream 3's node table gives shot nodes to this set). Stream 4 hides its
 * storyboard group once `shotsTakeOver` (take-model.ts) is true, so the shots are not drawn twice for long.
 */

export const SHOTS_GROUP = STUDIO_GROUP.shots;
export const REVIEW_GROUP = "group:review";

/** The Shots group's data: the shared group frame's, plus its cost line and the run its Stop stops. */
export type ShotsGroupData = GroupData & {
  cost?: { live: boolean; spent: number | null };
  stop?: { runId: string };
};
export type TakeCardData = { row: ShotTakes };

export function deriveShots(src: Pick<BoardSource, "kind" | "project" | "library" | "agent">): BoardCard[] {
  if (src.kind !== "studio") return [];
  const rows = shotTakes(src.project, src.library);
  if (!rows.length) return [];
  const header = shotsHeader(rows, src.agent);
  const group: ShotsGroupData = {
    title: header.title,
    columns: 2,
    cost: { live: header.live, spent: header.spent },
    ...(header.stopRunId ? { stop: { runId: header.stopRunId } } : {}),
  };
  const cards: BoardCard[] = [{ id: SHOTS_GROUP, kind: "group", region: "shots", order: 0, state: "empty", summary: header.summary, data: group }];
  for (const row of rows) {
    const state = shotState(row);
    cards.push({
      id: row.nodeId, kind: "take", region: "shots", order: row.index, group: SHOTS_GROUP, nodeId: row.nodeId,
      state, ...(state === "needs" ? { needs: 1 } : {}), summary: header.summary, data: { row } satisfies TakeCardData,
    });
  }
  const waiting = rows.find((r) => r.shown && needsReview(r.shown));
  if (waiting?.shown) {
    const review: GroupData = { title: `Shot ${waiting.index} · review`, meta: `${waiting.shown.label} · needs you`, columns: 2, gap: 24 };
    cards.push(
      { id: REVIEW_GROUP, kind: "group", region: "shots", order: 1, state: "empty", data: review },
      { id: `take-review:${waiting.nodeId}`, kind: "take-review", region: "shots", order: 0, group: REVIEW_GROUP, state: "empty", data: { row: waiting } satisfies TakeCardData },
      { id: `versions:${waiting.nodeId}`, kind: "versions", region: "shots", order: 1, group: REVIEW_GROUP, state: "empty", data: { row: waiting } satisfies TakeCardData },
    );
  }
  return cards;
}
