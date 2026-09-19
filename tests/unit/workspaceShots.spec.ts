import { test, expect } from "@playwright/test";
import { seedProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { rigShots, rigSubtitle, shotPatch, ShotPatchError, isShotNode, type RigJob } from "../../lib/workspace/shots";
import { shotEstimateKey } from "../../lib/workspace/cost";
import { NODE_DEFS } from "../../lib/workbench/node-graph";

const SD25 = "dreamina-seedance-2-5-260628", SD20 = "dreamina-seedance-2-0-260128", KLING = "fal-ai/kling-video/v3/standard";

function shot(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, title: "Shot " + id, type: "scene", x: 0, y: 0, width: 344, linked: [], role: "Director", status: "draft",
    operations: [{ id: "d-" + id, kind: "direction", enabled: true, values: { note: "Hold on " + id } }], ...extra };
}
/** Fixture draft: the seed's references plus six render nodes and a finishing node. */
function project(): Project {
  const p = seedProject();
  return {
    ...p,
    productionProjectId: "prod",
    shotMappings: { s1: "ps1", s2: "ps2", s3: "ps3", s4: "ps4", s5: "ps5" },
    nodes: [
      ...p.nodes.filter((n) => n.id !== "scene"),
      shot("s1", { status: "approved", look: "look", engine: SD25, durationS: 5 }),
      shot("s2", { look: "Chrome dusk", engine: SD25, durationS: 6, linked: ["look", "cast"] }),
      shot("s3", { type: "generate", role: undefined, engine: SD20, durationS: 99 }),
      shot("s4", { operations: [], text: "" }),
      shot("s5", { engine: "retired-engine-id" }),
      shot("s6", { linked: ["missing-node"] }),
    ],
  };
}
const priced = (p: Project) => Object.fromEntries(rigShots(p).map((s) => [s.estimateKey!, 18]).filter(([k]) => k));

test("shots are the Create family (scene, generate), in draft order, with derived fields", () => {
  const createFamily = Object.entries(NODE_DEFS).filter(([, d]) => d.family === "Create").map(([t]) => t).sort();
  expect(createFamily).toEqual(["generate", "scene"]);
  const p = project();
  expect(p.nodes.filter(isShotNode).map((n) => n.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
  const shots = rigShots(p);
  expect(shots.map((s) => [s.index, s.id])).toEqual([[1, "s1"], [2, "s2"], [3, "s3"], [4, "s4"], [5, "s5"], [6, "s6"]]);
  const [s1, s2, s3, s4] = shots;
  expect(s1).toMatchObject({ name: "Shot s1", note: "Hold on s1", role: "Director", look: "A world out of the ordinary", lookNodeId: "look",
    engine: SD25, durationS: 5, ratio: "16:9", resolution: "720p", nodeType: "scene" });
  expect(s2).toMatchObject({ look: "Chrome dusk", lookNodeId: null, durationS: 6 });
  // Role falls back to the node type's department; duration clamps to 2.0's 4–15s.
  expect(s3).toMatchObject({ role: NODE_DEFS.generate.role, engine: SD20, durationS: 15, nodeType: "generate" });
  // No stored engine → the default engine and its defaults.
  expect(s4).toMatchObject({ engine: SD25, durationS: 5, note: "" });
  expect(s4.issues).toContain("Add a direction note.");
  expect(shots[4].issues[0]).toMatch(/no longer available/);
  expect(shots[5].issues).toContain("A connected input no longer exists.");
});

test("status: approved, queued, failed (not billed), ready only when resolved and priced, else draft", () => {
  const p = project();
  const unpriced = rigShots(p);
  expect(unpriced.map((s) => s.status)).toEqual(["approved", "draft", "draft", "draft", "draft", "draft"]);
  expect(unpriced[1].issues).toEqual(["Not priced yet."]);

  const quotes = priced(p);
  expect(rigShots(p, [], { quotes }).map((s) => s.status)).toEqual(["approved", "ready", "ready", "draft", "draft", "draft"]);
  expect(rigShots(p, [], { quotes: { ...quotes, [rigShots(p)[1].estimateKey!]: null } })[1].status).toBe("draft");

  const jobs: RigJob[] = [
    { id: "j1", status: "running", shotId: "ps1", createdAt: 5 },              // approved wins
    { id: "j2a", status: "succeeded", shotId: "ps2", createdAt: 1, creditsBilled: 18 },
    { id: "j2b", status: "held", shotId: "ps2", createdAt: 2 },                // held = live
    { id: "j3a", status: "succeeded", shotId: "ps3", createdAt: 1, creditsBilled: 12 },
    { id: "j3b", status: "failed", shotId: "ps3", createdAt: 9, creditsBilled: 0, costUsd: null },
    { id: "j4", status: "failed", shotId: "ps4", createdAt: 3, costUsd: 0.5 }, // billed failure
    { id: "j5", status: "failed", shotId: "ps5", createdAt: 1 },
    { id: "other", status: "queued", shotId: "someone-else", createdAt: 1 },
  ];
  const shots = rigShots(p, jobs, { quotes });
  expect(shots.map((s) => s.status)).toEqual(["approved", "queued", "failed", "failed", "failed", "draft"]);
  expect(shots[2]).toMatchObject({ failedUnbilled: true, lastJobId: "j3b" });
  expect(shots[3]).not.toHaveProperty("failedUnbilled");
  expect(shots[1].lastJobId).toBe("j2b");
  // A retry that succeeds clears the failure.
  expect(rigShots(p, [...jobs, { id: "j3c", status: "succeeded", shotId: "ps3", createdAt: 10 }], { quotes })[2].status).toBe("ready");
  // Unmapped shots never pick up another shot's jobs.
  expect(rigShots({ ...p, shotMappings: {} }, jobs, { quotes })[1].status).toBe("ready");
});

test("rigSubtitle counts from the list", () => {
  expect(rigSubtitle(rigShots(project()))).toBe("6 shots · 1 approved");
  expect(rigSubtitle([{ status: "approved" }])).toBe("1 shot · 1 approved");
  expect(rigSubtitle([])).toBe("0 shots · 0 approved");
  expect(rigSubtitle(Array.from({ length: 1200 }, () => ({ status: "draft" as const })))).toBe("1,200 shots · 0 approved");
});

test("shotPatch edits name, note, look, engine and duration immutably, clamped to the catalogue", () => {
  const p = project();
  const before = JSON.stringify(p);
  let next = shotPatch(p, "s4", { name: "  The turn ", note: "She looks back once." });
  expect(JSON.stringify(p)).toBe(before);
  const s4 = next.nodes.find((n) => n.id === "s4")!;
  expect(s4.title).toBe("The turn");
  expect(s4.operations).toHaveLength(1);
  expect(s4.operations![0]).toMatchObject({ kind: "direction", enabled: true, values: { note: "She looks back once." } });
  next = shotPatch(next, "s1", { note: "Wide." });
  expect(next.nodes.find((n) => n.id === "s1")!.operations).toEqual([{ id: "d-s1", kind: "direction", enabled: true, values: { note: "Wide." } }]);

  next = shotPatch(next, "s2", { durationS: 2 });
  expect(next.nodes.find((n) => n.id === "s2")).toMatchObject({ durationS: 4, ratio: "16:9", resolution: "720p" });
  next = shotPatch(next, "s2", { durationS: 31 });
  expect(next.nodes.find((n) => n.id === "s2")!.durationS).toBe(30);
  // Engine change re-fits duration and keeps what the new engine supports.
  next = shotPatch(next, "s2", { engine: SD20 });
  expect(next.nodes.find((n) => n.id === "s2")).toMatchObject({ engine: SD20, durationS: 15, ratio: "16:9", resolution: "720p" });
  next = shotPatch(next, "s2", { engine: KLING });
  expect(next.nodes.find((n) => n.id === "s2")).toMatchObject({ engine: KLING, durationS: 15, resolution: "1080p" });
  next = shotPatch(next, "s2", { look: "look" });
  expect(rigShots(next)[1]).toMatchObject({ look: "A world out of the ordinary", lookNodeId: "look" });
  next = shotPatch(next, "s2", { look: "" });
  expect(next.nodes.find((n) => n.id === "s2")).not.toHaveProperty("look");

  const fail = (fn: () => unknown, message: RegExp) => { expect(fn).toThrow(ShotPatchError); expect(fn).toThrow(message); };
  fail(() => shotPatch(p, "look", { name: "x" }), /Choose a shot/);
  fail(() => shotPatch(p, "nope", { name: "x" }), /Choose a shot/);
  fail(() => shotPatch(p, "s1", { name: "   " }), /needs a name/);
  fail(() => shotPatch(p, "s1", { engine: "fal-ai/topaz/upscale/image" }), /available engine/);
  fail(() => shotPatch(p, "s1", { ratio: "2.39:1" }), /aspect ratio/);
  fail(() => shotPatch(p, "s1", { resolution: "4k" }), /resolution/);
  fail(() => shotPatch(p, "s1", { durationS: Number.NaN }), /duration/);
  fail(() => shotPatch({ ...p, nodes: p.nodes.map((n) => (n.id === "s1" ? { ...n, locked: true } : n)) }, "s1", { name: "x" }), /Unlock/);
});

test("estimate keys agree with the key the hook caches under", () => {
  const s = rigShots(project())[0];
  expect(s.estimateKey).toBe(shotEstimateKey({ engine: SD25, durationS: 5, ratio: "16:9", resolution: "720p" }));
});
