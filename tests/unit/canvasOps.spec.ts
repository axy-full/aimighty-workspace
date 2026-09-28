import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode } from "../../lib/workbench/studio";
import { kindSectionId, tidyBoard } from "../../lib/workspace/rig-board";
import {
  applyTeamPatch, catchUpForTeam, emptyTeamCanvas, overlay, parseTeamCanvas, roomPeer, writeRoom,
  type RoomStorage, type TeamCanvas, type TeamPatch,
} from "../../lib/workbench/team-canvas-model";
import { focusPoint, PERSON_WINS, planCanvasOps, roomPatchFor, type CanvasOp } from "../../lib/workbench/canvas-ops-model";
import type { LiveRoot, RoomClient } from "../../lib/workbench/canvas-push";

/*
 * Server-made changes to the Rig's team canvas (plan §5.2, structure 3-A):
 * applyCanvasOps, the writers record, the rig_canvas_ops log and outbox, the
 * push into the live room (a stand-in for Liveblocks: never the real
 * service), Atomik's presence, and the check windows make with no live room.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-canvas-ops-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
/* Rooms are off in this process: only the stand-in below is ever pushed to. */
delete process.env.LIVEBLOCKS_SECRET_KEY;

function workspace(name: string): TenantWorkspace {
  return { id: "ws_" + name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [], ...extra });
const note = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "note", x: 0, y: 0, width: 254, linked: [], text: "", ...extra });
const asset = (id: string): Asset => ({ id, name: id, kind: "image", category: "Shot", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const canvasOf = (nodes: CanvasNode[], extra: Partial<TeamCanvas> = {}): TeamCanvas =>
  ({ ...applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: [], order: nodes.map((n) => n.id), at: 1, author: "ana" }), ...extra });

/* ── A stand-in for the live room (Liveblocks storage) and its REST client ── */
class FakeMap {
  m = new Map<string, unknown>();
  get(key: string) { return this.m.get(key); }
  set(key: string, value: unknown) { this.m.set(key, JSON.parse(JSON.stringify(value))); }
  delete(key: string) { return this.m.delete(key); }
}
function fakeRoom(seed?: TeamCanvas) {
  const store = new Map<string, unknown>([["nodes", new FakeMap()], ["assets", new FakeMap()], ["order", []]]);
  const root: LiveRoot = { get: (key) => store.get(key), set: (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); } };
  const storage = (): RoomStorage => {
    const nodes = store.get("nodes") as FakeMap, assets = store.get("assets") as FakeMap;
    return {
      nodes: { get: (id) => nodes.get(id), set: (id, v) => nodes.set(id, v), delete: (id) => { nodes.delete(id); } },
      assets: { get: (id) => assets.get(id), set: (id, v) => assets.set(id, v) },
      order: () => (store.get("order") as string[]) ?? [],
      setOrder: (order) => store.set("order", order),
      serverMade: () => (store.get("serverMade") as Record<string, string>) ?? {},
      setServerMade: (made) => store.set("serverMade", made),
    };
  };
  /* A window alone in the room starts it from the saved canvas. */
  if (seed) for (const id of Object.keys(seed.nodes)) storage().nodes.set(id, seed.nodes[id]);
  if (seed) store.set("order", Object.keys(seed.nodes));
  const calls: string[] = [];
  const presence: { userId: string; data: Record<string, unknown>; userInfo?: Record<string, unknown> }[] = [];
  const state = { fail: null as unknown };
  const client: RoomClient = {
    async mutateStorage(roomId, callback, options) {
      calls.push(roomId);
      /* Every push is bounded: one that hangs counts as not landed. */
      if (!options?.signal) throw new Error("A push must carry a time limit.");
      if (state.fail) throw state.fail;
      await callback({ root });
    },
    async setPresence(_roomId, params, options) {
      if (!options?.signal) throw new Error("Presence must carry a time limit.");
      presence.push(params);
    },
  };
  const nodes = () => Object.fromEntries((store.get("nodes") as FakeMap).m) as Record<string, CanvasNode>;
  return { client, storage, nodes, calls, presence, state, root, store };
}

/* ── Planning: pure ─────────────────────────────────────────────────────── */

test("create makes a card once: made again, it adds nothing; one taken off is only ever put back by a person", () => {
  const canvas = canvasOf([scene("a")]);
  const first = planCanvasOps(canvas, [{ kind: "create", node: scene("s1", { x: 30000 }), assets: [asset("plate")] }], "agent:run-1");
  expect(first.patch.made).toEqual(["s1"]);
  expect(first.patch.upsertNodes[0]).toMatchObject({ id: "s1", x: 20000 });
  expect(first.patch.upsertAssets.map((a) => a.id)).toEqual(["plate"]);
  const after = applyTeamPatch(canvas, { ...first.patch, at: 5, author: "agent:run-1" });
  const again = planCanvasOps(after, [{ kind: "create", node: scene("s1") }], "agent:run-1");
  expect(again.changes).toEqual([]);
  expect(again.outcomes).toEqual([{ kind: "create", nodeIds: [] }]);
  const off = applyTeamPatch(after, { upsertNodes: [], removeNodes: ["s1"], upsertAssets: [], order: null, at: 6, author: "ana" });
  expect(planCanvasOps(off, [{ kind: "create", node: scene("s1") }], "agent:run-1").outcomes[0].held).toMatch(/only a person/);
  /* A made card's inputs are wired by the graph's rules: two cards made to feed each other get one wire, not a loop.
     It never arrives approved. */
  const pair = planCanvasOps(canvas, [
    { kind: "create", node: scene("p", { linked: ["q", "a"], status: "approved" }) },
    { kind: "create", node: scene("q", { linked: ["p"] }) },
  ], "agent:run-1");
  const made = Object.fromEntries(pair.patch.upsertNodes.map((n) => [n.id, n]));
  expect({ p: made.p.linked, q: made.q.linked, status: made.p.status }).toEqual({ p: ["a"], q: ["p"], status: undefined });
  expect(pair.outcomes.filter((o) => o.held).map((o) => o.held)).toEqual(["Choose two existing nodes."]);
});

test("move writes only x and y onto the card as it is now; a locked card is held", () => {
  const canvas = canvasOf([scene("a", { text: "Teammate's prompt" }), scene("m", { locked: true })]);
  const plan = planCanvasOps(canvas, [{ kind: "move", nodeId: "a", x: 120.4, y: -20000 }, { kind: "move", nodeId: "m", x: 1, y: 1 }], "ana");
  expect(plan.patch.fields).toEqual({ a: ["x", "y"] });
  expect(plan.changes).toEqual([{ id: "a", made: false, fields: ["x", "y"], before: { x: 0, y: 0 }, after: { x: 120, y: -10000 } }]);
  expect(plan.outcomes[1]).toEqual({ kind: "move", nodeIds: [], held: "That card is locked." });
  /* A teammate rewrote the prompt meanwhile: the move lands on their card, their prompt stands. */
  const edited = applyTeamPatch(canvas, { upsertNodes: [scene("a", { text: "Newer prompt" })], fields: { a: ["text"] }, removeNodes: [], upsertAssets: [], order: null, at: 3, author: "bo" });
  const moved = applyTeamPatch(edited, { ...plan.patch, at: 4, author: "ana" });
  expect(moved.nodes.a).toMatchObject({ x: 120, y: -10000, text: "Newer prompt" });
});

test("wire adds one input to what the card has now, by the graph's rules; an existing wire is not doubled", () => {
  const canvas = canvasOf([scene("a"), scene("b"), scene("c", { linked: ["a"] }), note("n")]);
  const plan = planCanvasOps(canvas, [{ kind: "wire", from: "b", to: "c" }, { kind: "wire", from: "a", to: "c" }, { kind: "wire", from: "c", to: "c" }], "agent:run-1");
  expect(plan.patch.fields).toEqual({ c: ["linked"] });
  expect(plan.outcomes.map((o) => o.held ?? "ok")).toEqual(["ok", "ok", "A node cannot connect to itself."]);
  /* A teammate wired n into c while the plan was made: the server's wire lands on their inputs, theirs stands. */
  const teammate = applyTeamPatch(canvas, { upsertNodes: [scene("c", { linked: ["a", "n"] })], fields: { c: ["linked"] }, removeNodes: [], upsertAssets: [], order: null, at: 2, author: "bo" });
  const replanned = planCanvasOps(teammate, [{ kind: "wire", from: "b", to: "c" }], "agent:run-1");
  expect(applyTeamPatch(teammate, { ...replanned.patch, at: 3, author: "agent:run-1" }).nodes.c.linked).toEqual(["a", "n", "b"]);
  /* A cycle is refused with the graph's own words. */
  expect(planCanvasOps(canvasOf([scene("x", { linked: ["y"] }), scene("y")]), [{ kind: "wire", from: "x", to: "y" }], "ana").outcomes[0].held).toBe("This connection would create a circular path.");
});

test("set writes only the fields an operation may set: approving stays a person's", () => {
  const canvas = canvasOf([scene("a")]);
  const plan = planCanvasOps(canvas, [
    { kind: "set", nodeId: "a", fields: { title: "Harbour wide", durationS: 6 } },
    { kind: "set", nodeId: "a", fields: { status: "approved" } as unknown as Record<string, never> },
    { kind: "set", nodeId: "gone", fields: { title: "x" } },
  ], "ana");
  expect(plan.patch.fields).toEqual({ a: ["title", "durationS"] });
  expect(plan.outcomes.map((o) => o.held ?? "ok")).toEqual(["ok", "A card's status is not set this way.", "That card is not on the canvas."]);
});

test("tidy lays the board out by sections: a block per section under its title, rows in order, locked cards stay; a second tidy moves nothing", () => {
  const canvas = canvasOf([scene("a", { x: 900, y: 700 }), scene("b", { x: 100, y: 1200, linked: ["a"] }), scene("c", { x: 1500, y: 100 }), scene("l", { x: 3000, y: 3000, locked: true })]);
  const plan = planCanvasOps(canvas, [{ kind: "tidy" }], "ana");
  const positions = Object.fromEntries(plan.changes.filter((c) => !c.made).map((c) => [c.id, c.after]));
  expect(positions).toEqual({ a: { x: 60, y: 140 }, b: { x: 60, y: 400 }, c: { x: 60, y: 660 } });
  /* The shots' section title is made with them, in its place. */
  const shots = kindSectionId("shots");
  expect(plan.changes.filter((c) => c.made).map((c) => [c.id, c.after.title, c.after.x, c.after.y])).toEqual([[shots, "Shots", 60, 60]]);
  expect(plan.outcomes).toEqual([{ kind: "create", nodeIds: [shots] }, { kind: "tidy", nodeIds: ["a", "b", "c"] }]);
  /* The same layout the board's own tidy makes (lib/workspace/rig-board.ts). */
  for (const spot of tidyBoard(Object.values(canvas.nodes), { assets: [] }).spots) expect(positions[spot.id]).toEqual({ x: spot.x, y: spot.y });
  const tidied = applyTeamPatch(canvas, { ...plan.patch, at: 5, author: "ana" });
  expect(tidied.nodes.l).toMatchObject({ x: 3000, y: 3000 });
  expect(planCanvasOps(tidied, [{ kind: "tidy" }], "ana").changes).toEqual([]);
  /* Atomik's cursor sits on the card it touched last, in the graph's own coordinates. */
  expect(focusPoint(Object.values(tidied.nodes), "c")).toEqual({ x: 44, y: 638 });
});

test("a person always wins: an Atomik run moves only cards it made and still last wrote, and may still wire into a teammate's", () => {
  const made = planCanvasOps(canvasOf([scene("person")]), [{ kind: "create", node: scene("mine") }], "agent:run-1");
  let canvas = applyTeamPatch(canvasOf([scene("person")]), { ...made.patch, at: 2, author: "agent:run-1" });
  canvas = { ...canvas, serverMade: { mine: "agent:run-1" } };
  const ops: CanvasOp[] = [
    { kind: "move", nodeId: "person", x: 500, y: 500 },
    { kind: "move", nodeId: "mine", x: 500, y: 500 },
    { kind: "create", node: scene("fresh") },
    { kind: "set", nodeId: "fresh", fields: { title: "Made and named" } },
    { kind: "wire", from: "fresh", to: "person" },
  ];
  const plan = planCanvasOps(canvas, ops, "agent:run-1");
  expect(plan.outcomes.map((o) => o.held ?? "ok")).toEqual([PERSON_WINS, "ok", "ok", "ok", "ok"]);
  /* A tidy by the run lays out only its own cards (and makes their section's title); a teammate's stay where they put them. */
  const tidy = planCanvasOps(canvas, [{ kind: "tidy" }], "agent:run-1");
  expect(tidy.changes.map((c) => c.id)).toEqual([kindSectionId("shots"), "mine"]);
  /* Another run is not this one. */
  expect(planCanvasOps(canvas, [{ kind: "move", nodeId: "mine", x: 1, y: 1 }], "agent:run-2").outcomes[0].held).toBe(PERSON_WINS);
  /* Wiring into a teammate's card makes Atomik its last writer, never its owner: it still may not move it. */
  const wired = applyTeamPatch(canvas, { ...plan.patch, at: 3, author: "agent:run-1" });
  expect(wired.writers.person).toBe("agent:run-1");
  expect(planCanvasOps(wired, [{ kind: "move", nodeId: "person", x: 1, y: 1 }], "agent:run-1").outcomes[0].held).toBe(PERSON_WINS);
  /* Once a teammate changes a card Atomik made, Atomik stops touching it. */
  const touched = applyTeamPatch(canvas, { upsertNodes: [scene("mine", { title: "Bo's now" })], fields: { mine: ["title"] }, removeNodes: [], upsertAssets: [], order: null, at: 4, author: "bo" });
  expect(planCanvasOps(touched, [{ kind: "move", nodeId: "mine", x: 1, y: 1 }], "agent:run-1").outcomes[0].held).toBe(PERSON_WINS);
});

/* ── The canvas record: writers, server-made cards, the guard ──────────── */

test("writers name who last changed each card, only when a write changed it; the record survives a read back", () => {
  let canvas = canvasOf([scene("a"), scene("b")]);
  expect(canvas.writers).toEqual({ a: "ana", b: "ana" });
  /* Bo's save carries a back exactly as it is: nothing changed, Ana is still its writer. */
  canvas = applyTeamPatch(canvas, { upsertNodes: [scene("a")], fields: { a: ["x"] }, removeNodes: [], upsertAssets: [], order: null, at: 2, author: "bo" });
  expect(canvas.writers.a).toBe("ana");
  canvas = applyTeamPatch(canvas, { upsertNodes: [scene("a", { x: 9 })], fields: { a: ["x"] }, removeNodes: ["b"], upsertAssets: [], order: null, at: 3, author: "bo" });
  expect(canvas.writers).toEqual({ a: "bo", b: "bo" });
  const read = parseTeamCanvas(JSON.parse(JSON.stringify({ ...canvas, serverMade: { s: "agent:run-1", bad: 7 }, writers: { ...canvas.writers, junk: { x: 1 } } })));
  expect(read.writers).toEqual({ a: "bo", b: "bo" });
  expect(read.serverMade).toEqual({ s: "agent:run-1" });
  /* A canvas saved before either existed reads as empty records, never undefined. */
  expect(parseTeamCanvas({ nodes: {} })).toMatchObject({ writers: {}, serverMade: {} });
});

test("a card the server made is never taken off by a removal a save only implied; a removal made on the canvas still lands", () => {
  const base = canvasOf([scene("a"), scene("s")], { serverMade: { s: "agent:run-1" } });
  const drop = (patch: Partial<TeamPatch>) => applyTeamPatch(base, { upsertNodes: [], removeNodes: ["s", "a"], upsertAssets: [], order: null, at: 5, author: "bo", ...patch });
  /* A draft save that no longer shows s (lost to a stale view): s stays; a, a person's card, goes as before. */
  const implied = drop({ implied: true });
  expect(Object.keys(implied.nodes)).toEqual(["s"]);
  expect(implied.removed.a).toBeTruthy();
  /* A catch-up (what another save brought in) that dropped s: the same. */
  const caught = drop({ expect: { s: base.nodes.s, a: base.nodes.a } });
  expect(Object.keys(caught.nodes)).toEqual(["s"]);
  /* The Rig's own delete, made on the canvas: it lands. */
  expect(Object.keys(drop({}).nodes)).toEqual([]);
  /* The room and a window's own view follow the same rule. */
  const room = fakeRoom(base);
  room.storage().setServerMade({ s: "agent:run-1" });
  writeRoom(room.storage(), { upsertNodes: [], removeNodes: ["s", "a"], upsertAssets: [], order: null, at: 5, expect: { s: base.nodes.s, a: base.nodes.a } });
  expect(Object.keys(room.nodes())).toEqual(["s"]);
  const view = overlay({ nodes: base.nodes, assets: {}, order: ["a", "s"], removedIds: [], serverMade: base.serverMade }, { upsertNodes: [], removeNodes: ["s"], upsertAssets: [], order: null, at: 5, expect: { s: base.nodes.s } });
  expect(Object.keys(view.nodes).sort()).toEqual(["a", "s"]);
});

/* ── On the server: the transaction, the log, idempotency ──────────────── */

test("applyCanvasOps: applied in the canvas's own transaction, logged once per op id; the same op again changes nothing and answers the same", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { patchTeamCanvas, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { latestServerChange } = await import("../../lib/workbench/canvas-ops-log");
  await runInTenant(workspace("ops-idempotent"), async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    await expect(applyCanvasOps("prod-x", { opId: "op-1", ops: [{ kind: "tidy" }], author: "ana" }, { room: null })).rejects.toThrow("not in this workspace");
    await expect(applyCanvasOps("prod-1", { opId: "no spaces", ops: [{ kind: "tidy" }], author: "ana" }, { room: null })).rejects.toThrow("op id");
    await expect(applyCanvasOps("prod-1", { opId: "op-bad", ops: [{ kind: "explode" }] as unknown as CanvasOp[], author: "ana" }, { room: null })).rejects.toThrow("Check the canvas change");
    /* No server change yet, and the log is not made by reading. */
    expect(await latestServerChange("prod-1")).toBeNull();
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("a", { x: 900 }), scene("b", { x: 50, linked: ["a"] })], removeNodes: [], upsertAssets: [], order: ["a", "b"] }, "ana");
    const ops: CanvasOp[] = [{ kind: "create", node: scene("s1", { title: "Atomik's shot" }) }, { kind: "wire", from: "s1", to: "b" }];
    const first = await applyCanvasOps("prod-1", { opId: "run-1:step-1", ops, author: "agent:run-1", runId: "run-1" }, { room: null });
    expect(first).toMatchObject({ revision: 2, changed: 2, replay: false, live: "off" });
    const second = await applyCanvasOps("prod-1", { opId: "run-1:step-1", ops, author: "agent:run-1", runId: "run-1" }, { room: null });
    expect(second).toEqual({ ...first, replay: true });
    const saved = (await readTeamCanvas("prod-1"))!;
    expect(saved.revision).toBe(2);
    expect(saved.canvas.nodes.b.linked).toEqual(["a", "s1"]);
    expect(saved.canvas.writers).toMatchObject({ a: "ana", s1: "agent:run-1", b: "agent:run-1" });
    expect(saved.canvas.serverMade).toEqual({ s1: "agent:run-1" });
    const rows = (await db().execute("SELECT op_id,what,author,run_id,changed,revision,push,changes FROM rig_canvas_ops")).rows;
    expect(rows.map((r) => [r.op_id, r.author, r.run_id, Number(r.changed), Number(r.revision), r.push])).toEqual([["run-1:step-1", "agent:run-1", "run-1", 2, 2, "none"]]);
    /* The record keeps each card's fields before and after. */
    expect(JSON.parse(String(rows[0].changes))[1]).toEqual({ id: "b", made: false, fields: ["linked"], before: { linked: ["a"] }, after: { linked: ["a", "s1"] } });
    /* An op that changes nothing is recorded (so it answers the same again) but is no news to open windows. */
    const change = await latestServerChange("prod-1");
    expect(change).toMatchObject({ what: "ops", agent: true });
    await applyCanvasOps("prod-1", { opId: "run-1:step-2", ops: [{ kind: "wire", from: "s1", to: "b" }], author: "agent:run-1" }, { room: null });
    expect(await latestServerChange("prod-1")).toEqual(change);
    expect((await readTeamCanvas("prod-1"))!.revision).toBe(2);
  });
});

test("concurrent edits: nothing a person changed is lost, and nothing the server made is taken off", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { patchTeamCanvas, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(workspace("ops-concurrent"), async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("a", { x: 900, y: 700 }), scene("b", { x: 100, y: 1200, linked: ["a"] })], removeNodes: [], upsertAssets: [], order: ["a", "b"] }, "ana");
    /* Bo edits a's prompt and Ana tidies at the same moment: both land, whichever is first. */
    const [tidied] = await Promise.all([
      applyCanvasOps("prod-1", { opId: "tidy-1", ops: [{ kind: "tidy" }], author: "ana", what: "tidy" }, { room: null }),
      patchTeamCanvas("prod-1", { upsertNodes: [scene("a", { x: 900, y: 700, text: "Bo's prompt" })], fields: { a: ["text"] }, removeNodes: [], upsertAssets: [], order: null }, "bo"),
    ]);
    /* Two cards moved, and the shots' section title made. */
    expect(tidied.changed).toBe(3);
    let canvas = (await readTeamCanvas("prod-1"))!.canvas;
    expect(canvas.nodes.a).toMatchObject({ x: 60, y: 140, text: "Bo's prompt" });
    /* Bo drags b after the tidy: the later write wins, and Bo is its writer. */
    await patchTeamCanvas("prod-1", { upsertNodes: [{ ...canvas.nodes.b, x: 1234 }], fields: { b: ["x"] }, removeNodes: [], upsertAssets: [], order: null }, "bo");
    /* Atomik makes s; a stale catch-up from Bo's other window drops it, and so does Bo's stale draft save: s stays. */
    await applyCanvasOps("prod-1", { opId: "make-s", ops: [{ kind: "create", node: scene("s", { x: 60, y: 900 }) }], author: "agent:run-1" }, { room: null });
    canvas = (await readTeamCanvas("prod-1"))!.canvas;
    const stale = { ...newProject("Team"), productionProjectId: "prod-1", nodes: [canvas.nodes.a, canvas.nodes.b, canvas.nodes.s] };
    const caught = catchUpForTeam(stale, { ...stale, nodes: [canvas.nodes.a, canvas.nodes.b] }, 0)!;
    const held = await patchTeamCanvas("prod-1", caught, "bo");
    expect(held.held).toEqual(["s"]);
    canvas = (await readTeamCanvas("prod-1"))!.canvas;
    expect(canvas.nodes.b.x).toBe(1234);
    expect(canvas.nodes.s).toBeTruthy();
    expect(canvas.removed.s).toBeUndefined();
    /* The server told the room to keep it: a re-assert waits for any room there is (none here). */
    const reassert = (await db().execute("SELECT what,author,changed,push FROM rig_canvas_ops WHERE what='reassert'")).rows;
    expect(reassert.map((r) => [r.author, Number(r.changed), r.push])).toEqual([["server", 1, "none"]]);
  });
});

test("a draft save that lost a card the server made (a stale live room) never takes it off the team canvas", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { saveDraft, readDraft } = await import("../../lib/workbench/records");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { patchTeamCanvas, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { latestServerChange } = await import("../../lib/workbench/canvas-ops-log");
  await runInTenant(workspace("ops-drift"), async () => {
    const p = { ...newProject("Drift"), nodes: [scene("a"), scene("mine")] };
    const pid = (await saveDraft("ana", p, 0)).productionProjectId;
    /* Ana's Rig opened the canvas; Atomik made s on it. */
    await patchTeamCanvas(pid, { upsertNodes: p.nodes, removeNodes: [], upsertAssets: [], order: ["a", "mine"] }, "ana");
    await applyCanvasOps(pid, { opId: "make-s", ops: [{ kind: "create", node: scene("s", { title: "Atomik's shot" }) }], author: "agent:run-1" }, { room: null });
    const s = (await readTeamCanvas(pid))!.canvas.nodes.s;
    /* Ana's window folded s in and saved it... */
    let draft = (await readDraft("ana", p.id))!;
    await saveDraft("ana", { ...draft.project, nodes: [...draft.project.nodes, s] }, draft.revision);
    const before = await latestServerChange(pid);
    /* ...then joined a room that had not caught up, lost s with it, and deleted her own card too. Her next save: */
    draft = (await readDraft("ana", p.id))!;
    await saveDraft("ana", { ...draft.project, nodes: draft.project.nodes.filter((n) => n.id !== "s" && n.id !== "mine") }, draft.revision);
    const canvas = (await readTeamCanvas(pid))!.canvas;
    expect(canvas.nodes.s).toMatchObject({ title: "Atomik's shot" });
    expect(canvas.removed.s).toBeUndefined();
    /* Her own card's delete still reaches the team. */
    expect(canvas.removed.mine).toBeTruthy();
    /* Open windows hear about it: the re-assert is a server change they fold in. */
    expect((await latestServerChange(pid))!.seq).toBeGreaterThan(before!.seq);
    /* Deleting s on the canvas itself (the Rig's delete) takes it off, kept whole in the canvas's record. */
    await patchTeamCanvas(pid, { upsertNodes: [], removeNodes: ["s"], upsertAssets: [], order: null }, "ana");
    expect((await readTeamCanvas(pid))!.canvas.removed.s).toMatchObject({ id: "s" });
  });
});

/* ── The room: push, presence, outbox ──────────────────────────────────── */

test("the room push reaches the same canvas as the database merge, and a teammate's edit that reached the room first stands", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { patchTeamCanvas, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(workspace("ops-room"), async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("a", { x: 900, y: 700 }), scene("b", { x: 100, y: 1200, linked: ["a"] }), note("n", { x: 5, y: 5 })], removeNodes: [], upsertAssets: [], order: ["a", "b", "n"] }, "ana");
    const room = fakeRoom((await readTeamCanvas("prod-1"))!.canvas);
    const ops: CanvasOp[] = [
      { kind: "create", node: scene("s", { title: "Atomik's shot", assetId: "plate" }), assets: [asset("plate")] },
      { kind: "wire", from: "s", to: "b" },
      { kind: "set", nodeId: "n", fields: { text: "Hold the frame." } },
      { kind: "tidy" },
    ];
    const result = await applyCanvasOps("prod-1", { opId: "build-1", ops, author: "ana", what: "ops" }, { room: room.client });
    expect(result.live).toBe("sent");
    expect(room.calls).toEqual(["particl:ws_ops-room:prod-1"]);
    const saved = (await readTeamCanvas("prod-1"))!.canvas;
    expect(room.nodes()).toEqual(saved.nodes);
    /* The made card and the section titles the tidy made join the room's order, and the room learns the server made them. */
    const titles = [kindSectionId("direction"), kindSectionId("shots")];
    expect(room.store.get("order")).toEqual(["a", "b", "n", "s", ...titles]);
    expect(room.storage().serverMade()).toEqual({ s: "ana", [titles[0]]: "ana", [titles[1]]: "ana" });
    expect((room.store.get("assets") as FakeMap).get("plate")).toEqual(asset("plate"));
    /* Atomik shows in the room, its cursor on the card it touched last. */
    expect(room.presence.at(-1)).toMatchObject({ userId: "particl-atomik", userInfo: { name: "Atomik", agent: true }, data: { doing: "Working on the board", drag: null } });
    expect(room.presence.at(-1)!.data.selected).toBeTruthy();

    /* Ana moves b (her window writes the room and the server); then Bo drags it in the room, his save still on its way.
       A second tidy moves b back on the server, but not over Bo's place in the room. */
    await patchTeamCanvas("prod-1", { upsertNodes: [{ ...saved.nodes.b, x: 3000 }], fields: { b: ["x"] }, removeNodes: [], upsertAssets: [], order: null }, "ana");
    room.storage().nodes.set("b", { ...room.nodes().b, x: 3000 });
    room.storage().nodes.set("b", { ...room.nodes().b, x: 2500 });
    const second = await applyCanvasOps("prod-1", { opId: "tidy-2", ops: [{ kind: "tidy" }], author: "ana", what: "tidy" }, { room: room.client });
    expect(second.outcomes).toEqual([{ kind: "tidy", nodeIds: ["b"] }]);
    expect(room.nodes().b.x).toBe(2500);
    expect(room.presence.at(-1)).toMatchObject({ data: { doing: "Tidying the board", selected: "b" } });
    /* ...and his save then lands: the room and the database agree again, on Bo's place. */
    await patchTeamCanvas("prod-1", { upsertNodes: [{ ...(await readTeamCanvas("prod-1"))!.canvas.nodes.b, x: 2500 }], fields: { b: ["x"] }, removeNodes: [], upsertAssets: [], order: null }, "bo");
    expect(room.nodes()).toEqual((await readTeamCanvas("prod-1"))!.canvas.nodes);
    /* A push that arrives twice changes nothing: the room's copy of a made card is never replaced by it. */
    room.storage().nodes.set("s", { ...(room.nodes().s), title: "Renamed in the room" });
    const again = roomPatchFor([{ id: "s", made: true, fields: [], before: {}, after: saved.nodes.s as unknown as Record<string, unknown> }], []);
    writeRoom(room.storage(), again);
    expect(room.nodes().s.title).toBe("Renamed in the room");
  });
});

test("the outbox: a push the room did not take waits, is retried in order before anything newer, and never lands out of order", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { drainCanvasPushes } = await import("../../lib/workbench/canvas-push");
  const { patchTeamCanvas, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(workspace("ops-outbox"), async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("a", { x: 900, y: 700 })], removeNodes: [], upsertAssets: [], order: ["a"] }, "ana");
    const room = fakeRoom((await readTeamCanvas("prod-1"))!.canvas);
    room.state.fail = Object.assign(new Error("Service unavailable"), { status: 503 });
    /* The room is down: the tidy lands on the canvas and waits in the outbox. */
    const first = await applyCanvasOps("prod-1", { opId: "tidy-1", ops: [{ kind: "tidy" }], author: "ana", what: "tidy" }, { room: room.client });
    expect(first.live).toBe("waiting");
    const pending = async () => (await db().execute("SELECT op_id,push,push_attempts,push_error FROM rig_canvas_ops ORDER BY seq")).rows.map((r) => [r.op_id, r.push, Number(r.push_attempts), r.push_error]);
    expect(await pending()).toEqual([["tidy-1", "pending", 1, "status 503"]]);
    /* A newer change is not pushed ahead of it: both go out together, oldest first, when the room is back. */
    const second = await applyCanvasOps("prod-1", { opId: "move-1", ops: [{ kind: "move", nodeId: "a", x: 500, y: 500 }], author: "ana" }, { room: room.client });
    expect(second.live).toBe("waiting");
    expect(await pending()).toEqual([["tidy-1", "pending", 2, "status 503"], ["move-1", "pending", 2, "status 503"]]);
    /* Backed off: a drain before it is due pushes nothing. */
    room.state.fail = null;
    expect(await drainCanvasPushes("prod-1", { room: room.client })).toEqual({ sent: 0, waiting: 0 });
    await db().execute("UPDATE rig_canvas_ops SET push_after=0");
    expect(await drainCanvasPushes(null, { room: room.client })).toEqual({ sent: 2, waiting: 0 });
    expect((await pending()).map((r) => r[1])).toEqual(["done", "done"]);
    /* In order, the move lands on the tidied place: the room holds what the database holds. */
    expect(room.nodes().a).toMatchObject({ x: 500, y: 500 });
    expect(room.nodes()).toEqual((await readTeamCanvas("prod-1"))!.canvas.nodes);
    /* A room nobody has opened: nothing to push to (the first window starts it from the saved canvas). */
    room.state.fail = Object.assign(new Error("Not found"), { status: 404 });
    expect((await applyCanvasOps("prod-1", { opId: "move-2", ops: [{ kind: "move", nodeId: "a", x: 7, y: 7 }], author: "ana" }, { room: room.client })).live).toBe("sent");
    /* A room with no canvas in it yet: the same. */
    room.state.fail = null;
    room.store.delete("nodes");
    expect((await applyCanvasOps("prod-1", { opId: "move-3", ops: [{ kind: "move", nodeId: "a", x: 8, y: 8 }], author: "ana" }, { room: room.client })).live).toBe("sent");
    /* A room that never answers: the push gives up in time and the change waits, never a hung request. */
    room.store.set("nodes", new FakeMap());
    const hung: RoomClient = { mutateStorage: (_room, _cb, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason))), setPresence: async () => {} };
    const started = Date.now();
    expect((await applyCanvasOps("prod-1", { opId: "move-hung", ops: [{ kind: "move", nodeId: "a", x: 10, y: 10 }], author: "ana" }, { room: hung })).live).toBe("waiting");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await db().execute("SELECT push,push_error FROM rig_canvas_ops WHERE op_id='move-hung'")).rows.map((r) => [r.push, r.push_error])).toEqual([["pending", "unreachable"]]);
    /* Rooms off altogether: marked so, never pushed. */
    expect((await applyCanvasOps("prod-1", { opId: "move-4", ops: [{ kind: "move", nodeId: "a", x: 9, y: 9 }], author: "ana" }, { room: null })).live).toBe("off");
    expect((await db().execute("SELECT push FROM rig_canvas_ops WHERE op_id='move-4'")).rows[0].push).toBe("none");
    /* ...and a change still waiting when rooms are switched off is marked so on the next drain. */
    expect(await drainCanvasPushes("prod-1", { room: null })).toEqual({ sent: 0, waiting: 0 });
    expect((await db().execute("SELECT push FROM rig_canvas_ops WHERE op_id='move-hung'")).rows[0].push).toBe("none");
  });
});

test("in a live room Atomik is its own kind of peer, with what it is doing; a teammate is shown as before", () => {
  const atomik = roomPeer({ connectionId: 7, info: { name: "Atomik", color: "#e0b95e", agent: true }, presence: { cursor: { x: 44, y: 38 }, selected: "b", drag: null, doing: "Tidying the board" } });
  expect(atomik).toEqual({ id: 7, name: "Atomik", color: "#e0b95e", cursor: { x: 44, y: 38 }, selected: "b", drag: null, agent: true, doing: "Tidying the board" });
  expect(roomPeer({ connectionId: 3, info: { name: "Bo", color: "#30D158" }, presence: { cursor: null, selected: null, drag: null } }))
    .toEqual({ id: 3, name: "Bo", color: "#30D158", cursor: null, selected: null, drag: null });
  /* A teammate cannot pass as Atomik by sending `doing`: only the server's user info marks an agent. */
  expect(roomPeer({ connectionId: 4, info: { name: "Cy" }, presence: { cursor: null, selected: null, drag: null, doing: "Tidying" } })).not.toHaveProperty("agent");
});

/* ── No live room: the check windows make ──────────────────────────────── */

test("with no live room, a window folds in a server change with its own unsent edits laid over it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { patchTeamCanvas, readTeamCanvas, teamCanvasRevision } = await import("../../lib/workbench/team-canvas");
  const { latestServerChange } = await import("../../lib/workbench/canvas-ops-log");
  await runInTenant(workspace("ops-poll"), async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("a", { x: 900, y: 700 }), scene("b", { x: 100, y: 1200, linked: ["a"] })], removeNodes: [], upsertAssets: [], order: ["a", "b"] }, "ana");
    const seen = await latestServerChange("prod-1");
    expect(seen).toBeNull();
    const revision = await teamCanvasRevision("prod-1");
    await applyCanvasOps("prod-1", { opId: "tidy-1", ops: [{ kind: "tidy" }], author: "bo", what: "tidy" }, { room: null });
    /* The light check: the revision moved, and the newest server change is the tidy. */
    expect(await teamCanvasRevision("prod-1")).toBe(revision + 1);
    const change = (await latestServerChange("prod-1"))!;
    expect(change).toMatchObject({ what: "tidy", agent: false });
    /* Ana's window had renamed b and not sent it yet: the fold keeps her title and takes the tidied places. */
    const saved = (await readTeamCanvas("prod-1"))!.canvas;
    const mine: TeamPatch = { upsertNodes: [scene("b", { x: 100, y: 1200, linked: ["a"], title: "Ana's title" })], fields: { b: ["title"] }, removeNodes: [], upsertAssets: [], order: null, at: 9 };
    const view = overlay({ nodes: saved.nodes, assets: saved.assets, order: ["a", "b"], removedIds: [] }, mine);
    expect(view.nodes.a).toMatchObject({ x: 60, y: 140 });
    expect(view.nodes.b).toMatchObject({ x: 60, y: 400, title: "Ana's title" });
  });
});
