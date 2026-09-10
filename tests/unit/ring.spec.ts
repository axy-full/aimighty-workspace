import { test, expect } from "@playwright/test";
import {
  RING_DOTS, RING_VIEWBOX, PULSE_LAP_S, PULSE_STEP_S, STEP_STATES, RING_MODES,
  stepDot, stepDots, modeDots, ringDots,
} from "../../lib/ring";
import { ATOMIK_RING } from "../../components/AtomikMark";

/**
 * The Atomik ring (design/particl-v2/README.md §3).
 *
 * The handoff specifies the eight dots and the per-state arithmetic to the
 * decimal, and the whole UI is going to draw from this one table: the
 * header button, the rail, the checkpoint card, the loader. So the table
 * is asserted verbatim, and each state is asserted against the numbers the
 * handoff's own renderer produces — not against a description of them.
 */

test("the eight dots are the handoff's, verbatim, and there is one table", () => {
  expect(RING_DOTS).toEqual([
    [100, 38, 16], [56.16, 56.16, 11.9], [38, 100, 8.8], [56.16, 143.84, 6.5],
    [100, 162, 4.8], [143.84, 143.84, 3.6], [162, 100, 2.7], [143.84, 56.16, 2],
  ]);
  expect(RING_VIEWBOX).toBe("0 0 200 200");
  /* The mark that ships today carries the same dots. It must stay the same
     table, not a second copy that can drift. */
  expect(ATOMIK_RING).toBe(RING_DOTS);
});

test("the loader's lap is 1.6s with 0.2s between dots — eight beats fill the lap", () => {
  expect(PULSE_LAP_S).toBe(1.6);
  expect(PULSE_STEP_S).toBe(0.2);
  expect(RING_DOTS.length * PULSE_STEP_S).toBeCloseTo(PULSE_LAP_S, 10);
});

test("each step state paints its dot the way the handoff draws it", () => {
  // done = ink fill, at the dot's own radius.
  expect(stepDot(0, "done")).toMatchObject({ cx: 100, cy: 38, r: 16, fill: "ink", stroke: "none", opacity: 1 });
  // running = accent fill.
  expect(stepDot(3, "running")).toMatchObject({ r: 6.5, fill: "accent", stroke: "none" });
  // checkpoint = hollow accent ring, r−2, stroke 4.
  expect(stepDot(3, "checkpoint")).toMatchObject({ r: 4.5, fill: "none", stroke: "accent", strokeWidth: 4, strokeOpacity: 1 });
  // queued = outline, r−1.5, stroke 3, 35% ink.
  expect(stepDot(4, "queued")).toMatchObject({ r: 3.3, fill: "none", stroke: "ink", strokeWidth: 3, strokeOpacity: 0.35 });
  // needsYou = ink fill r+3 with a 3px ground stroke.
  expect(stepDot(3, "needsYou")).toMatchObject({ r: 9.5, fill: "ink", stroke: "ground", strokeWidth: 3 });
});

test("the handoff's floors: a checkpoint ring stops at r=2, a queued outline at r=1.5", () => {
  /* The tail dot is r=2. "r−2" would vanish it and "r−1.5" would leave a
     half-unit outline; the reference clamps both, and the reference's own
     rendering of the tail reads r=1.5 for queued — so this does too. */
  expect(stepDot(7, "checkpoint").r).toBe(2);
  expect(stepDot(7, "queued").r).toBe(1.5);
  expect(stepDot(6, "queued").r).toBe(1.5);   // 2.7 − 1.5 = 1.2 → floor
  expect(stepDot(5, "queued").r).toBeCloseTo(2.1, 10);
});

test("nothing pulses except planning; nothing but the accent states is accent", () => {
  for (const s of STEP_STATES) {
    for (let i = 0; i < RING_DOTS.length; i++) {
      const d = stepDot(i, s);
      expect(d.pulseDelay, `${s}[${i}] does not animate`).toBeNull();
      const accented = d.fill === "accent" || d.stroke === "accent";
      expect(accented, `${s}[${i}] accent`).toBe(s === "running" || s === "checkpoint");
    }
  }
  for (const m of RING_MODES) {
    const dots = modeDots(m);
    expect(dots).toHaveLength(8);
    for (const [i, d] of dots.entries()) {
      expect(d.pulseDelay === null, `${m}[${i}] pulses only when planning`).toBe(m !== "planning");
      expect(d.fill === "accent", `${m}[${i}] accent only when done`).toBe(m === "done");
    }
  }
});

test("the modes: idle is the mark, listening holds the head and fades the trail, planning beats head-first", () => {
  expect(modeDots("idle").every((d) => d.fill === "ink" && d.opacity === 1 && d.stroke === "none")).toBe(true);
  expect(modeDots("done").every((d) => d.fill === "accent" && d.opacity === 1)).toBe(true);
  expect(modeDots("listening").map((d) => d.opacity)).toEqual([1, 0.65, 0.65, 0.35, 0.35, 0.35, 0.35, 0.35]);
  expect(modeDots("planning").map((d) => d.pulseDelay)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4].map((x) => expect.closeTo(x, 10)));
});

test("steps map head-first; fewer steps means fewer dots, more than eight shows the first eight", () => {
  const run = stepDots(["done", "done", "running", "queued"]);
  expect(run).toHaveLength(4);
  expect(run.map((d) => [d.cx, d.cy])).toEqual(RING_DOTS.slice(0, 4).map(([x, y]) => [x, y]));
  expect(run.map((d) => d.fill)).toEqual(["ink", "ink", "accent", "none"]);
  expect(stepDots(Array(11).fill("queued"))).toHaveLength(8);
  expect(stepDots([])).toEqual([]);
});

test("ringDots takes either shape and never both", () => {
  expect(ringDots({ mode: "idle" })).toEqual(modeDots("idle"));
  expect(ringDots({ steps: ["done", "checkpoint"] })).toEqual(stepDots(["done", "checkpoint"]));
});
