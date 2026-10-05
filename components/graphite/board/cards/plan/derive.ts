import { nodesForSet, STUDIO_GROUP } from "@/lib/board/regions";
import type { BoardCard, BoardSource, CardState, GroupData } from "@/lib/board/types";
import { briefDoc, type BriefDoc } from "../doc/model";
import { storyboard } from "../storyboard/model";
import { shotTakes, shotsTakeOver } from "../take/take-model";

/*
 * Which of this set's cards are on the board, from the production as it is now (stream 3's CardSet.derive):
 * the brief document, the briefs placed on the canvas, and the Storyboard group with one frame per shot.
 * Pure and cheap. The looks, the questions and the plan join as their PRs land.
 */

/** The brief card: the project's own brief, or a brief card placed on the canvas. */
export type DocData =
  | { variant: "brief"; doc: BriefDoc }
  | { variant: "node"; nodeId: string; title: string; text: string };

/** One storyboard frame. */
export type FrameData = { shotId: string; index: number; name: string; line: string; genId: string | null; rendering: boolean };

/** Runs of Atomik past their approval: the shots were approved to render, so the storyboard is done. */
const APPROVED: readonly string[] = ["running", "needs_you", "paused", "done"];

export function derivePlanCards(src: BoardSource): BoardCard[] {
  const cards: BoardCard[] = [];
  const { project } = src;

  const doc = briefDoc(project);
  /* An empty brief puts no card down: the empty board's "What are we making?" is the way in (frame a). */
  if (doc.state === "done") {
    cards.push({ id: "doc:brief", kind: "doc", region: "brief", order: 0, state: "done", summary: doc.summary, data: { variant: "brief", doc } satisfies DocData });
  }
  nodesForSet(project, "plan").forEach(({ node, role }, i) => {
    if (role.kind !== "doc") return;
    const text = (node.text ?? "").trim();
    const state: CardState = text ? "done" : "empty";
    cards.push({
      id: node.id, kind: "doc", region: "brief", order: 1 + i, nodeId: node.id, state, ...(text ? { summary: "Brief · 1 document" } : {}),
      data: { variant: "node", nodeId: node.id, title: node.title, text: node.text ?? "" } satisfies DocData,
    });
  });

  const board = storyboard(project, { approved: Boolean(src.agent && APPROVED.includes(src.agent.state)) });
  /* Frames become takes in place (README § 3.1 f): once the Shots cards take over, the storyboard group gives way. */
  const takenOver = shotsTakeOver(shotTakes(project, src.library), src.agent);
  if (board.frames.length && !takenOver) {
    const group: GroupData = { title: board.title, meta: board.meta, columns: 2 };
    cards.push({
      id: STUDIO_GROUP.storyboard, kind: "group", region: "storyboard", order: -1, state: board.state,
      ...(board.state === "needs" ? { needs: 1 } : {}), summary: board.summary, data: group,
    });
    for (const frame of board.frames) {
      cards.push({
        id: `frame:${frame.shotId}`, kind: "frame", region: "storyboard", group: STUDIO_GROUP.storyboard, order: frame.index,
        state: frame.rendering ? "working" : frame.genId ? "done" : "empty",
        data: { shotId: frame.shotId, index: frame.index, name: frame.name, line: frame.line, genId: frame.genId, rendering: frame.rendering } satisfies FrameData,
      });
    }
  }
  return cards;
}
