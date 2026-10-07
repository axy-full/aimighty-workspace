import { blockingDef } from "../blocking/BlockingCard";
import { deriveBlocking } from "../blocking/blocking-model";
import { mediaDef } from "../transcribe/MediaCard";
import type { CardSet } from "./types";

/*
 * The gap screens of lane 2 (3D blocking, Transcribe, Line drawings, Cut-out) that need a card definition of their own. Line drawings
 * and Cut-out live on the Storyboard frame (storyboard/FrameCard.tsx) and the Cast card (cast/CastCard.tsx); Transcribe is on the
 * reference card for a video or audio original, here, and on Social's source card. A later set's definition of a kind replaces
 * the board set's plain one (cards/index.ts).
 */
export const gapCardsA: CardSet = {
  id: "gaps-a",
  defs: [mediaDef, blockingDef],
  derive: (src) => deriveBlocking(src),
};
