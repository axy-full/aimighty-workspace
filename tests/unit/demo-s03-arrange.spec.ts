import { test, expect } from "@playwright/test";
import { newProject, type CanvasNode } from "../../lib/workbench/studio";
import { moved, reorderNodes, reorderSlot, siblingsOf, canReorder } from "../../lib/board/reorder";
import { tidyFree, TIDY_LEFT, TIDY_WIDTH } from "../../lib/board/tidy";
import type { BoardCard } from "../../lib/board/types";
import { runBoardCommand } from "../../lib/board/commands";
import { addFreeMedia, removeFreeCards, FREE_MEDIA_WIDTH } from "../../lib/board/snap";

/* Stream 3 · arranging: reorder by drag (draft order) and Tidy for free cards. Pure parts; neutral names. */
const node = (id: string, type: CanvasNode["type"] = "scene"): CanvasNode => ({ id, title: id, type, x: 0, y: 0, width: 254, linked: [] });
const box = (x: number, y: number) => ({ x, y, w: 340, h: 290 });

test("a drop lands by reading order: a row above, or the same row and left of the point", () => {
  /* Two columns: a b / c d, each 340 × 290 with 14 between. */
  const grid = [{ id: "a", box: box(0, 0) }, { id: "b", box: box(354, 0) }, { id: "c", box: box(0, 304) }, { id: "d", box: box(354, 304) }];
  /* d dragged to the left half of a: first. */
  expect(reorderSlot(grid, "d", { x: 20, y: 100 })?.index).toBe(0);
  /* b dragged under c's right side: after c (index 2 among a, c, d without b). */
  expect(reorderSlot(grid, "b", { x: 300, y: 450 })?.index).toBe(2);
  /* a dragged below everything: last. */
  expect(reorderSlot(grid, "a", { x: 100, y: 900 })?.index).toBe(3);
  /* Let go where it already is, or alone: no move. */
  expect(reorderSlot(grid, "b", { x: 500, y: 100 })).toBeNull();
  expect(reorderSlot([{ id: "a", box: box(0, 0) }], "a", { x: 5, y: 5 })).toBeNull();
  /* The line sits in the gap before the card it lands ahead of, or after the last. */
  expect(reorderSlot(grid, "d", { x: 20, y: 100 })?.line).toEqual({ x: -8, y: 0, w: 4, h: 290 });
  const last = reorderSlot(grid, "a", { x: 100, y: 900 })!.line;
  expect(last.x).toBe(354 + 340 + 4);
});

test("a reorder is one edit to the draft's order, and every other node keeps its place", () => {
  const project = { ...newProject("Fixture"), nodes: [node("s1"), node("cast", "character"), node("s2"), node("note", "note"), node("s3")] };
  const out = reorderNodes(project, moved(["s1", "s2", "s3"], "s3", 0));
  expect(out.nodes.map((n) => n.id)).toEqual(["s3", "cast", "s1", "note", "s2"]);
  /* The inverse restores it. */
  expect(reorderNodes(out, ["s1", "s2", "s3"]).nodes.map((n) => n.id)).toEqual(project.nodes.map((n) => n.id));
  /* Nothing to change, a node that is gone, or a set that changed: the draft as it was. */
  expect(reorderNodes(project, ["s1", "s2", "s3"])).toBe(project);
  expect(reorderNodes(project, ["s1", "gone"])).toBe(project);
  expect(reorderNodes(project, ["s1", "s1"])).toBe(project);
});

test("only arranged shots and references reorder, among their own kind in their own frame", () => {
  const card = (id: string, kind: string, order: number, extra: Partial<BoardCard> = {}): BoardCard => ({ id, kind, region: "shots", order, nodeId: id, state: "empty", data: {}, group: "g", ...extra });
  const cards = [card("t2", "take", 2), card("t1", "take", 1), card("c1", "cast", 0, { group: "g2", region: "cast" }), card("n", "note", 0, { region: null }), card("t9", "take", 9, { group: "other" }), card("g", "group", 0, { nodeId: undefined })];
  expect(siblingsOf(cards, cards[0]).map((c) => c.id)).toEqual(["t1", "t2"]);
  expect([canReorder(cards[0]), canReorder(cards[2]), canReorder(cards[3]), canReorder(cards[5])]).toEqual([true, true, false, false]);
});

test("Tidy puts the free cards in canvas order on the dots, rows wrapping, and leaves locked cards and cards already placed", () => {
  const free = (id: string, w: number, h: number, x: number, y: number, locked = false) => ({ id, w, h, x, y, locked });
  const moves = tidyFree([free("a", 254, 168, 507, 333), free("b", 254, 168, 1611, 45), free("c", 260, 52, 805, 801), free("lock", 254, 168, 5, 5, true), free("d", 254, 168, 0, 0)]);
  for (const m of moves) { expect(m.x % 24).toBe(0); expect(m.y % 24).toBe(0); expect(m.x).toBeGreaterThanOrEqual(TIDY_LEFT); }
  expect(moves.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  const at = Object.fromEntries(moves.map((m) => [m.id, m]));
  expect(at.a.y).toBe(at.b.y);
  expect(at.b.x).toBeGreaterThan(at.a.x + 254);
  expect(moves.some((m) => m.id === "lock")).toBe(false);
  /* Rows wrap at the block's width. */
  const wide = tidyFree(Array.from({ length: 6 }, (_, i) => free(`w${i}`, 254, 168, 0, 0)));
  expect(Math.max(...wide.map((m) => m.x + 254))).toBeLessThanOrEqual(TIDY_LEFT + TIDY_WIDTH);
  expect(new Set(wide.map((m) => m.y)).size).toBeGreaterThan(1);
  /* Already tidy: nothing to move. */
  expect(tidyFree(tidyFree([free("a", 254, 168, 9, 9), free("b", 254, 168, 9, 9)]).map((m) => free(m.id, 254, 168, m.x, m.y)))).toEqual([]);
});

test("a board command with no board open says so", () => {
  expect(runBoardCommand({ name: "tidy" })).toBe(false);
});

test("a picture or a video added to the board is a free media card on the dots, its file kept on the project; other files are refused", () => {
  const project = newProject("Fixture");
  const asset = (kind: "image" | "video" | "audio") => ({ id: `a-${kind}`, name: `${kind}.file`, kind, category: "Take", url: "/x", description: "", prompt: "", status: "Draft" as const, locked: false, version: 1, refs: [] });
  const out = addFreeMedia(project, asset("image"), { x: 101, y: 59 }, "node-media001");
  const card = out.nodes.at(-1)!;
  expect([card.id, card.type, card.assetId, card.width, card.x % 24, card.y % 24]).toEqual(["node-media001", "media", "a-image", FREE_MEDIA_WIDTH, 0, 0]);
  expect(out.assets.map((a) => a.id)).toEqual(["a-image"]);
  /* The same id again is the same board; a second card of a filed asset adds no asset. */
  expect(addFreeMedia(out, asset("image"), { x: 0, y: 0 }, "node-media001")).toBe(out);
  expect(addFreeMedia(out, asset("image"), { x: 0, y: 0 }, "node-media002").assets).toHaveLength(1);
  expect(() => addFreeMedia(project, asset("audio"), { x: 0, y: 0 }, "node-media003")).toThrow("pictures and videos");
  /* ⌫ takes it off (it feeds no shot), and the Undo's input is what was taken. */
  const gone = removeFreeCards(out, ["node-media001"]);
  expect(gone.removed.map((n) => n.id)).toEqual(["node-media001"]);
});
