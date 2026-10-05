import { BRIEF_DOC_WIDTH, briefDocHeight } from "./doc/model";
import { DocCard, ShotList } from "./doc/DocCards";
import { derivePlanCards, type DocData, type FrameData, type PlanData } from "./plan/derive";
import { PlanCard } from "./plan/PlanCard";
import { NextCard, NEXT_CARD_SIZE, type NextData } from "./plan/NextCard";
import { PLAN_CARD_WIDTH, planCardHeight, shapeOfSample } from "./plan/model";
import { LookCard } from "./looks/LookCard";
import { LookInspector } from "./looks/LookInspector";
import { PlanInspector } from "./plan/PlanInspector";
import { FrameInspector } from "./storyboard/FrameInspector";
import { LOOK_WIDTH, type LookData } from "./looks/derive";
import { FrameCard } from "./storyboard/FrameCard";
import { frameTileHeight } from "./storyboard/FrameTile";
import { defineCard, type CardSet } from "./types";

/*
 * Board cards 1 (design/particl-graphite/README.md § 3.1 b–e): the brief and shot list, the storyboard, and
 * — as their PRs land — the questions, the looks and the plan. Each kind replaces the board set's plain
 * fallback of the same kind; the Storyboard group uses the shared `group` frame.
 */

/** A storyboard frame's width on the board (the master's 340). */
const FRAME_WIDTH = 340;

export const planCards: CardSet = {
  id: "plan",
  defs: [
    defineCard<DocData>({
      kind: "doc",
      size: (data) => ({
        w: BRIEF_DOC_WIDTH,
        h: data.variant === "brief" ? briefDocHeight(data.doc) : briefDocHeight({ title: data.title, brief: data.text, look: "", footer: "" }),
      }),
      Card: DocCard,
    }),
    defineCard<FrameData>({
      kind: "frame",
      size: (_data, at) => ({ w: FRAME_WIDTH, h: frameTileHeight(FRAME_WIDTH, at.aspect) }),
      Card: FrameCard,
      Inspector: FrameInspector,
    }),
    defineCard<LookData>({
      kind: "look",
      size: (_data, at) => ({ w: LOOK_WIDTH, h: frameTileHeight(LOOK_WIDTH, at.aspect) }),
      Card: LookCard,
      Inspector: LookInspector,
    }),
    defineCard<NextData>({ kind: "next", size: () => NEXT_CARD_SIZE, Card: NextCard }),
    defineCard<PlanData>({
      kind: "plan",
      size: (data) => ({ w: PLAN_CARD_WIDTH, h: planCardHeight(data.run ?? shapeOfSample(data.sample), data.open) }),
      Card: PlanCard,
      Inspector: PlanInspector,
    }),
  ],
  derive: derivePlanCards,
  List: ShotList,
};
