/**
 * The Atomik ring, as data (design/particl-v2/README.md §3).
 *
 * Eight dots on a 200 × 200 grid, head at the top, shrinking clockwise to
 * the tail. The same eight dots draw three things: the mark (every dot ink),
 * a run (each dot is one paid step, painted by its state) and the loader
 * (each dot breathes in turn). Nothing here knows about React or CSS — it
 * only decides, per dot, where it is, how big it is and what paints it —
 * so the rule that a step in state X looks like Y is written exactly once
 * and can be tested without a browser.
 *
 * The radii and the per-state arithmetic are transcribed from the handoff's
 * own renderer (`dotOf` in the reference), including its two floors: a
 * checkpoint ring never shrinks under r=2 and a queued outline never under
 * r=1.5, which is why the tail's outline is 1.5 rather than the 0.5 the
 * spec's "r−1.5" would give it.
 */

/** cx, cy, r — verbatim from the handoff. Head first. */
export const RING_DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [100, 38, 16], [56.16, 56.16, 11.9], [38, 100, 8.8], [56.16, 143.84, 6.5],
  [100, 162, 4.8], [143.84, 143.84, 3.6], [162, 100, 2.7], [143.84, 56.16, 2],
];
export const RING_VIEWBOX = "0 0 200 200";

/** One lap of the loader, and the gap between one dot's beat and the next's. */
export const PULSE_LAP_S = 1.6;
export const PULSE_STEP_S = 0.2;

/** A paid step, as the ring paints it. */
export type StepState = "done" | "running" | "checkpoint" | "queued" | "needsYou";
export const STEP_STATES: readonly StepState[] = ["done", "running", "checkpoint", "queued", "needsYou"];

/** Atomik itself, when there is no run to show. */
export type RingMode = "idle" | "listening" | "planning" | "done";
export const RING_MODES: readonly RingMode[] = ["idle", "listening", "planning", "done"];

/** The three paints. `ground` only ever strokes: the halo round a needs-you dot. */
export type Paint = "ink" | "accent" | "ground";

export type Dot = {
  cx: number; cy: number; r: number;
  fill: Paint | "none";
  stroke: Paint | "none";
  strokeWidth: number;
  /** The queued outline is ink at 35%; every other stroke is solid. */
  strokeOpacity: number;
  /** Whole-dot opacity — 1, or the listening trail's .65 and .35. */
  opacity: number;
  /** Planning only: this dot's beat in the lap, in seconds after the head's. */
  pulseDelay: number | null;
};

const solid = (i: number, fill: Paint, opacity = 1): Dot => {
  const [cx, cy, r] = RING_DOTS[i];
  return { cx, cy, r, fill, stroke: "none", strokeWidth: 0, strokeOpacity: 1, opacity, pulseDelay: null };
};

/** One dot painted by one step's state. `i` is the dot's place, head first. */
export function stepDot(i: number, state: StepState): Dot {
  const [cx, cy, r] = RING_DOTS[i];
  switch (state) {
    case "done": return solid(i, "ink");
    case "running": return solid(i, "accent");
    case "checkpoint":
      return { cx, cy, r: Math.max(r - 2, 2), fill: "none", stroke: "accent", strokeWidth: 4, strokeOpacity: 1, opacity: 1, pulseDelay: null };
    case "queued":
      return { cx, cy, r: Math.max(r - 1.5, 1.5), fill: "none", stroke: "ink", strokeWidth: 3, strokeOpacity: 0.35, opacity: 1, pulseDelay: null };
    case "needsYou":
      return { cx, cy, r: r + 3, fill: "ink", stroke: "ground", strokeWidth: 3, strokeOpacity: 1, opacity: 1, pulseDelay: null };
  }
}

/** The whole ring in one of Atomik's own states. */
export function modeDots(mode: RingMode): Dot[] {
  return RING_DOTS.map((_, i) => {
    switch (mode) {
      case "idle": return solid(i, "ink");
      case "done": return solid(i, "accent");
      case "listening": return solid(i, "ink", i === 0 ? 1 : i < 3 ? 0.65 : 0.35);
      case "planning": return { ...solid(i, "ink"), pulseDelay: i * PULSE_STEP_S };
    }
  });
}

/**
 * A run's steps on the ring, head first. The ring has eight dots; a recipe
 * with more steps than that shows its first eight, and one with fewer shows
 * only as many dots as it has steps — a dot that is not a step would be a
 * step that does not exist.
 */
export function stepDots(steps: readonly StepState[]): Dot[] {
  return steps.slice(0, RING_DOTS.length).map((s, i) => stepDot(i, s));
}

export type RingInput = { steps: readonly StepState[]; mode?: undefined } | { mode: RingMode; steps?: undefined };

export function ringDots(input: RingInput): Dot[] {
  return input.steps ? stepDots(input.steps) : modeDots(input.mode);
}
