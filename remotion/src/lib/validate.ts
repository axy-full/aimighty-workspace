import {
  ASPECTS,
  CAPTION_STYLES,
  COMPOSITION_IDS,
  CUTDOWN_TARGETS,
  DEFAULT_FPS,
  DEFAULT_THEME,
  FPS_CHOICES,
  REFRAME_MODES,
  type Aspect,
  type CaptionStyle,
  type CaptionsProps,
  type ClipItem,
  type ClipSource,
  type CompositionId,
  type Cue,
  type CutdownProps,
  type CutdownTarget,
  type EndCardProps,
  type EndCardSpec,
  type FileRef,
  type FinalProps,
  type FixtureClipProps,
  type MusicSpec,
  type PropsById,
  type Range,
  type ReframeMode,
  type ReframeProps,
  type ReframeSpec,
  type Theme,
  type TitleCardProps,
  type TitleCardSpec,
  type Word,
} from "./types";
import { DEFAULT_LIMITS, type ExportLimits } from "./limits";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VIDEO_EXT = ["mp4", "mov", "webm", "m4v"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg"];

/**
 * A file named by the app: a plain relative path inside the session's input folder.
 * No scheme (so nothing can be fetched), no absolute path, no `..`, no backslash,
 * no control character, and an extension we know how to read.
 */
export function isSafeInputPath(value: unknown, extensions: string[]): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes(":") || value.includes("?") || value.includes("#") || value.includes("%")) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return false;
  return extensions.includes(value.slice(dot + 1).toLowerCase());
}

class Issues {
  readonly list: string[] = [];
  add(path: string, message: string) {
    if (this.list.length < 25) this.list.push(`${path}: ${message}`);
  }
}

type Rec = Record<string, unknown>;

function record(value: unknown, path: string, issues: Issues, allowed: string[]): Rec | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.add(path, "must be an object");
    return null;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.add(`${path}.${key}`, "is not allowed");
  return value as Rec;
}

function text(value: unknown, path: string, issues: Issues, max: number, { optional = false, empty = false } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (!optional) issues.add(path, "is required");
    return undefined;
  }
  if (typeof value !== "string") {
    issues.add(path, "must be text");
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) issues.add(path, "has a control character");
  if (!empty && trimmed.length === 0) {
    if (!optional) issues.add(path, "must not be empty");
    return undefined;
  }
  if (trimmed.length > max) {
    issues.add(path, `must be at most ${max} characters`);
    return undefined;
  }
  return trimmed;
}

function num(value: unknown, path: string, issues: Issues, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    issues.add(path, "is required");
    return min;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    issues.add(path, `must be a number from ${min} to ${max}`);
    return fallback ?? min;
  }
  return value;
}

function oneOf<T extends string | number>(value: unknown, path: string, issues: Issues, choices: readonly T[], fallback?: T): T {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (!choices.includes(value as T)) {
    issues.add(path, `must be one of ${choices.join(", ")}`);
    return fallback ?? choices[0];
  }
  return value as T;
}

function hex(value: unknown, path: string, issues: Issues, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    issues.add(path, "must be a colour like #1a2b3c");
    return fallback;
  }
  return value.toLowerCase();
}

function fileRef(value: unknown, path: string, issues: Issues, extensions: string[]): FileRef | undefined {
  if (value === undefined || value === null) return undefined;
  const rec = record(value, path, issues, ["file"]);
  if (!rec) return undefined;
  if (!isSafeInputPath(rec.file, extensions)) {
    issues.add(`${path}.file`, "must be a plain relative path to a file in the input folder");
    return undefined;
  }
  return { file: rec.file };
}

function theme(value: unknown, path: string, issues: Issues): Theme {
  if (value === undefined || value === null) return { ...DEFAULT_THEME };
  const rec = record(value, path, issues, ["background", "foreground", "accent"]);
  if (!rec) return { ...DEFAULT_THEME };
  return {
    background: hex(rec.background, `${path}.background`, issues, DEFAULT_THEME.background),
    foreground: hex(rec.foreground, `${path}.foreground`, issues, DEFAULT_THEME.foreground),
    accent: hex(rec.accent, `${path}.accent`, issues, DEFAULT_THEME.accent),
  };
}

function common(rec: Rec, issues: Issues, limits: ExportLimits): { aspect: Aspect; fps: number; scale: number } {
  return {
    aspect: oneOf<Aspect>(rec.aspect, "aspect", issues, ASPECTS),
    fps: oneOf<number>(rec.fps, "fps", issues, FPS_CHOICES, DEFAULT_FPS),
    scale: num(rec.scale, "scale", issues, limits.minScale, 1, 1),
  };
}

function source(value: unknown, path: string, issues: Issues, limits: ExportLimits): ClipSource {
  const blank: ClipSource = { file: "x.mp4", durationSeconds: 1, width: 2, height: 2, hasAudio: false };
  const rec = record(value, path, issues, ["file", "durationSeconds", "width", "height", "hasAudio", "offsetSeconds"]);
  if (!rec) return blank;
  if (!isSafeInputPath(rec.file, VIDEO_EXT)) {
    issues.add(`${path}.file`, "must be a plain relative path to a video file in the input folder");
  }
  const hasAudio = rec.hasAudio === undefined ? true : rec.hasAudio;
  if (typeof hasAudio !== "boolean") issues.add(`${path}.hasAudio`, "must be true or false");
  const durationSeconds = num(rec.durationSeconds, `${path}.durationSeconds`, issues, 0.1, limits.maxSourceSeconds);
  const offsetSeconds = rec.offsetSeconds === undefined ? 0 : num(rec.offsetSeconds, `${path}.offsetSeconds`, issues, 0, durationSeconds);
  return {
    file: typeof rec.file === "string" ? rec.file : blank.file,
    durationSeconds,
    width: Math.round(num(rec.width, `${path}.width`, issues, 16, 7680)),
    height: Math.round(num(rec.height, `${path}.height`, issues, 16, 7680)),
    hasAudio: hasAudio === false ? false : true,
    ...(offsetSeconds > 0 ? { offsetSeconds } : {}),
  };
}

function range(value: unknown, path: string, issues: Issues, within: number): Range {
  const rec = record(value, path, issues, ["startSeconds", "endSeconds"]);
  if (!rec) return { startSeconds: 0, endSeconds: 0.1 };
  const startSeconds = num(rec.startSeconds, `${path}.startSeconds`, issues, 0, within);
  const endSeconds = num(rec.endSeconds, `${path}.endSeconds`, issues, 0, within);
  if (endSeconds <= startSeconds) issues.add(path, "must end after it starts");
  return { startSeconds, endSeconds };
}

function cues(value: unknown, path: string, issues: Issues, limits: ExportLimits): Cue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.add(path, "must be a list");
    return [];
  }
  if (value.length > limits.maxCues) {
    issues.add(path, `must have at most ${limits.maxCues} cues`);
    return [];
  }
  const out: Cue[] = [];
  value.forEach((item, index) => {
    const here = `${path}[${index}]`;
    const rec = record(item, here, issues, ["startMs", "endMs", "text", "words"]);
    if (!rec) return;
    const startMs = num(rec.startMs, `${here}.startMs`, issues, 0, 24 * 3600 * 1000);
    const endMs = num(rec.endMs, `${here}.endMs`, issues, 0, 24 * 3600 * 1000);
    if (endMs <= startMs) issues.add(here, "must end after it starts");
    const body = text(rec.text, `${here}.text`, issues, limits.maxTextChars) ?? "";
    let words: Word[] | undefined;
    if (rec.words !== undefined && rec.words !== null) {
      if (!Array.isArray(rec.words) || rec.words.length > limits.maxWordsPerCue) {
        issues.add(`${here}.words`, `must be a list of at most ${limits.maxWordsPerCue} words`);
      } else {
        words = [];
        rec.words.forEach((word, wi) => {
          const wp = `${here}.words[${wi}]`;
          const wr = record(word, wp, issues, ["startMs", "endMs", "text"]);
          if (!wr) return;
          const ws = num(wr.startMs, `${wp}.startMs`, issues, 0, 24 * 3600 * 1000);
          const we = num(wr.endMs, `${wp}.endMs`, issues, 0, 24 * 3600 * 1000);
          if (we <= ws) issues.add(wp, "must end after it starts");
          words!.push({ startMs: ws, endMs: we, text: text(wr.text, `${wp}.text`, issues, 40) ?? "" });
        });
      }
    }
    out.push(words ? { startMs, endMs, text: body, words } : { startMs, endMs, text: body });
  });
  return out;
}

function reframe(value: unknown, path: string, issues: Issues): ReframeSpec {
  const fallback: ReframeSpec = { mode: "fill", focusX: 0.5, focusY: 0.5 };
  if (value === undefined || value === null) return fallback;
  const rec = record(value, path, issues, ["mode", "focusX", "focusY"]);
  if (!rec) return fallback;
  return {
    mode: oneOf<ReframeMode>(rec.mode, `${path}.mode`, issues, REFRAME_MODES, "fill"),
    focusX: num(rec.focusX, `${path}.focusX`, issues, 0, 1, 0.5),
    focusY: num(rec.focusY, `${path}.focusY`, issues, 0, 1, 0.5),
  };
}

function clip(value: unknown, path: string, issues: Issues, limits: ExportLimits): ClipItem {
  const rec = record(value, path, issues, ["source", "trim", "cues", "reframe"]);
  const blank = source(undefined, `${path}.source`, new Issues(), limits);
  if (!rec) return { source: blank, cues: [], reframe: reframe(undefined, path, issues) };
  const src = source(rec.source, `${path}.source`, issues, limits);
  const item: ClipItem = { source: src, cues: cues(rec.cues, `${path}.cues`, issues, limits), reframe: reframe(rec.reframe, `${path}.reframe`, issues) };
  if (rec.trim !== undefined && rec.trim !== null) {
    const trim = range(rec.trim, `${path}.trim`, issues, src.durationSeconds);
    item.trim = trim;
  }
  return item;
}

function title(value: unknown, path: string, issues: Issues, limits: ExportLimits): TitleCardSpec {
  const rec = record(value, path, issues, ["title", "subtitle", "logo", "theme", "durationSeconds"]);
  if (!rec) return { title: "-", theme: { ...DEFAULT_THEME }, durationSeconds: 2.5 };
  const spec: TitleCardSpec = {
    title: text(rec.title, `${path}.title`, issues, limits.maxTextChars) ?? "-",
    theme: theme(rec.theme, `${path}.theme`, issues),
    durationSeconds: num(rec.durationSeconds, `${path}.durationSeconds`, issues, 1, 10, 2.5),
  };
  const subtitle = text(rec.subtitle, `${path}.subtitle`, issues, limits.maxTextChars, { optional: true });
  if (subtitle) spec.subtitle = subtitle;
  const logo = fileRef(rec.logo, `${path}.logo`, issues, IMAGE_EXT);
  if (logo) spec.logo = logo;
  return spec;
}

function endCard(value: unknown, path: string, issues: Issues, limits: ExportLimits): EndCardSpec {
  const rec = record(value, path, issues, ["headline", "callToAction", "line", "logo", "theme", "durationSeconds"]);
  if (!rec) return { headline: "-", theme: { ...DEFAULT_THEME }, durationSeconds: 3 };
  const spec: EndCardSpec = {
    headline: text(rec.headline, `${path}.headline`, issues, limits.maxTextChars) ?? "-",
    theme: theme(rec.theme, `${path}.theme`, issues),
    durationSeconds: num(rec.durationSeconds, `${path}.durationSeconds`, issues, 1, 10, 3),
  };
  const cta = text(rec.callToAction, `${path}.callToAction`, issues, limits.maxTextChars, { optional: true });
  if (cta) spec.callToAction = cta;
  const line = text(rec.line, `${path}.line`, issues, limits.maxTextChars, { optional: true });
  if (line) spec.line = line;
  const logo = fileRef(rec.logo, `${path}.logo`, issues, IMAGE_EXT);
  if (logo) spec.logo = logo;
  return spec;
}

function music(value: unknown, path: string, issues: Issues): MusicSpec | null {
  if (value === undefined || value === null) return null;
  const rec = record(value, path, issues, ["file", "durationSeconds", "volume"]);
  if (!rec) return null;
  if (!isSafeInputPath(rec.file, AUDIO_EXT)) issues.add(`${path}.file`, "must be a plain relative path to an audio file in the input folder");
  return {
    file: typeof rec.file === "string" ? rec.file : "x.mp3",
    durationSeconds: num(rec.durationSeconds, `${path}.durationSeconds`, issues, 0.5, 3600),
    volume: num(rec.volume, `${path}.volume`, issues, 0, 1, 0.25),
  };
}

function captionStyle(value: unknown, path: string, issues: Issues, fallback: CaptionStyle): CaptionStyle;
function captionStyle(value: unknown, path: string, issues: Issues, fallback: null): CaptionStyle | null;
function captionStyle(value: unknown, path: string, issues: Issues, fallback: CaptionStyle | null): CaptionStyle | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return oneOf<CaptionStyle>(value, path, issues, CAPTION_STYLES);
}

type Validator<T> = (value: unknown, issues: Issues, limits: ExportLimits) => T;

const validators: { [K in CompositionId]: Validator<PropsById[K]> } = {
  "title-card": (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "card"]) ?? {};
    return { ...common(rec, issues, limits), card: title(rec.card, "props.card", issues, limits) } satisfies TitleCardProps;
  },
  "end-card": (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "card"]) ?? {};
    return { ...common(rec, issues, limits), card: endCard(rec.card, "props.card", issues, limits) } satisfies EndCardProps;
  },
  captions: (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "clip", "captionStyle"]) ?? {};
    return {
      ...common(rec, issues, limits),
      clip: clip(rec.clip, "props.clip", issues, limits),
      captionStyle: captionStyle(rec.captionStyle, "props.captionStyle", issues, "bold"),
    } satisfies CaptionsProps;
  },
  reframe: (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "clip"]) ?? {};
    return { ...common(rec, issues, limits), clip: clip(rec.clip, "props.clip", issues, limits) } satisfies ReframeProps;
  },
  cutdown: (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "source", "targetSeconds", "keep", "cues", "captionStyle", "reframe"]) ?? {};
    const src = source(rec.source, "props.source", issues, limits);
    let keep: Range[] = [];
    if (rec.keep !== undefined && rec.keep !== null) {
      if (!Array.isArray(rec.keep) || rec.keep.length > 12) issues.add("props.keep", "must be a list of at most 12 ranges");
      else keep = rec.keep.map((item, index) => range(item, `props.keep[${index}]`, issues, src.durationSeconds));
    }
    return {
      ...common(rec, issues, limits),
      source: src,
      targetSeconds: oneOf<CutdownTarget>(rec.targetSeconds, "props.targetSeconds", issues, CUTDOWN_TARGETS),
      keep,
      cues: cues(rec.cues, "props.cues", issues, limits),
      captionStyle: captionStyle(rec.captionStyle, "props.captionStyle", issues, null),
      reframe: reframe(rec.reframe, "props.reframe", issues),
    } satisfies CutdownProps;
  },
  final: (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "title", "clips", "captionStyle", "end", "music"]) ?? {};
    let clips: ClipItem[] = [];
    if (!Array.isArray(rec.clips) || rec.clips.length === 0 || rec.clips.length > limits.maxClips) {
      issues.add("props.clips", `must be a list of 1 to ${limits.maxClips} clips`);
    } else {
      clips = rec.clips.map((item, index) => clip(item, `props.clips[${index}]`, issues, limits));
    }
    return {
      ...common(rec, issues, limits),
      title: rec.title ? title(rec.title, "props.title", issues, limits) : null,
      clips,
      captionStyle: captionStyle(rec.captionStyle, "props.captionStyle", issues, null),
      end: rec.end ? endCard(rec.end, "props.end", issues, limits) : null,
      music: music(rec.music, "props.music", issues),
    } satisfies FinalProps;
  },
  "fixture-clip": (value, issues, limits) => {
    const rec = record(value, "props", issues, ["aspect", "fps", "scale", "durationSeconds", "label"]) ?? {};
    return {
      ...common(rec, issues, limits),
      durationSeconds: num(rec.durationSeconds, "props.durationSeconds", issues, 0.5, limits.maxSeconds, 2),
      label: text(rec.label, "props.label", issues, 40, { optional: true }) ?? "SAMPLE",
    } satisfies FixtureClipProps;
  },
};

export function isCompositionId(value: unknown): value is CompositionId {
  return typeof value === "string" && (COMPOSITION_IDS as readonly string[]).includes(value);
}

/** Validate and normalise the props of one composition. Unknown keys are refused. */
export function validateProps<K extends CompositionId>(id: K, props: unknown, limits: ExportLimits = DEFAULT_LIMITS): Result<PropsById[K]> {
  const issues = new Issues();
  const value = (validators[id] as Validator<PropsById[K]>)(props, issues, limits);
  return issues.list.length ? { ok: false, errors: issues.list } : { ok: true, value };
}
