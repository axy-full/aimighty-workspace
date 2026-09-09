import { test, expect } from "@playwright/test";
import { groupSpan, clockIndex, tileTarget, needsCorrection, readout, DRIFT_TOL, FPS, FRAME, stepFrame, frameAt } from "../../lib/transport";

/* The real shape of the problem, from this workspace's own data: every
   multi-take shot has takes of different lengths. shot_1a05c273f3691dhod is
   6 takes at 5, 10, 10, 10, 4 and 5 seconds. */
const REAL = [5, 10, 10, 10, 4, 5];

test("the span is the longest take, because the bar has to reach the end of it", () => {
  expect(groupSpan(REAL)).toBe(10);
  expect(groupSpan([4, 5])).toBe(5);
});

test("a span nobody has reported yet is zero, not NaN", () => {
  expect(groupSpan([null, undefined, Number.NaN, 0, -3])).toBe(0);
});

test("the clock is the longest take — a shorter one cannot express the end", () => {
  /* The bug this replaces took position from whichever tile was leftmost. On
     REAL that is the 5s take, so from 5s onward the bar reported a number no
     tile was actually at. */
  expect(clockIndex(REAL)).toBe(1);
  expect(clockIndex([null, 4, null, 9])).toBe(3);
  expect(clockIndex([null, undefined])).toBe(-1);
});

test("ties go to the first, so the clock does not hop between equals", () => {
  expect(clockIndex([10, 10, 10])).toBe(0);
});

test("a take that has run out holds its last frame instead of looping", () => {
  /* `loop` on every tile is what shipped: at 6s the 4s take was 2s into a
     replay, showing an unrelated moment under a bar claiming 6s. */
  const short = tileTarget(6, 4);
  expect(short.ended).toBe(true);
  expect(short.time).toBeGreaterThan(3.9);
  expect(short.time).toBeLessThan(4);
});

test("a take still running is asked for the group's own position", () => {
  expect(tileTarget(6, 10)).toEqual({ time: 6, ended: false });
});

test("a take whose length is unknown is followed, not guessed at", () => {
  expect(tileTarget(6, null)).toEqual({ time: 6, ended: false });
});

test("correction ignores drift too small to see and catches drift that reads", () => {
  expect(needsCorrection(5, 5.05)).toBe(false);          // under tolerance: a seek would be worse
  expect(needsCorrection(5, 5 + DRIFT_TOL + 0.01)).toBe(true);
  expect(needsCorrection(0, 0.4)).toBe(true);            // the late-joiner case
});

test("correction never acts on a number it does not have", () => {
  expect(needsCorrection(Number.NaN, 3)).toBe(false);
  expect(needsCorrection(3, Number.POSITIVE_INFINITY)).toBe(false);
});

test("the read-out never claims a position past the span", () => {
  expect(readout(12, 10)).toBe("10.0s / 10.0s");
  expect(readout(6, 10)).toBe("6.0s / 10.0s");
  expect(readout(3, 0)).toBe("3.0s");
});

/* ── One frame, at the workflow's rate ─────────────────────────────────── */

test("the workflow is 24fps, and it is one number", () => {
  /* It used to be two: 24 for the billing maths and 25 for the EDL's
     timecode, with nothing reconciling them — a cut listed at 25 conformed
     against masters rendered at 24 drifts a frame every 25. */
  expect(FPS).toBe(24);
  expect(FRAME).toBeCloseTo(1 / 24, 6);
});

test("a step is exactly one frame, forwards and back", () => {
  expect(stepFrame(1, 10, 1)).toBeCloseTo(1 + 1 / 24, 6);
  expect(stepFrame(1, 10, -1)).toBeCloseTo(1 - 1 / 24, 6);
});

test("stepping back from the first frame stays on it", () => {
  expect(stepFrame(0, 10, -1)).toBe(0);
  expect(stepFrame(0.01, 10, -1)).toBe(0);
});

test("stepping forward never lands on the end, where a decoder blanks", () => {
  /* Seeking exactly to `duration` fires `ended` and some decoders show
     nothing, so the last stop is half a frame short. */
  const last = stepFrame(9.999, 10, 1);
  expect(last).toBeLessThan(10);
  expect(last).toBeGreaterThan(10 - 1 / 24);
  expect(stepFrame(10, 10, 1)).toBe(stepFrame(9.999, 10, 1));
});

test("a clip of unknown length can still be stepped", () => {
  expect(stepFrame(2, null, 1)).toBeCloseTo(2 + 1 / 24, 6);
});

test("a broken position steps from the top rather than to NaN", () => {
  expect(stepFrame(Number.NaN, 10, 1)).toBeCloseTo(1 / 24, 6);
});

test("the frame number counts, and 24 of them is one second", () => {
  expect(frameAt(0)).toBe(0);
  expect(frameAt(1)).toBe(24);
  expect(frameAt(0.5)).toBe(12);
  expect(frameAt(-3)).toBe(0);
});
