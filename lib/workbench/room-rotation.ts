import { db, now } from "@/lib/db";
import { liveRooms, type RoomClient } from "./canvas-push";
import { teamRoomFor } from "./team-canvas";
import { requireTenant } from "@/lib/tenant";

/**
 * The live room is rotated when the people who may write a board change for the worse (Can edit taken away, or sharing stopped).
 *
 * A Liveblocks ACCESS token (what /api/collab/auth issues) cannot be revoked before it expires, and the connection it opened stays open: an editor
 * who was just removed would go on receiving the board's live edits and pushing their own. So the room a production is edited in carries a
 * generation, kept here (a settings row of the workspace, no migration). Rotating bumps it: from then on the server names the new room, issues tokens
 * for it alone, and refuses a token for any older one, and the old room is deleted through Liveblocks' REST API (`deleteRoom`, in the installed
 * @liveblocks/node), which closes every connection to it. The new room starts from the saved canvas (the first window in), never from what was in the
 * old room, so nothing a removed editor sent after the change can reach it.
 */
const KEY = (productionId: string) => `collab:room-generation:${productionId}`;

export async function roomGeneration(productionId: string): Promise<number> {
  const row = (await db().execute({ sql: "SELECT value FROM settings WHERE key=? LIMIT 1", args: [KEY(productionId)] })).rows[0];
  const n = row ? Number(row.value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The room the production's canvas is edited in right now. */
export async function currentRoom(workspaceId: string, productionId: string): Promise<string> {
  return teamRoomFor(workspaceId, productionId, await roomGeneration(productionId));
}

/**
 * Close the production's current room and start the next: the generation moves first (no new token for the old room from this moment), then the old room
 * is deleted so its open connections end. A room that does not exist (nobody had opened it) is nothing to delete. Never throws for Liveblocks: the
 * generation has already moved, which is what keeps a removed editor out.
 */
export async function rotateRoom(productionId: string, rooms: Pick<RoomClient, "deleteRoom"> | null = liveRooms()): Promise<{ from: string; to: string }> {
  const workspaceId = requireTenant().id;
  const from = await currentRoom(workspaceId, productionId);
  await db().execute({
    sql: `INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,'1','system',?)
          ON CONFLICT(key) DO UPDATE SET value=CAST(settings.value AS INTEGER)+1, updated_at=excluded.updated_at`,
    args: [KEY(productionId), now()],
  });
  const to = await currentRoom(workspaceId, productionId);
  try { await rooms?.deleteRoom?.(from); } catch { /* an absent room, or Liveblocks unreachable: the new generation already keeps the old one out */ }
  return { from, to };
}
