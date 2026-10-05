import { db } from "@/lib/db";
import { canvasOpsExist } from "@/lib/workbench/canvas-ops-log";
import { historyEntries, type BoardHistoryEntry, type LoggedChange } from "./history";

/*
 * The board's History, read (team-canvas GET `history=1`, people only): the production's canvas change log in this
 * workspace's own database, newest first, with the names of this workspace's people. Read only: it creates nothing,
 * and carries no prices, prompts or fields beyond a card's title.
 */
const LIMIT = 100;

export async function boardHistory(productionId: string): Promise<BoardHistoryEntry[]> {
  if (!(await canvasOpsExist())) return [];
  const rows = (await db().execute({
    sql: "SELECT seq, at, what, author, changes, focus FROM rig_canvas_ops WHERE production_id=? AND changed>0 AND what<>'reassert' ORDER BY seq DESC LIMIT ?",
    args: [productionId, LIMIT],
  })).rows;
  const logged: LoggedChange[] = rows.map((row) => {
    let changes: LoggedChange["changes"] = [];
    try { changes = JSON.parse(String(row.changes)); } catch { changes = []; }
    return { seq: Number(row.seq), at: Number(row.at), what: String(row.what), author: String(row.author), changes, focus: row.focus == null ? null : String(row.focus) };
  });
  const people = [...new Set(logged.map((row) => row.author).filter((author) => !author.startsWith("agent:") && author !== "server"))];
  const names = new Map<string, string>();
  if (people.length) {
    const found = (await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${people.map(() => "?").join(",")})`, args: people })).rows;
    for (const row of found) if (row.name) names.set(String(row.id), String(row.name));
  }
  return historyEntries(logged, names);
}
