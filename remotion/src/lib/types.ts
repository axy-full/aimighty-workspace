/**
 * Props and timeline types for Particl's export templates.
 *
 * Everything in `src/lib` is plain TypeScript with no imports from remotion or
 * react, so the app's unit tests (and the worker's command) can use it without
 * a browser. The compositions in `src/*.tsx` are thin: they render a Timeline.
 */

export const ASPECTS = ["16:9", "9:16"] as const;
export type Aspect = (typeof ASPECTS)[number];

export const FORMAT_SIZE: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
};

export const FPS_CHOICES = [24, 25, 30, 60] as const;
export const DEFAULT_FPS = 30;

export const CUTDOWN_TARGETS = [6, 15, 30] as const;
export type CutdownTarget = (typeof CUTDOWN_TARGETS)[number];

export const CAPTION_STYLES = ["bold", "clean", "karaoke"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const REFRAME_MODES = ["fill", "fit"] as const;
export type ReframeMode = (typeof REFRAME_MODES)[number];

/** Every composition id the worker will render. Nothing else is accepted. */
export const COMPOSITION_IDS = [
  "captions",
  "title-card",
  "end-card",
  "reframe",
  "cutdown",
  "final",
  "fixture-clip",
] as const;
export type CompositionId = (typeof COMPOSITION_IDS)[number];

/** A file the app wrote into the session's input folder: a relative path, never a URL. */
export type FileRef = { file: string };

export type ClipSource = {
  file: string;
  durationSeconds: number;
  width: number;
  height: number;
  /** false when the file has no audio track; default true. */
  hasAudio: boolean;
};

export type Word = { startMs: number; endMs: number; text: string };
export type Cue = { startMs: number; endMs: number; text: string; words?: Word[] };

export type Theme = { background: string; foreground: string; accent: string };
export const DEFAULT_THEME: Theme = { background: "#000000", foreground: "#ffffff", accent: "#ffd400" };

export type TitleCardSpec = {
  title: string;
  subtitle?: string;
  logo?: FileRef;
  theme: Theme;
  durationSeconds: number;
};

export type EndCardSpec = {
  headline: string;
  callToAction?: string;
  /** A handle, a web address or a short line. Shown as text; never fetched. */
  line?: string;
  logo?: FileRef;
  theme: Theme;
  durationSeconds: number;
};

export type ReframeSpec = {
  mode: ReframeMode;
  /** 0..1 across the source; where a fill crop is centred. */
  focusX: number;
  focusY: number;
};

export type Range = { startSeconds: number; endSeconds: number };

export type ClipItem = {
  source: ClipSource;
  /** Part of the source to use; default the whole file. */
  trim?: Range;
  cues: Cue[];
  reframe: ReframeSpec;
};

export type MusicSpec = { file: string; durationSeconds: number; volume: number };

type Common = { aspect: Aspect; fps: number; scale: number };

export type TitleCardProps = Common & { card: TitleCardSpec };
export type EndCardProps = Common & { card: EndCardSpec };
export type CaptionsProps = Common & { clip: ClipItem; captionStyle: CaptionStyle };
export type ReframeProps = Common & { clip: ClipItem };
export type CutdownProps = Common & {
  source: ClipSource;
  targetSeconds: CutdownTarget;
  /** Moments that must stay in the cut, in source time. */
  keep: Range[];
  cues: Cue[];
  captionStyle: CaptionStyle | null;
  reframe: ReframeSpec;
};
export type FinalProps = Common & {
  title: TitleCardSpec | null;
  clips: ClipItem[];
  captionStyle: CaptionStyle | null;
  end: EndCardSpec | null;
  music: MusicSpec | null;
};
export type FixtureClipProps = Common & { durationSeconds: number; label: string };

export type PropsById = {
  captions: CaptionsProps;
  "title-card": TitleCardProps;
  "end-card": EndCardProps;
  reframe: ReframeProps;
  cutdown: CutdownProps;
  final: FinalProps;
  "fixture-clip": FixtureClipProps;
};

/* ---- the timeline every composition renders ---- */

export type ClipTimelineItem = {
  kind: "clip";
  from: number;
  durationInFrames: number;
  file: string;
  /** First source frame played. */
  trimBefore: number;
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  reframe: ReframeSpec;
  /** Cues in time local to the start of this item. */
  cues: Cue[];
  captionStyle: CaptionStyle | null;
};
export type TitleTimelineItem = { kind: "title"; from: number; durationInFrames: number; card: TitleCardSpec };
export type EndTimelineItem = { kind: "end"; from: number; durationInFrames: number; card: EndCardSpec };
export type TimelineItem = ClipTimelineItem | TitleTimelineItem | EndTimelineItem;

export type Timeline = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  items: TimelineItem[];
  music: { file: string; volume: number; durationInFrames: number } | null;
  /** Set only by the fixture clip. */
  fixture: { label: string } | null;
};

export type Box = { x: number; y: number; width: number; height: number };
