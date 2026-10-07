import { test, expect } from "@playwright/test";
import { STUDIO_SETS, buildRegistry } from "../../components/graphite/board/cards";
import type { BoardCard } from "../../lib/board/types";

/* Release 1 CI, C1: a Library file dropped on a shot card. The shot cards (set-shots) replace the board's plain take card,
   and BoardView.dropOn only acts on a kind whose definition has `accepts`. Every registry the board builds must keep it. */

const shot = { id: "node-shot0001", kind: "take", region: "shots", order: 0, nodeId: "node-shot0001", state: "empty", data: {} } as unknown as BoardCard;
const noShot = { ...shot, id: "made:x", nodeId: undefined } as unknown as BoardCard;

for (const [name, sets] of [["Studio's sets", STUDIO_SETS], ["the board set alone", []]] as const) {
  test(`${name}: a shot takes a still or a video as its reference, and nothing else`, () => {
    const accepts = buildRegistry(sets).defs.get("take")?.accepts;
    expect(typeof accepts, "the take card definition takes drops").toBe("function");
    expect(accepts!({ type: "asset", assetId: "gen_a", media: "image" }, shot)).toEqual({ type: "reference", shotId: "node-shot0001", assetId: "gen_a" });
    expect(accepts!({ type: "asset", assetId: "gen_b", media: "video" }, shot)).toEqual({ type: "reference", shotId: "node-shot0001", assetId: "gen_b" });
    expect(accepts!({ type: "asset", assetId: "gen_c", media: "audio" }, shot)).toBeNull();
    expect(accepts!({ type: "asset", assetId: "gen_d", media: null }, shot)).toBeNull();
    expect(accepts!({ type: "card", cardId: "other" }, shot)).toBeNull();
    expect(accepts!({ type: "asset", assetId: "gen_e", media: "image" }, noShot), "a card with no shot behind it").toBeNull();
  });
}
