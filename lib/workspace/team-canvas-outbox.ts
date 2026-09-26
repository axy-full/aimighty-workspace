import { DraftRequestError } from "../workbench/draft-request";
import type { TeamPatch } from "../workbench/team-canvas-model";

/*
 * The Rig's team canvas edits waiting to be sent (components/workspace/rig/use-team-canvas.ts).
 *
 * Every edit is filed under the production it was made in and is only ever
 * sent there. Switching projects while an edit waits, or while one is being
 * retried, can never land it in the next production's canvas.
 */

/** Several edits between saves travel as one patch: the last write of each node wins. */
export function mergePatches(a: TeamPatch | null, b: TeamPatch): TeamPatch {
  if (!a) return b;
  const nodes = new Map(a.upsertNodes.map((n) => [n.id, n]));
  const removed = new Set(a.removeNodes);
  for (const n of b.upsertNodes) { nodes.set(n.id, n); removed.delete(n.id); }
  for (const id of b.removeNodes) { removed.add(id); nodes.delete(id); }
  const assets = new Map(a.upsertAssets.map((x) => [x.id, x]));
  for (const x of b.upsertAssets) assets.set(x.id, x);
  return { upsertNodes: [...nodes.values()], removeNodes: [...removed], upsertAssets: [...assets.values()], order: b.order ?? a.order, at: b.at };
}

export class TeamOutbox {
  private waiting = new Map<string, TeamPatch>();

  /** A new local edit in production `pid`. */
  add(pid: string, patch: TeamPatch) {
    this.waiting.set(pid, mergePatches(this.waiting.get(pid) ?? null, patch));
  }

  /** Everything waiting, handed out once, each with its own production. */
  take(): [pid: string, patch: TeamPatch][] {
    const out = [...this.waiting];
    this.waiting.clear();
    return out;
  }

  /** A send that did not arrive goes back under its own production; edits made since are newer and win. */
  keep(pid: string, patch: TeamPatch) {
    const later = this.waiting.get(pid);
    this.waiting.set(pid, later ? mergePatches(patch, later) : patch);
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
