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
  /** When each node or asset was last written (ms), for last-write-wins. */
  stamps: Record<string, number>;
};

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
};

export const emptyTeamCanvas = (): TeamCanvas => ({ nodes: {}, assets: {}, order: [], removed: {}, stamps: {} });

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

/** Fold a patch in. A write older than what the canvas already holds for that item is ignored. */
export function applyTeamPatch(canvas: TeamCanvas, patch: TeamPatch): TeamCanvas {
  const out: TeamCanvas = { nodes: { ...canvas.nodes }, assets: { ...canvas.assets }, order: [...canvas.order], removed: { ...canvas.removed }, stamps: { ...canvas.stamps } };
  const newer = (key: string) => (out.stamps[key] ?? 0) <= patch.at;
  for (const node of patch.upsertNodes) {
    const key = `n:${node.id}`;
    if (!newer(key)) continue;
    const next = landedWrite(out.nodes[node.id], out.removed[node.id], node, patch);
    if (!next) continue;
    out.nodes[node.id] = next;
    delete out.removed[node.id];
    out.stamps[key] = patch.at;
    if (!out.order.includes(node.id)) out.order.push(node.id);
  }
  for (const id of patch.removeNodes) {
    const key = `n:${id}`;
    if (!newer(key) || !landedRemoval(out.nodes[id], id, patch)) continue;
    out.removed[id] = out.nodes[id];
    delete out.nodes[id];
    out.stamps[key] = patch.at;
  }
  for (const asset of patch.upsertAssets) {
    const key = `a:${asset.id}`;
    if (!newer(key)) continue;
    out.assets[asset.id] = asset;
    out.stamps[key] = patch.at;
  }
  if (patch.order && newer("order")) {
    out.order = patch.order;
    out.stamps.order = patch.at;
  }
  out.order = orderedIds(out);
  return out;
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
 * The draft's other assets stay, so nothing private is lost.
 */
export function withTeamCanvas(project: Project, canvas: Pick<TeamCanvas, "nodes" | "assets" | "order">): Project {
  const nodes = orderedIds(canvas).map((id) => canvas.nodes[id]);
  const shared = Object.values(canvas.assets);
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
  return {
    nodes: record<CanvasNode>(v.nodes),
    assets: record<Asset>(v.assets),
    order: Array.isArray(v.order) ? v.order.filter((id): id is string => typeof id === "string") : [],
    removed: record<CanvasNode>(v.removed),
    stamps: record<number>(v.stamps),
  };
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
