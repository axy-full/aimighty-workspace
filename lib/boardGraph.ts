import type { Board, BoardNode } from "./boards";

/**
 * Anything downstream of a changed node goes stale — never re-run on its
 * own (§8). Follows wires forward from `nodeId`; nodes that already have
 * an output are marked with the moment; nodes that never ran are left.
 */
export function markStale(board: Board, nodeId: string, at = Date.now()): BoardNode[] {
  const downstream = new Set<string>();
  const walk = (id: string) => {
    for (const w of board.wires) if (w.from.nodeId === id && !downstream.has(w.to.nodeId)) { downstream.add(w.to.nodeId); walk(w.to.nodeId); }
  };
  walk(nodeId);
  return board.nodes.map((n) => downstream.has(n.id) && n.output?.genId ? { ...n, state: "stale", staleSince: n.staleSince ?? at } : n);
}
