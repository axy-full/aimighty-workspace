import type { CutdownTarget, Range } from "./types";
import type { Segment } from "./captions";

export type CutSegment = {
  /** First source frame. */
  srcStartFrame: number;
  durationInFrames: number;
  /** Where it starts in the finished video. */
  outStartFrame: number;
};

export type CutdownPlan = {
  fps: number;
  targetFrames: number;
  totalFrames: number;
  segments: CutSegment[];
  /** True when the source is shorter than the target, so the cut is the whole source. */
  underTarget: boolean;
};

/** How many pieces each length is cut from when nothing is marked to keep. */
export const DEFAULT_PIECES: Record<CutdownTarget, number> = { 6: 2, 15: 3, 30: 5 };

type FrameRange = { start: number; end: number };

/**
 * Plan a 6, 15 or 30 second cut of one source. Frame-exact: the segments add up to the target
 * whenever the source is at least as long. All frames are source frames at the same fps.
 *
 * - Source no longer than the target: the whole source.
 * - Nothing marked to keep: a few pieces spread evenly, the first starting at frame 0 (the hook)
 *   and the last ending on the source's last frame (the ending).
 * - Marked moments: those moments, trimmed from their tails if they overrun the target, or
 *   grown (forward first, then backward) into the source if they fall short.
 */
export function planCutdown(input: { sourceSeconds: number; targetSeconds: CutdownTarget; fps: number; keep?: Range[] }): CutdownPlan {
  const { fps, targetSeconds } = input;
  const sourceFrames = Math.floor(input.sourceSeconds * fps);
  const targetFrames = targetSeconds * fps;
  if (sourceFrames <= targetFrames) {
    return {
      fps,
      targetFrames,
      totalFrames: sourceFrames,
      segments: [{ srcStartFrame: 0, durationInFrames: sourceFrames, outStartFrame: 0 }],
      underTarget: sourceFrames < targetFrames,
    };
  }
  const ranges = mergeRanges(
    (input.keep ?? []).map((r) => ({
      start: Math.max(0, Math.floor(r.startSeconds * fps)),
      end: Math.min(sourceFrames, Math.floor(r.endSeconds * fps)),
    })),
  );
  const chosen = ranges.length ? fitRanges(ranges, targetFrames, sourceFrames) : evenPieces(sourceFrames, targetFrames, DEFAULT_PIECES[targetSeconds]);
  let cursor = 0;
  const segments = chosen.map((range) => {
    const durationInFrames = range.end - range.start;
    const segment = { srcStartFrame: range.start, durationInFrames, outStartFrame: cursor };
    cursor += durationInFrames;
    return segment;
  });
  return { fps, targetFrames, totalFrames: cursor, segments, underTarget: false };
}

function mergeRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: FrameRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function evenPieces(sourceFrames: number, targetFrames: number, pieces: number): FrameRange[] {
  const base = Math.floor(targetFrames / pieces);
  const lengths = Array.from({ length: pieces }, (_, i) => (i === pieces - 1 ? targetFrames - base * (pieces - 1) : base));
  const free = sourceFrames - targetFrames;
  let before = 0;
  return lengths.map((length, i) => {
    const start = before + (pieces === 1 ? 0 : Math.round((i * free) / (pieces - 1)));
    before += length;
    return { start, end: start + length };
  });
}

function fitRanges(ranges: FrameRange[], targetFrames: number, sourceFrames: number): FrameRange[] {
  const total = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  if (total >= targetFrames) {
    // Shrink every range from its tail, in proportion; the first ones take the rounding left over.
    const out = ranges.map((r) => ({ start: r.start, end: r.start + Math.floor(((r.end - r.start) * targetFrames) / total) }));
    let rest = targetFrames - out.reduce((sum, r) => sum + (r.end - r.start), 0);
    out.forEach((r, i) => {
      const give = Math.min(rest, ranges[i].end - r.end);
      r.end += give;
      rest -= give;
    });
    return mergeRanges(out);
  }
  // Grow into the source: forward first, then backward.
  const out = ranges.map((r) => ({ ...r }));
  let add = targetFrames - total;
  for (const direction of ["forward", "backward"] as const) {
    while (add > 0) {
      let moved = 0;
      const step = Math.max(1, Math.ceil(add / out.length));
      for (let i = 0; i < out.length && add > 0; i += 1) {
        const room = direction === "forward" ? (i + 1 < out.length ? out[i + 1].start : sourceFrames) - out[i].end : out[i].start - (i > 0 ? out[i - 1].end : 0);
        const grow = Math.min(room, step, add);
        if (grow <= 0) continue;
        if (direction === "forward") out[i].end += grow;
        else out[i].start -= grow;
        add -= grow;
        moved += grow;
      }
      if (moved === 0) break;
    }
  }
  return mergeRanges(out);
}

/** The plan as source-time to output-time segments, for carrying captions through the cut. */
export function planSegmentsMs(plan: CutdownPlan): Segment[] {
  const ms = (frames: number) => (frames * 1000) / plan.fps;
  return plan.segments.map((s) => ({
    srcStartMs: ms(s.srcStartFrame),
    srcEndMs: ms(s.srcStartFrame + s.durationInFrames),
    outStartMs: ms(s.outStartFrame),
  }));
}
