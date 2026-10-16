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
  /** false = do not use the file's sound (a muted clip, or a file with none); true = use it, and the file must have it. Default true. */
  hasAudio: boolean;
  /**
   * Where in the source the file in input/ starts, when it holds only a stretch of it (the conform pre-pass's windowed copy): the file's
   * first frame is the source's `offsetSeconds`. Trims and cues stay in source time. Absent: the file is the whole source.
   */
  offsetSeconds?: number;
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
  /** Cues to burn in, in time local to the start of this item: empty when no caption style is chosen. */
  cues: Cue[];
  /** The same cues whether or not they are burned in, for the sidecar subtitle files (src/lib/subtitles.ts). */
  subtitleCues: Cue[];
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

/**
 * The finished video's format (spec.output.format). H.264 is the default delivery file; ProRes 422 and ProRes 422 HQ
 * are mezzanine files for editing. H.265 is refused (owner, 15 Oct 2026: "H.265 stays off until my lawyer answers").
 */
export const VIDEO_FORMATS = ["h264", "prores-422", "prores-422-hq"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export const isProRes = (format: VideoFormat): boolean => format !== "h264";
/** The file a format is written to, and its media type. */
export const FORMAT_FILE: Record<VideoFormat, { name: string; mime: string }> = {
  h264: { name: "export.mp4", mime: "video/mp4" },
  "prores-422": { name: "export.mov", mime: "video/quicktime" },
  "prores-422-hq": { name: "export.mov", mime: "video/quicktime" },
};
/** Names a person or an agent might ask for that mean H.265. Refused with a plain reason, never guessed at. */
export const H265_NAMES: readonly string[] = ["h265", "h.265", "hevc", "h265-mp4", "x265"];

/** The sidecar subtitle files an export may also write (spec.output.subtitles), from the same cue data as the burned-in captions. */
export const SUBTITLE_FORMATS = ["srt", "vtt"] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];
export const SUBTITLE_FILE: Record<SubtitleFormat, { name: string; mime: string }> = {
  srt: { name: "subtitles.srt", mime: "application/x-subrip" },
  vtt: { name: "subtitles.vtt", mime: "text/vtt" },
};
