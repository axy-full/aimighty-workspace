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
