import { MIN_CUE_MS } from "./captions";
import type { Cue } from "./types";

/**
 * A narrated cut's captions from its voice lines. A voice line that carries its words (`VoiceLine.text`) is a caption for as long
 * as it plays, whichever clips that spans. This file only splits one such cue across the clips it overlaps; the timeline puts the
 * pieces on the clips (src/lib/timeline.ts). Pure.
 */

/** A film-clock stretch (milliseconds) that one clip covers. */
export type ClipWindow = { startMs: number; endMs: number };

/**
 * The pieces of a spoken line, one per clip window it overlaps, in the window's local time. The words are shared out by letters
 * over the line's own time, so a line that runs across a cut keeps each half on its own shot. A piece shorter than MIN_CUE_MS or
 * with no words is dropped, as the rest of the caption code does.
 */
export function splitLineAcrossClips(line: { startMs: number; endMs: number; text: string }, windows: readonly ClipWindow[]): (Cue | null)[] {
  const words = line.text.split(/\s+/).filter(Boolean);
  const span = line.endMs - line.startMs;
  if (!words.length || span <= 0) return windows.map(() => null);
  const letters = words.reduce((sum, word) => sum + Array.from(word).length, 0) || 1;
  let cursor = 0;
  const timed = words.map((word) => {
    const share = (span * Array.from(word).length) / letters;
    const out = { text: word, startMs: line.startMs + cursor, endMs: line.startMs + cursor + share };
    cursor += share;
    return out;
  });
  return windows.map((window) => {
    const start = Math.max(line.startMs, window.startMs);
    const end = Math.min(line.endMs, window.endMs);
    if (end - start < MIN_CUE_MS) return null;
    /* A word belongs to the clip that holds the middle of it. */
    const here = timed.filter((word) => {
      const middle = (word.startMs + word.endMs) / 2;
      return middle >= window.startMs && middle < window.endMs;
    });
    if (!here.length) return null;
    return {
      startMs: Math.round(start - window.startMs),
      endMs: Math.round(end - window.startMs),
      text: here.map((word) => word.text).join(" "),
      words: here.map((word) => ({ text: word.text, startMs: Math.round(Math.max(start, word.startMs) - window.startMs), endMs: Math.round(Math.min(end, word.endMs) - window.startMs) })).filter((word) => word.endMs > word.startMs),
    };
  });
}
