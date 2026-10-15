import type { Range } from "./types";

/**
 * Silence-aware cutdowns, the pure half. The worker runs ffmpeg's `silencedetect` over the source's sound (node/silence.ts) and
 * hands its output here: `parseSilence` reads the quiet stretches, `speechRanges` turns them into the stretches to KEEP, which the
 * cutdown planner then uses as its marked moments (src/lib/cutdown.ts). Nothing here touches a file.
 */

/** Quieter than this is silence. */
export const SILENCE_NOISE_DB = -35;
/** A quiet stretch must last this long to count: a breath between words is not a silence. */
export const SILENCE_MIN_SECONDS = 0.6;
/** Each spoken stretch keeps this much of the quiet on both sides, so no word is clipped. */
export const SPEECH_PAD_SECONDS = 0.15;
/** A spoken stretch shorter than this is a click or a cough, not speech. */
export const SPEECH_MIN_SECONDS = 0.3;
/** A kept stretch shorter than this makes a cut that jumps about, so shorter speech is not chosen (unless it is all there is). */
export const MIN_SEGMENT_SECONDS = 1.0;
/** A cutdown's `keep` holds at most this many ranges (src/lib/validate.ts): the longest spoken stretches are used. */
export const MAX_KEEP_RANGES = 12;

/** Quiet stretches from ffmpeg's `silencedetect` log lines. A silence that starts and never ends runs to `durationSeconds`. */
export function parseSilence(log: string, durationSeconds: number): Range[] {
  const out: Range[] = [];
  let start: number | null = null;
  for (const line of log.split("\n")) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) { start = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (e && start !== null) {
      out.push({ startSeconds: start, endSeconds: Math.min(durationSeconds, Number(e[1])) });
      start = null;
    }
  }
  if (start !== null && start < durationSeconds) out.push({ startSeconds: start, endSeconds: durationSeconds });
  return out.filter((r) => r.endSeconds > r.startSeconds);
}

/**
 * The stretches to keep: everything that is not silence, padded, merged where the pads meet, with blips dropped; at most
 * MAX_KEEP_RANGES of them (the longest, in time order). A source that is all quiet gives none.
 */
export function speechRanges(silences: Range[], durationSeconds: number, options: { pad?: number; minSpeech?: number; max?: number } = {}): Range[] {
  const pad = options.pad ?? SPEECH_PAD_SECONDS;
  const minSpeech = options.minSpeech ?? SPEECH_MIN_SECONDS;
  const max = options.max ?? MAX_KEEP_RANGES;
  const sorted = [...silences].sort((a, b) => a.startSeconds - b.startSeconds);
  const speech: Range[] = [];
  let cursor = 0;
  for (const silence of sorted) {
    if (silence.startSeconds - cursor >= minSpeech) speech.push({ startSeconds: cursor, endSeconds: silence.startSeconds });
    cursor = Math.max(cursor, silence.endSeconds);
  }
  if (durationSeconds - cursor >= minSpeech) speech.push({ startSeconds: cursor, endSeconds: durationSeconds });
  const padded = speech.map((r) => ({ startSeconds: Math.max(0, r.startSeconds - pad), endSeconds: Math.min(durationSeconds, r.endSeconds + pad) }));
  const merged: Range[] = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r.startSeconds <= last.endSeconds) last.endSeconds = Math.max(last.endSeconds, r.endSeconds);
    else merged.push({ ...r });
  }
  const round = rounder(durationSeconds);
  const rounded = (list: Range[]) => list.map(round).filter((r) => r.endSeconds > r.startSeconds);
  if (merged.length <= max) return rounded(merged);
  const longest = [...merged].sort((a, b) => b.endSeconds - b.startSeconds - (a.endSeconds - a.startSeconds)).slice(0, max);
  return rounded(longest.sort((a, b) => a.startSeconds - b.startSeconds));
}

/** Rounded to the millisecond and kept inside [0, duration]: rounding never pushes a range past the end of the file. */
const rounder = (durationSeconds: number) => (r: Range): Range => ({ startSeconds: Math.max(0, Math.min(durationSeconds, Math.round(r.startSeconds * 1000) / 1000)), endSeconds: Math.min(durationSeconds, Math.round(r.endSeconds * 1000) / 1000) });

const length = (r: Range) => r.endSeconds - r.startSeconds;
const byTime = (a: Range, b: Range) => a.startSeconds - b.startSeconds;

function union(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const r of [...ranges].sort(byTime)) {
    const last = merged[merged.length - 1];
    if (last && r.startSeconds <= last.endSeconds) last.endSeconds = Math.max(last.endSeconds, r.endSeconds);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * Which spoken stretches go into a cut of `budgetSeconds`: WHOLE stretches, longest first, until the budget is used, never one under
 * `minSegment` (unless nothing is longer), returned in time order. Nothing is shrunk here: a cut that is not full is grown by the
 * planner, and when even the longest stretch is over the budget the planner trims that one from its tail. This replaces handing every
 * stretch to the planner, which would shrink them all from their tails.
 */
export function chooseSpeech(speech: Range[], budgetSeconds: number, minSegment = MIN_SEGMENT_SECONDS): Range[] {
  if (!speech.length || budgetSeconds <= 0) return [];
  const long = speech.filter((r) => length(r) >= minSegment);
  const pool = long.length ? long : [[...speech].sort((a, b) => length(b) - length(a))[0]];
  if (pool.reduce((sum, r) => sum + length(r), 0) <= budgetSeconds) return [...pool].sort(byTime);
  const chosen: Range[] = [];
  let used = 0;
  for (const r of [...pool].sort((a, b) => length(b) - length(a))) {
    if (used + length(r) <= budgetSeconds) { chosen.push(r); used += length(r); }
  }
  /* Nothing whole fits: take the longest, which the planner trims from its tail. */
  if (!chosen.length) chosen.push([...pool].sort((a, b) => length(b) - length(a))[0]);
  return chosen.sort(byTime);
}

/**
 * Explicit `keep` ranges and detected speech together. The explicit ranges always survive: they are merged first and the speech is
 * added to them longest first, each only while the whole stays within `max` ranges (a speech range that touches an explicit one is
 * absorbed into it and costs nothing); the speech that does not fit is dropped.
 */
export function mergeKeep(explicit: Range[], speech: Range[], max = MAX_KEEP_RANGES): Range[] {
  let result = union(explicit);
  for (const candidate of [...speech].sort((a, b) => length(b) - length(a))) {
    const next = union([...result, candidate]);
    if (next.length <= Math.max(max, result.length)) result = next;
  }
  return result;
}
