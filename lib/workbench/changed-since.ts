/**
 * The words of the "changed since you opened it" bar (components/v12/board/ChangedBar.tsx): who, when, and which of this window's changes are being kept.
 * The server names who saved already masked for this viewer (lib/workbench/records.ts `draftStamp`); `by` is null when it was this person's own other window.
 */
export const CHANGED_WORDS = { reload: "Reload", keep: "Keep my version", reloaded: "Showing the saved version", kept: "Kept your version" } as const;

/** "just now", "2 min ago", "3 h ago", "yesterday"; a clock that is a little ahead reads "just now". */
export function changedWhen(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return hours < 48 ? "yesterday" : `${Math.floor(hours / 24)} days ago`;
}

/** "Shot 3", "Shot 3 and Shot 4", "Shot 3 and 2 more". */
export function changedThings(things: readonly string[]): string {
  if (things.length <= 1) return things[0] ?? "this board";
  if (things.length === 2) return `${things[0]} and ${things[1]}`;
  return `${things[0]} and ${things.length - 1} more`;
}

export function changedLine(c: { by: string | null; at: number; things: readonly string[] }, now: number): string {
  const who = c.by ? `${c.by} changed this board` : "This board changed in another window";
  return `${who} ${changedWhen(c.at, now)} · your change to ${changedThings(c.things)} is kept until you choose`;
}
