import { test, expect } from "@playwright/test";
import { boardRings } from "../../lib/v12/boardRing";
import type { TrayJob } from "../../lib/jobsTray";

/** The board tab's ring (lib/v12/boardRing.ts): the share of a board's running work, capped at 90%, and about how long is left. */
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const job = (over: Partial<TrayJob>): TrayJob => ({
  id: "j", source: "engine", kind: "video", name: "A take", mediaUrl: null, stage: "rendering", label: "Rendering", tone: "blue", reason: null, progress: null,
  createdAt: NOW - 60_000, settledAt: null, price: null, draftId: "board-a", projectName: "A board", action: null, ...over,
} as TrayJob);

test("a board with takes running has a ring, by the kind's typical time, never past 90%", () => {
  const rings = boardRings([job({ id: "a" }), job({ id: "b", createdAt: NOW - 3_600_000 })], NOW);
  const ring = rings.get("board-a")!;
  expect(ring.count).toBe(2);
  expect(ring.pct).toBeGreaterThan(0.04);
  expect(ring.pct).toBeLessThanOrEqual(0.9);
  expect(ring.words).toMatch(/^Rendering · (almost done|about \d+ (s|min) left)$/);
});

test("takes of other boards, finished ones and ones with no board have no ring", () => {
  const rings = boardRings([job({ id: "a", draftId: "board-b" }), job({ id: "b", stage: "complete", settledAt: NOW }), job({ id: "c", draftId: null })], NOW);
  expect(rings.has("board-a")).toBe(false);
  expect([...rings.keys()]).toEqual(["board-b"]);
});

test("a take just asked for starts a little way in, and a long wait holds at the cap", () => {
  expect(boardRings([job({ createdAt: NOW })], NOW).get("board-a")!.pct).toBeGreaterThanOrEqual(0.04);
  const late = boardRings([job({ createdAt: NOW - 24 * 3_600_000 })], NOW).get("board-a")!;
  expect(late.pct).toBe(0.9);
  expect(late.leftMs).toBe(0);
});
