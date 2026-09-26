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
 * page offers a reload).
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
};

export function createBoardSaver(opts: {
  put: (body: string) => Promise<PutResponse>;
  onState: (state: SaveState) => void;
  /** The `updatedAt` of the board as it was loaded. */
  baseUpdatedAt: number;
}): BoardSaver {
  let base = opts.baseUpdatedAt;
  let pending: Graph | null = null;
  let inFlight = false;
  let blocked = false;

  const reason = (res: PutResponse, json: { error?: unknown } | null) =>
    typeof json?.error === "string" && json.error ? json.error : `The server answered ${res.status}.`;

  async function drain() {
    if (inFlight || blocked || !pending) return;
    inFlight = true;
    try {
      while (pending && !blocked) {
        const graph = pending;
        pending = null;
        opts.onState({ kind: "saving" });
        let res: PutResponse;
        try {
          res = await opts.put(JSON.stringify({ nodes: graph.nodes, wires: graph.wires, baseUpdatedAt: base }));
        } catch (error) {
          pending = pending ?? graph;
          opts.onState({ kind: "failed", message: error instanceof Error && error.message ? error.message : "The board could not be reached." });
          return;
        }
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as { error?: unknown; conflict?: unknown } | null;
          pending = pending ?? graph;
          /* Only the route's revision check is a teammate's save. Another 409 — a
             referenced upload or take that is gone — is a refusal like any other. */
          if (res.status === 409 && json?.conflict === true) {
            blocked = true;
            opts.onState({ kind: "conflict" });
          } else {
            opts.onState({ kind: "failed", message: reason(res, json) });
          }
          return;
        }
        const json = (await res.json().catch(() => null)) as { board?: { updatedAt?: unknown } } | null;
        const at = Number(json?.board?.updatedAt);
        if (Number.isFinite(at) && at > 0) base = at;
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
  };
}
