import { sameJson } from "./merge";
import type { Asset, CanvasNode, Project } from "./studio";

/*
 * The team canvas: one Rig canvas per production that everyone in the
 * workspace edits together (owner, 2026-09-24). Each person still has their
 * own draft of everything else; only the Rig's nodes, their order, and the
 * assets those nodes point at are shared.
 *
 * Pure and shared by the server (merging saved patches) and the browser
 * (diffing local edits, folding in teammates' edits). Every item carries the
 * moment it was last written so two saves of the same node settle the same
 * way everywhere: the later write wins, per node, never per canvas.
 */

export type TeamCanvas = {
  nodes: Record<string, CanvasNode>;
  assets: Record<string, Asset>;
  order: string[];
  /** Nodes taken off the canvas, kept whole: nothing a team makes is erased. */
  removed: Record<string, CanvasNode>;
  /** Assets no node uses any more, kept whole: off every draft, back when a node points at one again. */
  retired: Record<string, Asset>;
  /** When each node or asset was last written (ms), for last-write-wins. */
  stamps: Record<string, number>;
  /** Per node: who last changed it — a person's user id, or a server writer such as `agent:<runId>`. */
  writers: Record<string, string>;
  /**
   * Nodes a server operation made (lib/workbench/canvas-ops.ts), by who made
   * them. A removal a save only implied never takes one off (heldRemoval).
   */
  serverMade: Record<string, string>;
};

/** A server writer (an Atomik run) rather than a person: `agent:<runId>`. */
export const isAgentAuthor = (author: string | undefined) => !!author && author.startsWith("agent:");

export type TeamPatch = {
  /** Nodes written whole — except those named in `fields` or `made`. */
  upsertNodes: CanvasNode[];
  /**
   * For a node the edit changed: the fields it changed. Only those are
   * written, so a teammate's edit to another field of the same node stands
   * (and a node a teammate took off comes back with the change).
   */
  fields?: Record<string, string[]>;
  /**
   * Nodes the edit made (new here, or put back by an undo): each joins the
   * canvas unless the canvas already holds it — both sides made it, or a
   * teammate put it back first and changed it since.
   */
  made?: string[];
  removeNodes: string[];
  upsertAssets: Asset[];
  order: string[] | null;
  at: number;
  /**
   * For a node here, what the window sending it had before another save
   * brought the change in (catchUpForTeam): each field is written only where
   * the canvas still holds that, and the node is taken off only if unchanged
   * since — a teammate's edit made meanwhile stands. Null: a node new to that
   * window, which joins only a canvas that never held it.
   */
  expect?: Record<string, CanvasNode | null>;
  /** Who wrote it (set by the server, never taken from a window): recorded per node it changed (TeamCanvas.writers). */
  author?: string;
  /**
   * A patch a draft save implied (lib/workbench/records.ts saveDraft) rather
   * than an edit made on the canvas: a node its window no longer shows may
   * have been lost to a stale view, so its removals never take off a node a
   * server operation made. Set by the server, never taken from a window.
   */
  implied?: boolean;
};

export const emptyTeamCanvas = (): TeamCanvas => ({ nodes: {}, assets: {}, order: [], removed: {}, retired: {}, stamps: {}, writers: {}, serverMade: {} });

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The assets a canvas needs to render and generate: what its nodes point at, and takes filed on them. */
export function referencedAssetIds(nodes: CanvasNode[], assets: Asset[]): Set<string> {
  const ids = new Set<string>();
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.assetId) ids.add(n.assetId);
    if (n.firstFrameId) ids.add(n.firstFrameId);
    for (const v of n.versions ?? []) if (v.assetId) ids.add(v.assetId);
  }
  for (const a of assets) if (a.nodeId && nodeIds.has(a.nodeId)) ids.add(a.id);
  return ids;
}

/** What one local edit changed on the shared canvas; null when it changed nothing shared. */
export function diffForTeam(before: Project, after: Project, at: number): TeamPatch | null {
  if (before.nodes === after.nodes && before.assets === after.assets) return null;
  const prev = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const upsertNodes = after.nodes.filter((n) => !same(prev.get(n.id), n));
  /* A node that was already here travels as the fields this edit changed, never as a whole stale copy. */
  const fields: Record<string, string[]> = {};
  const made: string[] = [];
  for (const n of upsertNodes) {
    const was = prev.get(n.id) as Record<string, unknown> | undefined, now = n as unknown as Record<string, unknown>;
    if (was) fields[n.id] = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((key) => !same(was[key], now[key]));
    else made.push(n.id);
  }
  const removeNodes = before.nodes.filter((n) => !next.has(n.id)).map((n) => n.id);
  const wanted = referencedAssetIds(after.nodes, after.assets);
  const wantedBefore = referencedAssetIds(before.nodes, before.assets);
  const prevAssets = new Map(before.assets.map((a) => [a.id, a]));
  /* Newly used by a node (teammates may not have it yet), or changed while in use. */
  const upsertAssets = after.assets.filter((a) => wanted.has(a.id) && (!wantedBefore.has(a.id) || !same(prevAssets.get(a.id), a)));
  const orderChanged = !same(before.nodes.map((n) => n.id), after.nodes.map((n) => n.id));
  if (!upsertNodes.length && !removeNodes.length && !upsertAssets.length && !orderChanged) return null;
  return { upsertNodes, fields, made, removeNodes, upsertAssets, order: orderChanged ? after.nodes.map((n) => n.id) : null, at };
}

/**
 * What another save brought into a window, for the team canvas — a save the
 * canvas may have missed (it was carried before the canvas existed, or a live
 * room never saw it). The same changes as diffForTeam, each conditional on the
 * canvas still holding what the window had (`expect`): a node new to it joins
 * only a canvas that never held it, a field is written only where the canvas
 * still has the old value, a node is taken off only if unchanged. So the
 * canvas catches up, and a teammate's edit made since stands.
 */
export function catchUpForTeam(before: Project, after: Project, at: number): TeamPatch | null {
  const patch = diffForTeam(before, after, at);
  if (!patch) return null;
  const prev = new Map(before.nodes.map((n) => [n.id, n]));
  const expect: Record<string, CanvasNode | null> = {};
  for (const n of patch.upsertNodes) expect[n.id] = prev.get(n.id) ?? null;
  for (const id of patch.removeNodes) expect[id] = prev.get(id) ?? null;
  const known = new Set(before.assets.map((a) => a.id));
  return { ...patch, made: [], upsertAssets: patch.upsertAssets.filter((a) => !known.has(a.id)), order: null, expect };
}

/**
 * A node as the canvas holds it once a patch's write of `node` lands. `live`
 * is the canvas's node, `gone` the one it took off. A changed node takes only
 * its changed fields (onto the node taken off, when it was: it comes back); a
 * made node joins unless one is live; any other write is the node, whole.
 */
export function nodeAfterEdit(live: CanvasNode | undefined, gone: CanvasNode | undefined, node: CanvasNode, patch: Pick<TeamPatch, "fields" | "made">): CanvasNode {
  const changed = patch.fields?.[node.id];
  if (changed) {
    const current = live ?? gone;
    if (!current) return node;
    const out = { ...current } as Record<string, unknown>, from = node as unknown as Record<string, unknown>;
    for (const key of changed) {
      if (from[key] === undefined) delete out[key];
      else out[key] = from[key];
    }
    return out as unknown as CanvasNode;
  }
  if (patch.made?.includes(node.id)) return live ?? node;
  return node;
}

/**
 * A patch's write of `node`, as the canvas holds it after — or undefined when
 * the write does not land: one that expects what the canvas no longer holds
 * (TeamPatch.expect) writes only the fields still as expected.
 */
export function landedWrite(live: CanvasNode | undefined, gone: CanvasNode | undefined, node: CanvasNode, patch: Pick<TeamPatch, "fields" | "made" | "expect">): CanvasNode | undefined {
  const was = patch.expect?.[node.id];
  if (was === undefined) return nodeAfterEdit(live, gone, node, patch);
  if (was === null) return live || gone ? undefined : node;
  if (!live) return undefined;
  const current = live as unknown as Record<string, unknown>, before = was as unknown as Record<string, unknown>;
  const fields = (patch.fields?.[node.id] ?? []).filter((key) => sameJson(current[key], before[key]));
  return fields.length ? nodeAfterEdit(live, undefined, node, { fields: { [node.id]: fields } }) : undefined;
}

/** Whether a patch's removal of a node lands: one that expects the node as it was lands only on it unchanged. */
export function landedRemoval(live: CanvasNode | undefined, id: string, patch: Pick<TeamPatch, "expect">): boolean {
  const was = patch.expect?.[id];
  return !!live && (!was || sameJson(live, was));
}

/**
 * Whether a removal must not land: one a save only implied (a draft save's,
 * or a catch-up's — it carries `expect`) of a node a server operation made.
 * The window that sent it may have lost that node to a stale view (a live
 * room that had not caught up with the server yet), so taking it off would
 * throw away what the server made for everyone. A removal made on the canvas
 * itself (the Rig's own delete) still lands.
 */
export function heldRemoval(serverMade: Record<string, string> | undefined, id: string, patch: Pick<TeamPatch, "implied" | "expect">): boolean {
  return !!serverMade?.[id] && (!!patch.implied || patch.expect?.[id] !== undefined);
}

/** The removals of a patch that would take a card off this canvas but that heldRemoval keeps from landing. */
export function heldRemovals(canvas: Pick<TeamCanvas, "nodes" | "serverMade">, patch: Pick<TeamPatch, "removeNodes" | "implied" | "expect">): string[] {
  return patch.removeNodes.filter((id) => landedRemoval(canvas.nodes[id], id, patch) && heldRemoval(canvas.serverMade, id, patch));
}

/** Fold a patch in. A write older than what the canvas already holds for that item is ignored. */
export function applyTeamPatch(canvas: TeamCanvas, patch: TeamPatch): TeamCanvas {
  const out: TeamCanvas = {
    nodes: { ...canvas.nodes }, assets: { ...canvas.assets }, order: [...canvas.order], removed: { ...canvas.removed }, retired: { ...canvas.retired }, stamps: { ...canvas.stamps },
    writers: { ...canvas.writers }, serverMade: { ...canvas.serverMade },
  };
  const newer = (key: string) => (out.stamps[key] ?? 0) <= patch.at;
  for (const node of patch.upsertNodes) {
    const key = `n:${node.id}`;
    if (!newer(key)) continue;
    const next = landedWrite(out.nodes[node.id], out.removed[node.id], node, patch);
    if (!next) continue;
    /* The writer is who last changed the node: a save that only carries what the canvas already holds changes nothing. */
    const changed = !out.nodes[node.id] || !sameJson(out.nodes[node.id], next);
    out.nodes[node.id] = next;
    delete out.removed[node.id];
    out.stamps[key] = patch.at;
    if (changed && patch.author) out.writers[node.id] = patch.author;
    if (!out.order.includes(node.id)) out.order.push(node.id);
  }
  for (const id of patch.removeNodes) {
    const key = `n:${id}`;
    if (!newer(key) || !landedRemoval(out.nodes[id], id, patch) || heldRemoval(out.serverMade, id, patch)) continue;
    out.removed[id] = out.nodes[id];
    delete out.nodes[id];
    out.stamps[key] = patch.at;
    if (patch.author) out.writers[id] = patch.author;
  }
  for (const asset of patch.upsertAssets) {
    const key = `a:${asset.id}`;
    if (!newer(key)) continue;
    out.assets[asset.id] = asset;
    delete out.retired[asset.id];
    out.stamps[key] = patch.at;
  }
  if (patch.order && newer("order")) {
    out.order = patch.order;
    out.stamps.order = patch.at;
  }
  out.order = orderedIds(out);
  /* Only what a node points at stays shared (a node taken off keeps its own, so it can come back whole).
     An asset no node uses any more is retired, not erased: it would otherwise be folded into every draft
     forever, and a teammate's stale edit that points a node back at it brings it back. */
  const used = referencedAssetIds([...Object.values(out.nodes), ...Object.values(out.removed)], [...Object.values(out.assets), ...Object.values(out.retired)]);
  for (const [id, asset] of Object.entries(out.retired)) if (used.has(id)) { out.assets[id] = asset; delete out.retired[id]; }
  for (const [id, asset] of Object.entries(out.assets)) if (!used.has(id)) { out.retired[id] = asset; delete out.assets[id]; }
  return out;
}

/** The canvas assets a draft takes: only those its live nodes use. */
export function liveCanvasAssets(canvas: Pick<TeamCanvas, "nodes" | "assets">): Asset[] {
  const assets = Object.values(canvas.assets);
  const used = referencedAssetIds(Object.values(canvas.nodes), assets);
  return assets.filter((a) => used.has(a.id));
}

/** Every live node exactly once: the saved order first, then any node it does not name yet. */
export function orderedIds(canvas: Pick<TeamCanvas, "nodes" | "order">): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of canvas.order) if (canvas.nodes[id] && !seen.has(id)) { seen.add(id); ids.push(id); }
  for (const id of Object.keys(canvas.nodes)) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  return ids;
}

/**
 * A person's draft with the team canvas folded in: the canvas's nodes, in its
 * order, replace the draft's; the assets they need are added or refreshed.
 * The draft's other assets stay, so nothing private is lost. A canvas asset no
 * live node uses is not folded in, so one the draft removed stays removed.
 */
export function withTeamCanvas(project: Project, canvas: Pick<TeamCanvas, "nodes" | "assets" | "order">): Project {
  const nodes = orderedIds(canvas).map((id) => canvas.nodes[id]);
  const shared = liveCanvasAssets(canvas);
  const ids = new Set(shared.map((a) => a.id));
  const assets = [...project.assets.filter((a) => !ids.has(a.id)), ...shared];
  const nodesSame = same(project.nodes, nodes);
  const assetsSame = same(project.assets, assets);
  if (nodesSame && assetsSame) return project;
  return { ...project, nodes: nodesSame ? project.nodes : nodes, assets: assetsSame ? project.assets : assets };
}

/** A saved canvas read back defensively: anything malformed becomes empty rather than breaking the Rig. */
export function parseTeamCanvas(value: unknown): TeamCanvas {
  const v = (value && typeof value === "object" ? value : {}) as Partial<TeamCanvas>;
  const record = <T>(x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, T>) : {});
  /* Who wrote what: names only, so a malformed entry is dropped rather than trusted. */
  const names = (x: unknown) => Object.fromEntries(Object.entries(record<unknown>(x)).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 200));
  return {
    nodes: record<CanvasNode>(v.nodes),
    assets: record<Asset>(v.assets),
    order: Array.isArray(v.order) ? v.order.filter((id): id is string => typeof id === "string") : [],
    removed: record<CanvasNode>(v.removed),
    retired: record<Asset>(v.retired),
    stamps: record<number>(v.stamps),
    writers: names(v.writers),
    serverMade: names(v.serverMade),
  };
}

/* ── The live room ─────────────────────────────────────────────────────────
 * The room keeps each node and asset whole under its id, and the order as a
 * list. The browser writes it through its live connection
 * (components/workspace/rig/use-team-canvas.ts) and the server through
 * Liveblocks' storage API (lib/workbench/canvas-push.ts); both go through
 * writeRoom, so a server change lands in the room exactly as the same change
 * made in a window would, by the same landedWrite / landedRemoval rules the
 * database merge uses.
 */

/** The room's storage as the team canvas uses it (structural, so a test's stand-in and both Liveblocks clients fit). */
export type RoomStorage = {
  nodes: { get(id: string): unknown; set(id: string, value: unknown): void; delete(id: string): void };
  assets: { get(id: string): unknown; set(id: string, value: unknown): void };
  order(): readonly string[];
  setOrder(order: string[]): void;
  /** The nodes a server operation made, as the server last told the room (none until it has). */
  serverMade(): Record<string, string>;
  setServerMade(made: Record<string, string>): void;
};

/** A plain JSON copy: what a room may hold. */
export const plainJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A patch written to the room: for a node that was already there, only the
 * fields it changed (a teammate's edit to another field stands); a catch-up
 * or a server write lands only where the room still holds what its sender had
 * (`expect`); a removal a save only implied never takes off a node a server
 * operation made.
 */
export function writeRoom(room: RoomStorage, patch: TeamPatch) {
  for (const n of patch.upsertNodes) {
    const next = landedWrite(room.nodes.get(n.id) as CanvasNode | undefined, undefined, n, patch);
    if (next) room.nodes.set(n.id, plainJson(next));
  }
  const made = patch.removeNodes.length ? room.serverMade() : {};
  for (const id of patch.removeNodes)
    if (!heldRemoval(made, id, patch) && landedRemoval(room.nodes.get(id) as CanvasNode | undefined, id, patch)) room.nodes.delete(id);
  for (const a of patch.upsertAssets) room.assets.set(a.id, plainJson(a));
  if (patch.order) room.setOrder(patch.order);
}

export type RoomPoint = { x: number; y: number };
export type RoomDrag = { id: string; dx: number; dy: number };
/** Someone in the live room as the Rig shows them: a teammate, or Atomik (the server's writer: `agent` in its user info, with what it is doing). */
export type RoomPeer = { id: number; name: string; color: string; cursor: RoomPoint | null; selected: string | null; drag: RoomDrag | null; agent?: boolean; doing?: string };

export function roomPeer(other: { connectionId: number; info?: unknown; presence: { cursor?: RoomPoint | null; selected?: string | null; drag?: RoomDrag | null; doing?: unknown } }): RoomPeer {
  const info = (other.info ?? {}) as { name?: string; color?: string; agent?: boolean };
  const agent = info.agent === true;
  return {
    id: other.connectionId, name: info.name ?? (agent ? "Atomik" : "Teammate"), color: info.color ?? "#0A84FF",
    cursor: other.presence.cursor ?? null, selected: other.presence.selected ?? null, drag: other.presence.drag ?? null,
    ...(agent ? { agent, ...(typeof other.presence.doing === "string" ? { doing: other.presence.doing.slice(0, 80) } : {}) } : {}),
  };
}

/** The shape a room is read into: live nodes, assets, the order, and nodes known to be off. */
export type TeamCanvasView = { nodes: Record<string, CanvasNode>; assets: Record<string, Asset>; order: string[]; removedIds: string[]; serverMade?: Record<string, string> };

/** A canvas as a window sees it, with its not-yet-sent edits laid over it (the same rules as writeRoom). */
export function overlay(canvas: TeamCanvasView, patch: TeamPatch | null): TeamCanvasView {
  if (!patch) return canvas;
  const nodes = { ...canvas.nodes }, assets = { ...canvas.assets };
  const removedIds = new Set(canvas.removedIds);
  for (const n of patch.upsertNodes) {
    const next = landedWrite(nodes[n.id], removedIds.has(n.id) ? n : undefined, n, patch);
    if (next) { nodes[n.id] = next; removedIds.delete(n.id); }
  }
  for (const id of patch.removeNodes)
    if (!heldRemoval(canvas.serverMade, id, patch) && landedRemoval(nodes[id], id, patch)) { delete nodes[id]; removedIds.add(id); }
  for (const a of patch.upsertAssets) assets[a.id] = a;
  return { ...canvas, nodes, assets, order: patch.order ?? canvas.order, removedIds: [...removedIds] };
}

/**
 * Opening a project onto its team canvas. Nodes the canvas has never seen
 * (a private Rig built before the canvas was shared, or while offline) join
 * it instead of vanishing; a node a teammate took off stays off. Everything
 * else comes from the canvas.
 */
export function joinTeamCanvas(
  project: Project,
  canvas: Pick<TeamCanvas, "nodes" | "assets" | "order"> & { removedIds: string[] },
  at: number,
): { project: Project; patch: TeamPatch | null } {
  const known = new Set([...Object.keys(canvas.nodes), ...canvas.removedIds]);
  const unseen = project.nodes.filter((n) => !known.has(n.id));
  if (!unseen.length) return { project: withTeamCanvas(project, canvas), patch: null };
  const wanted = referencedAssetIds(unseen, project.assets);
  const unseenAssets = project.assets.filter((a) => wanted.has(a.id) && !canvas.assets[a.id]);
  const order = [...orderedIds(canvas), ...unseen.map((n) => n.id)];
  const merged = {
    nodes: { ...canvas.nodes, ...Object.fromEntries(unseen.map((n) => [n.id, n])) },
    assets: { ...canvas.assets, ...Object.fromEntries(unseenAssets.map((a) => [a.id, a])) },
    order,
  };
  return {
    project: withTeamCanvas(project, merged),
    patch: { upsertNodes: unseen, made: unseen.map((n) => n.id), removeNodes: [], upsertAssets: unseenAssets, order, at },
  };
}
