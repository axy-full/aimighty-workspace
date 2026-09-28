import { sameJson } from "./merge";
import { canConnect } from "./node-graph";
import { PROJECT_LIMITS } from "./project-limits";
import type { Asset, CanvasNode } from "./studio";
import { isAgentAuthor, orderedIds, type TeamCanvas, type TeamPatch } from "./team-canvas-model";
import { graphLayout } from "../workspace/rig-graph";
import { tidyBoard } from "../workspace/rig-board";

/*
 * Server-made changes to a production's team canvas, as intents: create a
 * node, move one, wire one into another, set a few fields, tidy the board.
 *
 * Pure. lib/workbench/canvas-ops.ts plans them against the canvas as it is
 * inside the write transaction and folds the result in through the same merge
 * a person's edit goes through (applyTeamPatch), so an intent is applied to
 * the current value: a wire adds one input to whatever the node has now, a
 * move writes only x and y, and a teammate's edit to another field stands.
 *
 * A person always wins: an Atomik run (`agent:<runId>`) moves, rewords or
 * tidies only cards it made itself and that nobody has changed since (it is
 * still their last writer). Wiring into a teammate's card is an intent, so it
 * is allowed — and it never makes that card Atomik's. Anything else is held,
 * with the reason.
 */

/** What an operation may set on a node directly. Placement is `move`, inputs are `wire`; approving and locking stay a person's. */
export const SETTABLE_FIELDS = ["title", "text", "mode", "role", "engine", "durationS", "ratio", "resolution", "look", "collapsed", "width"] as const;
export type SettableField = (typeof SETTABLE_FIELDS)[number];

export type CanvasOp =
  | { kind: "create"; node: CanvasNode; assets?: Asset[] }
  | { kind: "move"; nodeId: string; x: number; y: number }
  | { kind: "wire"; from: string; to: string }
  | { kind: "set"; nodeId: string; fields: Partial<Pick<CanvasNode, SettableField>> }
  | { kind: "tidy"; nodeIds?: string[] };

/** What became of one operation: the nodes it changed, or why it was held. */
export type OpOutcome = { kind: CanvasOp["kind"]; nodeIds: string[]; held?: string };

/**
 * One card an operation batch changed: made (`after` is the whole card), or
 * these fields, from `before` (their values then) to `after` (their values now).
 */
export type NodeChange = { id: string; made: boolean; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> };

export type CanvasOpsPlan = {
  /** The batch as one team canvas patch (no `at`: the server's clock stamps it). */
  patch: Omit<TeamPatch, "at">;
  outcomes: OpOutcome[];
  changes: NodeChange[];
  /** The node the batch touched last: where Atomik's cursor sits for the team. */
  focus: string | null;
};

export const PERSON_WINS = "Someone else made or last changed this card, so Atomik leaves it as it is.";
const MIN = -10_000, MAX = 20_000;
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v)));

export function planCanvasOps(canvas: TeamCanvas, ops: readonly CanvasOp[], author: string): CanvasOpsPlan {
  const nodes = new Map(Object.entries(canvas.nodes));
  const order = orderedIds(canvas);
  const made = new Set<string>();
  const fields = new Map<string, Set<string>>();
  const assets = new Map<string, Asset>();
  const outcomes: OpOutcome[] = [];
  const last = { focus: null as string | null };
  const agent = isAgentAuthor(author);
  /* A person always wins: an Atomik run changes only cards it made, while it is still their last writer. */
  const mine = (id: string) => !agent || made.has(id) || (canvas.serverMade[id] === author && canvas.writers[id] === author);
  const touch = (id: string, next: CanvasNode, keys: readonly string[]) => {
    const was = nodes.get(id)! as unknown as Record<string, unknown>, now = next as unknown as Record<string, unknown>;
    const changed = keys.filter((key) => !sameJson(was[key], now[key]));
    if (!changed.length) return false;
    nodes.set(id, next);
    if (!made.has(id)) {
      const set = fields.get(id) ?? new Set<string>();
      for (const key of changed) set.add(key);
      fields.set(id, set);
    }
    last.focus = id;
    return true;
  };
  /** An input wired into a card, by the graph's own rules (types, limits, locked targets, cycles) against the canvas as it is now. */
  const wire = (from: string, to: string): OpOutcome => {
    const problem = canConnect([...nodes.values()], from, to);
    if (problem === "These nodes are already connected.") return { kind: "wire", nodeIds: [] };
    if (problem) return { kind: "wire", nodeIds: [], held: problem };
    const target = nodes.get(to)!;
    touch(to, { ...target, linked: [...target.linked, from] }, ["linked"]);
    return { kind: "wire", nodeIds: [to] };
  };
  /** The node an operation names, or why the operation cannot touch it. */
  const editable = (id: string): { node: CanvasNode } | { held: string } => {
    const node = nodes.get(id);
    if (!node) return { held: canvas.removed[id] ? "That card was taken off the canvas." : "That card is not on the canvas." };
    if (node.locked) return { held: "That card is locked." };
    if (!mine(id)) return { held: PERSON_WINS };
    return { node };
  };

  for (const op of ops) {
    if (op.kind === "create") {
      const id = op.node.id;
      /* Made already (this batch or an earlier one arriving twice): nothing to add. */
      if (nodes.has(id)) { outcomes.push({ kind: op.kind, nodeIds: [] }); continue; }
      /* Taken off by someone: only a person puts it back. */
      if (canvas.removed[id]) { outcomes.push({ kind: op.kind, nodeIds: [], held: "That card was taken off the canvas; only a person can put it back." }); continue; }
      if (nodes.size >= PROJECT_LIMITS.nodes) { outcomes.push({ kind: op.kind, nodeIds: [], held: `A canvas holds at most ${PROJECT_LIMITS.nodes.toLocaleString("en-US")} cards.` }); continue; }
      /* A made card starts with no inputs: the ones it names are wired by the graph's rules, like any wire. It never
         arrives approved: approving stays a person's. */
      const { status, ...card } = op.node;
      nodes.set(id, { ...card, ...(status && status !== "approved" ? { status } : {}), linked: [], x: clamp(op.node.x), y: clamp(op.node.y) });
      made.add(id);
      order.push(id);
      last.focus = id;
      for (const asset of op.assets ?? []) if (!canvas.assets[asset.id]) assets.set(asset.id, asset);
      outcomes.push({ kind: op.kind, nodeIds: [id] });
      for (const from of op.node.linked) {
        const wired = wire(from, id);
        if (wired.held) outcomes.push(wired);
      }
    } else if (op.kind === "move") {
      const found = editable(op.nodeId);
      if ("held" in found) { outcomes.push({ kind: op.kind, nodeIds: [], held: found.held }); continue; }
      const moved = touch(op.nodeId, { ...found.node, x: clamp(op.x), y: clamp(op.y) }, ["x", "y"]);
      outcomes.push({ kind: op.kind, nodeIds: moved ? [op.nodeId] : [] });
    } else if (op.kind === "wire") {
      outcomes.push(wire(op.from, op.to));
    } else if (op.kind === "set") {
      const keys = Object.keys(op.fields);
      const refused = keys.find((key) => !(SETTABLE_FIELDS as readonly string[]).includes(key));
      if (refused || !keys.length) { outcomes.push({ kind: op.kind, nodeIds: [], held: refused ? `A card's ${refused} is not set this way.` : "Nothing to set." }); continue; }
      const found = editable(op.nodeId);
      if ("held" in found) { outcomes.push({ kind: op.kind, nodeIds: [], held: found.held }); continue; }
      const next = { ...found.node } as unknown as Record<string, unknown>;
      for (const key of keys) {
        const value = (op.fields as Record<string, unknown>)[key];
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      const changed = touch(op.nodeId, next as unknown as CanvasNode, keys);
      outcomes.push({ kind: op.kind, nodeIds: changed ? [op.nodeId] : [] });
    } else {
      /* The board by sections (lib/workspace/rig-board.ts tidyBoard): a block of columns per section under its title —
         Cast, Environment, Elements, Refs, Looks, Direction, Shots, Finishing, Review and output, and each section a
         person made — rows in canvas order, on the 20 px grid. A kind's missing title is made here (never one a person
         took off the board). Locked cards keep their place, and so does every card this writer may not move: the rest
         flow around them. */
      const scope = op.nodeIds ? new Set(op.nodeIds) : null;
      const live = order.filter((id) => nodes.has(id)).map((id) => nodes.get(id)!);
      const movable = (n: CanvasNode) => !n.locked && (!scope || scope.has(n.id)) && mine(n.id);
      const board = tidyBoard(live, { assets: [...Object.values(canvas.assets), ...assets.values()] }, { movable, canMake: (id) => !canvas.removed[id] });
      const titles: string[] = [];
      /* Within the canvas's card limit: a title that does not fit is simply not made (its section keeps its place). */
      for (const title of board.made.slice(0, Math.max(0, PROJECT_LIMITS.nodes - nodes.size))) {
        nodes.set(title.id, title);
        made.add(title.id);
        order.push(title.id);
        titles.push(title.id);
        last.focus = title.id;
      }
      const moved: string[] = [];
      for (const spot of board.spots) {
        const node = nodes.get(spot.id)!;
        const keys = spot.width === undefined ? ["x", "y"] : ["x", "y", "width"];
        const next = { ...node, x: clamp(spot.x), y: clamp(spot.y), ...(spot.width === undefined ? {} : { width: spot.width }) };
        if (touch(spot.id, next, keys)) moved.push(spot.id);
      }
      /* The titles it made are cards made, like a create's; the cards it moved are the tidy's. */
      if (titles.length) outcomes.push({ kind: "create", nodeIds: titles });
      outcomes.push({ kind: op.kind, nodeIds: moved });
    }
  }

  const changes: NodeChange[] = [];
  const upsertNodes: CanvasNode[] = [];
  const patchFields: Record<string, string[]> = {};
  for (const id of made) {
    const after = nodes.get(id)!;
    upsertNodes.push(after);
    changes.push({ id, made: true, fields: [], before: {}, after: after as unknown as Record<string, unknown> });
  }
  for (const [id, set] of fields) {
    const after = nodes.get(id)!, was = canvas.nodes[id] as unknown as Record<string, unknown>, now = after as unknown as Record<string, unknown>;
    /* Moved and moved back in one batch: nothing changed. */
    const keys = [...set].filter((key) => !sameJson(was[key], now[key]));
    if (!keys.length) continue;
    upsertNodes.push(after);
    patchFields[id] = keys;
    changes.push({ id, made: false, fields: keys, before: Object.fromEntries(keys.map((key) => [key, was[key]])), after: Object.fromEntries(keys.map((key) => [key, now[key]])) });
  }
  return {
    patch: { upsertNodes, fields: patchFields, made: [...made], removeNodes: [], upsertAssets: [...assets.values()], order: null },
    outcomes,
    changes,
    focus: changes.some((c) => c.id === last.focus) ? last.focus : changes.at(-1)?.id ?? null,
  };
}

/**
 * Where Atomik's cursor sits on the Rig graph for a node: the same board
 * coordinates a teammate's cursor uses (lib/workspace/rig-graph graphLayout,
 * shifted to the top-left node), just inside the card's corner.
 */
export function focusPoint(nodes: readonly CanvasNode[], id: string): { x: number; y: number } | null {
  const card = graphLayout(nodes).cards.find((c) => c.id === id);
  return card ? { x: card.left + 24, y: card.top + 18 } : null;
}

/**
 * The room write for a logged batch: made cards join only a room that does
 * not hold them yet, and each changed field lands only where the room still
 * holds what the canvas had before — so a teammate's edit that reached the
 * room first stands, a push that arrives twice changes nothing, and a card
 * someone just took off is never put back.
 */
export function roomPatchFor(changes: readonly Pick<NodeChange, "id" | "made" | "fields" | "before" | "after">[], assets: readonly Asset[]): TeamPatch {
  const expect: Record<string, CanvasNode | null> = {};
  const fields: Record<string, string[]> = {};
  for (const change of changes) {
    if (change.made) { expect[change.id] = null; continue; }
    fields[change.id] = change.fields;
    /* landedWrite compares only the changed fields with what is expected of them. */
    expect[change.id] = change.before as unknown as CanvasNode;
  }
  const upsertNodes = changes.map((c) => ({ ...c.after, id: c.id }) as unknown as CanvasNode);
  return { upsertNodes, fields, made: [], removeNodes: [], upsertAssets: [...assets], order: null, at: 0, expect };
}
