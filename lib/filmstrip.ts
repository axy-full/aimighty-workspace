/**
 * Every take on this shot, in the order they were made (SOW §10 4.3).
 *
 * Derived from the rows the player already holds rather than fetched: a Gen
 * carries `shotId`, so the takes of one shot are a filter away, and asking
 * the server again for rows that are already in the browser would make
 * opening a take slower to tell it something it knows.
 *
 * The consequence, stated rather than hidden: the strip shows the takes of
 * this shot THAT ARE IN THE LIST THE PLAYER WAS OPENED WITH. Opened from a
 * production's wall that is already scoped to the shot, that is all of them.
 * Opened from the library, it is the ones on screen. It is never a claim to
 * be exhaustive, which is why it counts what it shows.
 */

type Take = {
  id: string; shotId?: string | null; version?: number | null; createdAt?: number;
  kind?: string | null; storedUrl?: string | null; sourceUrl?: string | null;
};

/**
 * A strip is of frames, so a take needs a picture to be in one.
 *
 * Audio takes file against shots too (the audio desk writes "SH010 · A1"),
 * and without this they appeared as black cells all labelled v1 — and were
 * counted in "3 here", so the strip claimed takes it could not show.
 */
const showable = (t: Take): boolean =>
  (t.kind ?? "video") !== "audio" && Boolean(t.storedUrl ?? t.sourceUrl);

/**
 * Ascending by version — v1 leftmost, the way a strip reads in an edit
 * suite. Newest-first is right for a wall, where the last thing you made is
 * the thing you want; it is wrong for a strip, where the point is to see
 * how a shot developed.
 *
 * Empty unless there is genuinely a choice: one take is not a filmstrip,
 * and a take with no shot has no siblings to show.
 */
export function stripFor<T extends Take>(gens: readonly T[], current: T | null | undefined): T[] {
  if (!current?.shotId || !showable(current)) return [];
  const mine = gens.filter((g) => g.shotId === current.shotId && showable(g));
  if (mine.length < 2) return [];
  return [...mine].sort((a, b) => {
    const av = a.version ?? 0, bv = b.version ?? 0;
    if (av !== bv) return av - bv;
    // Same version number is possible across a retry; fall back to when it
    // was made so the order is at least stable between renders.
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/** Where the current take sits in its own strip, or -1. */
export function stripIndex<T extends Take>(strip: readonly T[], current: T | null | undefined): number {
  return current ? strip.findIndex((g) => g.id === current.id) : -1;
}

/**
 * The take one step away, along the strip when there is one and along the
 * caller's own list otherwise.
 *
 * The player's arrows have always walked the list it was opened with. With
 * a strip on screen they should walk what is on screen — a key that moves
 * the highlight somewhere the eye cannot follow is worse than no key.
 */
export function neighbour<T extends Take>(
  all: readonly T[], strip: readonly T[], current: T | null | undefined, dir: -1 | 1,
): T | null {
  const list = strip.length ? strip : all;
  const i = current ? list.findIndex((g) => g.id === current.id) : -1;
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < list.length ? list[j] : null;
}
