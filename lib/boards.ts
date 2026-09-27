import { withMediaSources } from "./mediaMutation";
import { db, ready, id as newId, now } from "./db";

/**
 * Boards (design/particl-v2/README.md §8, §15): the Canvas as a generation
 * graph. A board belongs to a project and holds its nodes and wires as
 * data — `node { id, kind, x, y, ports[], inputs[], output, settings,
 * state, credits, staleSince }`, `wire { from: {nodeId, portId}, to:
 * {nodeId, slotId}, kind }` — exactly §15's shape, stored as JSON on the
 * row, because a board is read and written whole and its graph has no
 * meaning outside itself.
 *
 * Building is free. A node prices itself before it runs; running it goes
 * through the ordinary generate route and the output lives in the node
 * that made it (`output.genId`) and files to a shot as its next version.
 * Changing anything upstream marks downstream nodes stale (`staleSince`);
 * nothing re-runs on its own. A board saved as a recipe becomes stages —
 * `lib/runs.ts` owns those.
 */

export type NodeKind = "asset" | "shot" | "prompt" | "image" | "video" | "edit" | "upscale" | "audio" | "voice" | "compare" | "note";
export type NodeState = "idle" | "priced" | "running" | "done" | "failed" | "stale";
export type WireKind = "inherited" | "override" | "filed" | "created";

export type BoardPort = { id: string; label: string; version?: string | null; attributeId?: string | null; versionId?: string | null; idle?: boolean };
export type BoardInput = { id: string; label: string; from?: { nodeId: string; portId: string } | null };
export type BoardOutput = { genId?: string | null; url?: string | null; kind?: "image" | "video" | "audio" | null; label?: string | null; filedTo?: { shotId: string; version: number } | null; variants?: { genId: string; url: string | null; chosen?: boolean }[]; /** How long the render took, for `DONE · 4 MIN`. */ tookMs?: number | null };

export type BoardNode = {
  id: string; kind: NodeKind; x: number; y: number;
  /** What the node shows as its name: `@Noor`, `SH04`, `Nano Banana Pro`. */
  label: string;
  /** The thing it stands for: an element, a shot, an engine. */
  ref?: { elementId?: string; shotId?: string; engine?: string } | null;
  ports: BoardPort[];
  inputs: BoardInput[];
  output: BoardOutput | null;
  settings: Record<string, unknown>;
  state: NodeState;
  credits: number;
  staleSince: number | null;
  text?: string;
};

export type BoardWire = { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; slotId: string }; kind: WireKind };

export type Board = { id: string; projectId: string; name: string; nodes: BoardNode[]; wires: BoardWire[]; createdAt: number; updatedAt: number };

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Row = any;
const json = <T,>(raw: unknown, fallback: T): T => { if (typeof raw !== "string" || !raw) return fallback; try { return JSON.parse(raw) as T; } catch { return fallback; } };

const toBoard = (r: Row): Board => ({
  id: String(r.id), projectId: String(r.project_id), name: String(r.name ?? "Board"),
  nodes: json<BoardNode[]>(r.nodes, []), wires: json<BoardWire[]>(r.wires, []),
  createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0),
});

export async function listBoards(projectId: string): Promise<Board[]> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM boards WHERE project_id = ? ORDER BY created_at ASC`, args: [projectId] });
  return rs.rows.map(toBoard);
}

export async function getBoard(boardId: string): Promise<Board | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM boards WHERE id = ?`, args: [boardId] });
  return rs.rows.length ? toBoard(rs.rows[0]) : null;
}

export async function createBoard(projectId: string, name: string): Promise<Board> {
  await ready();
  const at = now(); const bid = newId("brd");
  await db().execute({ sql: `INSERT INTO boards (id, project_id, name, nodes, wires, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, args: [bid, projectId, name.trim().slice(0, 80) || "Board", "[]", "[]", at, at] });
  return (await getBoard(bid))!;
}

type BoardPatch = { name?: string; nodes?: BoardNode[]; wires?: BoardWire[] };

/** The whole graph, written back; the board is the unit of edit. */
export async function saveBoard(boardId: string, patch: BoardPatch): Promise<Board | null> {
  const saved = await writeBoard(boardId, patch, null);
  return saved && "board" in saved ? saved.board : null;
}

/**
 * The same write, refused when the board has changed since `expectedUpdatedAt`
 * — the revision the browser edited from. Two people on one board used to
 * overwrite each other's whole graph on every keystroke; now the second write
 * gets the board as it stands instead, and nothing is lost.
 */
export async function saveBoardIfCurrent(boardId: string, patch: BoardPatch, expectedUpdatedAt: number): Promise<{ board: Board } | { conflict: Board } | null> {
  return writeBoard(boardId, patch, expectedUpdatedAt);
}

async function writeBoard(boardId: string, patch: BoardPatch, expected: number | null): Promise<{ board: Board } | { conflict: Board } | null> {
  await ready();
  const sets: string[] = []; const args: unknown[] = [];
  if (typeof patch.name === "string") { sets.push("name = ?"); args.push(patch.name.trim().slice(0, 80)); }
  if (patch.nodes) { sets.push("nodes = ?"); args.push(JSON.stringify(patch.nodes.slice(0, 200))); }
  if (patch.wires) { sets.push("wires = ?"); args.push(JSON.stringify(patch.wires.slice(0, 400))); }
  if (!sets.length) { const board = await getBoard(boardId); return board ? { board } : null; }
  /* Strictly later than the revision it replaces, so two writes in one
     millisecond can never share a revision. */
  sets.push("updated_at = ?"); args.push(expected == null ? now() : Math.max(now(), expected + 1), boardId);
  const where = expected == null ? "id = ?" : "id = ? AND updated_at = ?";
  if (expected != null) args.push(expected);
  const written = await withMediaSources(patch.nodes?.slice(0, 200), (tx) => tx.execute({ sql: `UPDATE boards SET ${sets.join(", ")} WHERE ${where}`, args: args as never[] }));
  const board = await getBoard(boardId);
  if (!board) return null;
  if (expected != null && Number(written.rowsAffected ?? 0) === 0) return { conflict: board };
  return { board };
}

export { markStale } from "./boardGraph";
