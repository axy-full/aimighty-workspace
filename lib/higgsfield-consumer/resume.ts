/**
 * The tray's words for a take: how long ago it started, and its name cut on a
 * word. Particl no longer signs in to Higgsfield (CLAUDE.md ground rule 10),
 * so no account job is read back or followed any more; the jobs tray reads
 * their rows from the ledger and names them with these, like its own takes.
 *
 * Pure (no fetch, no React), so the tray's server read and the browser say one
 * thing and a unit spec can check it.
 */

/** How long a job has been going: "just now", "4 min", "2 h", "3 d". */
export function resumeAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** A name cut on a word boundary with an ellipsis, never mid-word. */
export function shortName(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:·-]+$/, "")}…`;
}
