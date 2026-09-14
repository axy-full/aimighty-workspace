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

/** The whole graph, written back; the board is the unit of edit. */
export async function saveBoard(boardId: string, patch: { name?: string; nodes?: BoardNode[]; wires?: BoardWire[] }): Promise<Board | null> {
  await ready();
  const sets: string[] = []; const args: unknown[] = [];
  if (typeof patch.name === "string") { sets.push("name = ?"); args.push(patch.name.trim().slice(0, 80)); }
  if (patch.nodes) { sets.push("nodes = ?"); args.push(JSON.stringify(patch.nodes.slice(0, 200))); }
  if (patch.wires) { sets.push("wires = ?"); args.push(JSON.stringify(patch.wires.slice(0, 400))); }
  if (!sets.length) return getBoard(boardId);
  sets.push("updated_at = ?"); args.push(now(), boardId);
  await withMediaSources(patch.nodes?.slice(0, 200), (tx) => tx.execute({ sql: `UPDATE boards SET ${sets.join(", ")} WHERE id = ?`, args: args as never[] }));
  return getBoard(boardId);
}

export { markStale } from "./boardGraph";
