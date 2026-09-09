/**
 * Compare (brief 2.1): the producer's screen — two to four takes of one
 * shot side by side, played in step, picked with one tap. Pure; the wall
 * decides what goes in, this decides what a comparison may hold.
 */
export const COMPARE_MAX = 4;
export const COMPARE_MIN = 2;

type Take = { id: string; version?: number; storedUrl?: string | null; status?: string };

/**
 * The takes a comparison shows: only ones with something to play, newest
 * version first, at most four. Fewer than two is not a comparison.
 */
export function compareSet<T extends Take>(takes: T[], max = COMPARE_MAX): T[] {
  const playable = takes.filter((t) => Boolean(t.storedUrl) && (t.status ?? "succeeded") === "succeeded");
  return [...playable].sort((a, b) => (b.version ?? 0) - (a.version ?? 0)).slice(0, max);
}

export const canCompare = (takes: Take[]): boolean => compareSet(takes).length >= COMPARE_MIN;

/** How many across at most; a phone is held to two by the stylesheet. */
export const compareColumns = (n: number): number => Math.max(1, Math.min(n, COMPARE_MAX));

/**
 * Every take that COULD be compared, newest first.
 *
 * `compareSet` answers a different question — what a comparison opens on —
 * and it answers it by taking the newest four and dropping the rest without
 * saying so. On a shot with six takes that hid two of them, and it made
 * "A/B wipe for two" (§10 4.3) impossible to ask for: you got the newest
 * four whether or not those were the two you wanted to weigh.
 */
export function compareCandidates<T extends Take>(takes: T[]): T[] {
  return takes
    .filter((t) => Boolean(t.storedUrl) && (t.status ?? "succeeded") === "succeeded")
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
}

/**
 * Membership, held between two and four.
 *
 * At the bounds the answer is "no" rather than a silent shuffle: dropping
 * someone's oldest pick to make room for a new one is the kind of help that
 * loses the take they were actually looking at. The caller disables the
 * chips this refuses, so the limit is visible in the control instead of
 * explained in a sentence.
 */
export function toggleCompare(
  selected: readonly string[], id: string, max = COMPARE_MAX, min = COMPARE_MIN,
): string[] {
  const has = selected.includes(id);
  if (has) return selected.length <= min ? [...selected] : selected.filter((x) => x !== id);
  if (selected.length >= max) return [...selected];
  return [...selected, id];
}

/** Whether a chip may be pressed at all, so the bound shows rather than tells. */
export function canToggle(
  selected: readonly string[], id: string, max = COMPARE_MAX, min = COMPARE_MIN,
): boolean {
  return selected.includes(id) ? selected.length > min : selected.length < max;
}

/**
 * A wipe is offered at exactly two takes, and nowhere else.
 *
 * §10 4.3 asks for "side by side, or A/B wipe for two". Two is not an
 * arbitrary limit: a wipe works by putting one take UNDER another and
 * revealing across a seam, which has meaning for a pair and none for three.
 */
export function wipeAvailable(n: number): boolean {
  return n === 2;
}

/** Where the seam sits, as a percentage of the frame. */
export function clampWipe(pct: number): number {
  if (!Number.isFinite(pct)) return 50;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

/**
 * The seam from a pointer, measured against the frame it is dragged over.
 * Zero-width boxes happen during layout; they must not produce NaN.
 */
export function wipeFromPointer(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 50;
  return clampWipe(((clientX - left) / width) * 100);
}
