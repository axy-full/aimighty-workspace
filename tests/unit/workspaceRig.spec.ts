import { test, expect } from "@playwright/test";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import type { MediaJob } from "../../lib/workbench/job-recovery";
import { nodeHeight } from "../../lib/workbench/node-graph";
import {
  addShotNode, dispatchGate, dispatchQuoteQuery, generationPhase, neutralCopy, NODE_LIMIT, referenceRole,
  relativeAge, shotInputs, shotPreviewAsset, shotReferenceAssets, shotVersions, stepDuration,
} from "../../lib/workspace/rig";
import { rigShots, ShotPatchError } from "../../lib/workspace/shots";
import { vendorNameIn } from "../../lib/workspace/vendor-names";
import { rigPlanRequests, shotRequestInput } from "../../lib/workspace/rig-requests";
import { generationBrief } from "../../lib/workbench/node-graph";

const SD25 = "dreamina-seedance-2-5-260628";

function asset(id: string, extra: Partial<Asset> = {}): Asset {
  return { id, name: id, kind: "image", category: "Reference", url: "/api/uploads/" + id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra };
}
function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, title: "Node " + id, type: "scene", x: 100, y: 100, width: 344, linked: [], ...extra };
}
function fixture(): Project {
  return {
    ...newProject("Rig unit"),
    productionProjectId: "prod",
    shotMappings: { s1: "ps1" },
    assets: [
      asset("plate", { uploadId: "up-plate" }),
      asset("clip", { kind: "video", generationId: "g-clip", url: "/api/media/g-clip" }),
      asset("take1", { kind: "video", generationId: "g1", nodeId: "s1", url: "/api/media/g1", version: 1, description: SD25 }),
      asset("take2", { kind: "video", generationId: "g2", nodeId: "s1", url: "/api/media/g2", version: 2, description: SD25 }),
    ],
    nodes: [
      node("plate-node", { type: "media", title: "Dune plate", assetId: "plate", x: 0, y: 0 }),
      node("clip-node", { type: "media", title: "Motion ref", assetId: "clip", x: 0, y: 400 }),
      node("note", { type: "note", title: "Director's note", text: "Hold", x: 0, y: 800 }),
      node("s1", { linked: ["plate-node", "clip-node", "note"], assetId: "take1", x: 400, y: 0 }),
      node("s2", { x: 400, y: 600 }),
    ],
  };
}

test("addShotNode appends a scene node below the graph and never overlaps it", () => {
  const p = fixture();
  const { project, id } = addShotNode(p);
  expect(project.nodes).toHaveLength(p.nodes.length + 1);
  expect(p.nodes).toHaveLength(5); // input untouched
  const added = project.nodes.at(-1)!;
  expect(added.id).toBe(id);
  expect(added).toMatchObject({ type: "scene", mode: "Video", status: "draft", title: "Scene 03", linked: [] });
  const bottom = Math.max(...p.nodes.map((n) => n.y + nodeHeight(n)));
  expect(added.y).toBeGreaterThan(bottom);
  expect(added.x).toBe(0);
  /* It is a shot the Rig lists, last. */
  expect(rigShots(project).at(-1)!.id).toBe(id);
  /* Empty project: a first shot at the origin used by createNode. */
  expect(addShotNode(newProject("Empty")).project.nodes[0]).toMatchObject({ x: 100, y: 100, title: "Scene 01" });
  const full = { ...p, nodes: Array.from({ length: NODE_LIMIT }, (_, i) => node("n" + i, { type: "note" })) };
  expect(() => addShotNode(full)).toThrow(ShotPatchError);
});

test("inputs, references and preview are resolved from the graph", () => {
  const p = fixture();
  expect(shotInputs(p, "s1")).toEqual([
    expect.objectContaining({ id: "plate-node", name: "Dune plate", kind: "Media", version: "v1" }),
    expect.objectContaining({ id: "clip-node", name: "Motion ref", kind: "Media", version: "v1" }),
    expect.objectContaining({ id: "note", name: "Director's note", kind: "Direction", version: "—", asset: null }),
  ]);
  expect(shotInputs(p, "missing")).toEqual([]);
  const refs = shotReferenceAssets(p, p.nodes.find((n) => n.id === "s1")!);
  expect(refs.map((a) => a.id).sort()).toEqual(["clip", "plate", "take1"]);
  expect(refs.map(referenceRole).sort()).toEqual(["reference_image", "reference_video", "reference_video"]);
  /* The take on the node previews; without one, the newest take filed for it. */
  expect(shotPreviewAsset(p, "s1")!.id).toBe("take1");
  const detached = { ...p, nodes: p.nodes.map((n) => (n.id === "s1" ? { ...n, assetId: undefined } : n)) };
  expect(shotPreviewAsset(detached, "s1")!.id).toBe("take2");
  expect(shotPreviewAsset(p, "s2")).toBeNull();
});

test("the dispatch quote query matches GenerationDialog's, references included", () => {
  const p = fixture();
  const refs = shotReferenceAssets(p, p.nodes.find((n) => n.id === "s1")!);
  const query = new URLSearchParams(dispatchQuoteQuery({ engine: SD25, durationS: 6, ratio: "16:9", resolution: "720p" }, refs));
  expect(Object.fromEntries(["model", "resolution", "ratio", "duration"].map((k) => [k, query.get(k)]))).toEqual({ model: SD25, resolution: "720p", ratio: "16:9", duration: "6" });
  expect(query.getAll("uploadId")).toEqual(["up-plate"]);
  expect(query.getAll("genId").sort()).toEqual(["g-clip", "g1"]);
  /* Stills carry the dialog's default duration. */
  expect(new URLSearchParams(dispatchQuoteQuery({ engine: "gemini-3.1-flash-image", ratio: "1:1", resolution: "1K" }, [])).get("duration")).toBe("5");
});

test("versions merge filed takes with jobs in flight or failed, newest first", () => {
  const now = 10_000_000;
  const p = fixture();
  const jobs: MediaJob[] = [
    { id: "g1", status: "succeeded", kind: "video", shotId: "ps1", prompt: "", model: SD25, version: 1, createdAt: now - 3_600_000 },
    { id: "g2", status: "succeeded", kind: "video", shotId: "ps1", prompt: "", model: SD25, version: 2, createdAt: now - 120_000 },
    { id: "g3", status: "running", kind: "video", shotId: "ps1", prompt: "", model: SD25, version: 3, createdAt: now - 10_000 },
    { id: "g4", status: "failed", kind: "video", shotId: "ps1", prompt: "", model: SD25, version: 4, createdAt: now - 5_000, creditsBilled: 0 },
    { id: "other", status: "running", kind: "video", shotId: "ps9", prompt: "", model: SD25, version: 1 },
  ];
  const rows = shotVersions(p, "s1", jobs, now);
  expect(rows.map((r) => [r.v, r.state, r.current])).toEqual([["v4", "failed", false], ["v3", "rendering", false], ["v2", "rendered", false], ["v1", "rendered", true]]);
  expect(rows[0].label).toBe("Failed · not billed");
  expect(rows[1].label).toBe("Rendering");
  expect(rows[2]).toMatchObject({ label: "Take · Seedance 2.5", meta: "2 min" });
  expect(rows[3]).toMatchObject({ label: "Current · Seedance 2.5", meta: "1 hr" });
  for (const row of rows) expect(vendorNameIn(row.label)).toBeNull();
  expect(shotVersions(p, "s2", jobs, now)).toEqual([]);
  // A held take says what it waits for and carries its Discard action; a discarded one reads as cancelled.
  const held = shotVersions(p, "s1", [
    { id: "h1", status: "held", kind: "video", shotId: "ps1", prompt: "", model: SD25, version: 5, createdAt: now - 1_000, params: { held: { why: "slots" } } },
    { id: "h2", status: "cancelled", kind: "video", shotId: "ps1", prompt: "", model: SD25, version: 6, createdAt: now - 500, creditsBilled: 0 },
  ], now);
  expect(held.slice(0, 2).map((r) => [r.id, r.label, r.held ?? false])).toEqual([["h2", "Cancelled · not billed", false], ["h1", "Held · waiting for a slot", true]]);
  expect([relativeAge(now - 1000, now), relativeAge(now - 3 * 86_400_000, now), relativeAge(null, now)]).toEqual(["just now", "3 d", ""]);
});

test("generation phase follows the real job; a failed render is shown as not billed", () => {
  expect(generationPhase(null)).toMatchObject({ label: "Submitting", done: false });
  expect(generationPhase({ status: "queued" })).toMatchObject({ label: "Queued", tone: "blue", done: false });
  expect(generationPhase({ status: "held" })).toMatchObject({ label: "Held · needs credits", done: false });
  expect(generationPhase({ status: "held", params: { held: { why: "slots" } } })).toMatchObject({ label: "Held · waiting for a slot", done: false });
  expect(generationPhase({ status: "cancelled", creditsBilled: 0 })).toMatchObject({ label: "Cancelled · not billed", tone: "red", done: true });
  expect(generationPhase({ status: "running" })).toMatchObject({ label: "Rendering", done: false });
  expect(generationPhase({ status: "succeeded" })).toMatchObject({ label: "Complete", pct: 100, tone: "green", done: true });
  expect(generationPhase({ status: "failed", creditsBilled: 0 })).toMatchObject({ label: "Failed · not billed", tone: "red", done: true });
  expect(generationPhase({ status: "failed", creditsBilled: 12 })).toMatchObject({ label: "Failed", done: true });
});

test("duration steps through the engine's listed seconds", () => {
  expect(stepDuration([4, 5, 6, 8], 5, 1)).toBe(6);
  expect(stepDuration([4, 5, 6, 8], 6, 1)).toBe(8);
  expect(stepDuration([4, 5, 6, 8], 8, 1)).toBe(8);
  expect(stepDuration([8, 4, 6], 6, -1)).toBe(4);
  expect(stepDuration([4, 6], 4, -1)).toBe(4);
  expect(stepDuration([4, 6], undefined, 1)).toBe(4);
  expect(stepDuration([], 5, 1)).toBeUndefined();
});

test("the dispatch gate sends only the price that was shown", () => {
  expect(dispatchGate(18, 18)).toEqual({ ok: true });
  expect(dispatchGate(18, 22)).toEqual({ ok: false, credits: 22, reason: "The price is now 22 cr. Press Generate again to approve it." });
  expect(dispatchGate(18, 12)).toMatchObject({ ok: false, credits: 12 });
  expect(dispatchGate(null, 12)).toMatchObject({ ok: false, credits: 12 });
  expect(dispatchGate(1200, 1500)).toMatchObject({ reason: "The price is now 1,500 cr. Press Generate again to approve it." });
});

test("engine labels in messages become neutral names; other vendor names fall back", () => {
  expect(neutralCopy("Seedance 2.5 accepts at most 30 image references.")).toBe("Seedance 2.5 accepts at most 30 image references.");
  expect(neutralCopy("Review a live Genjutsu quote before submitting this take.")).toBe("The engine could not take this request. Nothing was charged.");
  expect(neutralCopy("Insufficient credits.", "x")).toBe("Insufficient credits.");
});

test("the request body is GenerationDialog's: quote body plus the approved ceiling and fingerprint", () => {
  const input = {
    prompt: "PRODUCTION: x", kind: "video" as const, model: { id: SD25 }, mapping: { shotId: "ps1", productionProjectId: "prod" },
    ratio: "16:9", resolution: "720p", duration: 5, references: [{ uploadId: "up-plate", role: "reference_image" }],
  };
  const quoted = generationRequestBody(input);
  expect(quoted).toEqual({ prompt: "PRODUCTION: x", model: SD25, projectId: "prod", shotId: "ps1", ratio: "16:9", resolution: "720p", duration: 5, refine: false, references: input.references, firstFrameAssetId: "" });
  const sent = generationRequestBody({ ...input, maxCredits: 18, quoteFingerprint: "f".repeat(64) });
  expect(sent).toEqual({ ...quoted, maxCredits: 18, quoteFingerprint: "f".repeat(64) });
  /* The dialog's other shapes are unchanged: marketing omits duration; identity renders carry the identity. */
  expect(generationRequestBody({ ...input, kind: "image", model: { id: "m", marketing: true }, marketing: { quality: "high" }, quoteFingerprint: "q", maxCredits: 3 }))
    .toEqual({ prompt: "PRODUCTION: x", model: "m", projectId: "prod", shotId: "ps1", ratio: "16:9", resolution: "720p", refine: false, maxCredits: 3, references: input.references, marketing: { quality: "high" }, quoteFingerprint: "q" });
  expect(generationRequestBody({ ...input, kind: "image", model: { id: "s", soulIdentity: true }, soul: { soulIdentityId: "id", soulStrength: 1, workbenchProjectId: "wb" } }))
    .toMatchObject({ soulIdentityId: "id", soulStrength: 1, workbenchProjectId: "wb" });
});


test("plan requests: one GenerationDialog body per ready, mapped shot whose references are saved", () => {
  const base = fixture();
  const p: Project = {
    ...base,
    shotMappings: { s1: "ps1", s2: "ps2" },
    nodes: base.nodes.map((n) => (n.id === "s1" || n.id === "s2"
      ? { ...n, engine: SD25, durationS: 6, ratio: "16:9", resolution: "720p", operations: [{ id: "d-" + n.id, kind: "direction" as const, enabled: true, values: { note: "Hold" } }] }
      : n)).concat([node("s3", { engine: SD25, operations: [{ id: "d3", kind: "direction", enabled: true, values: { note: "Hold" } }] })]),
  };
  const quotes = Object.fromEntries(rigShots(p).map((s) => [s.estimateKey!, 18]));
  const shots = rigShots(p, [], { quotes });
  expect(shots.map((s) => [s.id, s.status])).toEqual([["s1", "ready"], ["s2", "ready"], ["s3", "ready"]]);
  const requests = rigPlanRequests(p, shots);
  /* s3 has no production mapping yet: left out rather than guessed. */
  expect(requests.map((r) => r.name)).toEqual(["Node s1", "Node s2"]);
  const s1 = p.nodes.find((n) => n.id === "s1")!;
  expect(requests[0].body).toEqual({
    prompt: generationBrief(s1, p), model: SD25, projectId: "prod", shotId: "ps1", ratio: "16:9", resolution: "720p", duration: 6, refine: false,
    references: expect.arrayContaining([{ uploadId: "up-plate", role: "reference_image" }, { genId: "g-clip", role: "reference_video" }, { genId: "g1", role: "reference_video" }]),
    firstFrameAssetId: "",
  });
  expect(requests[0].body).not.toHaveProperty("maxCredits");
  /* A reference not yet saved (it would need an upload) keeps the shot out. */
  const unsaved = { ...p, assets: p.assets.map((a) => (a.id === "plate" ? { ...a, uploadId: undefined, url: "/campaign/plate.webp" } : a)) };
  expect(rigPlanRequests(unsaved, rigShots(unsaved, [], { quotes })).map((r) => r.name)).toEqual(["Node s2"]);
  /* Not ready (unpriced) → nothing. */
  expect(rigPlanRequests(p, rigShots(p))).toEqual([]);
  expect(shotRequestInput(p, s1, { id: "s1", engine: "retired", ratio: "16:9", resolution: "720p", durationS: 5 }, { shotId: "a", productionProjectId: "b" }, [])).toBeNull();
});
