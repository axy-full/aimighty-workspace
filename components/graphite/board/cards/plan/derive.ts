import { nodesForSet, STUDIO_GROUP } from "@/lib/board/regions";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import type { BoardCard, BoardSource, CardState, GroupData } from "@/lib/board/types";
import { briefDoc, type BriefDoc } from "../doc/model";
import { deriveLooks } from "../looks/derive";
import { pickedLook } from "../looks/model";
import { storyboard } from "../storyboard/model";
import type { PlanModel } from "./model";
import { planStepsOpen } from "./ui";
import { nextChoices, NEXT_GROUP_TITLE, showWhereNext } from "./next";
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

/** The plan card: Atomik's run on the board, while it has something to approve, or renders to ask for. */
export type PlanData = {
  /** Atomik's run; null on the explore-only sample, which has none (./sample.ts). */
  run: RigAgentRunView | null;
  /** The sample's plan, built from its recorded prices. */
  sample?: PlanModel;
  open: boolean;
};

/** The run states whose plan the board shows: a proposal, and the build and renders that follow while they wait on someone. */
const PLAN_STATES: readonly string[] = ["awaiting_approval", "running", "needs_you", "paused"];
export const PLAN_CARD_ID = "plan:run";

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

  cards.push(...deriveLooks(project));
  const board = storyboard(project, { look: pickedLook(project)?.name ?? null, approved: Boolean(src.agent && APPROVED.includes(src.agent.state)) });
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
  /* "Where to next?" once every shot is approved (README § 3.1 j): a frame of three cards, each a way into a tool. */
  if (showWhereNext(shotTakes(project, src.library))) {
    const group: GroupData = { title: NEXT_GROUP_TITLE, columns: 3 };
    cards.push({ id: STUDIO_GROUP.next, kind: "group", region: "next", order: -1, state: "empty", data: group });
    nextChoices(project.aspect).forEach((choice, i) => cards.push({
      id: `next:${choice.id}`, kind: "next", region: "next", group: STUDIO_GROUP.next, order: i, state: "empty", summary: `${choice.name} · ${choice.line}`, data: choice,
    }));
  }
  /* The plan sits in the Storyboard group's open slot (README § 3.1 e); once the Shots cards have taken the group's place it stands alone beside them. */
  const run = src.agent;
  if (run && PLAN_STATES.includes(run.state) && run.paid.some((p) => p.tool === "render")) {
    const inGroup = cards.some((c) => c.id === STUDIO_GROUP.storyboard);
    cards.push({
      id: PLAN_CARD_ID, kind: "plan", region: inGroup ? "storyboard" : "shots", order: inGroup ? 10_000 : -1, ...(inGroup ? { group: STUDIO_GROUP.storyboard } : {}),
      state: run.state === "awaiting_approval" || run.state === "needs_you" || run.state === "paused" ? "needs" : "working",
      ...(inGroup ? {} : { summary: run.state === "awaiting_approval" ? "Plan at the gate" : run.state === "running" ? "Atomik is working" : "Waiting for you" }),
      data: { run, open: planStepsOpen(run.id) } satisfies PlanData,
    });
  }
  return cards;
}
