/**
 * Keeping several takes of one shot at the same moment.
 *
 * Compare says on its face that the takes run "in step", and it prints IN
 * STEP in its header. It did not. Nothing measured drift and nothing
 * corrected it: the transport COMMANDED every clip to play and then trusted
 * them, the read-out took its position from whichever tile happened to be
 * leftmost, and `loop` sat on each tile so every clip wrapped on its own
 * length.
 *
 * That is not a rounding error on this data. Every multi-take shot in the
 * workspace has takes of different lengths — 5, 10, 10, 10, 4 and 5 seconds
 * on one of them — so past the shortest clip the grid showed four unrelated
 * moments under one bar claiming a single position. A director picks a take
 * off that screen.
 *
 * The rules here are the whole fix, kept pure so they can be tested without
 * a browser or a video.
 */

/**
 * How far a tile may drift before it is worth seizing it back.
 *
 * A seek is visible — the picture jumps and the decoder re-buffers — so
 * correcting every frame would be worse than the drift. Three frames at 24fps
 * is about the point where two takes stop reading as the same moment.
 */
export const DRIFT_TOL = 0.125;

/** A duration that is not a real, finite, positive number tells us nothing. */
function known(d: number | null | undefined): d is number {
  return typeof d === "number" && Number.isFinite(d) && d > 0;
}

/**
 * The group's span is the LONGEST take.
 *
 * It has to be: the span is what the scrub bar measures against, and a bar
 * that stopped at the shortest take could not express the moment the longest
 * one is still playing. Zero when nothing has reported a duration yet.
 */
export function groupSpan(durations: (number | null | undefined)[]): number {
  return durations.reduce<number>((max, d) => (known(d) && d > max ? d : max), 0);
}

/**
 * Which take drives the clock: the longest one.
 *
 * Reading the position off real media time rather than a wall clock means a
 * stall holds the whole group together instead of racing ahead and dragging
 * everyone through a seek. It must be the longest take, because a shorter
 * one cannot express positions past its own end — which is exactly where the
 * old leftmost-tile reading went wrong. Ties go to the first, and -1 means
 * nothing has a duration yet.
 */
export function clockIndex(durations: (number | null | undefined)[]): number {
  let best = -1;
  let longest = 0;
  durations.forEach((d, i) => {
    if (known(d) && d > longest) { longest = d; best = i; }
  });
  return best;
}

/**
 * Where a tile belongs at the group's position, and whether it has run out.
 *
 * A take shorter than the group HOLDS ITS LAST FRAME rather than looping.
 * Looping it — which is what shipped — put it at an unrelated moment while
 * claiming to be in step. Holding says the true thing: this take has ended
 * and the others are still going.
 */
export function tileTarget(groupPos: number, duration: number | null | undefined): { time: number; ended: boolean } {
  if (!known(duration)) return { time: Math.max(0, groupPos), ended: false };
  const ended = groupPos >= duration;
  // Never seek exactly to duration: browsers report `ended` and blank some
  // decoders. A hair inside keeps the last frame on screen.
  return { time: ended ? Math.max(0, duration - 0.04) : Math.max(0, groupPos), ended };
}

/** Far enough off to be worth a corrective seek. */
export function needsCorrection(actual: number, target: number, tol: number = DRIFT_TOL): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(target)) return false;
  return Math.abs(actual - target) > tol;
}

/** Position and span, spoken the way the bar shows them. */
export function readout(pos: number, span: number): string {
  const s = (n: number) => `${Math.max(0, n).toFixed(1)}s`;
  return span > 0 ? `${s(Math.min(pos, span))} / ${s(span)}` : s(pos);
}
