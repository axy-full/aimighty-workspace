import { DraftRequestError } from "../workbench/draft-request";
import type { TeamPatch } from "../workbench/team-canvas-model";

/*
 * The Rig's team canvas edits waiting to be sent (components/workspace/rig/use-team-canvas.ts).
 *
 * Every edit is filed under the production it was made in and is only ever
 * sent there. Switching projects while an edit waits, or while one is being
 * retried, can never land it in the next production's canvas.
 *
 * Sends are not serialised (the save that runs as the page hides must start at
 * once, as keepalive), so an older send can fail after a newer one has already
 * gone out. Each send is numbered per production when it is handed out, and a
 * failed send is kept only for the nodes, assets and order no later send
 * carried: the later one either lands or is kept itself, so the older value is
 * never re-sent over it.
 */

/**
 * Several edits between saves travel as one patch: the last write of each node
 * wins, with every field any of them changed (TeamPatch.fields); a node one of
 * them made stays made, and one written whole stays whole.
 */
export function mergePatches(a: TeamPatch | null, b: TeamPatch): TeamPatch {
  if (!a) return b;
  const nodes = new Map(a.upsertNodes.map((n) => [n.id, n]));
  const removed = new Set(a.removeNodes);
  const fields = new Map(Object.entries(a.fields ?? {}));
  const made = new Set(a.made ?? []);
  const whole = new Set(a.upsertNodes.filter((n) => !fields.has(n.id) && !made.has(n.id)).map((n) => n.id));
  for (const n of b.upsertNodes) {
    nodes.set(n.id, n);
    removed.delete(n.id);
    const changed = b.fields?.[n.id];
    if (b.made?.includes(n.id)) { made.add(n.id); fields.delete(n.id); whole.delete(n.id); }
    else if (!changed) { whole.add(n.id); fields.delete(n.id); made.delete(n.id); }
    /* Made here, then changed: still one node this window made, as it is now. */
    else if (!made.has(n.id) && !whole.has(n.id)) fields.set(n.id, [...new Set([...(fields.get(n.id) ?? []), ...changed])]);
  }
  for (const id of b.removeNodes) { removed.add(id); nodes.delete(id); fields.delete(id); made.delete(id); whole.delete(id); }
  const assets = new Map(a.upsertAssets.map((x) => [x.id, x]));
  for (const x of b.upsertAssets) assets.set(x.id, x);
  return { upsertNodes: [...nodes.values()], fields: Object.fromEntries(fields), made: [...made], removeNodes: [...removed], upsertAssets: [...assets.values()], order: b.order ?? a.order, at: b.at };
}

/** Per production: the number of the latest send that carried each node, asset and the order. */
type Carried = { nodes: Map<string, number>; assets: Map<string, number>; order: number };

export class TeamOutbox {
  private waiting = new Map<string, TeamPatch>();
  private sends = new Map<string, number>();
  private carried = new Map<string, Carried>();
  private tickets = new WeakMap<TeamPatch, number>();

  /** A new local edit in production `pid`. */
  add(pid: string, patch: TeamPatch) {
    this.waiting.set(pid, mergePatches(this.waiting.get(pid) ?? null, patch));
  }

  /** Everything waiting, handed out once, each with its own production. */
  take(): [pid: string, patch: TeamPatch][] {
    const out = [...this.waiting];
    this.waiting.clear();
    for (const [pid, patch] of out) {
      const ticket = (this.sends.get(pid) ?? 0) + 1;
      this.sends.set(pid, ticket);
      this.tickets.set(patch, ticket);
      const carried = this.carried.get(pid) ?? { nodes: new Map(), assets: new Map(), order: 0 };
      for (const n of patch.upsertNodes) carried.nodes.set(n.id, ticket);
      for (const id of patch.removeNodes) carried.nodes.set(id, ticket);
      for (const a of patch.upsertAssets) carried.assets.set(a.id, ticket);
      if (patch.order) carried.order = ticket;
      this.carried.set(pid, carried);
    }
    return out;
  }

  /**
   * A send that did not arrive goes back under its own production, less what a
   * later send already carried; edits made since are newer and win.
   */
  keep(pid: string, patch: TeamPatch) {
    const ticket = this.tickets.get(patch);
    const carried = this.carried.get(pid);
    const newer = (at: number | undefined) => ticket !== undefined && at !== undefined && at > ticket;
    const rest: TeamPatch = carried && ticket !== undefined ? {
      ...patch,
      upsertNodes: patch.upsertNodes.filter((n) => !newer(carried.nodes.get(n.id))),
      removeNodes: patch.removeNodes.filter((id) => !newer(carried.nodes.get(id))),
      upsertAssets: patch.upsertAssets.filter((a) => !newer(carried.assets.get(a.id))),
      order: newer(carried.order) ? null : patch.order,
    } : patch;
    if (!rest.upsertNodes.length && !rest.removeNodes.length && !rest.upsertAssets.length && !rest.order) return;
    const later = this.waiting.get(pid);
    this.waiting.set(pid, later ? mergePatches(rest, later) : rest);
  }

  get size() {
    return this.waiting.size;
  }
}

/**
 * What a failed send means. A refusal (the server answered with a 4xx) will be
 * refused again: it is dropped and reported, never merged into later edits,
 * which would make every later edit fail with it. Anything else (no
 * connection, a 5xx) is kept and retried.
 */
export function sendFailure(error: unknown): "refused" | "retry" {
  return error instanceof DraftRequestError && !error.retryable ? "refused" : "retry";
}
