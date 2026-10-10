import { maskStoredActor } from "./platformOwnerPrivacy";
import { createHash } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { db, ready, now, id } from "./db";
import { getElement, insertElement, insertVersion, readElement, setElementLock, type AttributeRow, type ElementFull } from "./elements";
import { primaryAttribute } from "./rig";
import { readOriginalBytesLimited, readUploadBytes, type OriginalKind } from "./storage";
import { isDemoMediaUrl } from "./demoProduction";
import { workbenchTransaction } from "./workbench/records";
import { applyTeamCanvasPatch, readTeamCanvas, requireProduction, teamCanvasReady } from "./workbench/team-canvas";
import { emptyTeamCanvas, parseTeamCanvas, type TeamCanvas } from "./workbench/team-canvas-model";
import { refKindOf } from "./workbench/ref-kind";
import {
  MASTER_COPY, MASTER_ELEMENT_KIND, cleanUnlockReason, isMasterKind, lockProblem, masterRecord, masterSource, snapshotDrift, unlockProblem,
  type LockEvent, type MasterCheck, type MasterSnapshot,
} from "./workbench/master-lock";

export type { MasterCheck };
import type { CanvasNode } from "./workbench/studio";

/*
 * Locking a master (the agentic Rig, plan step 3), on the server.
 *
 * A master is a locked element (lib/elements.ts). Locking one from a Rig card
 * mirrors the card into an element when it has none (a character, a location
 * or a prop, by the card's kind), makes the card's source the element's
 * current version, records the sha256 of that source, locks the element, logs
 * the lock (element_lock_events) and writes the lock record on the card in the
 * team canvas, all in one write transaction. It is free: nothing is priced,
 * reserved or charged, and no provider is called.
 *
 * Unlocking needs a signed-in admin and a reason, and is logged the same way.
 * Atomik may lock; it never unlocks. The team canvas's guard
 * (team-canvas-model guardMasters) keeps every edit, from anyone, off a locked
 * master's source, element, kind, type and lock record, and off its removal.
 */

export class MasterLockError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Who is locking or unlocking, as it is recorded. For Atomik, `userId`/`name` are the person it acts for. */
export type LockBy = {
  userId: string;
  name: string;
  email?: string;
  admin: boolean;
  /** An API token rather than a signed-in person: it may lock, never unlock. */
  token?: boolean;
  /** Set when Atomik does it (and the run, when there is one). */
  agent?: { runId?: string | null } | null;
};

export type LockResult = {
  element: ElementFull;
  /** The history row written; null when nothing changed. */
  event: LockEvent | null;
  unchanged: boolean;
  /** The card as the team canvas holds it now, when the lock came from one. */
  node: CanvasNode | null;
  revision: number | null;
  /** The sha256 of the card's (or the primary attribute's) source the lock froze. */
  sha256: string | null;
};

const HASH = /^[a-f0-9]{64}$/;
const SOURCE_LIMIT = 100 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The sha256 of a stored source: an upload's recorded content hash (its bytes
 * hashed when there is none), or a render's stored bytes. Null when there is no
 * stored file of this workspace to hash (a demo take, a missing file).
 */
export async function sourceSha256(ref: { uploadId?: string | null; genId?: string | null }): Promise<string | null> {
  await ready();
  if (ref.uploadId) {
    const row = (await db().execute({ sql: "SELECT id, ext, stored_url, bytes, sha256 FROM uploads WHERE id=?", args: [ref.uploadId] })).rows[0];
    if (!row) return null;
    if (HASH.test(String(row.sha256 ?? ""))) return String(row.sha256);
    if (!(Number(row.bytes) > 0 && Number(row.bytes) <= SOURCE_LIMIT)) return null;
    try { return sha(await readUploadBytes(String(row.id), String(row.ext ?? ""), String(row.stored_url ?? ""))); } catch { return null; }
  }
  if (ref.genId) {
    const row = (await db().execute({ sql: "SELECT id, kind, status, deleted, stored_url FROM generations WHERE id=?", args: [ref.genId] })).rows[0];
    if (!row || String(row.status) !== "succeeded" || Number(row.deleted ?? 0) === 1) return null;
    const kind = String(row.kind);
    if (!["image", "video", "audio", "model"].includes(kind) || isDemoMediaUrl(String(row.stored_url ?? ""))) return null;
    try {
      const bytes = await readOriginalBytesLimited(kind as OriginalKind, String(row.id), SOURCE_LIMIT);
      return bytes ? sha(bytes) : null;
    } catch { return null; }
  }
  return null;
}

/** Each attribute's current version and the sha256 of its source now (read outside any transaction: it may read files). */
async function currentSnapshot(element: ElementFull, known: Map<string, string | null> = new Map()): Promise<MasterSnapshot> {
  const out: MasterSnapshot = {};
  for (const attr of element.attributes) {
    const version = attr.currentId ? attr.versions.find((v) => v.id === attr.currentId) : undefined;
    if (!version) continue;
    const key = version.uploadId ? `u:${version.uploadId}` : version.genId ? `g:${version.genId}` : "";
    if (key && !known.has(key)) known.set(key, await sourceSha256({ uploadId: version.uploadId, genId: version.genId }));
    out[attr.id] = { versionId: version.id, sha256: key ? known.get(key) ?? null : null, kind: attr.kind };
  }
  return out;
}

function eventFrom(row: Record<string, unknown>): LockEvent {
  let snapshot: MasterSnapshot = {};
  try { snapshot = JSON.parse(String(row.snapshot ?? "{}")) as MasterSnapshot; } catch { snapshot = {}; }
  const hashed = Object.values(snapshot).find((s) => s && typeof s.sha256 === "string");
  return {
    id: String(row.id),
    action: String(row.action) === "unlock" ? "unlock" : "lock",
    byName: String(maskStoredActor(String(row.by_name ?? ""))),
    agent: row.agent != null && String(row.agent) !== "",
    reason: String(row.reason ?? ""),
    at: Number(row.at),
    sha256: hashed?.sha256 ?? null,
  };
}

async function logEvent(tx: Transaction, input: {
  elementId: string; action: "lock" | "unlock"; by: LockBy; reason?: string; snapshot: MasterSnapshot; productionId?: string | null; nodeId?: string | null; at: number;
}): Promise<LockEvent> {
  const row = {
    id: id("lockev"), element_id: input.elementId, action: input.action, by_user: input.by.userId, by_name: input.by.name.slice(0, 200),
    agent: input.by.agent ? "atomik" : null, agent_run: input.by.agent?.runId ?? null, reason: input.reason ?? "",
    snapshot: JSON.stringify(input.snapshot), production_id: input.productionId ?? null, node_id: input.nodeId ?? null, at: input.at,
  };
  await tx.execute({
    sql: `INSERT INTO element_lock_events (id, element_id, action, by_user, by_name, agent, agent_run, reason, snapshot, production_id, node_id, at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [row.id, row.element_id, row.action, row.by_user, row.by_name, row.agent, row.agent_run, row.reason, row.snapshot, row.production_id, row.node_id, row.at],
  });
  return eventFrom(row);
}

/** Records each snapshot hash on its version the first time a lock freezes it (never rewritten after). */
async function recordHashes(tx: Transaction, snapshot: MasterSnapshot) {
  for (const entry of Object.values(snapshot))
    if (entry.sha256) await tx.execute({ sql: "UPDATE attribute_versions SET sha256=? WHERE id=? AND sha256 IS NULL", args: [entry.sha256, entry.versionId] });
}

async function canvasIn(tx: Transaction, productionId: string): Promise<TeamCanvas | null> {
  const row = (await tx.execute({ sql: "SELECT body FROM workbench_team_canvas WHERE production_id=?", args: [productionId] })).rows[0];
  if (!row) return null;
  try { return parseTeamCanvas(JSON.parse(String(row.body))); } catch { return emptyTeamCanvas(); }
}

/**
 * Writes (or clears) the lock record on every card of this production's
 * canvas that stands for the element, as the lock's own trusted write. A card
 * locked from elsewhere (the element page, Atomik's plan) says so on the Rig
 * too; an unlock takes the record off, and the card keeps its element and kind.
 */
async function markCards(tx: Transaction, productionId: string, elementId: string, record: ReturnType<typeof masterRecord> | null, author: string, only?: string) {
  const canvas = await canvasIn(tx, productionId);
  if (!canvas) return null;
  const cards = Object.values(canvas.nodes).filter((n) => n.elementId === elementId && (only === undefined || n.id === only) && (record ? !n.master || n.master.elementId !== elementId : !!n.master));
  if (!cards.length) return null;
  const upsertNodes = cards.map((n) => {
    if (record) return { ...n, master: record };
    const rest = { ...n };
    delete rest.master;
    return rest;
  });
  return applyTeamCanvasPatch(tx, productionId, {
    upsertNodes, fields: Object.fromEntries(cards.map((n) => [n.id, ["master"]])), made: [], removeNodes: [], upsertAssets: [], order: null,
  }, author, true, { trusted: true });
}

const authorOf = (by: LockBy) => (by.agent ? `agent:${by.agent.runId ?? "atomik"}` : by.userId);
const lockedByOf = (by: LockBy) => (by.agent ? "atomik" : by.email || by.userId);
const shownName = (by: LockBy) => (by.agent ? (by.name ? `Atomik for ${by.name}` : "Atomik") : by.name);

/** Shots elsewhere that follow this element's current version (a legacy binding): moving it would re-render them. */
async function followingShots(tx: Transaction, elementId: string): Promise<number> {
  const row = (await tx.execute({
    sql: `SELECT COUNT(DISTINCT b.shot_id) AS n FROM bindings b JOIN shots s ON s.id = b.shot_id WHERE b.element_id = ? AND b.version_id IS NULL`,
    args: [elementId],
  })).rows[0];
  return Number(row?.n ?? 0);
}

/**
 * Lock a master. From a Rig card (`canvas`): the card is mirrored into an
 * element when it stands for none (`elementId` then names none), its source
 * becomes the element's current version, and the lock record lands on the
 * card. Without a card: the element named is locked as it is. Free.
 */
export async function lockMaster(input: { elementId?: string | null; canvas?: { productionId: string; nodeId: string } | null }, by: LockBy): Promise<LockResult> {
  await ready();
  if (!input.canvas) {
    if (!input.elementId) throw new MasterLockError("Name the element to lock.", 400);
    const element = await getElement(input.elementId);
    if (!element) throw new MasterLockError("No such element.", 404);
    if (element.locked) return { element, event: null, unchanged: true, node: null, revision: null, sha256: null };
    const snapshot = await currentSnapshot(element);
    const at = now();
    const record = masterRecord({ at, by: shownName(by), elementId: element.id, versionId: primaryVersion(element)?.id ?? null, sha256: primaryHash(element, snapshot), agent: !!by.agent });
    await teamCanvasReady();
    return workbenchTransaction(async (tx) => {
      const fresh = await readElement(tx, element.id);
      if (!fresh) throw new MasterLockError("No such element.", 404);
      if (fresh.locked) return { element: fresh, event: null, unchanged: true, node: null, revision: null, sha256: null };
      await recordHashes(tx, snapshot);
      await setElementLock(fresh.id, true, lockedByOf(by), tx);
      const event = await logEvent(tx, { elementId: fresh.id, action: "lock", by, snapshot, at });
      if (fresh.projectId) await markCards(tx, fresh.projectId, fresh.id, record, authorOf(by));
      return { element: (await readElement(tx, fresh.id))!, event, unchanged: false, node: null, revision: null, sha256: record.sha256 };
    });
  }

  const { productionId, nodeId } = input.canvas;
  await requireProduction(productionId);
  await teamCanvasReady();
  const saved = await readTeamCanvas(productionId);
  const node = saved?.canvas.nodes[nodeId];
  if (!saved || !node) throw new MasterLockError(MASTER_COPY.gone, 404);
  if (input.elementId && input.elementId !== node.elementId) throw new MasterLockError("That card stands for another element. Reload the page and try again.", 409);
  const project = { assets: Object.values(saved.canvas.assets) };
  const existing = node.elementId ? await getElement(node.elementId) : null;
  if (existing?.locked) {
    /* Locked already (from the element page, or another window): the card says so, and nothing else changes. */
    const last = (await db().execute({ sql: "SELECT by_name, agent, at FROM element_lock_events WHERE element_id=? AND action='lock' ORDER BY at DESC, rowid DESC LIMIT 1", args: [existing.id] })).rows[0];
    const lockedBy = last ? (last.agent ? (last.by_name ? `Atomik for ${maskStoredActor(String(last.by_name))}` : "Atomik") : String(maskStoredActor(String(last.by_name ?? "")))) : "";
    const record = masterRecord({ at: Number(last?.at ?? existing.lockedAt ?? now()), by: lockedBy, elementId: existing.id, versionId: primaryVersion(existing)?.id ?? null, sha256: null });
    const result = await workbenchTransaction((tx) => markCards(tx, productionId, existing.id, record, authorOf(by), nodeId));
    return { element: existing, event: null, unchanged: true, node: result?.canvas.nodes[nodeId] ?? node, revision: result?.revision ?? saved.revision, sha256: null };
  }
  const problem = lockProblem(node, project, false);
  if (problem) throw new MasterLockError(problem, problem === MASTER_COPY.gone ? 404 : 409);
  const kind = refKindOf(node, project);
  if (!isMasterKind(kind)) throw new MasterLockError(MASTER_COPY.ref, 409);
  const source = masterSource(node, project)!;
  const known = new Map<string, string | null>();
  const sourceKey = "uploadId" in source.ref ? `u:${source.ref.uploadId}` : `g:${source.ref.genId}`;
  known.set(sourceKey, await sourceSha256(source.ref));
  /* The other attributes an element already has (a character's hair, wardrobe) are frozen as they stand. */
  if (existing) await currentSnapshot(existing, known);
  const at = now();

  return workbenchTransaction(async (tx) => {
    const current = (await canvasIn(tx, productionId))?.nodes[nodeId];
    if (!current) throw new MasterLockError(MASTER_COPY.gone, 404);
    if (current.assetId !== node.assetId || current.elementId !== node.elementId || refKindOf(current, project) !== kind)
      throw new MasterLockError("This card changed while it was being locked. Try again.", 409);
    let element = existing ? await readElement(tx, existing.id) : null;
    if (element?.locked) throw new MasterLockError("It was locked in another window meanwhile. Reload the page to see it.", 409);
    if (!element) {
      const eid = await insertElement(tx, { name: node.title.trim().slice(0, 60) || "Master", kind: MASTER_ELEMENT_KIND[kind], projectId: productionId }, by.userId || "atomik");
      element = (await readElement(tx, eid))!;
    }
    const attr = element.attributes.find((a) => a.kind === primaryAttribute(element!.kind)) ?? element.attributes[0];
    if (!attr) throw new MasterLockError("This element has nothing a picture can be locked to.", 409);
    const same = attr.versions.find((v) => v.status === "ready" && ("uploadId" in source.ref ? v.uploadId === source.ref.uploadId : v.genId === source.ref.genId));
    /* The card's source becomes the current version: added when the element has no version of it, pointed at when it has. */
    if (!same || attr.currentId !== same.id) {
      /* Moving the current version moves every shot that follows it: that is a priced swap on the element's page, never a side effect of a free lock. */
      const following = attr.currentId ? await followingShots(tx, element.id) : 0;
      if (following) throw new MasterLockError(`${element.name} is used by ${following === 1 ? "a shot that follows" : `${following} shots that follow`} its current version. Change its version on its element page, where what that does to those shots is priced, then lock it.`, 409);
      if (same) await tx.execute({ sql: "UPDATE element_attributes SET current_id=?, updated_at=? WHERE id=?", args: [same.id, at, attr.id] });
      else if (!(await insertVersion(tx, attr.id, "uploadId" in source.ref ? { uploadId: source.ref.uploadId } : { genId: source.ref.genId }, { label: "master", makeCurrent: true }, by.userId || "atomik")))
        throw new MasterLockError("The card's source could not be added to its element.", 409);
      element = (await readElement(tx, element.id))!;
    }
    const snapshot: MasterSnapshot = {};
    for (const a of element.attributes) {
      const v = a.currentId ? a.versions.find((x) => x.id === a.currentId) : undefined;
      if (!v) continue;
      const key = v.uploadId ? `u:${v.uploadId}` : v.genId ? `g:${v.genId}` : "";
      snapshot[a.id] = { versionId: v.id, sha256: key ? known.get(key) ?? null : null, kind: a.kind };
    }
    await recordHashes(tx, snapshot);
    await setElementLock(element.id, true, lockedByOf(by), tx);
    const event = await logEvent(tx, { elementId: element.id, action: "lock", by, snapshot, productionId, nodeId, at });
    const sha256 = known.get(sourceKey) ?? null;
    const record = masterRecord({ at, by: shownName(by), elementId: element.id, versionId: snapshot[attr.id]?.versionId ?? null, sha256, agent: !!by.agent });
    /* The card: its element, its kind pinned as it reads now, and the lock record. The lock's own trusted write. */
    const written = await applyTeamCanvasPatch(tx, productionId, {
      upsertNodes: [{ ...current, elementId: element.id, refKind: kind, master: record }],
      fields: { [nodeId]: ["elementId", "refKind", "master"] }, made: [], removeNodes: [], upsertAssets: [], order: null,
    }, authorOf(by), false, { trusted: true });
    return { element: (await readElement(tx, element.id))!, event, unchanged: false, node: written!.canvas.nodes[nodeId] ?? null, revision: written!.revision, sha256 };
  });
}

function primaryVersion(element: ElementFull) {
  const attr: AttributeRow | undefined = element.attributes.find((a) => a.kind === primaryAttribute(element.kind)) ?? element.attributes[0];
  return attr?.currentId ? attr.versions.find((v) => v.id === attr.currentId) ?? null : null;
}
function primaryHash(element: ElementFull, snapshot: MasterSnapshot) {
  const attr = element.attributes.find((a) => a.kind === primaryAttribute(element.kind)) ?? element.attributes[0];
  return attr ? snapshot[attr.id]?.sha256 ?? null : null;
}

/**
 * Unlock a master: a signed-in admin, with a reason, both recorded. Atomik
 * never unlocks; a member never does; a token never does. The lock record comes
 * off the element's cards (they keep their element and kind). Free.
 */
export async function unlockMaster(input: { elementId: string; reason: unknown; canvas?: { productionId: string; nodeId: string } | null }, by: LockBy): Promise<LockResult> {
  await ready();
  if (by.token && !by.agent) throw new MasterLockError(MASTER_COPY.tokenUnlock, 403);
  const problem = unlockProblem(by.agent ? { kind: "agent" } : { kind: "person", admin: by.admin }, input.reason);
  if (problem) throw new MasterLockError(problem, problem === MASTER_COPY.reason ? 400 : 403);
  const reason = cleanUnlockReason(input.reason);
  if (input.canvas) await requireProduction(input.canvas.productionId);
  const element = await getElement(input.elementId);
  if (!element) throw new MasterLockError("No such element.", 404);
  if (!element.locked) return { element, event: null, unchanged: true, node: null, revision: null, sha256: null };
  await teamCanvasReady();
  const at = now();
  return workbenchTransaction(async (tx) => {
    const fresh = await readElement(tx, element.id);
    if (!fresh) throw new MasterLockError("No such element.", 404);
    if (!fresh.locked) return { element: fresh, event: null, unchanged: true, node: null, revision: null, sha256: null };
    /* What it held when it was let go: each current version with the hash recorded when it was locked. */
    const hashes = new Map<string, string | null>();
    for (const row of (await tx.execute({ sql: "SELECT id, sha256 FROM attribute_versions WHERE element_id=?", args: [fresh.id] })).rows) hashes.set(String(row.id), row.sha256 == null ? null : String(row.sha256));
    const snapshot: MasterSnapshot = {};
    for (const a of fresh.attributes) if (a.currentId) snapshot[a.id] = { versionId: a.currentId, sha256: hashes.get(a.currentId) ?? null, kind: a.kind };
    await setElementLock(fresh.id, false, lockedByOf(by), tx);
    const event = await logEvent(tx, { elementId: fresh.id, action: "unlock", by, reason, snapshot, productionId: input.canvas?.productionId ?? null, nodeId: input.canvas?.nodeId ?? null, at });
    const productions = [...new Set([input.canvas?.productionId, fresh.projectId].filter((p): p is string => !!p))];
    let node: CanvasNode | null = null, revision: number | null = null;
    for (const pid of productions) {
      const written = await markCards(tx, pid, fresh.id, null, authorOf(by));
      if (input.canvas && pid === input.canvas.productionId) {
        node = written?.canvas.nodes[input.canvas.nodeId] ?? (await canvasIn(tx, pid))?.nodes[input.canvas.nodeId] ?? null;
        revision = written?.revision ?? null;
      }
    }
    return { element: (await readElement(tx, fresh.id))!, event, unchanged: false, node, revision, sha256: null };
  });
}

/** An element's lock history, newest first. */
export async function lockHistory(elementId: string, limit = 50): Promise<LockEvent[]> {
  await ready();
  const rows = (await db().execute({
    sql: "SELECT * FROM element_lock_events WHERE element_id=? ORDER BY at DESC, rowid DESC LIMIT ?",
    args: [elementId, Math.max(1, Math.min(200, Math.floor(limit)))],
  })).rows;
  return rows.map((row) => eventFrom(row as unknown as Record<string, unknown>));
}

/**
 * Whether a locked master's source is still what the lock froze: the latest
 * lock's snapshot against each attribute's current version and the sha256 of
 * its source now. `unrecorded`: locked before locks were logged.
 */
export async function masterCheck(elementId: string): Promise<MasterCheck> {
  await ready();
  const element = await getElement(elementId);
  if (!element?.locked) return { state: "unlocked", changes: [] };
  const row = (await db().execute({ sql: "SELECT snapshot FROM element_lock_events WHERE element_id=? AND action='lock' ORDER BY at DESC, rowid DESC LIMIT 1", args: [elementId] })).rows[0];
  if (!row) return { state: "unrecorded", changes: [] };
  let locked: MasterSnapshot = {};
  try { locked = JSON.parse(String(row.snapshot ?? "{}")) as MasterSnapshot; } catch { locked = {}; }
  const changes = snapshotDrift(locked, await currentSnapshot(element));
  const state = changes.some((c) => c.change !== "unhashed") ? "changed" : changes.length ? "unverified" : "matches";
  return { state, changes };
}
