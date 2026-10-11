import type { DecidedItem, QueueItem } from "@/lib/control-room/queue";

/**
 * The control room's words that are not prices (prices go through
 * lib/shell/price-words.ts): when something happened, and the line under a
 * row. Pure, so the unit spec reads them as the screen does.
 */

const DAY = 86_400_000;
const clock = (at: Date) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "Today 09:40", "Yesterday 17:38", else "3 Oct 14:02". */
export function when(at: number, now = Date.now()): string {
  const then = new Date(at), today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return `Today ${clock(then)}`;
  if (at >= startOfToday - DAY) return `Yesterday ${clock(then)}`;
  return `${then.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${clock(then)}`;
}

/** The line under a waiting item: its project, where it was made, and when. */
export function itemLine(item: Pick<QueueItem, "project" | "where" | "at">, now = Date.now()): string {
  return [item.project.name, item.where, when(item.at, now)].filter(Boolean).join(" · ");
}

/** The line under a decision: its project, what was decided and by whom, and when. */
export function decidedLine(item: Pick<DecidedItem, "project" | "what" | "by" | "byYou" | "at">, now = Date.now()): string {
  const who = item.byYou ? "you" : item.by;
  return [item.project.name, who ? `${item.what} by ${who}` : item.what, when(item.at, now)].filter(Boolean).join(" · ");
}

/** The empty queue, in the frame's words, said as the code behaves (a draft under Auto's line runs without a tap). */
export const EMPTY_QUEUE = "Nothing is waiting. A priced step that needs your yes waits here until you approve it or let it go.";
/** Said where a sample production's item would have its buttons. */
export const SAMPLE_LINE = "Sample production · nothing here spends credits";
