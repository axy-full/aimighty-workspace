import type { TrashRecord } from "@/lib/board/remove";

/**
 * The browser's half of a board's Trash (lib/boardTrash.ts, app/api/boards/[id]/trash): it records what it removed, and claims a record back when a removal is
 * undone. `board` is the board's project id (the production project). The answers say what went wrong in the server's own words; nothing here changes billing.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const path = (board: string) => `/api/boards/${encodeURIComponent(board)}/trash`;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Records one removal. `entry` is the Trash record's id (to claim it back on Undo); `error` is why it could not be recorded. */
export async function recordToTrash(fetcher: Fetcher, board: string, record: TrashRecord): Promise<{ entry: string } | { error: string }> {
  try {
    const res = await fetcher(path(board), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind: record.kind, itemId: record.itemId, label: record.label, payload: record.kind === "take" ? undefined : record.payload }) });
    const body = (await res.json().catch(() => ({}))) as { entry?: { id: string }; error?: string };
    if (res.ok && body.entry) return { entry: body.entry.id };
    return { error: body.error ?? "It could not be added to the Trash." };
  } catch {
    return { error: "It could not be added to the Trash: the connection dropped." };
  }
}

/** Claims a record back (the Undo of a removal). A take comes back on the server; for a node the browser puts it back itself. Failure is not fatal: the Undo already ran. */
export async function restoreFromTrash(fetcher: Fetcher, board: string, entry: string): Promise<boolean> {
  try { return (await fetcher(`${path(board)}/${encodeURIComponent(entry)}/restore`, { method: "POST" })).ok; } catch { return false; }
}
