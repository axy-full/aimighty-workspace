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

export const emptyTeamCanvas = (): TeamCanvas => ({ nodes: {}, assets: {}, order: [], removed: {}, retired: {}, stamps: {} });

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

/* ── Locked masters (the agentic Rig, plan step 3) ─────────────────────────
 * A reference card whose element (lib/elements.ts) is locked is a master: the
 * one source of truth for a character, a place or a product. What makes the
 * card that master (MASTER_NODE_FIELDS) and the card itself (a removal) do not
 * change through a canvas edit, whoever sends it: a person, a stale window,
 * Atomik. Such writes do not land; the rest of the same edit does, the way a
 * write that expects what the canvas no longer holds does not land (`expect`).
 * The edit is filtered, never refused: a refusal would drop the teammate's
 * whole patch (lib/workspace/team-canvas-outbox.ts). Only the lock itself
 * (lib/masters.ts) writes these fields, as a trusted write.
 *
 * Which cards are masters is the elements table's answer (`locks`: the ids of
 * locked elements), never a card's own `master` record alone. A caller with no
 * table to ask (a pure test, a path not wired to it) passes no guard, and then
 * a card carrying a lock record counts as locked: the guard fails closed.
 */

/** What makes a card the master it is: its source, its element, its kind, its type and its lock record. */
export const MASTER_NODE_FIELDS = ["assetId", "elementId", "refKind", "type", "master"] as const;
/** What makes a master's source asset that picture: the stored file it names, and its medium. */
export const MASTER_ASSET_FIELDS = ["uploadId", "generationId", "kind"] as const;
/** `locks`: the locked element ids (the elements table). "trusted": the lock's own write, which the guard lets through. */
export type MasterGuard = { locks: ReadonlySet<string> } | "trusted";
/** A write that did not land because it would have changed a locked master: which card or asset, which fields, or its removal. */
export type MasterHold = { nodeId?: string; assetId?: string; elementId?: string; fields: string[]; removal?: true };

/** Whether a card is a locked master under this guard (none: its lock record, failing closed). */
export function isLockedMaster(node: Pick<CanvasNode, "elementId" | "master"> | undefined, guard?: MasterGuard): boolean {
  if (!node || guard === "trusted") return false;
  if (guard) return !!node.elementId && guard.locks.has(node.elementId);
  return !!node.master;
}

function pinned<T extends object>(value: T, to: object, keys: readonly string[]): T {
  const out = { ...value } as Record<string, unknown>, from = to as Record<string, unknown>;
  for (const key of keys) {
    if (from[key] === undefined) delete out[key];
    else out[key] = from[key];
  }
  return out as T;
}
const changedKeys = (a: object | undefined, b: object | undefined, keys: readonly string[]) =>
  keys.filter((key) => !sameJson((a as Record<string, unknown> | undefined)?.[key], (b as Record<string, unknown> | undefined)?.[key]));

/**
 * A patch with every write that would change a locked master taken out, and
 * what was held. For a master already on the canvas (or taken off it): its
 * MASTER_NODE_FIELDS keep what the canvas holds, its removal does not land,
 * and its source asset keeps its MASTER_ASSET_FIELDS. For any other card, a
 * write that would tie it to a locked element keeps its element as it was:
 * only a lock makes a master.
 */
export function guardMasters(canvas: Pick<TeamCanvas, "nodes" | "removed" | "assets" | "retired">, patch: TeamPatch, guard?: MasterGuard): { patch: TeamPatch; held: MasterHold[] } {
  if (guard === "trusted") return { patch, held: [] };
  const held: MasterHold[] = [];
  const fields: Record<string, string[]> = { ...(patch.fields ?? {}) };
  const upsertNodes: CanvasNode[] = [];
  for (const node of patch.upsertNodes) {
    const live = canvas.nodes[node.id], gone = canvas.removed[node.id];
    const current = live ?? gone;
    const would = landedWrite(live, gone, node, patch);
    /* A master's identity stays as the canvas holds it; any other card is never tied to a locked element by an edit. */
    const keys: readonly string[] | null = !would ? null
      : current && isLockedMaster(current, guard) ? MASTER_NODE_FIELDS
      : guard && would.elementId && guard.locks.has(would.elementId) && would.elementId !== current?.elementId ? ["elementId"]
      : null;
    const lost = keys ? changedKeys(would, current, keys) : [];
    if (!keys || !lost.length) { upsertNodes.push(node); continue; }
    const elementId = current?.elementId ?? would!.elementId;
    held.push({ nodeId: node.id, ...(elementId ? { elementId } : {}), fields: lost });
    const named = patch.fields?.[node.id];
    if (named && current) {
      /* A field edit of a card the canvas holds: the other fields it changed still land. */
      const rest = named.filter((key) => !keys.includes(key));
      if (rest.length) { fields[node.id] = rest; upsertNodes.push(node); }
      else delete fields[node.id];
    } else upsertNodes.push(pinned(node, current ?? {}, keys));
  }
  const removeNodes = patch.removeNodes.filter((id) => {
    const live = canvas.nodes[id];
    if (!live || !isLockedMaster(live, guard) || !landedRemoval(live, id, patch)) return true;
    held.push({ nodeId: id, ...(live.elementId ? { elementId: live.elementId } : {}), fields: [], removal: true });
    return false;
  });
  const sources = new Set(Object.values(canvas.nodes).filter((n) => n.assetId && isLockedMaster(n, guard)).map((n) => n.assetId!));
  const upsertAssets = patch.upsertAssets.map((asset) => {
    const current = sources.has(asset.id) ? (canvas.assets[asset.id] ?? canvas.retired[asset.id]) : undefined;
    const lost = current ? changedKeys(asset, current, MASTER_ASSET_FIELDS) : [];
    if (!lost.length) return asset;
    held.push({ assetId: asset.id, fields: lost });
    return pinned(asset, current!, MASTER_ASSET_FIELDS);
  });
  if (!held.length) return { patch, held };
  return { patch: { ...patch, upsertNodes, fields, removeNodes, upsertAssets }, held };
}

/**
 * A window's own edit, with anything it would change on a locked master put
 * back as it was (the rule the server applies to the same edit): the fields
 * held keep their old values, and a master the edit took off is back where it
 * was. So the window never shows, or renders with, a master nobody may change.
 */
export function holdMasterEdits(before: Project, after: Project, locks: ReadonlySet<string>): { project: Project; held: MasterHold[] } {
  const patch = locks.size ? diffForTeam(before, after, 0) : null;
  if (!patch) return { project: after, held: [] };
  const canvas = { nodes: Object.fromEntries(before.nodes.map((n) => [n.id, n])), removed: {}, assets: Object.fromEntries(before.assets.map((a) => [a.id, a])), retired: {} };
  const { held } = guardMasters(canvas, patch, { locks });
  if (!held.length) return { project: after, held };
  return { project: restoreHeld(after, held, canvas.nodes, canvas.assets), held };
}

/**
 * A draft with what the canvas holds for held writes laid back over it: each
 * held field of a card or asset takes the canvas's value, and a master the
 * draft took off comes back where it stood. `nodes` and `assets` are what the
 * canvas holds (the route sends the held cards back with its answer).
 */
export function restoreHeld(project: Project, held: MasterHold[], nodes: Record<string, CanvasNode>, assets: Record<string, Asset> = {}): Project {
  let changed = false;
  const byNode = new Map<string, string[]>(), back: string[] = [];
  for (const h of held) {
    if (h.nodeId && h.removal) back.push(h.nodeId);
    else if (h.nodeId) byNode.set(h.nodeId, [...(byNode.get(h.nodeId) ?? []), ...h.fields]);
  }
  const out = project.nodes.map((n) => {
    const keys = byNode.get(n.id), truth = nodes[n.id];
    if (!keys || !truth || !changedKeys(n, truth, keys).length) return n;
    changed = true;
    return pinned(n, truth, keys);
  });
  /* A master taken off comes back after the card it followed on the canvas (first, when nothing did). */
  const order = Object.keys(nodes);
  for (const id of back) {
    const truth = nodes[id];
    if (!truth || out.some((n) => n.id === id)) continue;
    const before = order.slice(0, order.indexOf(id)).reverse().find((prev) => out.some((n) => n.id === prev));
    out.splice(before ? out.findIndex((n) => n.id === before) + 1 : 0, 0, truth);
    changed = true;
  }
  const heldAssets = new Map(held.filter((h) => h.assetId).map((h) => [h.assetId!, h.fields]));
  const assetsOut = heldAssets.size ? project.assets.map((a) => {
    const keys = heldAssets.get(a.id), truth = assets[a.id];
    if (!keys || !truth || !changedKeys(a, truth, keys).length) return a;
    changed = true;
    return pinned(a, truth, keys);
  }) : project.assets;
  /* A restored master's source travels with it when the draft no longer has it. */
  const have = new Set(assetsOut.map((a) => a.id));
  const missing = back.map((id) => nodes[id]?.assetId).filter((id): id is string => !!id && !have.has(id) && !!assets[id]).map((id) => assets[id]);
  if (missing.length) changed = true;
  return changed ? { ...project, nodes: out, assets: missing.length ? [...assetsOut, ...missing] : assetsOut } : project;
}

/** Fold a patch in. A write older than what the canvas already holds for that item is ignored; a write to a locked master does not land (guardMasters). */
export function applyTeamPatch(canvas: TeamCanvas, patch: TeamPatch, guard?: MasterGuard): TeamCanvas {
  if (guard !== "trusted") patch = guardMasters(canvas, patch, guard).patch;
  const out: TeamCanvas = { nodes: { ...canvas.nodes }, assets: { ...canvas.assets }, order: [...canvas.order], removed: { ...canvas.removed }, retired: { ...canvas.retired }, stamps: { ...canvas.stamps } };
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
  return {
    nodes: record<CanvasNode>(v.nodes),
    assets: record<Asset>(v.assets),
    order: Array.isArray(v.order) ? v.order.filter((id): id is string => typeof id === "string") : [],
    removed: record<CanvasNode>(v.removed),
    retired: record<Asset>(v.retired),
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
