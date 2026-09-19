import { test, expect } from "@playwright/test";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { cardWidth, connectNodes, edgePath, graphEdges, graphLayout, GRAPH_MIN, GRAPH_PAD } from "../../lib/workspace/rig-graph";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });

test("the prototype's edges come out of the same boxes", () => {
  /* Look board 20/46/220 (100 tall) and Scene 412/146/238 (208 tall), as in 03. */
  expect(edgePath({ left: 20, top: 46, width: 220, height: 100 }, { left: 412, top: 146, width: 238, height: 208 })).toBe("M240 96 C326 96, 326 250, 412 250");
  /* Scene → Direction: right edge to left edge, control points half-way across. */
  expect(edgePath({ left: 412, top: 146, width: 238, height: 136 }, { left: 776, top: 56, width: 254, height: 120 })).toBe("M650 214 C713 214, 713 116, 776 116");
});

test("layout keeps the saved positions, shifted to the padding, with the design's card widths", () => {
  const nodes = [node("look", { type: "moodboard", x: 460, y: 300, width: 280 }), node("s", { x: 860, y: 400 }), node("c", { type: "grade", x: 1260, y: 700, width: 236 })];
  const layout = graphLayout(nodes);
  expect(layout.cards).toEqual([
    { id: "look", left: GRAPH_PAD, top: GRAPH_PAD, width: 220 },
    { id: "s", left: 400 + GRAPH_PAD, top: 100 + GRAPH_PAD, width: 238 },
    { id: "c", left: 800 + GRAPH_PAD, top: 400 + GRAPH_PAD, width: 236 },
  ]);
  expect(layout.width).toBe(Math.max(GRAPH_MIN.width, 800 + GRAPH_PAD + 236 + GRAPH_PAD));
  expect(graphLayout([])).toEqual({ cards: [], ...GRAPH_MIN });
  expect([cardWidth({ type: "note", width: 400 }), cardWidth({ type: "note", width: 236 }), cardWidth({ type: "element", width: 280 })]).toEqual([254, 236, 220]);
});

test("edges follow stored links; connecting uses the Studio graph's rules", () => {
  const p: Project = { ...newProject("Graph"), nodes: [node("a", { type: "media" }), node("b", { linked: ["a", "gone"] }), node("g", { type: "grade", linked: ["b"] }), node("n", { type: "note" })] };
  expect(graphEdges(p.nodes)).toEqual([{ id: "a->b", source: "a", target: "b" }, { id: "b->g", source: "b", target: "g" }]);
  const ok = connectNodes(p, "n", "b");
  expect("project" in ok && ok.project.nodes.find((x) => x.id === "b")!.linked).toEqual(["a", "gone", "n"]);
  expect(p.nodes.find((x) => x.id === "b")!.linked).toEqual(["a", "gone"]);
  expect(connectNodes(p, "b", "b")).toEqual({ error: "A node cannot connect to itself." });
  expect(connectNodes(p, "a", "b")).toEqual({ error: "These nodes are already connected." });
  expect(connectNodes(p, "g", "b")).toEqual({ error: "This connection would create a circular path." });
  expect("error" in connectNodes(p, "n", "g")).toBe(true); // a colour node takes media, not a direction
});
