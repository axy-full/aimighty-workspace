/*
 * The board's History (README § 3.1 frame p): what changed on the board and who did it, newest first. Pure: the
 * server read (history.server.ts) passes the canvas's own change log and the workspace's names; the drawer merges in
 * the renders it already follows. No prices, no prompts: what happened, to which card, by whom, when.
 */
export type HistoryWho = { kind: "person" | "atomik"; name: string; initials: string };
export type BoardHistoryEntry = { id: string; at: number; who: HistoryWho; text: string; card: string | null };

/** One logged canvas change, as much of it as History reads. */
export type LoggedChange = {
  seq: number; at: number; what: string; author: string;
  changes: { id: string; made?: boolean; removed?: boolean; before?: Record<string, unknown>; after?: Record<string, unknown> }[];
  focus: string | null;
};

const ATOMIK: HistoryWho = { kind: "atomik", name: "Atomik", initials: "AT" };
export const initialsOf = (name: string) =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function titleOf(change: LoggedChange["changes"][number]): string | null {
  const title = change.after?.title ?? change.before?.title;
  return typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : null;
}

/** The log's rows as History says them; a row with nobody to name (the server keeping cards) is left out. */
export function historyEntries(rows: readonly LoggedChange[], names: ReadonlyMap<string, string>): BoardHistoryEntry[] {
  return rows.flatMap((row) => {
    const agent = row.author.startsWith("agent:");
    const person = names.get(row.author);
    if (!agent && !person) return [];
    const who: HistoryWho = agent ? ATOMIK : { kind: "person", name: person!, initials: initialsOf(person!) };
    const made = row.changes.filter((c) => c.made), removed = row.changes.filter((c) => c.removed);
    const named = row.changes.map(titleOf).find(Boolean);
    const text = row.what === "tidy" ? `Tidied the board · ${count(row.changes.length, "card")} moved`
      : row.what === "agent" ? `Built on the board · ${count(made.length || row.changes.length, "card")}`
      : row.what === "agent-undo" ? `Took its build off the board · ${count(removed.length || row.changes.length, "card")}`
      : row.what === "import" ? "Brought an old board across"
      : made.length === 1 && named ? `Added ${named}`
      : removed.length === 1 && named ? `Took ${named} off the board`
      : row.changes.length === 1 && named ? `Changed ${named}`
      : `Changed the board · ${count(row.changes.length, "card")}`;
    const card = row.focus ?? row.changes.find((c) => !c.removed)?.id ?? null;
    return [{ id: `op:${row.seq}`, at: row.at, who, text, card }];
  });
}
