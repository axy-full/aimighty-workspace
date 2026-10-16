import type { Timeline } from "./types";

/**
 * Ducking: while a voice line plays, the music and the clips' own sound drop to a share of their level (`duck`, 0.3 by default)
 * and come back after it. Pure frame maths; the composition applies it as each audio element's volume.
 */
export const DUCK_RAMP_SECONDS = 0.2;

export type Window = { from: number; to: number };

/** Where voice is playing, in frames: sorted, overlapping or touching lines merged. */
export function voiceWindows(timeline: Pick<Timeline, "voiceover">): Window[] {
  const sorted = timeline.voiceover.map((line) => ({ from: line.from, to: line.from + line.durationInFrames })).sort((a, b) => a.from - b.from);
  const out: Window[] = [];
  for (const window of sorted) {
    const last = out[out.length - 1];
    if (last && window.from <= last.to) last.to = Math.max(last.to, window.to);
    else out.push({ ...window });
  }
  return out;
}

/**
 * The gain at a frame: 1 well away from every voice window, `duck` inside one, and a straight ramp between over
 * DUCK_RAMP_SECONDS on each side, so the bed is already down as the voice starts and rises again after it stops.
 */
export function duckGain(frame: number, windows: readonly Window[], duck: number, fps: number): number {
  if (!windows.length || duck >= 1) return 1;
  const ramp = Math.max(1, Math.round(DUCK_RAMP_SECONDS * fps));
  let gain = 1;
  for (const window of windows) {
    const distance = frame < window.from ? window.from - frame : frame >= window.to ? frame - window.to + 1 : 0;
    const here = distance >= ramp ? 1 : duck + (1 - duck) * (distance / ramp);
    if (here < gain) gain = here;
  }
  return gain;
}
