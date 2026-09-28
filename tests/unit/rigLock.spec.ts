import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import {
  MASTER_COPY, cleanUnlockReason, lockEventLine, lockProblem, masterCheckLine, snapshotDrift, unlockProblem, UNLOCK_REASON_MAX,
} from "../../lib/workbench/master-lock";
import {
  MASTER_NODE_FIELDS, applyTeamPatch, catchUpForTeam, diffForTeam, emptyTeamCanvas, guardMasters, holdMasterEdits, isLockedMaster, restoreHeld,
  type TeamCanvas, type TeamPatch,
} from "../../lib/workbench/team-canvas-model";
import { CUTOUT_COPY, CUTOUT_MODEL, cutoutAsset, cutoutProblem, cutoutRequest, fileCutout, readCutoutRun } from "../../lib/workspace/cutout";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { cardVersions } from "../../lib/workspace/rig";
import { stillToolFor } from "../../lib/stillTools";

/*
 * Locked masters on the Rig (the agentic Rig, plan step 3) and the Luma
 * cut-out. A master is a reference card whose element is locked: anyone may
 * lock one, free; only an admin unlocks, with a reason, both recorded; Atomik
 * locks and never unlocks. No edit — a person's, a stale window's, a draft
 * save's, a catch-up's, Atomik's — changes a locked master's source, element,
 * kind, type or lock record, or takes it off the canvas; the rest of the same
 * edit lands. The lock records the sha256 of the master's source, so a source
 * that changed under it is told. The cut-out is priced first and files a new
 * version of the card's source, keeping the original.
 *
 * Everything local: temporary databases, files under .data/generations removed
 * afterwards, ENGINE_MOCK, and the network refused where admission runs.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-lock-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "element", x: 0, y: 0, width: 220, linked: [], ...extra });
const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "image", category: "Element", url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
const project = (nodes: CanvasNode[], assets: Asset[] = [], extra: Partial<Project> = {}): Project => ({ ...newProject("Masters"), id: "draft-masters", productionProjectId: "prod-masters", nodes, assets, ...extra });
const canvasOf = (nodes: CanvasNode[], assets: Asset[] = []): TeamCanvas =>
  applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: assets, order: nodes.map((n) => n.id), at: 1 }, "trusted");

/** The lock record the lock writes on a card. */
const record = { lockedAt: "2026-09-28T10:00:00.000Z", lockedBy: "Ana", elementId: "el_lamp", versionId: "ver_1", sha256: "a".repeat(64) };
const lamp = node("lamp", { title: "Brass lamp", assetId: "photo", refKind: "element", elementId: "el_lamp", master: record });
const locks = { locks: new Set(["el_lamp"]) };

test("who may lock and unlock: anyone locks, an admin unlocks with a reason, Atomik never unlocks", () => {
  expect(unlockProblem({ kind: "agent" }, "a good reason")).toBe(MASTER_COPY.agentUnlock);
  expect(unlockProblem({ kind: "person", admin: false }, "a good reason")).toBe(MASTER_COPY.memberUnlock);
  expect(unlockProblem({ kind: "person", admin: true }, "")).toBe(MASTER_COPY.reason);
  expect(unlockProblem({ kind: "person", admin: true }, "  ok ")).toBe(MASTER_COPY.reason);
  expect(unlockProblem({ kind: "person", admin: true }, 42)).toBe(MASTER_COPY.reason);
  expect(unlockProblem({ kind: "person", admin: true }, "Wrong product photo")).toBeNull();
  /* The reason as it is kept: one line, trimmed, bounded. */
  expect(cleanUnlockReason("  Wrong\n\nproduct   photo ")).toBe("Wrong product photo");
  expect(cleanUnlockReason("x".repeat(900))).toHaveLength(UNLOCK_REASON_MAX);
  expect(lockEventLine({ action: "lock", byName: "Ana", agent: false, reason: "" })).toBe("Locked · Ana");
  expect(lockEventLine({ action: "lock", byName: "Ana", agent: true, reason: "" })).toBe("Locked · Atomik for Ana");
  expect(lockEventLine({ action: "unlock", byName: "Bo", agent: false, reason: "Wrong photo" })).toBe("Unlocked · Bo · “Wrong photo”");

  /* A card can be locked when it is a Cast, Environment or Element reference holding a stored picture. */
  const p = project([], [asset("photo"), asset("sample", { url: "/campaign/hero.webp", uploadId: undefined })]);
  expect(lockProblem(undefined, p, false)).toBe(MASTER_COPY.gone);
  expect(lockProblem(node("shot", { type: "scene" }), p, false)).toBe(MASTER_COPY.notReference);
  expect(lockProblem(node("in", { type: "media", assetId: "photo" }), p, false)).toBe(MASTER_COPY.ref);
  expect(lockProblem(node("bare"), p, false)).toBe(MASTER_COPY.noSource);
  expect(lockProblem(node("s", { assetId: "sample" }), p, false)).toBe(MASTER_COPY.unstored);
  expect(lockProblem(node("p", { assetId: "photo" }), p, true)).toBe(MASTER_COPY.locked);
  expect(lockProblem(node("p", { assetId: "photo" }), p, false)).toBeNull();
  expect(lockProblem(node("c", { type: "character", assetId: "photo" }), p, false)).toBeNull();
  expect(lockProblem(node("m", { type: "media", assetId: "photo", refKind: "environment" }), p, false)).toBeNull();
});

test("the guard: a locked master's source, element, kind, type and lock record never change, and it is never taken off; the rest of an edit lands", () => {
  const canvas = canvasOf([lamp, node("shot", { type: "scene", linked: ["lamp"] })], [asset("photo")]);
  /* A field edit that changes the source and moves the card: the move lands, the source is held. */
  const edit: TeamPatch = { upsertNodes: [{ ...lamp, assetId: "other", x: 300, title: "Lamp" }], fields: { lamp: ["assetId", "x", "title"] }, removeNodes: [], upsertAssets: [], order: null, at: 5 };
  const guarded = guardMasters(canvas, edit, locks);
  expect(guarded.held).toEqual([{ nodeId: "lamp", elementId: "el_lamp", fields: ["assetId"] }]);
  const after = applyTeamPatch(canvas, edit, locks);
  expect(after.nodes.lamp).toMatchObject({ assetId: "photo", x: 300, title: "Lamp", refKind: "element", elementId: "el_lamp", master: record });
  /* Every guarded field, one by one, through a field edit. */
  for (const key of MASTER_NODE_FIELDS) {
    const changed = { ...lamp, [key]: key === "type" ? "media" : key === "master" ? { ...record, lockedBy: "Mallory" } : key === "refKind" ? "cast" : "changed" } as CanvasNode;
    const out = applyTeamPatch(canvas, { upsertNodes: [changed], fields: { lamp: [key] }, removeNodes: [], upsertAssets: [], order: null, at: 6 }, locks);
    expect([key, out.nodes.lamp]).toEqual([key, canvas.nodes.lamp]);
    /* Dropping the field is a change too. */
    const dropped = { ...lamp } as Record<string, unknown>;
    delete dropped[key];
    expect(applyTeamPatch(canvas, { upsertNodes: [dropped as CanvasNode], fields: { lamp: [key] }, removeNodes: [], upsertAssets: [], order: null, at: 7 }, locks).nodes.lamp).toEqual(canvas.nodes.lamp);
  }
  /* A stale window's whole write: the guarded fields keep what the canvas holds, the rest lands. */
  const stale = { ...node("lamp", { title: "Old title", x: 12 }), type: "media" as const };
  const whole = applyTeamPatch(canvas, { upsertNodes: [stale], removeNodes: [], upsertAssets: [], order: null, at: 8 }, locks);
  expect(whole.nodes.lamp).toMatchObject({ title: "Old title", x: 12, type: "element", assetId: "photo", elementId: "el_lamp", refKind: "element", master: record });
  /* A removal does not land, whatever else the edit does. */
  const removal: TeamPatch = { upsertNodes: [{ ...node("shot", { type: "scene" }), title: "Renamed" }], fields: { shot: ["title", "linked"] }, removeNodes: ["lamp"], upsertAssets: [], order: null, at: 9 };
  expect(guardMasters(canvas, removal, locks).held).toEqual([{ nodeId: "lamp", elementId: "el_lamp", fields: [], removal: true }]);
  const kept = applyTeamPatch(canvas, removal, locks);
  expect(kept.nodes.lamp).toEqual(canvas.nodes.lamp);
  expect(kept.removed.lamp).toBeUndefined();
  expect(kept.nodes.shot).toMatchObject({ title: "Renamed", linked: [] });
  /* A catch-up (what another save brought into a window) never moves a master's source either. */
  const before = project([lamp], [asset("photo")]);
  const caught = catchUpForTeam(before, { ...before, nodes: [{ ...lamp, assetId: "other", y: 40 }] }, 10)!;
  expect(applyTeamPatch(canvas, caught, locks).nodes.lamp).toMatchObject({ assetId: "photo", y: 40 });
  /* Its source asset keeps its file: a write that re-points the asset is held, its other fields land. */
  const swap: TeamPatch = { upsertNodes: [], removeNodes: [], upsertAssets: [{ ...asset("photo"), uploadId: "evil", name: "Renamed photo" }], order: null, at: 11 };
  expect(guardMasters(canvas, swap, locks).held).toEqual([{ assetId: "photo", fields: ["uploadId"] }]);
  expect(applyTeamPatch(canvas, swap, locks).assets.photo).toMatchObject({ uploadId: "photo", name: "Renamed photo" });
  /* An edit cannot make a card a master: tying another card to a locked element is held. */
  const claim: TeamPatch = { upsertNodes: [node("copy", { assetId: "other", elementId: "el_lamp" })], made: ["copy"], removeNodes: [], upsertAssets: [], order: null, at: 12 };
  expect(guardMasters(canvas, claim, locks).held).toEqual([{ nodeId: "copy", elementId: "el_lamp", fields: ["elementId"] }]);
  expect("elementId" in applyTeamPatch(canvas, claim, locks).nodes.copy).toBe(false);
  /* Nothing held: the patch goes through untouched. */
  const plain: TeamPatch = { upsertNodes: [{ ...lamp, x: 1 }], fields: { lamp: ["x"] }, removeNodes: [], upsertAssets: [], order: null, at: 13 };
  expect(guardMasters(canvas, plain, locks).patch).toBe(plain);
});

test("the elements table decides: a card's own lock record neither makes it a master nor unlocks it; with no table the guard fails closed; the lock's own write is trusted", () => {
  const unlockedTable = { locks: new Set<string>() };
  const canvas = canvasOf([lamp], [asset("photo")]);
  const edit: TeamPatch = { upsertNodes: [{ ...lamp, assetId: "other" }], fields: { lamp: ["assetId"] }, removeNodes: [], upsertAssets: [], order: null, at: 5 };
  /* The table says unlocked (an admin unlocked it): the record alone does not hold the edit. */
  expect(isLockedMaster(lamp, unlockedTable)).toBe(false);
  expect(applyTeamPatch(canvas, edit, unlockedTable).nodes.lamp.assetId).toBe("other");
  /* A card with no record whose element is locked (locked from the element page) is a master all the same. */
  const bare = { ...lamp };
  delete bare.master;
  expect(isLockedMaster(bare, locks)).toBe(true);
  expect(applyTeamPatch(canvasOf([bare], [asset("photo")]), edit, locks).nodes.lamp.assetId).toBe("photo");
  /* No table to ask (a path not wired to it): a card carrying a lock record is treated as locked. */
  expect(isLockedMaster(lamp)).toBe(true);
  expect(applyTeamPatch(canvas, edit).nodes.lamp.assetId).toBe("photo");
  /* The lock's own write lands whatever it names. */
  expect(applyTeamPatch(canvas, edit, "trusted").nodes.lamp.assetId).toBe("other");
  expect(isLockedMaster(lamp, "trusted")).toBe(false);
});

test("a window's own edit is held the same way the server holds it, and what the server held is put back", () => {
  const before = project([node("shot", { type: "scene", linked: ["lamp"] }), lamp, node("free", { assetId: "photo" })], [asset("photo")]);
  const after = { ...before, nodes: [{ ...before.nodes[0], title: "Opening" }, { ...node("free", { assetId: "photo" }), title: "Free lamp" }] };
  const mine = holdMasterEdits(before, after, locks.locks);
  expect(mine.held).toEqual([{ nodeId: "lamp", elementId: "el_lamp", fields: [], removal: true }]);
  /* The master is back where it stood; the rest of the edit stands. */
  expect(mine.project.nodes.map((n) => [n.id, n.title])).toEqual([["shot", "Opening"], ["lamp", "Brass lamp"], ["free", "Free lamp"]]);
  /* The same as the server makes of the same edit. */
  const canvas = canvasOf(before.nodes, before.assets);
  const server = applyTeamPatch(canvas, diffForTeam(before, after, 5)!, locks);
  expect(Object.keys(server.nodes).sort()).toEqual(["free", "lamp", "shot"]);
  expect(server.nodes.lamp).toEqual(lamp);
  /* A field edit held locally keeps the rest. */
  const moved = holdMasterEdits(before, { ...before, nodes: before.nodes.map((n) => (n.id === "lamp" ? { ...n, refKind: "cast" as const, x: 90 } : n)) }, locks.locks);
  expect(moved.held).toEqual([{ nodeId: "lamp", elementId: "el_lamp", fields: ["refKind"] }]);
  expect(moved.project.nodes.find((n) => n.id === "lamp")).toMatchObject({ refKind: "element", x: 90 });
  /* No masters known: nothing is checked. */
  expect(holdMasterEdits(before, after, new Set()).project).toBe(after);
  /* The route's answer folded back into a window that took the card off and changed its source. */
  const drifted = { ...before, nodes: [before.nodes[0], before.nodes[2]] };
  const restored = restoreHeld(drifted, [{ nodeId: "lamp", fields: [], removal: true }], { shot: before.nodes[0], lamp }, { photo: asset("photo") });
  expect(restored.nodes.map((n) => n.id)).toEqual(["shot", "lamp", "free"]);
  const repointed = { ...before, nodes: before.nodes.map((n) => (n.id === "lamp" ? { ...n, assetId: "other" } : n)) };
  expect(restoreHeld(repointed, [{ nodeId: "lamp", fields: ["assetId"] }], { lamp }).nodes.find((n) => n.id === "lamp")?.assetId).toBe("photo");
});

test("sha256 drift: a moved version or a changed file is told apart from one that cannot be hashed", () => {
  const locked = { a: { versionId: "v1", sha256: "1".repeat(64), kind: "turntable" }, b: { versionId: "v2", sha256: null, kind: "detail" } };
  expect(snapshotDrift(locked, { a: { versionId: "v1", sha256: "1".repeat(64) }, b: { versionId: "v2", sha256: null } })).toEqual([{ attributeId: "b", kind: "detail", change: "unhashed" }]);
  expect(snapshotDrift(locked, { a: { versionId: "v9", sha256: "1".repeat(64) }, b: { versionId: "v2", sha256: null } }).map((d) => d.change)).toEqual(["moved", "unhashed"]);
  expect(snapshotDrift(locked, { a: { versionId: "v1", sha256: "2".repeat(64) }, b: { versionId: "v2", sha256: null } }).map((d) => d.change)).toEqual(["changed", "unhashed"]);
  expect(snapshotDrift({}, { c: { versionId: "v3", sha256: null, kind: "plate" } })).toEqual([{ attributeId: "c", kind: "plate", change: "moved" }]);
  expect(masterCheckLine({ state: "changed", changes: [{ attributeId: "a", kind: "turntable", change: "changed" }] })).toBe("Its source changed since it was locked: turntable has a different file.");
  expect(masterCheckLine({ state: "matches", changes: [] })).toMatch(/same version, the same file/);
  expect(masterCheckLine(null)).toBeNull();
});

test("the cut-out: only an unlocked Element card holding a stored still; one priced request with no words; a new version that keeps the original", () => {
  const photo = asset("photo", { name: "Brass lamp photo", version: 2 });
  const p = project([
    node("lamp", { assetId: "photo", refKind: "element" }),
    node("place", { assetId: "photo", refKind: "environment" }),
    node("clip", { assetId: "clip" }),
    node("sample", { assetId: "sample" }),
    node("bare"),
  ], [photo, asset("clip", { kind: "video" }), asset("sample", { url: "/campaign/hero.webp", uploadId: undefined })]);
  const at = (id: string) => p.nodes.find((n) => n.id === id)!;
  expect(cutoutProblem(p, at("lamp"), false)).toBeNull();
  expect(cutoutProblem(p, at("lamp"), true)).toBe(CUTOUT_COPY.master);
  expect(cutoutProblem(p, at("place"), false)).toBe(CUTOUT_COPY.kind);
  expect(cutoutProblem(p, at("clip"), false)).toBe(CUTOUT_COPY.notStill);
  expect(cutoutProblem(p, at("sample"), false)).toBe(CUTOUT_COPY.unstored);
  expect(cutoutProblem(p, at("bare"), false)).toBe(CUTOUT_COPY.noSource);
  expect(cutoutProblem(p, node("shot", { type: "scene" }), false)).toBe(CUTOUT_COPY.notReference);

  /* Particl's own still background removal: one still in, no words, filed under the production and no shot. */
  expect(stillToolFor(CUTOUT_MODEL)).toBe("cutout");
  const input = cutoutRequest(p, at("lamp"))!;
  const body = generationRequestBody(input);
  expect(body).toMatchObject({ model: CUTOUT_MODEL, prompt: "", projectId: "prod-masters", shotId: "", ratio: "adaptive", resolution: "adaptive", refine: false, references: [{ uploadId: "photo", role: "reference_image" }] });
  expect("maxCredits" in body).toBe(false);
  /* Approved, the same body carries the quote as its ceiling. */
  expect(generationRequestBody({ ...input, maxCredits: 1, quoteFingerprint: "f".repeat(64) })).toMatchObject({ maxCredits: 1, quoteFingerprint: "f".repeat(64) });
  expect(cutoutRequest({ ...p, productionProjectId: undefined }, at("lamp"))).toBeNull();
  expect(cutoutRequest(p, at("sample"))).toBeNull();

  /* Filed: the next version of the source, a transparent PNG made from it; the card shows it; the original is kept on the card. */
  const filed = fileCutout(p, "lamp", "photo", "gen_cut1", "2026-09-28T12:00:00.000Z") as Project;
  expect(typeof filed).toBe("object");
  const cut = filed.assets.find((a) => a.id === "gen_cut1")!;
  expect(cut).toEqual(cutoutAsset(photo, "gen_cut1"));
  expect(cut).toMatchObject({ generationId: "gen_cut1", url: "/api/media/gen_cut1", kind: "image", mime: "image/png", version: 3, parentId: "photo", refs: ["photo"], name: "Brass lamp photo · cut out" });
  const card = filed.nodes.find((n) => n.id === "lamp")!;
  expect(card.assetId).toBe("gen_cut1");
  expect(card.versions).toEqual([{ id: "original-photo", label: "Original · Brass lamp photo", assetId: "photo", operations: [], savedAt: "2026-09-28T12:00:00.000Z" }]);
  expect(filed.assets.find((a) => a.id === "photo")).toEqual(photo);
  /* The card's versions: the cut-out current, the original once, below it. */
  expect(cardVersions(filed, card).map((row) => [row.v, row.label, row.current])).toEqual([["v3", "Current · Brass lamp photo · cut out", true], ["v2", "Brass lamp photo", false]]);
  /* Filing it again changes nothing; a card that shows another source now is not re-pointed. */
  expect(fileCutout(filed, "lamp", "photo", "gen_cut1", "later")).toBe(filed);
  expect(fileCutout(filed, "lamp", "photo", "gen_cut2", "later")).toBe(CUTOUT_COPY.moved);
  expect(fileCutout(p, "gone", "photo", "gen_cut1", "later")).toBe(CUTOUT_COPY.gone);
  /* To the team canvas it is an edit of the card's source: it lands on an unlocked card, and never on a locked master. */
  const patch = diffForTeam(p, filed, 20)!;
  expect(patch.fields).toEqual({ lamp: ["assetId", "versions"] });
  expect(patch.upsertAssets.map((a) => a.id)).toEqual(["gen_cut1"]);
  const canvas = canvasOf(p.nodes, p.assets);
  expect(applyTeamPatch(canvas, patch, { locks: new Set() }).nodes.lamp.assetId).toBe("gen_cut1");
  const masterCanvas = canvasOf(p.nodes.map((n) => (n.id === "lamp" ? { ...n, elementId: "el_lamp" } : n)), p.assets);
  expect(applyTeamPatch(masterCanvas, patch, locks).nodes.lamp.assetId).toBe("photo");
  /* A remembered run reads back only when it is whole. */
  expect(readCutoutRun(JSON.stringify({ jobId: "gen_cut1", sourceAssetId: "photo", credits: 1 }))).toEqual({ jobId: "gen_cut1", sourceAssetId: "photo", credits: 1 });
  expect(readCutoutRun("{\"jobId\":\"../x\",\"sourceAssetId\":\"photo\",\"credits\":1}")).toBeNull();
  expect(readCutoutRun("not json")).toBeNull();
});

/* ── Against a real tenant database ─────────────────────────────────────── */

const stored: string[] = [];
test.afterAll(async () => {
  await Promise.all(stored.map((id) => unlink(path.join(process.cwd(), ".data", "generations", `${id}.png`)).catch(() => {})));
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function tenant(name: string, fn: () => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const ws = { id: name, name, slug: name, dbUrl: `file:${path.join(dir, `${name}.db`)}`, legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-masters','Masters',0)", args: [] });
    await fn();
  });
}

/** A stored upload (its content hash recorded, as the upload route records it) and a stored render. */
async function sources() {
  const { db, now } = await import("../../lib/db");
  const { storeImageBytes } = await import("../../lib/storage");
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('up_photo','lamp.png','image/png','png',?,?,'uploads/up_photo.png',?)", args: [PNG.length, sha(PNG), now()] });
  const genId = `gen_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  stored.push(genId);
  const saved = await storeImageBytes(genId, PNG);
  await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_by,created_at,updated_at,stored_url) VALUES(?,'image','m','', '{}','succeeded','ana',?,?,?)", args: [genId, now(), now(), saved.url] });
  return { uploadId: "up_photo", genId };
}

const ana = { userId: "ana", name: "Ana", email: "ana@example.test", admin: false };
const admin = { userId: "root", name: "Rosa", email: "rosa@example.test", admin: true };

test("locking a card mirrors it into an element, freezes its source with its sha256, logs it and writes the lock record for everyone; every patch path then holds edits to it", async () => {
  await tenant("lock-card", async () => {
    const { db } = await import("../../lib/db");
    const store = await import("../../lib/workbench/team-canvas");
    const { lockMaster, lockHistory, masterCheck, sourceSha256, MasterLockError } = await import("../../lib/masters");
    const { getElement } = await import("../../lib/elements");
    const { saveDraft } = await import("../../lib/workbench/records");
    const { uploadId } = await sources();
    const photo = asset("photo", { uploadId, url: `/api/uploads/${uploadId}`, name: "Brass lamp photo" });
    const card = node("lamp", { title: "Brass lamp", assetId: "photo" });
    const draft = project([card, node("shot", { type: "scene", linked: ["lamp"] }), node("in", { type: "media", assetId: "photo" })], [photo]);
    /* The owner's draft, saved: the production's canvas holds its cards. */
    await saveDraft("ana", draft, 0);
    await store.patchTeamCanvas("prod-masters", { upsertNodes: draft.nodes, made: draft.nodes.map((n) => n.id), removeNodes: [], upsertAssets: [photo], order: draft.nodes.map((n) => n.id) }, "ana");

    /* A Ref is an input, never a master; the card that is not there cannot be locked. */
    await expect(lockMaster({ canvas: { productionId: "prod-masters", nodeId: "in" } }, ana)).rejects.toThrow(MASTER_COPY.ref);
    await expect(lockMaster({ canvas: { productionId: "prod-masters", nodeId: "nope" } }, ana)).rejects.toBeInstanceOf(MasterLockError);

    /* A member locks it, free. */
    const locked = await lockMaster({ canvas: { productionId: "prod-masters", nodeId: "lamp" } }, ana);
    expect(locked.unchanged).toBe(false);
    expect(locked.sha256).toBe(sha(PNG));
    expect(await sourceSha256({ uploadId })).toBe(sha(PNG));
    const element = (await getElement(locked.element.id))!;
    expect(element).toMatchObject({ kind: "prop", name: "Brass lamp", projectId: "prod-masters", locked: true, lockedBy: "ana@example.test" });
    const turntable = element.attributes.find((a) => a.kind === "turntable")!;
    const version = turntable.versions.find((v) => v.id === turntable.currentId)!;
    expect(version).toMatchObject({ uploadId, status: "ready" });
    expect((await db().execute({ sql: "SELECT sha256 FROM attribute_versions WHERE id=?", args: [version.id] })).rows[0].sha256).toBe(sha(PNG));
    expect(locked.node).toMatchObject({ elementId: element.id, refKind: "element", assetId: "photo", master: { lockedBy: "Ana", elementId: element.id, versionId: version.id, sha256: sha(PNG) } });
    const history = await lockHistory(element.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "lock", byName: "Ana", agent: false, reason: "", sha256: sha(PNG) });
    const row = (await db().execute({ sql: "SELECT * FROM element_lock_events WHERE element_id=?", args: [element.id] })).rows[0];
    expect(row).toMatchObject({ by_user: "ana", production_id: "prod-masters", node_id: "lamp", agent: null });
    expect(JSON.parse(String(row.snapshot))).toEqual({ [turntable.id]: { versionId: version.id, sha256: sha(PNG), kind: "turntable" } });
    expect(await masterCheck(element.id)).toEqual({ state: "matches", changes: [] });
    /* Locking it again changes nothing and logs nothing. */
    expect((await lockMaster({ canvas: { productionId: "prod-masters", nodeId: "lamp" } }, ana)).unchanged).toBe(true);
    expect(await lockHistory(element.id)).toHaveLength(1);
    /* The canvas read names it a master: the elements table's answer. */
    const read = (await store.readTeamCanvas("prod-masters"))!;
    expect([...(await store.masterLocks(db(), read.canvas))]).toEqual([element.id]);

    /* 1. The team-canvas route's patch: the source change is held (and said), the move lands. */
    const patched = await store.patchTeamCanvas("prod-masters", store.teamPatchSchema.parse({ productionId: "prod-masters", upsertNodes: [{ ...card, assetId: "other", x: 250 }], fields: { lamp: ["assetId", "x"] }, removeNodes: [], upsertAssets: [], order: null }), "bo");
    expect(patched.masterHolds).toEqual([{ nodeId: "lamp", elementId: element.id, fields: ["assetId"] }]);
    expect(patched.canvas.nodes.lamp).toMatchObject({ assetId: "photo", x: 250, elementId: element.id });
    /* 2. A removal through the route. */
    const removal = await store.patchTeamCanvas("prod-masters", { upsertNodes: [], removeNodes: ["lamp"], upsertAssets: [], order: null }, "bo");
    expect(removal.masterHolds).toEqual([{ nodeId: "lamp", elementId: element.id, fields: [], removal: true }]);
    expect(removal.canvas.nodes.lamp).toBeDefined();
    /* 3. A stale window's whole write that has never heard of the lock. */
    const stale = await store.patchTeamCanvas("prod-masters", { upsertNodes: [{ ...card, type: "media", title: "Lamp v2" }], removeNodes: [], upsertAssets: [], order: null }, "bo");
    expect(stale.canvas.nodes.lamp).toMatchObject({ type: "element", title: "Lamp v2", assetId: "photo", refKind: "element", elementId: element.id });
    expect(stale.canvas.nodes.lamp.master).toMatchObject({ elementId: element.id });
    /* 4. A catch-up (a merge another save brought in). */
    const seen = stale.canvas.nodes.lamp;
    const catchUp = catchUpForTeam(project([seen], [photo]), project([{ ...seen, refKind: "cast", y: 70 }], [photo]), 0)!;
    const caught = await store.patchTeamCanvas("prod-masters", catchUp, "bo");
    expect(caught.canvas.nodes.lamp).toMatchObject({ refKind: "element", y: 70 });
    /* 5. The draft save, which carries its node edits to the canvas: the draft keeps what its owner saved, the canvas keeps the master. */
    const { readDraft } = await import("../../lib/workbench/records");
    const mine = (await readDraft("ana", draft.id))!;
    await saveDraft("ana", { ...mine.project, nodes: mine.project.nodes.filter((n) => n.id !== "lamp").map((n) => (n.id === "shot" ? { ...n, title: "Opening" } : n)) }, mine.revision);
    const afterSave = (await store.readTeamCanvas("prod-masters"))!.canvas;
    expect(afterSave.nodes.lamp).toMatchObject({ assetId: "photo", elementId: element.id });
    expect(afterSave.nodes.shot.title).toBe("Opening");
    /* 6. Its source asset keeps its file. */
    const swap = await store.patchTeamCanvas("prod-masters", { upsertNodes: [], removeNodes: [], upsertAssets: [{ ...photo, uploadId: "someone-else", name: "Renamed" }], order: null }, "bo");
    expect(swap.masterHolds).toEqual([{ assetId: "photo", fields: ["uploadId"] }]);
    expect(swap.canvas.assets.photo).toMatchObject({ uploadId, name: "Renamed" });
  });
});

test("unlocking: never Atomik, never a member, never a token; an admin with a reason, recorded, and the card's record comes off; Atomik's lock says Atomik", async () => {
  await tenant("unlock", async () => {
    const store = await import("../../lib/workbench/team-canvas");
    const { lockMaster, unlockMaster, lockHistory, MasterLockError } = await import("../../lib/masters");
    const { uploadId } = await sources();
    const photo = asset("photo", { uploadId, url: `/api/uploads/${uploadId}` });
    const card = node("lamp", { title: "Brass lamp", assetId: "photo", refKind: "element" });
    await store.patchTeamCanvas("prod-masters", { upsertNodes: [card], made: ["lamp"], removeNodes: [], upsertAssets: [photo], order: ["lamp"] }, "ana");
    /* Atomik locks (its plan says so), recorded as Atomik for the person it acts for. */
    const locked = await lockMaster({ canvas: { productionId: "prod-masters", nodeId: "lamp" } }, { ...ana, agent: { runId: "run_1" } });
    const elementId = locked.element.id;
    expect(locked.node?.master).toMatchObject({ lockedBy: "Atomik for Ana", agent: "atomik" });
    expect((await lockHistory(elementId))[0]).toMatchObject({ action: "lock", agent: true, byName: "Ana" });

    const refused = async (by: Parameters<typeof unlockMaster>[1], reason: string) => {
      const error = await unlockMaster({ elementId, reason, canvas: { productionId: "prod-masters", nodeId: "lamp" } }, by).then(() => null, (e) => e);
      expect(error).toBeInstanceOf(MasterLockError);
      return [error.status, error.message];
    };
    expect(await refused({ ...admin, agent: { runId: "run_1" } }, "Atomik wants it")).toEqual([403, MASTER_COPY.agentUnlock]);
    expect(await refused(ana, "I am a member")).toEqual([403, MASTER_COPY.memberUnlock]);
    expect(await refused({ ...admin, token: true }, "A script")).toEqual([403, MASTER_COPY.tokenUnlock]);
    expect(await refused(admin, " ")).toEqual([400, MASTER_COPY.reason]);
    /* Still locked, still one history row. */
    expect((await lockHistory(elementId)).length).toBe(1);

    const unlocked = await unlockMaster({ elementId, reason: "Wrong  product photo", canvas: { productionId: "prod-masters", nodeId: "lamp" } }, admin);
    expect(unlocked.element.locked).toBe(false);
    expect(unlocked.node).toMatchObject({ elementId, refKind: "element", assetId: "photo" });
    expect(unlocked.node && "master" in unlocked.node).toBe(false);
    const history = await lockHistory(elementId);
    expect(history.map((e) => [e.action, e.byName, e.agent, e.reason])).toEqual([["unlock", "Rosa", false, "Wrong product photo"], ["lock", "Ana", true, ""]]);
    /* Unlocked, it takes edits again. */
    const moved = await store.patchTeamCanvas("prod-masters", { upsertNodes: [{ ...card, assetId: "photo2" }], fields: { lamp: ["assetId"] }, removeNodes: [], upsertAssets: [], order: null }, "bo");
    expect(moved.masterHolds).toEqual([]);
    expect(moved.canvas.nodes.lamp.assetId).toBe("photo2");
    /* Unlocking what is not locked changes nothing. */
    expect((await unlockMaster({ elementId, reason: "again", canvas: null }, admin)).unchanged).toBe(true);
  });
});

test("the sha256 check tells a master whose render was replaced, or whose version was moved under the lock; locking an element from its page writes its cards' record", async () => {
  await tenant("drift", async () => {
    const { db } = await import("../../lib/db");
    const store = await import("../../lib/workbench/team-canvas");
    const { lockMaster, masterCheck, sourceSha256 } = await import("../../lib/masters");
    const { storeImageBytes } = await import("../../lib/storage");
    const { genId } = await sources();
    const render = asset("render", { uploadId: undefined, generationId: genId, url: `/api/media/${genId}` });
    await store.patchTeamCanvas("prod-masters", { upsertNodes: [node("mira", { type: "character", assetId: "render" })], made: ["mira"], removeNodes: [], upsertAssets: [render], order: ["mira"] }, "ana");
    const locked = await lockMaster({ canvas: { productionId: "prod-masters", nodeId: "mira" } }, ana);
    expect(locked.element.kind).toBe("character");
    expect(locked.sha256).toBe(sha(PNG));
    expect(await masterCheck(locked.element.id)).toEqual({ state: "matches", changes: [] });
    /* The render's stored file is replaced under the lock: told, by its hash. */
    await storeImageBytes(genId, Buffer.concat([PNG, Buffer.from([0])]));
    expect(await sourceSha256({ genId })).toBe(sha(Buffer.concat([PNG, Buffer.from([0])])));
    const changed = await masterCheck(locked.element.id);
    expect(changed.state).toBe("changed");
    expect(changed.changes).toEqual([expect.objectContaining({ kind: "face", change: "changed" })]);
    /* The version moved under the lock (a write that went round the lock): told too. */
    await storeImageBytes(genId, PNG);
    const face = locked.element.attributes.find((a) => a.kind === "face")!;
    await db().execute({ sql: "UPDATE element_attributes SET current_id=NULL WHERE id=?", args: [face.id] });
    expect((await masterCheck(locked.element.id)).changes).toEqual([expect.objectContaining({ kind: "face", change: "moved" })]);

    /* An element locked from its own page (no card named): logged, and the production's cards that stand for it say so. */
    const { createElement } = await import("../../lib/elements");
    const other = await createElement({ name: "Dunes", kind: "location", projectId: "prod-masters" }, "ana");
    await store.patchTeamCanvas("prod-masters", { upsertNodes: [node("dunes", { assetId: "render", elementId: other.id })], made: ["dunes"], removeNodes: [], upsertAssets: [], order: null }, "ana");
    const fromPage = await lockMaster({ elementId: other.id }, ana);
    expect(fromPage.event).toMatchObject({ action: "lock", byName: "Ana" });
    expect((await store.readTeamCanvas("prod-masters"))!.canvas.nodes.dunes.master).toMatchObject({ elementId: other.id, lockedBy: "Ana" });
    expect(await masterCheck(other.id)).toEqual({ state: "matches", changes: [] });
  });
});

test("a lock never moves a version that shots elsewhere follow: that swap is priced on the element's page", async () => {
  await tenant("following", async () => {
    const { db, now } = await import("../../lib/db");
    const store = await import("../../lib/workbench/team-canvas");
    const { lockMaster } = await import("../../lib/masters");
    const { createElement, addVersion, getElement } = await import("../../lib/elements");
    const { uploadId, genId } = await sources();
    const el = await createElement({ name: "Lamp", kind: "prop", projectId: "prod-masters" }, "ana");
    const turntable = el.attributes.find((a) => a.kind === "turntable")!;
    await addVersion(turntable.id, { genId }, { makeCurrent: true }, "ana");
    await db().execute({ sql: "INSERT INTO shots(id,project_id,scene,code,title,status,position,created_by,created_at,updated_at) VALUES('s1','prod-masters','1','S1','One','open',0,'ana',?,?)", args: [now(), now()] });
    await db().execute({ sql: "INSERT INTO bindings(id,shot_id,project_id,slot,ordinal,element_id,attribute_id,version_id,created_by,created_at,updated_at) VALUES('b1','s1','prod-masters','element',0,?,NULL,NULL,'ana',?,?)", args: [el.id, now(), now()] });
    const photo = asset("photo", { uploadId, url: `/api/uploads/${uploadId}` });
    await store.patchTeamCanvas("prod-masters", { upsertNodes: [node("lamp", { assetId: "photo", elementId: el.id })], made: ["lamp"], removeNodes: [], upsertAssets: [photo], order: ["lamp"] }, "ana");
    await expect(lockMaster({ elementId: el.id, canvas: { productionId: "prod-masters", nodeId: "lamp" } }, ana)).rejects.toThrow(/used by a shot that follows its current version/);
    expect((await getElement(el.id))!.locked).toBe(false);
    /* The card naming another element than the one asked for is refused. */
    await expect(lockMaster({ elementId: "el_other", canvas: { productionId: "prod-masters", nodeId: "lamp" } }, ana)).rejects.toThrow(/another element/);
  });
});

test("the cut-out is priced by the server exactly as it is sent: about 1 cr for one still, refused without one", async () => {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db, now } = await import("../../lib/db");
  await platformReady();
  const name = `cutout-${randomUUID().slice(0, 8)}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  await grantCredits(name, 1000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  const actor = { user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin" as const, owner: true, disabled: false, createdAt: 0, lastSeen: null } };
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the cut-out quote test"); };
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-masters','Masters',0)", args: [] });
      await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('up_photo','lamp.png','image/png','png',?,?,'uploads/up_photo.png',?)", args: [PNG.length, sha(PNG), now()] });
      const { prepareGeneration } = await import("../../lib/generationAdmission");
      const p = project([node("lamp", { assetId: "photo", refKind: "element" })], [asset("photo", { uploadId: "up_photo" })]);
      const body = generationRequestBody(cutoutRequest(p, p.nodes[0])!);
      const prepared = await prepareGeneration(body, actor);
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      const quote = prepared.ok ? prepared.value.quote : null;
      expect(quote).toMatchObject({ estimatedCredits: 1, unit: "cr" });
      expect(quote?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      /* No still, no price, nothing to send. */
      const none = await prepareGeneration({ ...body, references: [] }, actor);
      expect(none.ok).toBe(false);
    }, actor);
  } finally {
    globalThis.fetch = fetch;
  }
});
