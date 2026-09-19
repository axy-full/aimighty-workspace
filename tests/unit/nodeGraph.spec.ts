import { test, expect } from "@playwright/test";
import {
  NODE_VERSION_LIMIT,
  appendNodeVersion,
  arrangeGraph,
  canConnect,
  nextVersionLabel,
  nodeHeight,
  previewRenderKey,
} from "../../lib/workbench/node-graph";
import { type CanvasNode, type NodeVersion } from "../../lib/workbench/studio";

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
const overlaps = (a: CanvasNode, b: CanvasNode) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + nodeHeight(b) &&
  a.y + nodeHeight(a) > b.y;

test("arrangeGraph keeps locked nodes in place, leaves no gap for them and steps below them", () => {
  const nodes = [
    node("a"),
    node("locked", { locked: true, x: 60, y: 70 }),
    node("b"),
    node("c", { linked: ["a"] }),
  ];
  const arranged = arrangeGraph(nodes);
  const byId = Object.fromEntries(arranged.map((n) => [n.id, n]));
  expect(byId.locked).toBe(nodes[1]);
  // Column 0 holds a and b; the locked node sits at the first slot, so a steps below it and b follows a with no hole.
  expect(byId.a.x).toBe(60);
  expect(byId.a.y).toBe(70 + nodeHeight(nodes[1]) + 38);
  expect(byId.b.y).toBe(byId.a.y + nodeHeight(byId.a) + 38);
  expect(byId.c.x).toBe(460);
  expect(byId.c.y).toBe(70);
  for (const n of arranged)
    for (const other of arranged)
      if (n !== other) expect(overlaps(n, other)).toBe(false);
  expect(nodes[0].x).toBe(0);
});

test("arrangeGraph never places a child in its parent's column, however deep the chain", () => {
  const chain = Array.from({ length: 16 }, (_, i) =>
    node("n" + String(i).padStart(2, "0"), i ? { linked: ["n" + String(i - 1).padStart(2, "0")] } : {}),
  );
  const arranged = arrangeGraph(chain);
  arranged.forEach((n, i) => {
    expect(n.x).toBe(60 + i * 400);
    if (i) expect(n.x).toBeGreaterThan(arranged[i - 1].x);
  });
});

test("arrangeGraph is deterministic for cycles regardless of array order", () => {
  const cycle = [node("b", { linked: ["a"] }), node("a", { linked: ["b"] }), node("c", { linked: ["b"] })];
  const column = (list: CanvasNode[]) =>
    Object.fromEntries(list.map((n) => [n.id, n.x]));
  const forward = column(arrangeGraph(cycle));
  // The cycle breaks at the same edge whichever node is visited first: rows follow node order, columns do not.
  expect(column(arrangeGraph([...cycle].reverse()))).toEqual(forward);
  expect(forward).toEqual({ a: 460, b: 60, c: 460 });
  const arranged = arrangeGraph(cycle);
  for (const n of arranged)
    for (const other of arranged)
      if (n !== other) expect(overlaps(n, other)).toBe(false);
});

test("canConnect checks kind, arity and existing topology with clear messages", () => {
  const nodes = [
    node("brief", { type: "brief" }),
    node("media", { type: "media" }),
    node("media2", { type: "media" }),
    node("media3", { type: "media" }),
    node("grade", { type: "grade", linked: ["media"] }),
    node("grade2", { type: "grade" }),
    node("merge", { type: "merge", linked: ["media", "media2"] }),
    node("scene", { type: "scene" }),
    node("locked", { type: "grade", locked: true }),
  ];
  expect(canConnect(nodes, "brief", "grade2")).toContain("take an image input, not a direction");
  expect(canConnect(nodes, "brief", "scene")).toBeNull();
  expect(canConnect(nodes, "media", "scene")).toBeNull();
  expect(canConnect(nodes, "media2", "grade")).toContain("take one input");
  expect(canConnect(nodes, "media3", "merge")).toContain("two inputs");
  expect(canConnect(nodes, "media", "grade2")).toBeNull();
  expect(canConnect(nodes, "media", "grade")).toBe("These nodes are already connected.");
  expect(canConnect(nodes, "media", "locked")).toBe("Unlock this node before changing its inputs.");
  expect(canConnect(nodes, "grade", "grade")).toBe("A node cannot connect to itself.");
  expect(canConnect(nodes, "grade", "media")).toBe("This connection would create a circular path.");
  expect(canConnect(nodes, "missing", "grade2")).toBe("Choose two existing nodes.");
});

test("version labels count every save and the cap reports the version it drops", () => {
  const version = (label: string): NodeVersion => ({
    id: label,
    label,
    operations: [],
    savedAt: "2026-09-19T00:00:00.000Z",
  });
  expect(nextVersionLabel()).toBe("Version 1");
  expect(nextVersionLabel([version("Version 1"), version("Before restoring Version 1")])).toBe("Version 3");
  let versions: NodeVersion[] = [];
  let dropped: NodeVersion | undefined;
  for (let i = 0; i < NODE_VERSION_LIMIT + 2; i++) {
    const saved = appendNodeVersion(versions, version(nextVersionLabel(versions)));
    versions = saved.versions;
    dropped = saved.dropped;
    if (i < NODE_VERSION_LIMIT) expect(dropped).toBeUndefined();
  }
  expect(versions).toHaveLength(NODE_VERSION_LIMIT);
  expect(versions.at(-1)!.label).toBe("Version 32");
  expect(versions[0].label).toBe("Version 3");
  expect(dropped!.label).toBe("Version 2");
});

test("preview key follows the upstream chain, not node positions", () => {
  const nodes = [node("src", { type: "media", assetId: "asset" }), node("grade", { type: "grade", linked: ["src"] })];
  const assets = [{ id: "asset", url: "/a.png", kind: "image" } as never];
  const before = previewRenderKey(nodes[1], nodes, assets);
  expect(previewRenderKey(nodes[1], [{ ...nodes[0], x: 500 }, nodes[1]], assets)).toBe(before);
  expect(previewRenderKey(nodes[1], [{ ...nodes[0], bypassed: true }, nodes[1]], assets)).not.toBe(before);
  expect(previewRenderKey(nodes[1], nodes, [{ id: "asset", url: "/b.png", kind: "image" } as never])).not.toBe(before);
});
