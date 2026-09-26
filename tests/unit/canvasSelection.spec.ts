import { test, expect } from "@playwright/test";
import { nodeHeight } from "../../lib/workbench/node-graph";
import { type CanvasNode } from "../../lib/workbench/studio";
import { PROJECT_LIMITS } from "../../lib/workbench/project-limits";
import {
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  clampCanvasZoom,
  describeRemoval,
  duplicateSelectedNodes,
  fitCanvasNodes,
  marqueeSelection,
  moveSelectedNodes,
  removableNodeIds,
  removeSelectedNodes,
  selectionRect,
  toggleNodeSelection,
  zoomAround,
} from "../../lib/workbench/canvas-selection";
const node = (id: string, fields: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  title: id,
  type: "note",
  x: 0,
  y: 0,
  width: 100,
  linked: [],
  ...fields,
});

test("marquee handles every drag direction, partial overlap, collapsed height, additive and deleted selections", () => {
  const nodes = [
    node("a", { x: 20, y: 20 }),
    node("b", { x: 200, y: 20, collapsed: true }),
    node("c", { x: 400, y: 300 }),
  ];
  expect(selectionRect({ x: 210, y: 80 }, { x: 10, y: 10 })).toEqual({
    x: 10,
    y: 10,
    width: 200,
    height: 70,
  });
  expect(marqueeSelection(nodes, { x: 210, y: 80 }, { x: 10, y: 10 })).toEqual([
    "a",
    "b",
  ]);
  expect(
    marqueeSelection(nodes, { x: 200, y: 75 }, { x: 290, y: 100 }, [
      "c",
      "missing",
    ]),
  ).toEqual(["c"]);
  expect(
    marqueeSelection(nodes, { x: 90, y: 220 }, { x: 140, y: 300 }),
  ).toEqual(["a"]);
});
test("shift toggles node selection without losing its other members", () => {
  expect(toggleNodeSelection(["a"], "b", true)).toEqual(["a", "b"]);
  expect(toggleNodeSelection(["a", "b"], "a", true)).toEqual(["b"]);
  expect(toggleNodeSelection(["a", "b"], "c", false)).toEqual(["c"]);
});
test("group move preserves spacing at limits and excludes locked nodes without mutating source", () => {
  const nodes = [
    node("a", { x: 19900, y: -9950 }),
    node("b", { x: 19990, y: -9900 }),
    node("locked", { locked: true }),
    node("outside"),
  ];
  const moved = moveSelectedNodes(nodes, ["a", "b", "locked"], {
    x: 90,
    y: -200,
  });
  expect(moved.slice(0, 2).map((n) => [n.x, n.y])).toEqual([
    [19910, -10000],
    [20000, -9950],
  ]);
  expect(moved[2]).toBe(nodes[2]);
  expect(moved[3]).toBe(nodes[3]);
  expect(nodes[0].x).toBe(19900);
  expect(moveSelectedNodes(nodes, ["a"], { x: NaN, y: 2 })).toBe(nodes);
});
test("duplicate preserves external references and remaps all internal edges and switch choice atomically", () => {
  const nodes = [
    node("external"),
    node("a", {
      linked: ["external"],
      status: "approved",
      operations: [
        {
          id: "op",
          kind: "direction",
          enabled: true,
          values: { note: "original" },
        },
      ],
    }),
    node("b", { type: "switch", linked: ["a", "external"], activeInput: "a" }),
    node("locked", { locked: true }),
  ];
  const copy = duplicateSelectedNodes(nodes, ["a", "b", "locked"]);
  expect(copy.ids).toHaveLength(2);
  const [a, b] = copy.nodes.slice(-2);
  expect(a.linked).toEqual(["external"]);
  expect(b.linked).toEqual([a.id, "external"]);
  expect(b.activeInput).toBe(a.id);
  expect(a.status).toBe("draft");
  a.operations![0].values.note = "changed";
  expect(nodes[1].operations![0].values.note).toBe("original");
  expect(
    duplicateSelectedNodes(
      Array.from({ length: PROJECT_LIMITS.nodes - 1 }, (_, i) => node(String(i))),
      ["0", "1"],
    ).ids,
  ).toEqual([]);
  // The old 250-node ceiling is gone: a 300-node canvas still duplicates.
  expect(
    duplicateSelectedNodes(
      Array.from({ length: 300 }, (_, i) => node(String(i))),
      ["0", "1"],
    ).ids,
  ).toHaveLength(2);
});
test("deletion retains locked nodes and their inputs, clears downstream edges and active switch route", () => {
  const nodes = [
    node("a"),
    node("b"),
    node("locked", { locked: true, linked: ["a"] }),
    node("switch", { type: "switch", linked: ["a", "b"], activeInput: "b" }),
  ];
  expect(removableNodeIds(nodes, ["a", "b", "locked"])).toEqual(["b"]);
  const result = removeSelectedNodes(nodes, ["a", "b", "locked"]);
  expect(result.map((n) => n.id)).toEqual(["a", "locked", "switch"]);
  expect(result[1]).toBe(nodes[2]);
  expect(result[2].linked).toEqual(["a"]);
  expect(result[2].activeInput).toBeUndefined();
  expect(nodes[3].linked).toEqual(["a", "b"]);
  expect(removeSelectedNodes(nodes, ["a", "locked"])).toBe(nodes);
});

test("overview fits tall graphs below manual zoom floor and leaves controls clear", () => {
  const nodes = [node("a", { x: -200, y: -100 }), node("b", { x: 900, y: 1200 })];
  const fit = fitCanvasNodes(nodes, { width: 844, height: 185 }, { top: 35, bottom: 76 });
  expect(fit.zoom).toBeGreaterThan(0);
  expect(fit.zoom).toBeLessThan(.25);
  for (const n of nodes) {
    expect(n.x * fit.zoom + fit.pan.x).toBeGreaterThanOrEqual(35);
    expect((n.x + n.width) * fit.zoom + fit.pan.x).toBeLessThanOrEqual(844 - 35);
    expect(n.y * fit.zoom + fit.pan.y).toBeGreaterThanOrEqual(35);
    expect((n.y + nodeHeight(n)) * fit.zoom + fit.pan.y).toBeLessThanOrEqual(185 - 76 + .001);
  }
  expect(fitCanvasNodes([], { width: 844, height: 185 }, { top: 35, bottom: 76 })).toEqual({ zoom: .82, pan: { x: 35, y: 35 } });
});


test("duplicates keep a visible screen offset in a zoomed-out overview", () => {
  const zoom = .08;
  const original = node("a");
  const result = duplicateSelectedNodes([original], [original.id], Math.max(40,24/zoom));
  expect((result.nodes[1].x-original.x)*zoom).toBe(24);
  expect((result.nodes[1].y-original.y)*zoom).toBe(24);
});

test("one zoom domain: steps clamp to the range but never jump up from an overview fit", () => {
  expect(clampCanvasZoom(2)).toBe(CANVAS_ZOOM_MAX);
  expect(clampCanvasZoom(0.1)).toBe(CANVAS_ZOOM_MIN);
  expect(clampCanvasZoom(0.08 + 0.1, 0.08)).toBeCloseTo(0.18);
  expect(clampCanvasZoom(0.08 - 0.1, 0.08)).toBe(0.08);
  expect(clampCanvasZoom(NaN, 0.5)).toBe(0.5);
  expect(clampCanvasZoom(0.5, NaN)).toBe(0.5);
  const anchored = zoomAround({ x: 100, y: 50 }, { x: 20, y: 10 }, 0.5, 1);
  // The world point under the anchor stays under it.
  expect((100 - anchored.pan.x) / anchored.zoom).toBeCloseTo((100 - 20) / 0.5);
  expect((50 - anchored.pan.y) / anchored.zoom).toBeCloseTo((50 - 10) / 0.5);
});

test("marquee edges that only touch a node do not select it", () => {
  const nodes = [node("a", { x: 100, y: 100 })];
  expect(marqueeSelection(nodes, { x: 0, y: 0 }, { x: 100, y: 100 })).toEqual([]);
  expect(marqueeSelection(nodes, { x: 0, y: 0 }, { x: 101, y: 101 })).toEqual(["a"]);
  expect(nodeHeight(node("c", { collapsed: true }))).toBe(48);
});

test("removal outcome names the locked blocker and reports partial removals honestly", () => {
  const nodes = [
    node("Alpha"),
    node("Beta"),
    node("Gamma", { locked: true, linked: ["Alpha"] }),
  ];
  expect(describeRemoval(nodes, ["Alpha"]).message).toBe("Alpha feeds locked Gamma. Unlock first to remove.");
  expect(describeRemoval(nodes, ["Gamma"]).message).toBe("Gamma is locked. Unlock first to remove.");
  expect(describeRemoval(nodes, ["Beta"]).message).toBe("Node removed. Use Undo to restore.");
  const mixed = describeRemoval(nodes, ["Alpha", "Beta", "Gamma"]);
  expect(mixed.removable).toEqual(["Beta"]);
  expect(mixed.message).toBe("1 of 3 nodes removed. Alpha feeds locked Gamma. Gamma is locked. Use Undo to restore.");
});
