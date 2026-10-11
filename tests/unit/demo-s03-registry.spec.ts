import { test, expect } from "@playwright/test";
import { newProject, type CanvasNode } from "../../lib/workbench/studio";
import { STUDIO_BANDS } from "../../lib/board/regions";
import type { BoardSource } from "../../lib/board/types";
import { buildRegistry, defineCard, type CardSet } from "../../components/graphite/board/cards";
import { placeBoard } from "../../components/graphite/board/layout-cards";

/* Stream 3 · the card registry (plan § 0.3): sets merge after the board set; a later kind or id replaces an earlier one. */

const node = (id: string, type: CanvasNode["type"]): CanvasNode => ({ id, title: id, type, x: 0, y: 0, width: 254, linked: [] });
const source = (nodes: CanvasNode[]): BoardSource => ({
  kind: "studio", project: { ...newProject("Fixture"), nodes }, shots: [], jobs: [], library: [], masters: new Set(), agent: null, now: 0,
});
const Plain = () => null;

test("the board set draws today's nodes as fallbacks, grouped, until a stream's set takes them over", () => {
  const src = source([node("s1", "scene"), node("s2", "scene"), node("n1", "note")]);
  const plain = buildRegistry([]);
  const cards = plain.derive(src);
  expect(cards.map((c) => [c.id, c.kind, c.group ?? null])).toEqual([
    ["s1", "take", "group:shots"], ["s2", "take", "group:shots"], ["n1", "note", null], ["group:shots", "group", null],
  ]);

  /* A stream's set: its own `take` (by kind) and its own cards for the same nodes (by id), in its own group. */
  const shots: CardSet = {
    id: "shots",
    defs: [defineCard<{ n: number }>({ kind: "take", size: () => ({ w: 340, h: 300 }), Card: Plain }), defineCard<{ title: string }>({ kind: "group", size: () => ({ w: 1, h: 1 }), container: { columns: 3 }, Card: Plain })],
    derive: (s) => [
      ...s.project.nodes.filter((n) => n.type === "scene").map((n, i) => ({ id: n.id, kind: "take", region: "shots" as const, order: i, group: "group:shots-mine", nodeId: n.id, state: "working" as const, data: { n: i } })),
      { id: "group:shots-mine", kind: "group", region: "shots" as const, order: 0, state: "working" as const, data: { title: "Shots" } },
    ],
  };
  const taken = buildRegistry([shots]);
  expect(taken.defs.get("take")!.size({ n: 0 }, { aspect: "16:9" })).toEqual({ w: 340, h: 300 });
  const placed = placeBoard(taken.derive(src), taken.defs, STUDIO_BANDS, "16:9");
  /* The fallback group lost its cards to the stream's group, so it is not drawn empty. */
  expect(placed.byId.has("group:shots")).toBe(false);
  expect(placed.byId.get("s1")!.group).toBe("group:shots-mine");
  expect(placed.containers.has("group:shots-mine")).toBe(true);
  const group = placed.boxes.get("group:shots-mine")!, first = placed.boxes.get("s1")!;
  expect(first.x).toBeGreaterThan(group.x);
  expect(first.y).toBeGreaterThan(group.y);
});

test("a card whose kind no set defines is left out", () => {
  const odd: CardSet = { id: "odd", defs: [], derive: () => [{ id: "x", kind: "nobody", region: "brief", order: 0, state: "empty", data: {} }] };
  expect(buildRegistry([odd]).derive(source([])).map((c) => c.id)).toEqual([]);
});

test("the Made in Make band holds a card for each result Make filed, in its own group, and waits for a shot not on the board yet", async () => {
  const { madeCards } = await import("../../components/graphite/board/cards/set-board");
  const src = source([node("s1", "scene"), node("s2", "scene")]);
  expect(madeCards(src, [])).toEqual([]);
  expect(madeCards(src, [{ nodeId: "not-yet" }])).toEqual([]);
  const cards = madeCards(src, [{ nodeId: "s2" }, { nodeId: "s1" }]);
  expect(cards.map((c) => [c.id, c.kind, c.region, c.group ?? null, c.nodeId ?? null])).toEqual([
    ["group:made", "group", "made", null, null], ["made:s2", "made", "made", "group:made", "s2"], ["made:s1", "made", "made", "group:made", "s1"],
  ]);
  expect((cards[0].data as { meta: string }).meta).toBe("2 cards");
  /* The band sits under everything else, and the shots keep their own cards. */
  const reg = buildRegistry([]);
  const placed = placeBoard([...reg.derive(src), ...cards], reg.defs, STUDIO_BANDS, "16:9");
  expect(placed.byId.has("s1") && placed.byId.has("made:s1")).toBe(true);
  expect(placed.boxes.get("made:s1")!.y).toBeGreaterThan(placed.boxes.get("s1")!.y);
  expect(placed.regions.has("made")).toBe(true);
});
