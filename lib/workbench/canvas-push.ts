import { after } from "next/server";
import { Liveblocks } from "@liveblocks/node";
import { db, now } from "@/lib/db";
import { collabConfigured } from "@/lib/collab";
import { currentTenant, requireTenant, runInTenant } from "@/lib/tenant";
import { canvasOpsExist, rowOf, type CanvasOpRow } from "./canvas-ops-log";
import { focusPoint, roomPatchFor } from "./canvas-ops-model";
import { orderedIds, writeRoom, type RoomStorage } from "./team-canvas-model";
import { readTeamCanvas, teamRoomFor } from "./team-canvas";
import { workbenchTransaction } from "./records";

/*
 * Server-made canvas changes, pushed into the production's live room so every
 * open window has them at once (plan §5.2: required, not optional — a window
 * that joins a room missing a server-made card would otherwise lose it).
 *
 * The outbox is the log itself (lib/workbench/canvas-ops-log.ts): a change the
 * room has not taken stays `pending` and is pushed again, oldest first, until
 * it lands. A production's pending changes go out together, in order, under
 * one lease, so a later change never reaches the room before an earlier one.
 * Each lands by writeRoom's rules (a made card joins only a room that lacks
 * it; a changed field lands only where the room still holds what the canvas
 * had before), so a push that arrives twice changes nothing and a teammate's
 * edit that reached the room first stands.
 *
 * Atomik shows in the room while it works: an ephemeral presence (Liveblocks
 * setPresence) with its cursor on the card it touched last. Nothing here is
 * paid, and a push never carries anything but the canvas the room already
 * shares.
 */

/** What the push uses of Liveblocks' server client; a test passes a stand-in. */
export type RoomClient = {
  mutateStorage(roomId: string, callback: (context: { root: LiveRoot }) => void | Promise<void>, options?: { signal?: AbortSignal }): Promise<void>;
  setPresence(roomId: string, params: { userId: string; data: Record<string, unknown>; userInfo?: Record<string, unknown>; ttl?: number }, options?: { signal?: AbortSignal }): Promise<void>;
};
export type LiveRoot = { get(key: string): unknown; set(key: string, value: unknown): void };
type LiveMapLike = { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): unknown };

/** Atomik as the room shows it. */
export const ATOMIK_PRESENCE = { id: "particl-atomik", name: "Atomik", color: "#e0b95e" } as const;
/** How long Atomik's presence stays after its last change (Liveblocks: 2–3,599 s). */
const PRESENCE_TTL_S = 12;
const LEASE_MS = 30_000;
/** A push that has not landed by then counts as not landed (it waits in the outbox); well inside the lease. */
const PUSH_TIMEOUT_MS = 8_000;
const PRESENCE_TIMEOUT_MS = 3_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** The live rooms, when the owner's Liveblocks key is set; otherwise there is nothing to push to. */
export function liveRooms(): RoomClient | null {
  if (!collabConfigured()) return null;
  return new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY! }) as unknown as RoomClient;
}

const isMap = (value: unknown): value is LiveMapLike =>
  !!value && typeof value === "object" && typeof (value as LiveMapLike).get === "function" && typeof (value as LiveMapLike).set === "function" && typeof (value as LiveMapLike).delete === "function";

/** The room's storage as writeRoom uses it, or null when the room holds no canvas yet. */
export function roomStorage(root: LiveRoot): RoomStorage | null {
  const nodes = root.get("nodes"), assets = root.get("assets");
  if (!isMap(nodes) || !isMap(assets)) return null;
  const list = (value: unknown): string[] => {
    const items = Array.isArray(value) ? value : value && typeof (value as { toArray?: () => unknown[] }).toArray === "function" ? (value as { toArray: () => unknown[] }).toArray() : [];
    return items.filter((id): id is string => typeof id === "string");
  };
  return {
    nodes: { get: (id) => nodes.get(id), set: (id, value) => nodes.set(id, value), delete: (id) => { nodes.delete(id); } },
    assets: { get: (id) => assets.get(id), set: (id, value) => assets.set(id, value) },
    order: () => list(root.get("order")),
    setOrder: (order) => root.set("order", order),
    serverMade: () => {
      const made = root.get("serverMade");
      return made && typeof made === "object" && !Array.isArray(made) ? (made as Record<string, string>) : {};
    },
    setServerMade: (made) => root.set("serverMade", made),
  };
}

/** One logged change, into the room. */
export function pushRow(room: RoomStorage, row: Pick<CanvasOpRow, "changes" | "assets" | "author">) {
  writeRoom(room, roomPatchFor(row.changes, row.assets));
  const madeIds = row.changes.filter((c) => c.made).map((c) => c.id);
  if (!madeIds.length) return;
  /* A made card joins the end of the order (a teammate's reordering meanwhile stands), and the room learns the server made it. */
  const order = room.order();
  const joining = madeIds.filter((id) => !order.includes(id) && room.nodes.get(id));
  if (joining.length) room.setOrder([...order, ...joining]);
  const made = room.serverMade();
  if (madeIds.some((id) => !made[id])) room.setServerMade({ ...made, ...Object.fromEntries(madeIds.filter((id) => !made[id]).map((id) => [id, row.author])) });
}

const statusOf = (error: unknown) =>
  error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;

const DOING: Record<string, string> = { tidy: "Tidying the board", reassert: "Keeping the team's cards", import: "Bringing an old board across", ops: "Working on the board", agent: "Building the board", "agent-undo": "Taking its build off the board" };

/**
 * Pushes every pending change of one production, in order, if one is due and
 * no other drain holds them. `sent`: changes the room took; `waiting`: still
 * in the outbox (pushed again later, from the next change, the next window
 * that reads the canvas, or the cron).
 */
async function drainProduction(productionId: string, rooms: RoomClient): Promise<{ sent: number; waiting: number }> {
  const t = now();
  /* Most reads find nothing waiting: a read, never a write, answers that. */
  if (!(await db().execute({ sql: "SELECT 1 FROM rig_canvas_ops WHERE production_id=? AND push='pending' AND push_after<=? LIMIT 1", args: [productionId, t] })).rows.length)
    return { sent: 0, waiting: 0 };
  const lease = t + LEASE_MS + Math.floor(Math.random() * 1000);
  /* Claimed whole, under the write lock: every pending change of this production, once one is due and no other drain
     holds them. A later change never goes out before an earlier one. */
  const rows = await workbenchTransaction(async (tx) => {
    const held = await tx.execute({ sql: "SELECT 1 FROM rig_canvas_ops WHERE production_id=? AND push='pending' AND push_lease>? LIMIT 1", args: [productionId, t] });
    const due = await tx.execute({ sql: "SELECT 1 FROM rig_canvas_ops WHERE production_id=? AND push='pending' AND push_after<=? LIMIT 1", args: [productionId, t] });
    if (held.rows.length || !due.rows.length) return [];
    await tx.execute({ sql: "UPDATE rig_canvas_ops SET push_lease=? WHERE production_id=? AND push='pending'", args: [lease, productionId] });
    return (await tx.execute({ sql: "SELECT * FROM rig_canvas_ops WHERE production_id=? AND push_lease=? ORDER BY seq", args: [productionId, lease] }))
      .rows.map((row) => rowOf(row as unknown as Record<string, unknown>));
  });
  const waiting = async () => Number((await db().execute({ sql: "SELECT COUNT(*) AS n FROM rig_canvas_ops WHERE production_id=? AND push='pending'", args: [productionId] })).rows[0].n);
  if (!rows.length) return { sent: 0, waiting: await waiting() };
  const room = teamRoomFor(requireTenant().id, productionId);
  try {
    await rooms.mutateStorage(room, ({ root }) => {
      const storage = roomStorage(root);
      /* A room with no canvas yet: the first window to open it brings the saved one, this change included. */
      if (!storage) return;
      for (const row of rows) pushRow(storage, row);
    }, { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) {
      /* No such room: nobody has opened it. The first window to open it starts it from the saved canvas. */
      await db().execute({ sql: "UPDATE rig_canvas_ops SET push='done',pushed_at=?,push_lease=NULL,push_error='no room' WHERE production_id=? AND push_lease=?", args: [now(), productionId, lease] });
      return { sent: rows.length, waiting: await waiting() };
    }
    const attempts = Math.max(...rows.map((r) => r.pushAttempts)) + 1;
    /* Only the status is kept: an error's text can carry request details. */
    await db().execute({
      sql: "UPDATE rig_canvas_ops SET push_attempts=?,push_after=?,push_error=?,push_lease=NULL WHERE production_id=? AND push_lease=?",
      args: [attempts, now() + Math.min(BACKOFF_MAX_MS, 2000 * 2 ** (attempts - 1)), status ? `status ${status}` : "unreachable", productionId, lease],
    });
    return { sent: 0, waiting: await waiting() };
  }
  await db().execute({ sql: "UPDATE rig_canvas_ops SET push='done',pushed_at=?,push_lease=NULL,push_error=NULL WHERE production_id=? AND push_lease=?", args: [now(), productionId, lease] });
  await showAtomik(rooms, room, productionId, rows.at(-1)!).catch(() => {});
  return { sent: rows.length, waiting: await waiting() };
}

/** Atomik's presence in the room, on the card it touched last (best effort: presence is only a courtesy). */
async function showAtomik(rooms: RoomClient, room: string, productionId: string, row: CanvasOpRow) {
  const saved = row.focus ? await readTeamCanvas(productionId) : null;
  const nodes = saved ? orderedIds(saved.canvas).map((id) => saved.canvas.nodes[id]) : [];
  const cursor = row.focus ? focusPoint(nodes, row.focus) : null;
  await rooms.setPresence(room, {
    userId: ATOMIK_PRESENCE.id,
    data: { cursor, selected: cursor ? row.focus : null, drag: null, doing: DOING[row.what] ?? DOING.ops },
    userInfo: { name: ATOMIK_PRESENCE.name, color: ATOMIK_PRESENCE.color, agent: true },
    ttl: PRESENCE_TTL_S,
  }, { signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS) });
}

/**
 * Drains the outbox: one production's pending changes, or (from the cron)
 * every production with one due, within the deadline. With rooms off there is
 * nothing to push to: pending changes are marked so, since the first window to
 * open a room starts it from the saved canvas.
 */
export async function drainCanvasPushes(productionId: string | null, options: { room?: RoomClient | null; limit?: number; deadlineAt?: number } = {}): Promise<{ sent: number; waiting: number }> {
  const out = { sent: 0, waiting: 0 };
  if (!(await canvasOpsExist())) return out;
  const rooms = options.room === undefined ? liveRooms() : options.room;
  if (!rooms) {
    const which = productionId ? " AND production_id=?" : "", args = productionId ? [productionId] : [];
    if ((await db().execute({ sql: `SELECT 1 FROM rig_canvas_ops WHERE push='pending'${which} LIMIT 1`, args })).rows.length)
      await db().execute({ sql: `UPDATE rig_canvas_ops SET push='none' WHERE push='pending'${which}`, args });
    return out;
  }
  const productions = productionId
    ? [productionId]
    : (await db().execute({ sql: "SELECT DISTINCT production_id FROM rig_canvas_ops WHERE push='pending' AND push_after<=? LIMIT ?", args: [now(), options.limit ?? 8] })).rows.map((r) => String(r.production_id));
  for (const pid of productions) {
    if (options.deadlineAt && now() >= options.deadlineAt) break;
    const result = await drainProduction(pid, rooms);
    out.sent += result.sent;
    out.waiting += result.waiting;
  }
  return out;
}

/** After this response: push a production's pending changes (a request that only noticed them never waits on the room). */
export function scheduleCanvasPush(productionId: string) {
  const workspace = currentTenant()?.workspace;
  if (!workspace || !collabConfigured()) return;
  const run = () => runInTenant(workspace, () => drainCanvasPushes(productionId)).then(() => {}, () => {});
  try { after(run); } catch { /* Outside a request: the outbox keeps it for the next drain. */ }
}
