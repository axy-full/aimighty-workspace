import { frameToMs, normaliseCues, remapCues, type Segment } from "./captions";
import { planCutdown } from "./cutdown";
import { evenPx, DEFAULT_LIMITS, type ExportLimits } from "./limits";
import {
  FORMAT_SIZE,
  type Aspect,
  type CaptionStyle,
  type ClipItem,
  type ClipTimelineItem,
  type CompositionId,
  type Cue,
  type PropsById,
  type ReframeSpec,
  type Timeline,
  type TimelineItem,
} from "./types";

export const frameSize = (aspect: Aspect, scale: number): { width: number; height: number } => ({
  width: evenPx(FORMAT_SIZE[aspect].width * scale),
  height: evenPx(FORMAT_SIZE[aspect].height * scale),
});

const frames = (seconds: number, fps: number): number => Math.round(seconds * fps);

export class ExportTooLong extends RangeError {}

function clipItem(args: {
  from: number;
  fps: number;
  file: string;
  hasAudio: boolean;
  sourceWidth: number;
  sourceHeight: number;
  srcStartFrame: number;
  durationInFrames: number;
  cues: Cue[];
  reframe: ReframeSpec;
  captionStyle: CaptionStyle | null;
}): ClipTimelineItem {
  const segment: Segment = {
    srcStartMs: frameToMs(args.srcStartFrame, args.fps),
    srcEndMs: frameToMs(args.srcStartFrame + args.durationInFrames, args.fps),
    outStartMs: 0,
  };
  const local = normaliseCues(remapCues(args.cues, [segment]), frameToMs(args.durationInFrames, args.fps));
  return {
    kind: "clip",
    from: args.from,
    durationInFrames: args.durationInFrames,
    file: args.file,
    trimBefore: args.srcStartFrame,
    sourceWidth: args.sourceWidth,
    sourceHeight: args.sourceHeight,
    hasAudio: args.hasAudio,
    reframe: args.reframe,
    cues: args.captionStyle ? local : [],
    subtitleCues: local,
    captionStyle: args.captionStyle,
  };
}

/** One clip's place on the timeline: its trim in frames (never past the end of the file). */
function clipFrames(item: ClipItem, fps: number): { srcStartFrame: number; durationInFrames: number } {
  const sourceFrames = Math.floor(item.source.durationSeconds * fps);
  const start = item.trim ? Math.min(sourceFrames - 1, Math.max(0, Math.floor(item.trim.startSeconds * fps))) : 0;
  const end = item.trim ? Math.min(sourceFrames, Math.floor(item.trim.endSeconds * fps)) : sourceFrames;
  return { srcStartFrame: start, durationInFrames: Math.max(1, end - start) };
}

function finish(placed: TimelineItem[], durationInFrames: number, fps: number, aspect: Aspect, scale: number, extra: Partial<Timeline>, limits: ExportLimits): Timeline {
  if (durationInFrames < 1) throw new RangeError("The export has no frames.");
  if (durationInFrames > limits.maxSeconds * fps) throw new ExportTooLong(`The export would be ${(durationInFrames / fps).toFixed(1)} s; the limit is ${limits.maxSeconds} s.`);
  return { ...frameSize(aspect, scale), fps, durationInFrames, items: placed, music: null, voiceover: [], duck: 1, fixture: null, ...extra };
}

function layout(items: TimelineItem[], fps: number, aspect: Aspect, scale: number, extra: Partial<Timeline>, limits: ExportLimits): Timeline {
  let cursor = 0;
  const placed = items.map((item) => {
    const placedItem = { ...item, from: cursor };
    cursor += item.durationInFrames;
    return placedItem;
  });
  return finish(placed, cursor, fps, aspect, scale, extra, limits);
}

/**
 * The timeline of any composition: its size, length in frames and what plays when. Pure: the
 * compositions render it, `calculateMetadata` reads its size and length, and the tests check it.
 * Throws ExportTooLong when the result would pass `limits.maxSeconds`.
 */
export function toTimeline<K extends CompositionId>(id: K, props: PropsById[K], limits: ExportLimits = DEFAULT_LIMITS): Timeline {
  switch (id) {
    case "title-card": {
      const p = props as PropsById["title-card"];
      return layout([{ kind: "title", from: 0, durationInFrames: frames(p.card.durationSeconds, p.fps), card: p.card }], p.fps, p.aspect, p.scale, {}, limits);
    }
    case "end-card": {
      const p = props as PropsById["end-card"];
      return layout([{ kind: "end", from: 0, durationInFrames: frames(p.card.durationSeconds, p.fps), card: p.card }], p.fps, p.aspect, p.scale, {}, limits);
    }
    case "captions":
    case "reframe": {
      const p = props as PropsById["captions"] & PropsById["reframe"];
      const f = clipFrames(p.clip, p.fps);
      const item = clipItem({
        from: 0,
        fps: p.fps,
        file: p.clip.source.file,
        hasAudio: p.clip.source.hasAudio,
        sourceWidth: p.clip.source.width,
        sourceHeight: p.clip.source.height,
        ...f,
        cues: p.clip.cues,
        reframe: p.clip.reframe,
        captionStyle: id === "captions" ? p.captionStyle : null,
      });
      return layout([item], p.fps, p.aspect, p.scale, {}, limits);
    }
    case "cutdown": {
      const p = props as PropsById["cutdown"];
      const plan = planCutdown({ sourceSeconds: p.source.durationSeconds, targetSeconds: p.targetSeconds, fps: p.fps, keep: p.keep });
      const items = plan.segments.map((segment) =>
        clipItem({
          from: 0,
          fps: p.fps,
          file: p.source.file,
          hasAudio: p.source.hasAudio,
          sourceWidth: p.source.width,
          sourceHeight: p.source.height,
          srcStartFrame: segment.srcStartFrame,
          durationInFrames: segment.durationInFrames,
          // Source-time cues: the clip takes only the part inside its own stretch, in its own local time.
          cues: p.cues,
          reframe: p.reframe,
          captionStyle: p.captionStyle,
        }),
      );
      return layout(items, p.fps, p.aspect, p.scale, {}, limits);
    }
    case "final": {
      const p = props as PropsById["final"];
      const items: TimelineItem[] = [];
      if (p.title) items.push({ kind: "title", from: 0, durationInFrames: frames(p.title.durationSeconds, p.fps), card: p.title });
      for (const clip of p.clips) {
        items.push(
          clipItem({
            from: 0,
            fps: p.fps,
            file: clip.source.file,
            hasAudio: clip.source.hasAudio,
            sourceWidth: clip.source.width,
            sourceHeight: clip.source.height,
            ...clipFrames(clip, p.fps),
            cues: clip.cues,
            reframe: clip.reframe,
            captionStyle: p.captionStyle,
          }),
        );
      }
      if (p.end) items.push({ kind: "end", from: 0, durationInFrames: frames(p.end.durationSeconds, p.fps), card: p.end });
      const timeline = layout(items, p.fps, p.aspect, p.scale, {}, limits);
      timeline.duck = p.duck;
      p.voiceover.forEach((line, index) => {
        const from = frames(line.startSeconds, p.fps);
        if (from >= timeline.durationInFrames) {
          throw new RangeError(`props.voiceover[${index}]: starts at ${line.startSeconds} s, after the end of the cut (${(timeline.durationInFrames / p.fps).toFixed(1)} s)`);
        }
        timeline.voiceover.push({ file: line.file, from, durationInFrames: Math.max(1, Math.min(frames(line.durationSeconds, p.fps), timeline.durationInFrames - from)), volume: line.volume });
      });
      /* Two voice lines cannot play at once: a line that starts before the one before it has ended is refused, not mixed. */
      const placed = timeline.voiceover.map((line, index) => ({ line, index })).sort((a, b) => a.line.from - b.line.from || a.index - b.index);
      for (let k = 1; k < placed.length; k += 1) {
        const before = placed[k - 1];
        const line = placed[k];
        if (line.line.from < before.line.from + before.line.durationInFrames) {
          throw new RangeError(`props.voiceover[${line.index}] overlaps props.voiceover[${before.index}]: two voice lines cannot play at once (one starts at ${(line.line.from / p.fps).toFixed(2)} s, the other runs until ${((before.line.from + before.line.durationInFrames) / p.fps).toFixed(2)} s)`);
        }
      }
      if (p.music) {
        timeline.music = {
          file: p.music.file,
          volume: p.music.volume,
          durationInFrames: Math.min(timeline.durationInFrames, frames(p.music.durationSeconds, p.fps)),
        };
      }
      return timeline;
    }
    case "fixture-clip": {
      const p = props as PropsById["fixture-clip"];
      const timeline = finish([], frames(p.durationSeconds, p.fps), p.fps, p.aspect, p.scale, { fixture: { label: p.label } }, limits);
      return timeline;
    }
    default: {
      const never: never = id;
      throw new Error(`Unknown composition ${String(never)}`);
    }
  }
}
