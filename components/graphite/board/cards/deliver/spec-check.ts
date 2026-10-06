/*
 * The Deliver card's spec rows (README § 3.1 frame i): what the cut is delivered as and whether it checks out.
 * Pure. A check is answered only for a cut that is finished: until every shot has its approved take in the cut, every
 * check reads "pending" (DECISIONS 39 e), never a tick for work that is not done.
 *
 * - Aspect and frame rate are the project's own delivery spec; a rate the EDL cannot carry (not 24, 25 or 30) fails.
 * - Duration is the cut's runtime. No target length is stored anywhere, so there is nothing to check it against: it
 *   is shown, never ticked.
 * - Loudness is not measured here: no code does it. The row says so and offers nothing.
 */

export type SpecMark = "ok" | "pending" | "fail" | "none";
export type SpecRow = { key: "aspect" | "fps" | "duration" | "loudness"; label: string; value: string; mark: SpecMark; word: string | null };

export const DELIVERY_RATES: readonly number[] = [24, 25, 30];

/** "00:10": minutes and seconds, as the edit's own clock reads. */
export function runtime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function specRows(i: { aspect: string; fps: number; seconds: number; complete: boolean; empty: boolean }): SpecRow[] {
  const verdict = (ok: boolean): Pick<SpecRow, "mark" | "word"> => (i.complete ? (ok ? { mark: "ok", word: null } : { mark: "fail", word: "not a delivery rate" }) : { mark: "pending", word: "pending" });
  return [
    { key: "aspect", label: "Aspect", value: i.aspect, ...verdict(true) },
    { key: "fps", label: "Frame rate", value: `${i.fps} fps`, ...verdict(DELIVERY_RATES.includes(i.fps)) },
    { key: "duration", label: "Duration", value: i.empty ? "00:00" : runtime(i.seconds), ...(i.complete ? { mark: "none" as const, word: null } : { mark: "pending" as const, word: "pending" }) },
    { key: "loudness", label: "Loudness", value: "Not measured", mark: "none", word: null },
  ];
}
