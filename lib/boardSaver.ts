/**
 * The Rig board's autosave (app/(app)/rig/canvas/[boardId]).
 *
 * A board is written whole, so two things used to go wrong silently: a PUT
 * that failed (a lapsed session, a server fault, no network) looked saved
 * until the reload, and two people on one board overwrote each other with
 * every keystroke. This keeps the graph until the server has it, and sends
 * the revision it was edited from so the server can refuse a stale write.
 *
 * One write is in flight at a time and only the newest graph waits behind it
 * — the graph is whole, so an older unsent one is never needed. A failed write
 * keeps its graph and goes again on the next edit or on retry(). A revision
 * conflict (409 with `conflict: true`) stops writing altogether: the board
 * changed elsewhere, and only the person can decide what happens next (the
 * page reloads the board and puts back what they added: reapplyAdditions).
 *
 * One conflict is not a teammate at all: a write the server committed whose
 * answer never arrived (the network dropped it, or the server failed after the
 * commit). The next write then carries a revision that is one behind — its own.
 * When the board the server answers with IS the graph whose fate was unknown,
 * the saver takes its revision and carries on.
 */
export type SaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "failed"; message: string }
  | { kind: "conflict" };

export type Graph = { nodes: unknown[]; wires: unknown[] };

type PutResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

export type BoardSaver = {
  save: (graph: Graph) => void;
  retry: () => void;
  /** True while a graph is unsent, failed or in flight. */
  dirty: () => boolean;
  /** The last graph the server is known to hold from this saver (or the one it was loaded with). */
  accepted: () => Graph;
};

/** The graph as the server stores it: whole nodes and wires, compared as JSON. */
const sameGraph = (a: Graph, b: Graph): boolean => JSON.stringify({ nodes: a.nodes, wires: a.wires }) === JSON.stringify({ nodes: b.nodes, wires: b.wires });

export function createBoardSaver(opts: {
  put: (body: string) => Promise<PutResponse>;
  onState: (state: SaveState) => void;
  /** The `updatedAt` of the board as it was loaded. */
  baseUpdatedAt: number;
  /** The graph of the board as it was loaded. */
  baseGraph?: Graph;
}): BoardSaver {
  let base = opts.baseUpdatedAt;
  let accepted: Graph = opts.baseGraph ?? { nodes: [], wires: [] };
  let pending: Graph | null = null;
  let inFlight = false;
  let blocked = false;
  /* A graph sent whose answer never came: it may be on the server already. */
  let uncertain: Graph | null = null;

  const reason = (res: PutResponse, json: { error?: unknown } | null) =>
    typeof json?.error === "string" && json.error ? json.error : `The server answered ${res.status}.`;

  async function drain() {
    if (inFlight || blocked || !pending) return;
    inFlight = true;
    try {
      while (pending && !blocked) {
        const graph: Graph = pending;
        pending = null;
        opts.onState({ kind: "saving" });
        let res: PutResponse;
        try {
          res = await opts.put(JSON.stringify({ nodes: graph.nodes, wires: graph.wires, baseUpdatedAt: base }));
        } catch (error) {
          pending = pending ?? graph;
          uncertain = graph;
          opts.onState({ kind: "failed", message: error instanceof Error && error.message ? error.message : "The board could not be reached." });
          return;
        }
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as { error?: unknown; conflict?: unknown; board?: { nodes?: unknown; wires?: unknown; updatedAt?: unknown } } | null;
          pending = pending ?? graph;
          /* Only the route's revision check is a teammate's save. Another 409 — a
             referenced upload or take that is gone — is a refusal like any other. */
          if (res.status === 409 && json?.conflict === true) {
            const theirs = json.board;
            const at = Number(theirs?.updatedAt);
            /* The board as it stands is the write whose answer was lost: ours. */
            if (uncertain && theirs && Array.isArray(theirs.nodes) && Array.isArray(theirs.wires) && Number.isFinite(at) && at > 0
              && sameGraph({ nodes: theirs.nodes, wires: theirs.wires }, uncertain)) {
              base = at;
              accepted = uncertain;
              uncertain = null;
              continue;
            }
            blocked = true;
            opts.onState({ kind: "conflict" });
          } else {
            /* A server fault may come after the write committed. */
            if (res.status >= 500) uncertain = graph;
            opts.onState({ kind: "failed", message: reason(res, json) });
          }
          return;
        }
        const json = (await res.json().catch(() => null)) as { board?: { updatedAt?: unknown } } | null;
        const at = Number(json?.board?.updatedAt);
        if (Number.isFinite(at) && at > 0) base = at;
        accepted = graph;
        uncertain = null;
      }
      if (!blocked && !pending) opts.onState({ kind: "saved" });
    } finally {
      inFlight = false;
    }
  }

  return {
    save(graph) {
      pending = graph;
      void drain();
    },
    retry() {
      void drain();
    },
    dirty: () => inFlight || pending != null,
    accepted: () => accepted,
  };
}

type Node = { id: string };
type Wire = { id: string; from: { nodeId: string }; to: { nodeId: string; slotId: string } };

/**
 * After a conflict, the board as it stands with the nodes this person ADDED
 * put back: nodes in their unsaved graph that neither the server's board nor
 * the last graph the server took from them has, with the wires INTO those
 * nodes (a node carries its own inputs, so those wires agree with it). A wire
 * comes back only when its source still exists. Everything else — moves,
 * edits, deletions, wires into a teammate's node — is the server's, because
 * without the other person's intent there is no safe merge of those.
 */
export function reapplyAdditions<N extends Node, W extends Wire>(server: { nodes: N[]; wires: W[] }, mine: { nodes: unknown[]; wires: unknown[] }, accepted: { nodes: unknown[]; wires: unknown[] }): { nodes: N[]; wires: W[]; added: number } {
  const idsOf = (list: unknown[]) => new Set(list.map((x) => (x as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string"));
  const known = new Set([...idsOf(server.nodes), ...idsOf(accepted.nodes)]);
  const nodes = [...server.nodes];
  const fresh = new Set<string>();
  for (const n of mine.nodes as N[]) {
    if (n && typeof n.id === "string" && !known.has(n.id)) { nodes.push(n); known.add(n.id); fresh.add(n.id); }
  }
  const present = new Set(nodes.map((n) => n.id));
  const knownWires = idsOf(server.wires);
  const wires = [...server.wires];
  for (const w of mine.wires as W[]) {
    if (!w || typeof w.id !== "string" || knownWires.has(w.id) || !w.from || !w.to) continue;
    if (!fresh.has(w.to.nodeId) || !present.has(w.from.nodeId)) continue;
    wires.push(w); knownWires.add(w.id);
  }
  return { nodes, wires, added: fresh.size };
}
