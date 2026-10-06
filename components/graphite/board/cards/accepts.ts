import type { BoardDrop, DropAction } from "./types";

/**
 * A shot's card takes a still or a video from the Library as its reference (rig-build's addInput, as the Rig's own
 * library does). Every card kind that draws a shot (`take`, whichever set defines it) uses this one rule, so a later
 * set replacing the definition cannot lose the drop. A card with no shot behind it, or a file that is not a picture
 * or a video, refuses.
 */
export function shotReferenceDrop(drop: BoardDrop, card: { nodeId?: string }): DropAction | null {
  if (drop.type !== "asset" || (drop.media !== "image" && drop.media !== "video") || !card.nodeId) return null;
  return { type: "reference", shotId: card.nodeId, assetId: drop.assetId };
}
