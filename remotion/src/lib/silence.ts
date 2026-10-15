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
  if (merged.length <= max) return merged.map(round);
  const longest = [...merged].sort((a, b) => b.endSeconds - b.startSeconds - (a.endSeconds - a.startSeconds)).slice(0, max);
  return longest.sort((a, b) => a.startSeconds - b.startSeconds).map(round);
}

const round = (r: Range): Range => ({ startSeconds: Math.round(r.startSeconds * 1000) / 1000, endSeconds: Math.round(r.endSeconds * 1000) / 1000 });

/** Explicit `keep` ranges and detected speech together, merged, still at most MAX_KEEP_RANGES (the longest). */
export function mergeKeep(explicit: Range[], speech: Range[], max = MAX_KEEP_RANGES): Range[] {
  const sorted = [...explicit, ...speech].sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startSeconds <= last.endSeconds) last.endSeconds = Math.max(last.endSeconds, r.endSeconds);
    else merged.push({ ...r });
  }
  if (merged.length <= max) return merged;
  return [...merged].sort((a, b) => b.endSeconds - b.startSeconds - (a.endSeconds - a.startSeconds)).slice(0, max).sort((a, b) => a.startSeconds - b.startSeconds);
}
