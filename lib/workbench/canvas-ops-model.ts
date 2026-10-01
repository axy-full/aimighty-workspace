import { sameJson } from "./merge";
import { arrangeGraph, canConnect } from "./node-graph";
import { PROJECT_LIMITS } from "./project-limits";
import type { Asset, CanvasNode } from "./studio";
import { isAgentAuthor, orderedIds, type MasterHold, type TeamCanvas, type TeamPatch } from "./team-canvas-model";
import { graphLayout } from "../workspace/rig-graph";

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
 * A person always wins: an Atomik run (`agent:<runId>`) moves, rewords,
 * tidies or takes off only cards it made itself and that nobody has changed
 * since (it is still their last writer). Wiring into a teammate's card is an
 * intent, so it is allowed — and it never makes that card Atomik's; so is
 * taking that wire out again (`unwire`, the undo of a wire). Anything else is
 * held, with the reason.
 *
 * Taking a card off (`remove`) is soft, like every removal on the team canvas:
 * the card moves to the canvas's own record of cards taken off, whole, and
 * nothing is erased. A card another card still takes an input from stays, so
 * a removal never leaves a teammate's card wired to nothing.
 */

/** What an operation may set on a node directly. Placement is `move`, inputs are `wire`; approving and locking stay a person's. */
export const SETTABLE_FIELDS = ["title", "text", "mode", "role", "engine", "durationS", "ratio", "resolution", "look", "collapsed", "width"] as const;
export type SettableField = (typeof SETTABLE_FIELDS)[number];

export type CanvasOp =
  | { kind: "create"; node: CanvasNode; assets?: Asset[] }
  | { kind: "move"; nodeId: string; x: number; y: number }
  | { kind: "wire"; from: string; to: string }
  /** Takes one input out of a card, if it has it (the undo of a wire): an intent, like wire. */
  | { kind: "unwire"; from: string; to: string }
  | { kind: "set"; nodeId: string; fields: Partial<Pick<CanvasNode, SettableField>> }
  | { kind: "tidy"; nodeIds?: string[] }
  /** Takes cards off the canvas, softly: they are kept whole in the canvas's record of cards taken off. */
  | { kind: "remove"; nodeIds: string[] };

/** What became of one operation: the nodes it changed, or why it was held (`card`: the card a held removal is about). */
export type OpOutcome = { kind: CanvasOp["kind"]; nodeIds: string[]; held?: string; card?: string };

/**
 * One card an operation batch changed: made (`after` is the whole card), taken
 * off (`removed`: `before` is the whole card as it was), or these fields, from
 * `before` (their values then) to `after` (their values now).
 */
export type NodeChange = { id: string; made: boolean; removed?: boolean; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> };

/** Why a card another card still takes an input from is not taken off. */
export const IN_USE = "Another card still takes an input from this one, so it stays on the board.";

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
  /* Cards this batch takes off, as the canvas had them before it. */
  const taken = new Map<string, CanvasNode>();
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
    if (!node) return { held: canvas.removed[id] || taken.has(id) ? "That card was taken off the canvas." : "That card is not on the canvas." };
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
      if (canvas.removed[id] || taken.has(id)) { outcomes.push({ kind: op.kind, nodeIds: [], held: "That card was taken off the canvas; only a person can put it back." }); continue; }
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
    } else if (op.kind === "unwire") {
      /* The undo of a wire: an intent on the card as it is now, like wire — it takes out that one input, if it is there. */
      const target = nodes.get(op.to);
      if (!target) { outcomes.push({ kind: op.kind, nodeIds: [], held: canvas.removed[op.to] || taken.has(op.to) ? "That card was taken off the canvas." : "That card is not on the canvas." }); continue; }
      if (!target.linked.includes(op.from)) { outcomes.push({ kind: op.kind, nodeIds: [] }); continue; }
      if (target.locked) { outcomes.push({ kind: op.kind, nodeIds: [], held: "Unlock this node before changing its inputs." }); continue; }
      const next = { ...target, linked: target.linked.filter((id) => id !== op.from) } as CanvasNode;
      if (next.activeInput === op.from) delete next.activeInput;
      touch(op.to, next, ["linked", "activeInput"]);
      outcomes.push({ kind: op.kind, nodeIds: [op.to] });
    } else if (op.kind === "remove") {
      /* Soft, like every removal on the team canvas: the card is kept whole in the canvas's record of cards taken off. */
      const going = new Set<string>();
      const held: OpOutcome[] = [];
      for (const id of new Set(op.nodeIds)) {
        /* Already off (a removal arriving twice, or a person took it off first): nothing to do. */
        if (!nodes.has(id) && (canvas.removed[id] || taken.has(id))) continue;
        const found = editable(id);
        if ("held" in found) held.push({ kind: op.kind, nodeIds: [], held: found.held, card: id });
        else going.add(id);
      }
      /* A card another card still takes an input from stays — unless that card goes too — so nothing is left wired to nothing. */
      for (let changed = true; changed;) {
        changed = false;
        for (const id of going) {
          if (![...nodes.values()].some((n) => !going.has(n.id) && n.linked.includes(id))) continue;
          going.delete(id);
          held.push({ kind: op.kind, nodeIds: [], held: IN_USE, card: id });
          changed = true;
        }
      }
      for (const id of going) {
        nodes.delete(id);
        fields.delete(id);
        /* Made and taken off in one batch: it never reaches the canvas. */
        if (made.delete(id)) continue;
        taken.set(id, canvas.nodes[id]);
      }
      outcomes.push({ kind: op.kind, nodeIds: [...going] }, ...held);
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
      /* The board laid out by the graph (lib/workbench/node-graph arrangeGraph): columns by input depth, rows in canvas
         order. Locked cards keep their place, and so does every card this writer may not move: the rest flow around them. */
      const scope = op.nodeIds ? new Set(op.nodeIds) : null;
      const live = order.filter((id) => nodes.has(id)).map((id) => nodes.get(id)!);
      const movable = (n: CanvasNode) => !n.locked && (!scope || scope.has(n.id)) && mine(n.id);
      const arranged = arrangeGraph(live.map((n) => (movable(n) ? n : { ...n, locked: true })));
      const moved: string[] = [];
      for (const spot of arranged) {
        const node = nodes.get(spot.id)!;
        if (movable(node) && touch(spot.id, { ...node, x: clamp(spot.x), y: clamp(spot.y) }, ["x", "y"])) moved.push(spot.id);
      }
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
  /* Taken off: the whole card as the canvas had it, for the record (and for putting it back). */
  for (const [id, was] of taken) changes.push({ id, made: false, removed: true, fields: [], before: was as unknown as Record<string, unknown>, after: {} });
  return {
    patch: { upsertNodes, fields: patchFields, made: [...made], removeNodes: [...taken.keys()], upsertAssets: [...assets.values()], order: null },
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
 * The changes a batch makes, less the writes the master guard held
 * (team-canvas-model guardMasters): what lands is what is recorded and pushed
 * to the live room. A card made keeps everything but the held fields (it is
 * never tied to a locked element); a changed card keeps only its fields that
 * landed, and a change left with none is dropped.
 */
export function withoutHeld(changes: NodeChange[], held: readonly MasterHold[]): NodeChange[] {
  const byNode = new Map<string, Set<string>>();
  for (const h of held) if (h.nodeId && !h.removal) byNode.set(h.nodeId, new Set([...(byNode.get(h.nodeId) ?? []), ...h.fields]));
  if (!byNode.size) return changes;
  return changes.flatMap((change) => {
    const keys = byNode.get(change.id);
    if (!keys) return [change];
    if (change.made) {
      const after = { ...change.after };
      for (const key of keys) delete after[key];
      return [{ ...change, after }];
    }
    const fields = change.fields.filter((key) => !keys.has(key));
    if (!fields.length) return [];
    const only = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([key]) => fields.includes(key)));
    return [{ ...change, fields, before: only(change.before), after: only(change.after) }];
  });
}

/**
 * The room write for a logged batch: made cards join only a room that does
 * not hold them yet, and each changed field lands only where the room still
 * holds what the canvas had before — so a teammate's edit that reached the
 * room first stands, a push that arrives twice changes nothing, and a card
 * someone just took off is never put back. A card the batch took off leaves
 * the room as it left the canvas (a push that arrives twice finds it gone).
 */
export function roomPatchFor(changes: readonly Pick<NodeChange, "id" | "made" | "removed" | "fields" | "before" | "after">[], assets: readonly Asset[]): TeamPatch {
  const expect: Record<string, CanvasNode | null> = {};
  const fields: Record<string, string[]> = {};
  const upsertNodes: CanvasNode[] = [];
  const removeNodes: string[] = [];
  for (const change of changes) {
    if (change.removed) { removeNodes.push(change.id); continue; }
    upsertNodes.push({ ...change.after, id: change.id } as unknown as CanvasNode);
    if (change.made) { expect[change.id] = null; continue; }
    fields[change.id] = change.fields;
    /* landedWrite compares only the changed fields with what is expected of them. */
    expect[change.id] = change.before as unknown as CanvasNode;
  }
  return { upsertNodes, fields, made: [], removeNodes, upsertAssets: [...assets], order: null, at: 0, expect };
}
