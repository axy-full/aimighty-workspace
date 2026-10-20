/**
 * The v25 stepper rail's rules (design/particl-prototype-25, README "V24 · A · Look" 2 and "V25" 7): a floating panel, vertically centred, circles joined by a thin
 * line, an icon per step, a ✓ badge when done, a blue ring and a status line for the current step, muted when not started. Spacing tightens before
 * anything scrolls, and the circles shrink from 30 to 26 px before that, so all ten Film steps fit at 1280 x 800. Pure: no React
 * (tests/unit/v25-rail-model.spec.ts).
 */
export type RailState = "current" | "done" | "idle";

export type RailGeometry = {
  /** The circle's diameter: 30, or 26 when the steps do not fit otherwise. */
  circle: number;
  /** The icon inside it. */
  icon: number;
  /** The space above and below each circle, 2 to 16 px: the line between two circles is this tall. */
  gap: number;
  /** The small rail: the circles shrank, so "Add step" drops its label. */
  compact: boolean;
};

/** What the rail never gets: the panel's own padding, borders and the add button's extra room (the prototype's own constants). */
const CHROME = 50 + 4;
const EXTRA = 15;

/**
 * The circle and the gap between steps for `count` steps in a canvas `height` px tall. The prototype's own arithmetic: try a 30 px circle, and when the gap
 * would fall under 6 px use 26 px; the gap is then between 2 and 16 px, less `shrink` (the screen's nudge when the current step's status wraps).
 */
export function railGeometry(input: { height: number; count: number; shrink?: number }): RailGeometry {
  const avail = input.height - CHROME;
  const n = Math.max(1, input.count);
  const fit = (c: number) => Math.floor((avail - n * (c + 3 + 4 + 14) - EXTRA * 2 - (c + 3 + 4 + 2) - 2) / (2 * n + 1));
  let circle = 30;
  let gap = fit(30);
  if (gap < 6) { circle = 26; gap = fit(26); }
  gap = Math.max(2, Math.min(16, gap - (input.shrink ?? 0)));
  return { circle, icon: circle === 30 ? 14 : 12, gap, compact: circle !== 30 };
}

/** Which state a step draws in: the current one (ringed, with its status line) wins over done. */
export function railState(input: { id: string; current: string | null; done?: boolean }): RailState {
  if (input.id === input.current) return "current";
  return input.done ? "done" : "idle";
}

/** The tooltip's line for a step: its status, and "optional" for the steps a board may skip (the prototype's Pitch / Treatment). */
export function railTip(input: { status: string; optional?: boolean }): string {
  return input.optional ? `Optional · ${input.status}` : input.status;
}
