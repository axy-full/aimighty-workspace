import type { InStatement, ResultSet } from "@libsql/client";
import { db, now, ready } from "@/lib/db";
import { TEAM_EDIT_SQL } from "@/lib/draftProject";
import { requireTenant } from "@/lib/tenant";
import { liveRooms, type RoomClient } from "./canvas-push";
import { teamRoomFor } from "./team-canvas";

/**
 * The live room is rotated when the people who may write a board change for the worse: Can edit taken away, sharing stopped, or a member who could hold a
 * token (the owner, or any editor) switched off or removed.
 *
 * A Liveblocks ACCESS token (what /api/collab/auth issues) cannot be revoked before it expires, and the connection it opened stays open: an editor
 * who was just removed would go on receiving the board's live edits and pushing their own. So the room a production is edited in carries a
 * generation, kept here (a settings row of the workspace, no migration). Rotating bumps it: from then on the server names the new room, issues tokens
 * for it alone, and refuses a token for any older one. The bump is one statement, and for a share change it is part of the same transaction as the change
 * itself (lib/workbench/records.ts › setBoardSharing), so the two cannot disagree. Afterwards the old room is deleted through Liveblocks' REST API
 * (`deleteRoom`, in the installed @liveblocks/node), which closes every connection to it; that call is retried, and if it still fails nothing is lost: the
 * generation already keeps the old room's tokens out, and the room ends on its own once nobody is in it. The new room starts from the saved canvas (the first
 * window in), never from what was in the old room, so nothing a removed editor sent after the change can reach it.
 */
const KEY = (productionId: string) => `collab:room-generation:${productionId}`;

type Exec = { execute(statement: InStatement): Promise<ResultSet> };

export async function roomGeneration(productionId: string, ex: Exec = db()): Promise<number> {
  const row = (await ex.execute({ sql: "SELECT value FROM settings WHERE key=? LIMIT 1", args: [KEY(productionId)] })).rows[0] as { value?: unknown } | undefined;
  const n = row ? Number(row.value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The room the production's canvas is edited in right now. */
export async function currentRoom(workspaceId: string, productionId: string): Promise<string> {
  return teamRoomFor(workspaceId, productionId, await roomGeneration(productionId));
}

/** Move the production to its next room: names, and nothing else, so it can run inside a caller's transaction. Returns the room that closed and the one that opens. */
export async function bumpRoomGeneration(ex: Exec, workspaceId: string, productionId: string): Promise<{ from: string; to: string }> {
  const before = await roomGeneration(productionId, ex);
  await ex.execute({
    sql: `INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,'1','system',?)
          ON CONFLICT(key) DO UPDATE SET value=CAST(settings.value AS INTEGER)+1, updated_at=excluded.updated_at`,
    args: [KEY(productionId), now()],
  });
  return { from: teamRoomFor(workspaceId, productionId, before), to: teamRoomFor(workspaceId, productionId, before + 1) };
}

/** Delete the closed room so its connections end: three tries, never throws. True when Liveblocks confirmed (or there was no such room). */
export async function closeRoom(room: string, rooms: Pick<RoomClient, "deleteRoom"> | null = liveRooms(), pausesMs: number[] = [250, 1500]): Promise<boolean> {
  if (!rooms?.deleteRoom) return true;
  for (let attempt = 0; ; attempt++) {
    try { await rooms.deleteRoom(room); return true; }
    catch (error) {
      if ((error as { status?: number })?.status === 404) return true;
      if (attempt >= pausesMs.length) return false;
      await new Promise((resolve) => setTimeout(resolve, pausesMs[attempt]));
    }
  }
}

/** Close the production's current room and start the next (the generation first, then the old room's connections). */
export async function rotateRoom(productionId: string, rooms: Pick<RoomClient, "deleteRoom"> | null = liveRooms(), pausesMs?: number[]): Promise<{ from: string; to: string; closed: boolean }> {
  const moved = await bumpRoomGeneration(db(), requireTenant().id, productionId);
  return { ...moved, closed: await closeRoom(moved.from, rooms, pausesMs) };
}

/**
 * Every board shared with "Can edit" in this workspace changes room: a member who was switched off or removed may hold a token for any of them (as an
 * editor) or own some (their boards' Can edit lapses with them). Called after the membership change has committed. The generations move here, at once (so no
 * old token is honoured from this moment); the rooms they replace are returned, to be closed afterwards with `closeRooms`, not inside the request.
 */
export async function bumpEditRooms(): Promise<string[]> {
  /* A workspace database that was never set up has no board table: set it up first, so a removal never fails for want of it (and a real failure below is a real one). */
  await ready();
  const workspaceId = requireTenant().id;
  /* The production each board is edited in is the one its draft is linked to (`productionProjectId`), the same one setBoardSharing rotates: not a recomputed default, which would
     miss the real room of a draft linked to another production and leave a removed member's token for it honoured. */
  const boards = (await db().execute({ sql: `SELECT json_extract(body,'$.productionProjectId') AS production FROM workbench_projects WHERE ${TEAM_EDIT_SQL}`, args: [] })).rows;
  const productions = [...new Set(boards.flatMap((board) => (typeof board.production === "string" && board.production ? [board.production] : [])))];
  const closed: string[] = [];
  for (const production of productions) closed.push((await bumpRoomGeneration(db(), workspaceId, production)).from);
  return closed;
}

/** Close several old rooms at once (each with its own retries); never throws. */
export async function closeRooms(rooms: readonly string[], client: Pick<RoomClient, "deleteRoom"> | null = liveRooms(), pausesMs?: number[]): Promise<boolean[]> {
  return Promise.all(rooms.map((room) => closeRoom(room, client, pausesMs)));
}
