import { test, expect } from "@playwright/test";
import { GRID_ACTIONS, GRID_CARD, GRID_GAP, GRID_STAGES, evenHeights, gridColumns, gridPlaces } from "../../lib/v12/board/grid";
import { gridCards } from "../../components/v12/board/stage-grid";
import type { BoardCard } from "../../lib/board/types";

/**
 * The stage grid (lib/v12/board/grid.ts, components/v12/board/stage-grid.ts; redesign P2-b, inventory § 6.6, FIX § 13.2):
 * 4 across at 1440 with Atomik closed, 3 with it open, one 24 px gap for rows and columns, every card of a kind one
 * height so a finished card and a rendering one in the same row leave no empty canvas, and the cards a grid stage draws.
 */
test("columns follow the canvas: 4 across at 1440 with Atomik closed, 3 with it open, 2 at 1280, never fewer than 2 or more than 4", () => {
  expect(gridColumns(1440 - 88)).toBe(4);
  expect(gridColumns(1440 - 88 - 340)).toBe(3);
  expect(gridColumns(1280 - 88 - 340)).toBe(2);
  expect(gridColumns(1920 - 88)).toBe(4);
  expect(gridColumns(300)).toBe(2);
  expect(gridColumns(0)).toBe(4);
});

test("Storyboard and Shots are the grid stages", () => {
  expect([...GRID_STAGES].sort()).toEqual(["shots", "storyboard"]);
});

test("one height per kind: the tallest card's, and no row leaves more than the gap between it and the next", () => {
  const sizes = new Map([["a", { w: GRID_CARD, h: 219 }], ["b", { w: GRID_CARD, h: 259 }], ["c", { w: GRID_CARD, h: 240 }]]);
  const even = evenHeights(sizes);
  expect(new Set([...even.values()].map((s) => s.h))).toEqual(new Set([259]));
  const places = gridPlaces([...even.values()], 2);
  expect(places.map((p) => p.x)).toEqual([0, GRID_CARD + GRID_GAP, 0]);
  expect(places[2].y - places[0].y).toBe(259 + GRID_GAP);
  expect(GRID_ACTIONS).toBeGreaterThanOrEqual(32);
});

const card = (id: string, kind: string, extra: Partial<BoardCard> = {}): BoardCard => ({ id, kind, region: "shots", order: 0, state: "empty", data: { title: id }, ...extra } as BoardCard);

test("a grid stage drops the review group, takes the plan out of the group, and tells shots, frames and groups they are on the grid", () => {
  const out = gridCards([
    card("group:shots", "group"),
    card("node-1", "take", { group: "group:shots" }),
    card("group:review", "group"),
    card("take-review:node-1", "take-review", { group: "group:review" }),
    card("versions:node-1", "versions", { group: "group:review" }),
    card("plan", "plan", { group: "group:storyboard" }),
    card("frame:1", "frame", { group: "group:storyboard" }),
    card("note", "note"),
  ]);
  expect(out.map((c) => c.id)).toEqual(["group:shots", "node-1", "plan", "frame:1", "note"]);
  const by = new Map(out.map((c) => [c.id, c]));
  expect((by.get("node-1")!.data as { grid?: boolean }).grid).toBe(true);
  expect((by.get("frame:1")!.data as { grid?: boolean }).grid).toBe(true);
  expect((by.get("group:shots")!.data as { grid?: boolean }).grid).toBe(true);
  expect(by.get("plan")!.group).toBeUndefined();
  expect((by.get("note")!.data as { grid?: boolean }).grid).toBeUndefined();
});
