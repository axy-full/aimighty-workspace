import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode, type NodeType, type Project } from "../../lib/workbench/studio";
import { canvasNodeSchema, RESERVED_NODE_FIELD_CHARS, saveSchema } from "../../lib/workbench/studio-schema";
import { canConnect, createNode, generationBrief, isKnownNodeType, nodeDef, nodeHeight, nodeOutputKind, NODE_DEFS, UNKNOWN_NODE_DEF } from "../../lib/workbench/node-graph";
import { cardLabel, isReferenceNode, REF_KIND_LABELS, refKindChosen, refKindOf, withRefKind } from "../../lib/workbench/ref-kind";
import { applyTeamPatch, catchUpForTeam, diffForTeam, emptyTeamCanvas, joinTeamCanvas, parseTeamCanvas, withTeamCanvas } from "../../lib/workbench/team-canvas-model";
import { mergeDraft, rebaseProject } from "../../lib/workbench/draft-merge";
import { cardWidth, graphEdges, graphLayout } from "../../lib/workspace/rig-graph";
import { inputKindText, shotInputs } from "../../lib/workspace/rig";
import { rigShots } from "../../lib/workspace/shots";

/*
 * The four reference kinds on the Rig (owner, 28 September; plan structure 1-B):
 * cards keep their node types and say Cast, Environment, Element or Ref. The
 * new fields are declared before anything writes them, every save and merge
 * keeps them, and a card type a newer release made never crashes this one.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-kinds-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "media", x: 0, y: 0, width: 220, linked: [], ...extra });
const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "image", category: "Reference", url: `/api/uploads/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
const project = (nodes: CanvasNode[], assets: Asset[] = [], extra: Partial<Project> = {}): Project => ({ ...newProject("Kinds"), id: "draft-kinds", productionProjectId: "prod-kinds", nodes, assets, ...extra });
/** A card type a later release adds: this one has never heard of it. */
const future = (id: string, extra: Partial<CanvasNode> = {}) => node(id, { type: "verify" as NodeType, ...extra });
/** Everything the agentic Rig's later steps may write on a card. */
const reserved = {
  elementId: "el_wren01",
  master: { lockedAt: "2026-09-28T10:00:00.000Z", lockedBy: "user-1", snapshot: { face: { versionId: "ver_1", sha256: "a".repeat(64) } } },
  verify: { rubric: 1, checks: ["identity", "wardrobe"], frames: { videoAt: [0.1, 0.5, 0.9], everySeconds: 2, max: 8 }, last: { id: "v1", takeId: "t1", verdict: "pass", at: 1 } },
  agent: { runId: "run-1", key: "cast:wren" },
};

test("refKindOf: a stored kind wins; otherwise a character is Cast, an element an Environment or an Element, a media input a Ref", () => {
  const plate = asset("plate", { category: "Environment" });
  const prop = asset("prop", { category: "Element" });
  const face = asset("face", { category: "Character" });
  const p = project([], [plate, prop, face], { sharedAssets: [asset("shared-plate", { category: "Environment" })] });
  const table: [Partial<CanvasNode>, string | null][] = [
    [{ type: "character" }, "cast"],
    [{ type: "character", assetId: "plate" }, "cast"],
    [{ type: "element", assetId: "plate" }, "environment"],
    [{ type: "element", assetId: "shared-plate" }, "environment"],
    [{ type: "element", assetId: "prop" }, "element"],
    [{ type: "element" }, "element"],
    [{ type: "element", assetId: "missing" }, "element"],
    [{ type: "media", assetId: "plate" }, "ref"],
    [{ type: "media", assetId: "face" }, "ref"],
    [{ type: "media" }, "ref"],
    /* Stored: a person's choice (or, later, Atomik's or a lock's) is the kind, whatever the card holds. */
    [{ type: "media", assetId: "face", refKind: "cast" }, "cast"],
    [{ type: "character", refKind: "environment" }, "environment"],
    [{ type: "element", assetId: "plate", refKind: "element" }, "element"],
    /* A value no release stores reads as if absent. */
    [{ type: "media", refKind: "look" as never }, "ref"],
    /* Not references: shots, direction, a look board, a card from a newer release. */
    [{ type: "scene" }, null],
    [{ type: "generate", refKind: "cast" }, null],
    [{ type: "note" }, null],
    [{ type: "brief" }, null],
    [{ type: "moodboard", assetId: "plate" }, null],
    [{ type: "verify" as NodeType }, null],
  ];
  for (const [fields, kind] of table) expect([fields, refKindOf(node("n", fields), p)]).toEqual([fields, kind]);
  /* The element a card stands for answers when the caller has it: a location is an Environment. */
  const linked = node("n", { type: "element", elementId: "el_1" });
  expect(refKindOf(linked, p, (id) => (id === "el_1" ? "location" : null))).toBe("environment");
  expect(refKindOf(linked, p, () => "prop")).toBe("element");
  expect(refKindOf(linked, p)).toBe("element");
  /* Every window reads the same card the same way. */
  expect(refKindOf(node("n", { type: "element", assetId: "plate" }), structuredClone(p))).toBe("environment");
  expect(refKindChosen(node("n", { refKind: "cast" }))).toBe(true);
  expect(refKindChosen(node("n"))).toBe(false);
  expect(refKindChosen(node("n", { type: "scene", refKind: "cast" }))).toBe(false);
  expect([isReferenceNode({ type: "character" }), isReferenceNode({ type: "moodboard" }), isReferenceNode({ type: "scene" })]).toEqual([true, false, false]);
});

test("cards are shown under their kind; anything else under its type, and an unknown type as a plain card", () => {
  const p = project([], [asset("plate", { category: "Environment" })]);
  expect(Object.values(REF_KIND_LABELS)).toEqual(["Cast", "Environment", "Element", "Ref"]);
  expect([
    cardLabel(node("a", { type: "character" }), p),
    cardLabel(node("b", { type: "element", assetId: "plate" }), p),
    cardLabel(node("c", { type: "element" }), p),
    cardLabel(node("d"), p),
    cardLabel(node("e", { type: "scene" }), p),
    cardLabel(node("f", { type: "moodboard" }), p),
    cardLabel(future("g"), p),
  ]).toEqual(["Cast", "Environment", "Element", "Ref", "Scene", "Look board", "Card"]);
});

test("a person sets a card's kind: only on a reference, never on a locked card, and setting the same kind changes nothing", () => {
  const p = project([node("ref"), node("shot", { type: "scene" }), node("held", { locked: true })]);
  const next = withRefKind(p, "ref", "cast");
  expect(typeof next).toBe("object");
  expect((next as Project).nodes.find((n) => n.id === "ref")).toMatchObject({ refKind: "cast", type: "media" });
  expect(p.nodes[0].refKind).toBeUndefined();
  expect(withRefKind(next as Project, "ref", "cast")).toBe(next);
  expect(withRefKind(p, "shot", "cast")).toBe("Only reference cards have a kind.");
  expect(withRefKind(p, "held", "cast")).toBe("Unlock this card before changing its kind.");
  expect(withRefKind(p, "gone", "cast")).toBe("That card is no longer on the canvas.");
});

test("the node schema declares the new fields: kind, element, and the reserved master, verify and agent (loose and bounded)", () => {
  const card = { ...node("wren", { type: "character", refKind: "cast" }), ...reserved };
  const parsed = canvasNodeSchema.parse(card);
  expect(parsed).toEqual(card);
  /* Reserved fields are loose: a key a later release adds to them rides through this one. */
  const later = canvasNodeSchema.parse({ ...card, master: { ...reserved.master, unlockedBy: null, extra: [1, 2] }, verify: { ...reserved.verify, rubric: 2, frames: { ...reserved.verify.frames, mode: "keyframes" } } });
  expect(later.master).toMatchObject({ unlockedBy: null, extra: [1, 2] });
  expect(later.verify).toMatchObject({ rubric: 2, frames: { mode: "keyframes" } });
  /* A key the node itself does not declare is still dropped: declaring is what keeps a field. */
  expect("future" in canvasNodeSchema.parse({ ...card, future: 1 })).toBe(false);
  /* Refused: a kind no release knows, a malformed element id, a reserved field past its bound. */
  expect(canvasNodeSchema.safeParse({ ...card, refKind: "look" }).success).toBe(false);
  expect(canvasNodeSchema.safeParse({ ...card, elementId: "../el" }).success).toBe(false);
  expect(canvasNodeSchema.safeParse({ ...card, agent: { runId: "run", note: "x".repeat(RESERVED_NODE_FIELD_CHARS) } }).success).toBe(false);
  expect(canvasNodeSchema.safeParse({ ...card, master: "yes" }).success).toBe(false);
  /* Every card saved before kinds still parses, unchanged. */
  const old = node("old", { type: "element", assetId: "plate" });
  expect(canvasNodeSchema.parse(old)).toEqual(old);
});

test("a draft save and a team canvas patch keep the new fields; the canvas read back keeps them", async () => {
  const card = { ...node("wren", { type: "character", refKind: "cast" as const }), ...reserved };
  const draft = project([card], [], { sharedNodes: [card] });
  const saved = saveSchema.parse({ project: draft, revision: 0 });
  expect(saved.project.nodes[0]).toEqual(card);
  expect(saved.project.sharedNodes![0]).toEqual(card);

  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const store = await import("../../lib/workbench/team-canvas");
  const ws = { id: "kinds", name: "kinds", slug: "kinds", dbUrl: `file:${path.join(dir, "kinds.db")}`, legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-kinds','Kinds',0)", args: [] });
    /* Exactly the route's path: the body is parsed, then what it parsed is folded in. */
    const body = store.teamPatchSchema.parse({ productionId: "prod-kinds", upsertNodes: [card, node("plate")], removeNodes: [], upsertAssets: [], order: ["wren", "plate"], expect: { plate: null } });
    expect(body.upsertNodes[0]).toEqual(card);
    const { productionId, ...patch } = body;
    await store.patchTeamCanvas(productionId, patch, "ana");
    /* A teammate's later edit to another field of the card leaves the kind as it is. */
    await store.patchTeamCanvas(productionId, store.teamPatchSchema.parse({ productionId, upsertNodes: [{ ...node("wren", { type: "character" }), x: 90 }], fields: { wren: ["x"] }, removeNodes: [], upsertAssets: [], order: null }), "bo");
    const read = (await store.readTeamCanvas("prod-kinds"))!;
    expect(read.canvas.nodes.wren).toEqual({ ...card, x: 90 });
    expect(read.canvas.nodes.plate.refKind).toBeUndefined();
  });
  /* The saved body read back defensively keeps them too. */
  const canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [card], removeNodes: [], upsertAssets: [], order: ["wren"], at: 1 });
  expect(parseTeamCanvas(JSON.parse(JSON.stringify(canvas))).nodes.wren).toEqual(card);
});

test("merges keep a kind: a teammate's move and my kind both land, a stale window never takes it off, and dropping it goes back to the reading", () => {
  const base = project([node("ref", { assetId: "p" })], [asset("p")]);
  const kinded = { ...base, nodes: [node("ref", { assetId: "p", refKind: "environment" })] };
  const patch = diffForTeam(base, kinded, 10)!;
  expect(patch.fields).toEqual({ ref: ["refKind"] });

  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: base.nodes, removeNodes: [], upsertAssets: base.assets, order: ["ref"], at: 1 });
  /* A teammate moves the card; my kind lands after, their move stands. */
  const moved = diffForTeam(base, { ...base, nodes: [node("ref", { assetId: "p", x: 300 })] }, 5)!;
  canvas = applyTeamPatch(canvas, moved);
  canvas = applyTeamPatch(canvas, patch);
  expect(canvas.nodes.ref).toMatchObject({ x: 300, refKind: "environment" });
  /* A window that never saw the kind renames the card: the kind stays. */
  canvas = applyTeamPatch(canvas, diffForTeam(base, { ...base, nodes: [node("ref", { assetId: "p", title: "Harbour" })] }, 20)!);
  expect(canvas.nodes.ref).toMatchObject({ x: 300, refKind: "environment", title: "Harbour" });
  /* What another save brought into a window that never saw the kind (a move) catches the canvas up; the kind stays. */
  const stale = { ...base, nodes: [node("ref", { assetId: "p", x: 300, title: "Harbour" })] };
  const caught = catchUpForTeam(stale, { ...stale, nodes: [node("ref", { assetId: "p", x: 480, title: "Harbour" })] }, 30)!;
  expect(caught.fields).toEqual({ ref: ["x"] });
  expect(applyTeamPatch(canvas, caught).nodes.ref).toMatchObject({ x: 480, refKind: "environment" });
  /* Folding the canvas into a draft, and joining it, keep the kind. */
  expect(withTeamCanvas(base, canvas).nodes[0].refKind).toBe("environment");
  expect(joinTeamCanvas(base, { ...canvas, removedIds: [] }, 40).project.nodes[0].refKind).toBe("environment");
  /* Reversible: an edit that drops the field takes it off, and the card is read from what it holds again. */
  const dropped = applyTeamPatch(canvas, diffForTeam(kinded, { ...kinded, nodes: [node("ref", { assetId: "p" })] }, 50)!);
  expect("refKind" in dropped.nodes.ref).toBe(false);
  expect(refKindOf(dropped.nodes.ref, base)).toBe("ref");

  /* Two saves of one draft: mine moved the card, theirs set its kind — the merge has both, and is a valid save. */
  const mine = { ...base, nodes: [node("ref", { assetId: "p", x: 120 })] };
  const merged = mergeDraft(base, mine, kinded);
  expect(merged.nodes[0]).toMatchObject({ x: 120, refKind: "environment" });
  expect(saveSchema.safeParse({ project: merged, revision: 0 }).success).toBe(true);
  expect(rebaseProject(base, mine, kinded).nodes[0]).toMatchObject({ x: 120, refKind: "environment" });
  /* Both set a kind: mine stands, as for any value both sides changed. */
  expect(mergeDraft(base, { ...base, nodes: [node("ref", { assetId: "p", refKind: "cast" })] }, kinded).nodes[0].refKind).toBe("cast");
});

test("a card type this release does not know is drawn as a plain card and never wired: no reader throws", () => {
  expect(isKnownNodeType("scene")).toBe(true);
  expect(isKnownNodeType("verify")).toBe(false);
  expect(isKnownNodeType("constructor")).toBe(false);
  expect(nodeDef("scene")).toBe(NODE_DEFS.scene);
  expect(nodeDef("verify")).toBe(UNKNOWN_NODE_DEF);
  expect(nodeDef("__proto__")).toBe(UNKNOWN_NODE_DEF);
  expect(UNKNOWN_NODE_DEF).toMatchObject({ label: "Card", shape: "flow" });
  expect(nodeOutputKind("verify")).toBe("media");
  expect(createNode("element", 0).title).toBe("World & element 01");

  const card = future("check", { width: 300 });
  const shot = node("shot", { type: "scene", width: 344, linked: ["check", "ref"] });
  const ref = node("ref", { assetId: "p" });
  const p = project([shot, card, ref], [asset("p")], { shotMappings: {} });
  expect(nodeHeight(card)).toBe(148);
  expect(cardWidth(card)).toBe(254);
  expect(graphLayout(p.nodes).cards.map((c) => c.id)).toEqual(["shot", "check", "ref"]);
  expect(graphEdges(p.nodes).map((e) => e.id)).toEqual(["check->shot", "ref->shot"]);
  /* Never wired from a page that does not know its rules, in either direction. */
  const refusal = "This card is from a newer version of Particl. Reload the page to connect it.";
  expect(canConnect(p.nodes, "ref", "check")).toBe(refusal);
  expect(canConnect([...p.nodes, node("other", { type: "scene" })], "check", "other")).toBe(refusal);
  expect(canConnect(p.nodes, "ref", "ref")).toBe("A node cannot connect to itself.");
  /* The shot it feeds still lists, prices and briefs. */
  expect(shotInputs(p, "shot").map((row) => [row.id, row.kind, row.refKind])).toEqual([["check", "Card", null], ["ref", "Ref", "ref"]]);
  expect(rigShots(p).map((s) => s.id)).toEqual(["shot"]);
  expect(generationBrief(shot, p)).toContain("check:");
});

test("a shot's input rows say the kind with the medium; a Ref reads as a plain reference", () => {
  const p = project(
    [node("cast", { type: "character", assetId: "face" }), node("plate", { type: "element", assetId: "env" }), node("clip", { assetId: "clip", refKind: "element" }), node("still", { assetId: "still" }), node("note", { type: "note", text: "Hold" }), node("s", { type: "scene", linked: ["cast", "plate", "clip", "still", "note"] })],
    [asset("face", { category: "Character" }), asset("env", { category: "Environment" }), asset("clip", { kind: "video" }), asset("still")],
  );
  const rows = shotInputs(p, "s");
  expect(rows.map((row) => [row.kind, row.refKind, inputKindText(row, false)])).toEqual([
    ["Cast", "cast", "Cast · image"],
    ["Environment", "environment", "Environment · image"],
    ["Element", "element", "Element · video"],
    ["Ref", "ref", "Reference image"],
    ["Direction", null, "Direction"],
  ]);
  expect(inputKindText(rows[3], true)).toBe("First frame");
});
