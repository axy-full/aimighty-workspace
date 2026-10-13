import type { Cue, Word } from "./types";

export const msToFrame = (ms: number, fps: number): number => Math.round((ms * fps) / 1000);
export const frameToMs = (frame: number, fps: number): number => (frame * 1000) / fps;

/** A cue shorter than this after clipping is dropped: nobody can read it. */
export const MIN_CUE_MS = 100;

/**
 * Sort cues, keep them inside [0, totalMs], and stop each one at the next one's start
 * so two captions are never on screen together. Words are clipped to their cue.
 */
export function normaliseCues(cues: Cue[], totalMs: number): Cue[] {
  const sorted = cues
    .filter((cue) => cue.text.trim().length > 0 && cue.endMs > cue.startMs && cue.startMs < totalMs)
    .map((cue) => ({ ...cue, startMs: Math.max(0, cue.startMs), endMs: Math.min(totalMs, cue.endMs) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: Cue[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const cue = { ...sorted[i] };
    const next = sorted[i + 1];
    if (next && cue.endMs > next.startMs) cue.endMs = next.startMs;
    if (cue.endMs - cue.startMs < MIN_CUE_MS) continue;
    if (cue.words) cue.words = clipWords(cue.words, cue.startMs, cue.endMs);
    out.push(cue);
  }
  return out;
}

function clipWords(words: Word[], startMs: number, endMs: number): Word[] {
  return words
    .filter((word) => word.endMs > startMs && word.startMs < endMs)
    .map((word) => ({ ...word, startMs: Math.max(startMs, word.startMs), endMs: Math.min(endMs, word.endMs) }))
    .filter((word) => word.endMs > word.startMs);
}

/** The cue on screen at time t (start inclusive, end exclusive), or null. Cues must be normalised. */
export function activeCueAt(cues: Cue[], tMs: number): Cue | null {
  for (const cue of cues) if (tMs >= cue.startMs && tMs < cue.endMs) return cue;
  return null;
}

/** Words of a cue. Without word timing, the cue's time is shared out by letters. */
export function cueWords(cue: Cue): Word[] {
  if (cue.words && cue.words.length > 0) return cue.words;
  const parts = cue.text.split(" ").filter(Boolean);
  const letters = parts.reduce((sum, part) => sum + part.length, 0) || 1;
  const span = cue.endMs - cue.startMs;
  let cursor = cue.startMs;
  return parts.map((part, index) => {
    const end = index === parts.length - 1 ? cue.endMs : Math.round(cursor + (span * part.length) / letters);
    const word = { startMs: cursor, endMs: end, text: part };
    cursor = end;
    return word;
  });
}

export type CaptionPage = { startMs: number; endMs: number; words: Word[] };

/**
 * Split a cue into pages of at most `maxChars` letters, so a long cue shows a few words at a time.
 * Pages tile the cue: each runs until the next begins, the last until the cue ends.
 */
export function paginateCue(cue: Cue, maxChars: number): CaptionPage[] {
  const words = cueWords(cue);
  const groups: Word[][] = [];
  let current: Word[] = [];
  let length = 0;
  for (const word of words) {
    const add = word.text.length + (current.length ? 1 : 0);
    if (current.length && length + add > maxChars) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(word);
    length += word.text.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => ({
    startMs: index === 0 ? cue.startMs : group[0].startMs,
    endMs: index === groups.length - 1 ? cue.endMs : groups[index + 1][0].startMs,
    words: group,
  }));
}

export type CaptionNow = { words: string[]; activeWord: number; pageStartMs: number };

/** What to draw at time t: the page's words and which one is being spoken (-1 before the first). */
export function captionAt(cues: Cue[], tMs: number, maxChars: number): CaptionNow | null {
  const cue = activeCueAt(cues, tMs);
  if (!cue) return null;
  const page = paginateCue(cue, maxChars).find((p) => tMs >= p.startMs && tMs < p.endMs);
  if (!page) return null;
  let activeWord = -1;
  page.words.forEach((word, index) => {
    if (tMs >= word.startMs) activeWord = index;
  });
  return { words: page.words.map((word) => word.text), activeWord, pageStartMs: page.startMs };
}

/** A stretch of source time laid at a position in the output. */
export type Segment = { srcStartMs: number; srcEndMs: number; outStartMs: number };

/**
 * Carry cues from source time to output time through the segments that were kept. A cue that
 * spans a cut is split; a piece shorter than MIN_CUE_MS is dropped. Output is sorted.
 */
export function remapCues(cues: Cue[], segments: Segment[]): Cue[] {
  const out: Cue[] = [];
  for (const segment of segments) {
    for (const cue of cues) {
      const start = Math.max(cue.startMs, segment.srcStartMs);
      const end = Math.min(cue.endMs, segment.srcEndMs);
      if (end - start < MIN_CUE_MS) continue;
      const shift = segment.outStartMs - segment.srcStartMs;
      const whole = start === cue.startMs && end === cue.endMs;
      const words = cue.words ? clipWords(cue.words, start, end).map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })) : undefined;
      const text = !whole && words && words.length ? words.map((w) => w.text).join(" ") : cue.text;
      const mapped: Cue = { startMs: start + shift, endMs: end + shift, text };
      if (words && words.length) mapped.words = words;
      out.push(mapped);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
