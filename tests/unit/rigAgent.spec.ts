import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { canvasNodeSchema } from "../../lib/workbench/studio-schema";
import { isKnownNodeType } from "../../lib/workbench/node-graph";
import { REF_NODE_TYPES, refKindOf } from "../../lib/workbench/ref-kind";
import { applyTeamPatch, emptyTeamCanvas, writeRoom, type RoomStorage, type TeamCanvas } from "../../lib/workbench/team-canvas-model";
import { IN_USE, PERSON_WINS, planCanvasOps, roomPatchFor } from "../../lib/workbench/canvas-ops-model";
import {
  AGENT_KINDS, DryBoard, agentNodeId, boardSnapshot, cardShape, compilePlan, undoOps, wiresOf, type BoardSnapshot,
} from "../../lib/workbench/rig-agent-plan";
import { mockPlanCalls, mockPlannerModel, runPlanner, selectPlannerModel, PLANNER_STEPS } from "../../lib/workbench/rig-agent-planner";

/*
 * Atomik builds the board (plan PR 9): the planner's dry tools, the kinds a
 * card is made as, the build compiled into canvas operations, the executor
 * (idempotent by op id), undo (only the run's own cards, softly), a held
 * operation surfaced on the run card, and the kill switch. Every model call
 * is the scripted mock planner through the real SDK loop: no provider.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-agent-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
delete process.env.LIVEBLOCKS_SECRET_KEY;

function workspace(name: string): TenantWorkspace {
  return { id: "ws_" + name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], mode: "Video", ...extra });
const image = (id: string, category = "Character"): Asset => ({ id, name: id, kind: "image", category, url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const snapshotOf = (extra: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  production: "Harbour", brief: "", goal: "A harbour at dawn, two shots.", cards: [], assets: [], cast: [], places: [], boardShots: [], ...extra,
});

/* ── Kinds: a kind is a card's field, never a new node type ───────────── */

test("create_node's kinds map to the reference node types and a kind, or to a shot or a note: never a new node type", () => {
  expect(cardShape("cast")).toEqual({ type: "character", refKind: "cast" });
  expect(cardShape("environment")).toEqual({ type: "element", refKind: "environment" });
  expect(cardShape("element")).toEqual({ type: "element", refKind: "element" });
  expect(cardShape("ref")).toEqual({ type: "media", refKind: "ref" });
  expect(cardShape("shot")).toEqual({ type: "scene", mode: "Video" });
  expect(cardShape("note")).toEqual({ type: "note" });
  expect(cardShape("section")).toEqual({ type: "note", mode: "section" });
  const board = new DryBoard(snapshotOf({ assets: [{ id: "plate", name: "Pier", kind: "image", category: "Environment" }] }));
  for (const kind of AGENT_KINDS) expect(board.create({ key: `k-${kind}`, kind, title: `A ${kind}`, ...(kind === "environment" ? { from: "plate" } : {}) })).toEqual({ ok: true });
  const plan = compilePlan(board.draft(), { runId: "rar_0123456789abcdef01234567", title: "Kinds", summary: "", existing: [], assets: new Map([["plate", image("plate", "Environment")]]) });
  const made = plan.steps.flatMap((s) => s.ops).filter((op) => op.kind === "create").map((op) => (op.kind === "create" ? op.node : null)!);
  expect(made).toHaveLength(AGENT_KINDS.length);
  const project = { ...newProject("Kinds"), assets: [image("plate", "Environment")] };
  for (const node of made) {
    expect(isKnownNodeType(node.type), node.type).toBe(true);
    expect(canvasNodeSchema.safeParse(node).success, node.title).toBe(true);
    const kind = node.agent!.key!.slice(2) as (typeof AGENT_KINDS)[number];
    /* A reference reads back as the kind it was made as, through the same reading every window uses. */
    if (["cast", "environment", "element", "ref"].includes(kind)) {
      expect((REF_NODE_TYPES as readonly string[]).includes(node.type)).toBe(true);
      expect(refKindOf(node, project)).toBe(kind);
    } else expect(refKindOf(node, project)).toBeNull();
  }
  /* The environment card holds its picture, and the op carries the picture for everyone's canvas. */
  const env = plan.steps.flatMap((s) => s.ops).find((op) => op.kind === "create" && op.node.refKind === "environment");
  expect(env).toMatchObject({ node: { assetId: "plate" }, assets: [{ id: "plate" }] });
});

test("the dry tools check and record, never apply: each problem is answered so the planner can fix it", () => {
  const board = new DryBoard(snapshotOf({
    cards: [{ id: "shot-a", kind: "Scene", title: "Their shot", shot: true }, { id: "locked-b", kind: "Scene", title: "Locked", shot: true, locked: true }, { id: "mira", kind: "Cast", title: "Mira", reference: true }],
    assets: [{ id: "still", name: "Still", kind: "image", category: "Character" }],
  }));
  expect(board.create({ key: "cast-1", kind: "cast", title: "The captain", from: "still" })).toEqual({ ok: true });
  expect(board.create({ key: "cast-1", kind: "cast", title: "Again" })).toMatchObject({ ok: false, problem: expect.stringContaining("taken") });
  expect(board.create({ key: "Bad Key!", kind: "cast", title: "x" })).toMatchObject({ ok: false });
  expect(board.create({ key: "x1", kind: "villain", title: "x" })).toMatchObject({ ok: false });
  expect(board.create({ key: "x2", kind: "shot", title: "x", from: "still" })).toMatchObject({ ok: false, problem: expect.stringContaining("Only a reference") });
  expect(board.create({ key: "x3", kind: "cast", title: "x", from: "somewhere-else" })).toMatchObject({ ok: false, problem: expect.stringContaining("No picture") });
  expect(board.create({ key: "x4", kind: "shot", title: "x", durationS: 90 })).toMatchObject({ ok: false });
  expect(board.create({ key: "shot-1", kind: "shot", title: "Opening", text: "The pier at dawn.", durationS: 5.4, ratio: "16:9" })).toEqual({ ok: true });
  expect(board.wire({ from: "cast-1", to: "shot-1" })).toEqual({ ok: true });
  expect(board.wire({ from: "cast-1", to: "shot-1" })).toEqual({ ok: true, note: "Already wired." });
  expect(board.wire({ from: "cast-1", to: "shot-a" })).toEqual({ ok: true });
  expect(board.wire({ from: "mira", to: "shot-1" })).toEqual({ ok: true });
  expect(board.wire({ from: "cast-1", to: "cast-1" })).toMatchObject({ ok: false });
  expect(board.wire({ from: "cast-1", to: "locked-b" })).toMatchObject({ ok: false, problem: expect.stringContaining("locked") });
  expect(board.wire({ from: "ghost", to: "shot-1" })).toMatchObject({ ok: false });
  expect(board.render({ shot: "cast-1" })).toMatchObject({ ok: false });
  expect(board.render({ shot: "shot-1" })).toMatchObject({ ok: true, note: expect.stringContaining("priced") });
  expect(board.lock({ card: "shot-1" })).toMatchObject({ ok: false });
  expect(board.lock({ card: "mira" })).toMatchObject({ ok: true });
  expect(board.tidy()).toEqual({ ok: true });
  expect(board.draft()).toEqual({
    cards: [{ key: "cast-1", kind: "cast", title: "The captain", from: "still" }, { key: "shot-1", kind: "shot", title: "Opening", text: "The pier at dawn.", durationS: 5, ratio: "16:9" }],
    wires: [{ from: "cast-1", to: "shot-1" }, { from: "cast-1", to: "shot-a" }, { from: "mira", to: "shot-1" }],
    tidy: true,
    next: [{ what: "render", card: "shot-1" }, { what: "lock", card: "mira" }],
  });
  /* One build is bounded. */
  const full = new DryBoard(snapshotOf());
  for (let i = 0; i < 24; i++) expect(full.create({ key: `n-${i}`, kind: "note", title: `Note ${i}` })).toEqual({ ok: true });
  expect(full.create({ key: "n-24", kind: "note", title: "One too many" })).toMatchObject({ ok: false, problem: expect.stringContaining("24") });
});

/* ── The planner: one bounded turn through the real SDK loop ──────────── */

test("the planner produces valid ops: the mock agent's plan compiles to canvas operations that apply cleanly, with stable ids", async () => {
  const snapshot = snapshotOf({
    cast: [{ name: "The captain", asset: "captain" }, { name: "Her daughter" }],
    places: [{ name: "The pier", asset: "pier" }],
    assets: [{ id: "captain", name: "Captain", kind: "image", category: "Character" }, { id: "pier", name: "Pier", kind: "image", category: "Environment" }],
  });
  const model = mockPlannerModel(snapshot);
  const outcome = await runPlanner(snapshot, model);
  expect(outcome.result.title).toBe("2-shot board");
  expect(outcome.usage.steps).toBeLessThanOrEqual(PLANNER_STEPS);
  expect(outcome.draft.cards.map((c) => [c.key, c.kind, c.from ?? null])).toEqual([
    ["cast-1", "cast", "captain"], ["cast-2", "cast", null], ["place-1", "environment", "pier"], ["shot-1", "shot", null], ["shot-2", "shot", null],
  ]);
  expect(outcome.draft.wires).toHaveLength(6);
  expect(outcome.draft.next).toEqual([{ what: "render", card: "shot-1" }, { what: "render", card: "shot-2" }]);
  const runId = "rar_aaaaaaaaaaaaaaaaaaaaaaaa";
  const existing = [scene("theirs", { x: 100, y: 100 })];
  const plan = compilePlan(outcome.draft, { runId, title: outcome.result.title, summary: outcome.result.summary, existing, assets: new Map([["captain", image("captain")], ["pier", image("pier", "Environment")]]) });
  /* Batched per step: cast, environment, shots, wires, tidy; renders only as next steps. */
  expect(plan.steps.map((s) => [s.tool, s.state, s.label])).toEqual([
    ["create", "proposed", "Cast · 2 cards"], ["create", "proposed", "Environment · 1 card"], ["create", "proposed", "Shot · 2 cards"],
    ["wire", "proposed", "Wires · 6 inputs"], ["tidy", "proposed", "Tidy the new cards"],
    ["render", "next", "Render 01 — Opening · priced"], ["render", "next", "Render 02 — The turn · priced"],
  ]);
  expect(plan.steps.filter((s) => s.state === "next").every((s) => s.ops.length === 0)).toBe(true);
  /* Stable ids: the same run and key make the same card; another run another. */
  expect(plan.cards[0].id).toBe(agentNodeId(runId, "cast-1"));
  expect(agentNodeId(runId, "cast-1")).not.toBe(agentNodeId("rar_bbbbbbbbbbbbbbbbbbbbbbbb", "cast-1"));
  /* New cards land clear of the team's, to their right. */
  const creates = plan.steps.flatMap((s) => s.ops).flatMap((op) => (op.kind === "create" ? [op.node] : []));
  expect(Math.min(...creates.map((n) => n.x))).toBeGreaterThan(100 + 344);
  /* Applied in order against a canvas holding a teammate's card: nothing held, every wire lands. */
  const { canvasOpSchema } = await import("../../lib/workbench/canvas-ops");
  let canvas: TeamCanvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: existing, removeNodes: [], upsertAssets: [], order: ["theirs"], at: 1, author: "ana" });
  for (const step of plan.steps.filter((s) => s.state === "proposed")) {
    for (const op of step.ops) expect(canvasOpSchema.safeParse(op).success).toBe(true);
    const planned = planCanvasOps(canvas, step.ops, `agent:${runId}`);
    expect(planned.outcomes.filter((o) => o.held)).toEqual([]);
    canvas = applyTeamPatch(canvas, { ...planned.patch, at: 10 + step.seq, author: `agent:${runId}` });
    for (const change of planned.changes) if (change.made) canvas.serverMade[change.id] = `agent:${runId}`;
  }
  const shot1 = canvas.nodes[agentNodeId(runId, "shot-1")];
  expect(shot1.linked.sort()).toEqual([agentNodeId(runId, "cast-1"), agentNodeId(runId, "cast-2"), agentNodeId(runId, "place-1")].sort());
  expect(shot1).toMatchObject({ type: "scene", mode: "Video", durationS: 5, ratio: "16:9", agent: { runId, key: "shot-1" } });
  expect(shot1.status).toBe("draft");
  /* The tidy moved only the run's cards: the teammate's card is where they left it. */
  expect(canvas.nodes.theirs).toMatchObject({ x: 100, y: 100 });
  expect(Object.keys(canvas.assets).sort()).toEqual(["captain", "pier"]);
});

test("the planner stays inside its bounds: a turn that answers nothing proposes nothing, and a plan that runs past its tool limit stops", async () => {
  const snapshot = snapshotOf();
  const empty = mockPlannerModel(snapshot, { calls: [], result: { title: "Nothing", summary: "Nothing." } });
  await expect(runPlanner(snapshot, empty)).rejects.toThrow(/did not propose any cards/);
  const flood = mockPlannerModel(snapshot, { calls: Array.from({ length: 200 }, (_, i) => ({ tool: "create_node" as const, input: { key: `n-${i}`, kind: "note", title: "x" } })), result: { title: "Flood", summary: "Too much." } });
  await expect(runPlanner(snapshot, flood)).rejects.toThrow(/limit/);
  /* The mock reads the request: "one shot" plans one. */
  expect(mockPlanCalls(snapshotOf({ goal: "Just one shot of the pier" })).calls.filter((c) => c.tool === "create_node" && c.input.kind === "shot")).toHaveLength(1);
});

test("the planner thinks with Claude, OpenAI or Grok from Atomik's policy: Auto picks among them, an explicit choice is never swapped", () => {
  const menu = [{ id: "google/gemini-3.1-pro-preview" }, { id: "spacexai/grok-4.7" }, { id: "openai/gpt-5.5" }, { id: "anthropic/claude-sonnet-4.6" }];
  expect(selectPlannerModel("auto", menu)).toBe("anthropic/claude-sonnet-4.6");
  expect(selectPlannerModel("auto", [{ id: "google/gemini-3.1-pro-preview" }, { id: "spacexai/grok-4.7" }])).toBe("spacexai/grok-4.7");
  expect(selectPlannerModel("openai/gpt-5.5", menu)).toBe("openai/gpt-5.5");
  expect(() => selectPlannerModel("google/gemini-3.1-pro-preview", menu)).toThrow(/Claude, OpenAI or Grok/);
  expect(() => selectPlannerModel("openai/gpt-5.4", menu)).toThrow(/not available/);
  expect(() => selectPlannerModel("auto", [{ id: "google/gemini-3.1-pro-preview" }])).toThrow(/No Claude, OpenAI or Grok/);
});

test("the board snapshot the planner reads is bounded and names each card's kind", () => {
  const project: Project = {
    ...newProject("Harbour"), brief: "b".repeat(5000),
    assets: [image("captain"), image("pier", "Environment"), { ...image("memo"), kind: "document" }],
    production: {
      cast: { entries: [{ id: "c1", name: "The captain", kind: "character", description: "Weathered.", prompt: "", takes: [], referenceAssetId: "captain" }] },
      environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "e1", name: "The pier", notes: "Dawn.", prompt: "", references: [], plates: [{ assetId: "pier", at: "", source: "upload" }], selected: "pier" }] },
    },
  };
  const nodes: CanvasNode[] = [{ id: "w", title: "World", type: "element", assetId: "pier", x: 0, y: 0, width: 280, linked: [] }, scene("s1", { locked: true })];
  const snap = boardSnapshot(project, { nodes, assets: [] }, "  Build it  ");
  expect(snap.goal).toBe("Build it");
  expect(snap.brief.length).toBeLessThanOrEqual(1200);
  expect(snap.cards).toEqual([{ id: "w", kind: "Environment", title: "World", reference: true }, { id: "s1", kind: "Scene", title: "s1", locked: true, shot: true }]);
  expect(snap.assets.map((a) => a.id)).toEqual(["captain", "pier"]);
  expect(snap.cast).toEqual([{ name: "The captain", asset: "captain", about: "Weathered." }]);
  expect(snap.places).toEqual([{ name: "The pier", asset: "pier", about: "Dawn." }]);
});

/* ── Undo and removal on the canvas: soft, and a person always wins ───── */

test("remove takes an Atomik run's own cards off softly; a card someone else changed or still uses stays, with the reason", () => {
  const run = "agent:rar_cccccccccccccccccccccccc";
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [scene("theirs")], removeNodes: [], upsertAssets: [], order: ["theirs"], at: 1, author: "ana" });
  const made = planCanvasOps(canvas, [
    { kind: "create", node: scene("a1") }, { kind: "create", node: scene("a2") }, { kind: "create", node: scene("a3") },
    { kind: "wire", from: "a1", to: "theirs" }, { kind: "wire", from: "a2", to: "a3" },
  ], run);
  canvas = applyTeamPatch(canvas, { ...made.patch, at: 2, author: run });
  for (const id of made.patch.made!) canvas.serverMade[id] = run;
  /* A teammate edits a3; a3 takes a2 as its input. */
  canvas = applyTeamPatch(canvas, { upsertNodes: [{ ...canvas.nodes.a3, title: "Bo's version" }], fields: { a3: ["title"] }, removeNodes: [], upsertAssets: [], order: null, at: 3, author: "bo" });
  const wires = wiresOf(made.changes);
  expect(wires).toEqual([{ from: "a1", to: "theirs" }]);
  const ops = undoOps(canvas, run, wires);
  expect(ops).toEqual([{ kind: "unwire", from: "a1", to: "theirs" }, { kind: "remove", nodeIds: ["a1", "a2", "a3"] }]);
  const undo = planCanvasOps(canvas, ops, run);
  expect(undo.outcomes).toEqual([
    { kind: "unwire", nodeIds: ["theirs"] },
    { kind: "remove", nodeIds: ["a1"] },
    { kind: "remove", nodeIds: [], held: PERSON_WINS, card: "a3" },
    { kind: "remove", nodeIds: [], held: IN_USE, card: "a2" },
  ]);
  const after = applyTeamPatch(canvas, { ...undo.patch, at: 4, author: run });
  /* Soft: the card is kept whole in the canvas's own record, and nothing a person made is touched. */
  expect(Object.keys(after.nodes).sort()).toEqual(["a2", "a3", "theirs"]);
  expect(after.removed.a1).toMatchObject({ id: "a1", title: "a1" });
  expect(after.nodes.theirs.linked).toEqual([]);
  expect(after.nodes.a3.title).toBe("Bo's version");
  /* The log records the removal whole; undoing again finds nothing left to take. */
  expect(undo.changes.find((c) => c.removed)).toMatchObject({ id: "a1", removed: true, fields: [], after: {} });
  expect(planCanvasOps(after, [{ kind: "remove", nodeIds: ["a1"] }], run).changes).toEqual([]);
  /* A person may not be undone by an agent: their own card is never Atomik's to take. */
  expect(planCanvasOps(after, [{ kind: "remove", nodeIds: ["theirs"] }], run).outcomes).toEqual([{ kind: "remove", nodeIds: [] }, { kind: "remove", nodeIds: [], held: PERSON_WINS, card: "theirs" }]);
});

test("a draft save that still carries cards an undo took off never brings them back; a card put back on the canvas itself does come back", () => {
  const run = "agent:rar_dddddddddddddddddddddddd";
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [scene("theirs")], removeNodes: [], upsertAssets: [], order: ["theirs"], at: 1, author: "ana" });
  canvas = applyTeamPatch(canvas, { upsertNodes: [scene("a1"), scene("a2")], made: ["a1", "a2"], removeNodes: [], upsertAssets: [], order: null, at: 2, author: run });
  canvas = { ...canvas, serverMade: { a1: run, a2: run } };
  /* The undo takes both off. */
  const undo = planCanvasOps(canvas, [{ kind: "remove", nodeIds: ["a1", "a2"] }], run);
  canvas = applyTeamPatch(canvas, { ...undo.patch, at: 3, author: run });
  expect(Object.keys(canvas.nodes)).toEqual(["theirs"]);
  /* A window had folded the build in and its draft save lands after the undo: made, or a field it moved. Held. */
  const stale = applyTeamPatch(canvas, { upsertNodes: [scene("a1"), { ...scene("a2"), x: 300 }], made: ["a1"], fields: { a2: ["x"] }, removeNodes: [], upsertAssets: [], order: null, at: 4, author: "ana", implied: true });
  expect(Object.keys(stale.nodes)).toEqual(["theirs"]);
  expect(Object.keys(stale.removed).sort()).toEqual(["a1", "a2"]);
  /* A person's card taken off by a teammate is unchanged by this rule (only server-made cards are held). */
  const personal = applyTeamPatch(canvas, { upsertNodes: [], removeNodes: ["theirs"], upsertAssets: [], order: null, at: 5, author: "bo" });
  expect(Object.keys(applyTeamPatch(personal, { upsertNodes: [scene("theirs")], made: ["theirs"], removeNodes: [], upsertAssets: [], order: null, at: 6, author: "ana", implied: true }).nodes)).toEqual(["theirs"]);
  /* Put back on the canvas itself (a window's own edit, not a save's implication): it lands. */
  const back = applyTeamPatch(canvas, { upsertNodes: [scene("a1")], made: ["a1"], removeNodes: [], upsertAssets: [], order: null, at: 7, author: "ana" });
  expect(Object.keys(back.nodes).sort()).toEqual(["a1", "theirs"]);
});

test("a removal reaches the live room too, even for a card the room knows the server made", () => {
  const store = new Map<string, unknown>([["a1", scene("a1")], ["theirs", scene("theirs", { linked: ["a1"] })]]);
  let made: Record<string, string> = { a1: "agent:r" };
  const room: RoomStorage = {
    nodes: { get: (id) => store.get(id), set: (id, value) => { store.set(id, value); }, delete: (id) => { store.delete(id); } },
    assets: { get: () => undefined, set: () => {} },
    order: () => ["a1", "theirs"], setOrder: () => {}, serverMade: () => made, setServerMade: (m) => { made = m; },
  };
  writeRoom(room, roomPatchFor([
    { id: "theirs", made: false, fields: ["linked"], before: { linked: ["a1"] }, after: { linked: [] } },
    { id: "a1", made: false, removed: true, fields: [], before: scene("a1") as unknown as Record<string, unknown>, after: {} },
  ], []));
  expect([...store.keys()]).toEqual(["theirs"]);
  expect((store.get("theirs") as CanvasNode).linked).toEqual([]);
});

/* ── The executor, the run, the switch (a real tenant database) ───────── */

async function seed(name: string) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const ws = workspace(name);
  const project: Project = { ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1", assets: [image("captain")] };
  await runInTenant(ws, async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0)");
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["ana:draft-1", "ana", "draft-1", "Harbour", JSON.stringify(project)] });
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("theirs", { x: 100, y: 100, title: "Ana's shot" })], removeNodes: [], upsertAssets: [], order: ["theirs"] }, "ana");
  });
  return ws;
}
/* Never the default planner here: the scripted mock, whatever the environment says. */
const mockPlan = async (snapshot: BoardSnapshot) => ({ ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: "mock/rig-agent" });
const deps = { access: async () => null, paceMs: 0, plan: mockPlan };

test("a run: asked, planned to a proposal, approved as shown, built step by step; the executor is idempotent by op id", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const agent = await import("../../lib/workbench/rig-agent");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(await seed("run"), async () => {
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000001", goal: "The captain on the pier, two shots." });
    expect(asked).toMatchObject({ state: "planning", mine: true, credits: 0, proposal: null });
    /* Asking again with the same request id is the same run; another request waits while this one plans. */
    expect((await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000001", goal: "Again" })).id).toBe(asked.id);
    await expect(agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "bo", requestId: "req-00000002", goal: "Mine" })).rejects.toThrow(/Open this project's Rig/);
    await expect(agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000003", goal: "Another" })).rejects.toMatchObject({ status: 409 });
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "awaiting_approval", more: false });
    const proposed = (await agent.rigAgentState("prod-1", "ana")).run!;
    expect(proposed.proposal).toMatchObject({ title: "2-shot board", cards: 4, wires: 4, tidy: true, next: ["Next: render 2 shots · priced, each one approved first"] });
    expect(proposed.proposal!.groups.map((g) => [g.label, g.titles])).toEqual([["Cast", ["The lead"]], ["Environment", ["The location"]], ["Shot", ["01 — Opening", "02 — The turn"]]]);
    expect(proposed.steps.map((s) => s.state)).toEqual(["proposed", "proposed", "proposed", "proposed", "proposed", "next", "next"]);
    /* Nothing is on the board until it is approved, and only the person who asked approves, as shown. */
    expect(Object.keys((await readTeamCanvas("prod-1"))!.canvas.nodes)).toEqual(["theirs"]);
    await expect(agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint: proposed.proposal!.fingerprint, userId: "bo" })).rejects.toMatchObject({ status: 403 });
    await expect(agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint: "f".repeat(64), userId: "ana" })).rejects.toMatchObject({ status: 409 });
    await expect(agent.approveRigAgent({ productionId: "prod-x", runId: asked.id, fingerprint: proposed.proposal!.fingerprint, userId: "ana" })).rejects.toMatchObject({ status: 404 });
    const approved = await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint: proposed.proposal!.fingerprint, userId: "ana" });
    expect(approved.state).toBe("running");
    /* A lost reply to that approval: the same answer, nothing twice. */
    expect((await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint: proposed.proposal!.fingerprint, userId: "ana" })).id).toBe(asked.id);
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "done", more: false });
    const built = (await agent.rigAgentState("prod-1", "ana")).run!;
    expect(built).toMatchObject({ state: "done", built: { cards: 4, wires: 4 }, held: [], canUndo: true, credits: 0 });
    expect(built.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "next", "next"]);
    const canvas = (await readTeamCanvas("prod-1"))!;
    const own = Object.entries(canvas.canvas.serverMade).filter(([, by]) => by === `agent:${asked.id}`).map(([id]) => id);
    expect(own.sort()).toEqual(["cast-1", "place-1", "shot-1", "shot-2"].map((key) => agentNodeId(asked.id, key)).sort());
    expect(canvas.canvas.nodes.theirs).toMatchObject({ x: 100, y: 100, title: "Ana's shot" });
    /* Every step is one logged batch under its own op id. */
    const logged = async () => (await db().execute({ sql: "SELECT op_id FROM rig_canvas_ops WHERE run_id=? ORDER BY seq", args: [asked.id] })).rows.map((r) => String(r.op_id));
    expect(await logged()).toEqual([1, 2, 3, 4, 5].map((seq) => `rig-agent:${asked.id}:${seq}`));
    /* A tick that applied its steps but died before recording them runs again: the same op ids change nothing. */
    await db().execute({ sql: "UPDATE rig_agent_steps SET state='queued' WHERE run_id=? AND state='done'", args: [asked.id] });
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running' WHERE id=?", args: [asked.id] });
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "done", more: false });
    const again = (await readTeamCanvas("prod-1"))!;
    expect(again.revision).toBe(canvas.revision);
    expect(again.canvas.nodes).toEqual(canvas.canvas.nodes);
    expect(await logged()).toEqual([1, 2, 3, 4, 5].map((seq) => `rig-agent:${asked.id}:${seq}`));
    /* A done run is never ticked again. */
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "done", more: false });
    /* Nothing in a build is paid: no step holds a request, a job or credits. */
    const money = (await db().execute({ sql: "SELECT COUNT(*) AS n FROM rig_agent_steps WHERE run_id=? AND (request_key IS NOT NULL OR job_id IS NOT NULL OR credits_reserved IS NOT NULL OR credits_settled IS NOT NULL)", args: [asked.id] })).rows[0];
    expect(Number(money.n)).toBe(0);
  });
});

test("undo takes off only the run's own cards, softly, and says what a teammate's edit kept; undoing twice changes nothing more", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const agent = await import("../../lib/workbench/rig-agent");
  const { readTeamCanvas, patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  /* A plan that also wires its cast card into Ana's own shot. */
  const plan = async (snapshot: BoardSnapshot) => ({
    ...(await runPlanner(snapshot, mockPlannerModel(snapshot, { calls: [
      { tool: "create_node", input: { key: "cast-1", kind: "cast", title: "The captain" } },
      { tool: "create_node", input: { key: "place-1", kind: "environment", title: "The pier" } },
      { tool: "create_node", input: { key: "shot-1", kind: "shot", title: "01 — Opening", text: "The pier at dawn." } },
      { tool: "create_node", input: { key: "shot-2", kind: "shot", title: "02 — Close", text: "Her face." } },
      { tool: "wire", input: { from: "cast-1", to: "shot-1" } }, { tool: "wire", input: { from: "place-1", to: "shot-1" } },
      { tool: "wire", input: { from: "cast-1", to: "shot-2" } }, { tool: "wire", input: { from: "cast-1", to: "theirs" } },
    ], result: { title: "Pier", summary: "Two shots on the pier." } }))),
    model: "mock/rig-agent",
  });
  await runInTenant(await seed("undo"), async () => {
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000010", goal: "Two shots." });
    await agent.advanceRigAgentRun(asked.id, { ...deps, plan });
    const fingerprint = (await agent.rigAgentState("prod-1", "ana")).run!.proposal!.fingerprint;
    await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint, userId: "ana" });
    await agent.advanceRigAgentRun(asked.id, deps);
    const id = (key: string) => agentNodeId(asked.id, key);
    const built = (await readTeamCanvas("prod-1"))!.canvas;
    expect(built.nodes.theirs.linked).toEqual([id("cast-1")]);
    /* Bo rewrites Atomik's second shot: it is his now, and it takes the cast card as its input. */
    await patchTeamCanvas("prod-1", { upsertNodes: [{ ...built.nodes[id("shot-2")], text: "Bo's prompt" }], fields: { [id("shot-2")]: ["text"] }, removeNodes: [], upsertAssets: [], order: null }, "bo");
    const undone = await agent.undoRigAgent({ productionId: "prod-1", runId: asked.id, userId: "bo" });
    expect(undone.undo).toMatchObject({ removed: 2, kept: 2 });
    expect([...undone.undo!.reasons].sort()).toEqual([IN_USE, PERSON_WINS].sort());
    expect(undone.canUndo).toBe(false);
    const after = (await readTeamCanvas("prod-1"))!.canvas;
    /* Off, kept whole in the canvas's record: shot 1 and the place only it used. Bo's shot stays, with the cast it uses.
       The input the run wired into Ana's shot is taken out; nothing else of hers changes. */
    expect(Object.keys(after.nodes).sort()).toEqual(["theirs", id("cast-1"), id("shot-2")].sort());
    expect(Object.keys(after.removed).sort()).toEqual([id("shot-1"), id("place-1")].sort());
    expect(after.removed[id("shot-1")]).toMatchObject({ title: "01 — Opening" });
    expect(after.nodes[id("shot-2")].text).toBe("Bo's prompt");
    expect(after.nodes.theirs).toMatchObject({ title: "Ana's shot", x: 100, y: 100, linked: [] });
    /* A window that had folded the build in saves its draft just after the undo: the cards stay off (the browser race). */
    const { applyTeamCanvasPatch } = await import("../../lib/workbench/team-canvas");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    await workbenchTransaction((tx) => applyTeamCanvasPatch(tx, "prod-1", { upsertNodes: [built.nodes[id("shot-1")], built.nodes[id("place-1")]], made: [id("shot-1"), id("place-1")], removeNodes: [], upsertAssets: [], order: null }, "ana", true, { implied: true }));
    expect(Object.keys((await readTeamCanvas("prod-1"))!.canvas.nodes).sort()).toEqual(["theirs", id("cast-1"), id("shot-2")].sort());
    /* The undo is logged once under its own op id; again, it changes nothing more. */
    const second = await agent.undoRigAgent({ productionId: "prod-1", runId: asked.id, userId: "ana" });
    expect(second.undo).toEqual(undone.undo);
    expect((await readTeamCanvas("prod-1"))!.canvas.nodes).toEqual(after.nodes);
  });
});

test("a held operation is surfaced on the run card: a card locked after the proposal keeps its inputs, and the build says why", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const agent = await import("../../lib/workbench/rig-agent");
  const { readTeamCanvas, patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { runPlanner: plan } = await import("../../lib/workbench/rig-agent-planner");
  await runInTenant(await seed("held"), async () => {
    /* A planner that wires its cast card into Ana's shot. */
    const wiring = async (snapshot: BoardSnapshot) => ({
      ...(await plan(snapshot, mockPlannerModel(snapshot, { calls: [
        { tool: "create_node", input: { key: "cast-1", kind: "cast", title: "The captain" } },
        { tool: "wire", input: { from: "cast-1", to: "theirs" } },
      ], result: { title: "Captain", summary: "The captain, into Ana's shot." } }))),
      model: "mock/rig-agent",
    });
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000020", goal: "The captain in my shot." });
    await agent.advanceRigAgentRun(asked.id, { ...deps, plan: wiring });
    const fingerprint = (await agent.rigAgentState("prod-1", "ana")).run!.proposal!.fingerprint;
    /* Ana locks her shot before approving. */
    const theirs = (await readTeamCanvas("prod-1"))!.canvas.nodes.theirs;
    await patchTeamCanvas("prod-1", { upsertNodes: [{ ...theirs, locked: true }], fields: { theirs: ["locked"] }, removeNodes: [], upsertAssets: [], order: null }, "ana");
    await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint, userId: "ana" });
    await agent.advanceRigAgentRun(asked.id, deps);
    const run = (await agent.rigAgentState("prod-1", "ana")).run!;
    expect(run).toMatchObject({ state: "done", built: { cards: 1, wires: 0 }, held: ["Unlock this node before changing its inputs."] });
    expect(run.steps.find((s) => s.label.startsWith("Wires"))!.held).toEqual(["Unlock this node before changing its inputs."]);
    expect((await readTeamCanvas("prod-1"))!.canvas.nodes.theirs.linked).toEqual([]);
  });
});

test("the kill switch: off in production until the owner says go; off, nothing new starts and a build pauses before its next step; stop and undo still work", async () => {
  const { rigAgentEnabled } = await import("../../lib/workbench/rig-agent");
  expect(rigAgentEnabled({ NODE_ENV: "production" })).toBe(false);
  expect(rigAgentEnabled({ NODE_ENV: "production", RIG_AGENT_ENABLED: "1" })).toBe(true);
  expect(rigAgentEnabled({ NODE_ENV: "development" })).toBe(true);
  expect(rigAgentEnabled({ NODE_ENV: "development", RIG_AGENT_ENABLED: "0" })).toBe(false);
  expect(rigAgentEnabled({ NODE_ENV: "test", RIG_AGENT_ENABLED: "off" })).toBe(false);

  const { runInTenant } = await import("../../lib/tenant");
  const agent = await import("../../lib/workbench/rig-agent");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const previous = process.env.RIG_AGENT_ENABLED;
  process.env.RIG_AGENT_ENABLED = "1";
  try {
    await runInTenant(await seed("switch"), async () => {
      const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000030", goal: "Two shots." });
      await agent.advanceRigAgentRun(asked.id, deps);
      const fingerprint = (await agent.rigAgentState("prod-1", "ana")).run!.proposal!.fingerprint;
      process.env.RIG_AGENT_ENABLED = "0";
      await expect(agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000031", goal: "More." })).rejects.toMatchObject({ status: 403, message: agent.RIG_AGENT_OFF });
      await expect(agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint, userId: "ana" })).rejects.toMatchObject({ status: 403 });
      process.env.RIG_AGENT_ENABLED = "1";
      await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint, userId: "ana" });
      /* Switched off between the approval and the build: it pauses before placing anything, and says why. */
      process.env.RIG_AGENT_ENABLED = "0";
      expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "paused", more: false });
      const paused = await agent.rigAgentState("prod-1", "ana");
      expect(paused).toMatchObject({ enabled: false, run: { state: "paused", reason: agent.RIG_AGENT_OFF } });
      expect(Object.keys((await readTeamCanvas("prod-1"))!.canvas.nodes)).toEqual(["theirs"]);
      /* Back on: the next tick resumes where it paused and finishes. */
      process.env.RIG_AGENT_ENABLED = "1";
      expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "done", more: false });
      /* Off again: undo still takes the build off. */
      process.env.RIG_AGENT_ENABLED = "0";
      const undone = await agent.undoRigAgent({ productionId: "prod-1", runId: asked.id, userId: "ana" });
      expect(undone.undo).toMatchObject({ removed: 4, kept: 0 });
      expect(Object.keys((await readTeamCanvas("prod-1"))!.canvas.nodes)).toEqual(["theirs"]);
      /* A member who lost access: the build pauses with the reason, and stop still works. */
      process.env.RIG_AGENT_ENABLED = "1";
      const next = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000032", goal: "One shot." });
      expect(await agent.advanceRigAgentRun(next.id, { ...deps, access: async () => "The person who asked for this build no longer has access to this workspace." })).toEqual({ state: "paused", more: false });
      expect((await agent.stopRigAgent({ productionId: "prod-1", runId: next.id, userId: "bo" })).state).toBe("stopped");
      expect(await agent.advanceRigAgentRun(next.id, deps)).toEqual({ state: "stopped", more: false });
    });
  } finally {
    if (previous === undefined) delete process.env.RIG_AGENT_ENABLED; else process.env.RIG_AGENT_ENABLED = previous;
  }
});

test("a proposal nobody approved is replaced by a newer request; set aside, it builds nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const agent = await import("../../lib/workbench/rig-agent");
  await runInTenant(await seed("replace"), async () => {
    const first = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000040", goal: "Two shots." });
    await agent.advanceRigAgentRun(first.id, deps);
    const second = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: "ana", requestId: "req-00000041", goal: "One shot." });
    const { getRun } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    expect(await getRun(db(), first.id)).toMatchObject({ state: "stopped", reason: "A newer request replaced this proposal." });
    await agent.advanceRigAgentRun(second.id, deps);
    await expect(agent.declineRigAgent({ productionId: "prod-1", runId: second.id, userId: "bo" })).rejects.toMatchObject({ status: 403 });
    const declined = await agent.declineRigAgent({ productionId: "prod-1", runId: second.id, userId: "ana" });
    expect(declined).toMatchObject({ state: "stopped", canUndo: false, built: { cards: 0, wires: 0 } });
    await expect(agent.undoRigAgent({ productionId: "prod-1", runId: second.id, userId: "ana" })).rejects.toMatchObject({ status: 409 });
  });
});

test("the rig-agent worker: an Inngest function on its own event, a native worker event, one run at a time per production, cancelled by a stop", async () => {
  const { rigAgent, functions } = await import("../../lib/workers");
  const { EVENTS, RIG_AGENT_STOPPED, WORKER_EVENT_NAMES } = await import("../../lib/dispatch");
  const { workerJobId } = await import("../../lib/worker-handlers");
  expect(functions).toContain(rigAgent);
  const opts = rigAgent.opts as { id: string; triggers?: { event?: string }[]; concurrency?: { limit: number; key?: string }[]; retries?: number; cancelOn?: { event: string; match?: string }[] };
  expect(opts.id).toBe("rig-agent");
  expect(opts.triggers?.map((t) => t.event)).toEqual(["rig/agent.run.requested"]);
  expect(EVENTS.rigAgent).toBe("rig/agent.run.requested");
  expect(opts.concurrency).toEqual([{ limit: 2, key: "event.data.workspaceId" }, { limit: 1, key: "event.data.productionId" }]);
  expect(opts.retries).toBe(3);
  expect(opts.cancelOn).toEqual([{ event: RIG_AGENT_STOPPED, match: "data.runId" }]);
  /* The native worker takes the same event; the stop signal is Inngest's alone. */
  expect(WORKER_EVENT_NAMES).toContain(EVENTS.rigAgent);
  expect((WORKER_EVENT_NAMES as readonly string[]).includes(RIG_AGENT_STOPPED)).toBe(false);
  expect(workerJobId({ id: "rig-agent-x-plan", name: EVENTS.rigAgent, data: { runId: "rar_0123456789abcdef01234567", productionId: "prod-1", workspaceId: "ws_1" } })).toBe("rar_0123456789abcdef01234567");
  /* A malformed event never reaches a tenant. */
  const { handleRigAgent } = await import("../../lib/workbench/rig-agent");
  await expect(handleRigAgent({ runId: "not-a-run", productionId: "prod-1", workspaceId: "ws_1" })).rejects.toThrow(/Invalid rig agent event/);
});
