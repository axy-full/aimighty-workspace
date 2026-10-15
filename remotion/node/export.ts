/**
 * The export command, as the worker runs it. A JSON spec in, files out. Nothing here knows about HTTP
 * or the app: the worker (PR 2) calls the cli, which calls runExport with the real renderer; the tests
 * call runExport with a fake one.
 *
 * Contract (version 1):
 *   spec.json   { "version": 1, "composition": <id>, "props": {...}, "output": { "video": true, "format": "h264", "stills": [0, 45], "subtitles": ["srt", "vtt"], "conform": "off" } }
 *   input/      the files the props name, as plain relative paths
 *   output/     export.mp4 (H.264) or export.mov (ProRes) when output.video is not false, still-<frame>.png for each still,
 *               subtitles.srt / subtitles.vtt when asked (from the same cues as the captions; no render), result.json
 */
import { copyFile, link, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LIMITS, PRORES_MAX_FRAMES, type ExportLimits } from "../src/lib/limits";
import { toTimeline, ExportTooLong } from "../src/lib/timeline";
import { FORMAT_FILE, H265_NAMES, SUBTITLE_FILE, SUBTITLE_FORMATS, VIDEO_FORMATS, isProRes, type CompositionId, type SubtitleFormat, type Timeline, type VideoFormat } from "../src/lib/types";
import { speakableCues, subtitleCuesOf, subtitleText } from "../src/lib/subtitles";
import { isCompositionId, validateProps } from "../src/lib/validate";
import { CONFORM_BUDGET_MS, CONFORM_FILE_MS, CONFORM_MODES, CONFORM_PAD_SECONDS, DEFAULT_CONFORM, filesToConform, reportInputs, type ConformMode, type ConformWindow, type Conformer, type InputReport } from "./conform";
import type { MediaFacts, Prober } from "./probe";
import type { SilenceDetector } from "./silence";
import { chooseSpeech, mergeKeep, speechRanges } from "../src/lib/silence";
import type { CutdownProps, Range } from "../src/lib/types";

export type ExportSpec = {
  version: 1;
  composition: CompositionId;
  props: unknown;
  output?: { video?: boolean; format?: string; stills?: number[]; subtitles?: string[]; conform?: string };
};

export type CompositionInfo = { id: string; width: number; height: number; fps: number; durationInFrames: number; props: Record<string, unknown> };

/** The slice of @remotion/renderer the export uses; the tests substitute a fake. */
export type Renderer = {
  prepare(): Promise<void>;
  selectComposition(args: { serveUrl: string; id: string; inputProps: Record<string, unknown> }): Promise<CompositionInfo>;
  renderVideo(args: { serveUrl: string; composition: CompositionInfo; inputProps: Record<string, unknown>; outputLocation: string; format: VideoFormat; concurrency: number; onProgress?: (done: number, total: number) => void }): Promise<void>;
  renderStill(args: { serveUrl: string; composition: CompositionInfo; inputProps: Record<string, unknown>; frame: number; outputLocation: string }): Promise<void>;
};

export type ExportFailure = { ok: false; code: "spec_invalid" | "too_long" | "input_missing" | "input_mismatch" | "silence_failed" | "render_failed"; errors: string[] };
export type ExportSuccess = {
  ok: true;
  composition: CompositionId;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  seconds: number;
  /** One line per picture input: its rate, and whether the render read a constant-rate copy (node/conform.ts). Absent when nothing was rendered. */
  inputs?: InputReport[];
  /** A silence-aware cutdown: what was found in the source's sound and the ranges the cut was planned to keep. */
  silence?: { file: string; silentSeconds: number; speech: Range[]; chosen: Range[]; kept: Range[]; fallback?: "no_silence_found" | "all_silent" };
  files: { name: string; kind: "video" | "still" | "subtitle"; bytes: number; frame?: number; format?: VideoFormat | SubtitleFormat; mime?: string }[];
};
export type ExportResult = ExportSuccess | ExportFailure;

export type RunExportArgs = {
  spec: unknown;
  /** Folder holding the input files. */
  inputDir: string;
  /** Folder the outputs are written to; created. */
  outputDir: string;
  /** The built bundle (index.html, bundle.js, public/fonts). Never modified. */
  bundleDir: string;
  /** Makes the constant-frame-rate copies of variable-rate pictures (node/conform.ts). Absent: nothing is conformed, and the inputs are only reported. */
  conformer?: Conformer;
  /** Finds the quiet stretches of a source's sound (node/silence.ts), for a cutdown with `silence: keep-speech`. Absent: such a request is refused. */
  silenceDetector?: SilenceDetector;
  /** The most the conform pre-pass may take in all (default CONFORM_BUDGET_MS); a test shortens it. */
  conformBudgetMs?: number;
  /** The clock the pre-pass budget is read from (default Date.now); only a test replaces it. */
  conformClock?: () => number;
  /** Scratch folder; created, and removed at the end. */
  workDir: string;
  renderer: Renderer;
  /** Reads what each input file really is; the spec's declared durations and sizes must match it. */
  prober: Prober;
  limits?: ExportLimits;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

const fail = (code: ExportFailure["code"], errors: string[]): ExportFailure => ({ ok: false, code, errors });

/** What the spec declares about each media input, by file: the video clips' length, size and audio, and the music's length. */
export type Declared = { file: string; kind: "video" | "audio"; durationSeconds: number; width?: number; height?: number; hasAudio?: boolean };

export function declaredOf(id: CompositionId, props: Record<string, unknown>): Declared[] {
  /* Keyed by what is declared as well as the file, so one file named by the music and by a voice line (or twice with two lengths) has each claim checked. */
  const out = new Map<string, Declared>();
  const audio = (file: string, durationSeconds: number) => out.set(`audio:${file}:${durationSeconds}`, { file, kind: "audio", durationSeconds });
  const video = (s: { file: string; durationSeconds: number; width: number; height: number; hasAudio: boolean }) =>
    out.set(`video:${s.file}:${s.durationSeconds}:${s.width}x${s.height}:${s.hasAudio}`, { file: s.file, kind: "video", durationSeconds: s.durationSeconds, width: s.width, height: s.height, hasAudio: s.hasAudio });
  const p = props as never as { clip?: { source: Parameters<typeof video>[0] }; source?: Parameters<typeof video>[0]; clips?: { source: Parameters<typeof video>[0] }[]; music?: { file: string; durationSeconds: number } | null; voiceover?: { file: string; durationSeconds: number }[] };
  if (id === "captions" || id === "reframe") video(p.clip!.source);
  if (id === "cutdown") video(p.source!);
  if (id === "final") {
    for (const clip of p.clips ?? []) video(clip.source);
    if (p.music) audio(p.music.file, p.music.durationSeconds);
    for (const line of p.voiceover ?? []) audio(line.file, line.durationSeconds);
  }
  return [...out.values()];
}

/**
 * The stretch of `file` the timeline plays, in source seconds, with a little padding and never past the file: every clip that uses
 * it counts, so a file used twice is covered from its earliest point to its latest.
 */
export function usedWindow(timeline: Timeline, file: string, fileSeconds?: number): ConformWindow | undefined {
  let start = Infinity;
  let end = 0;
  for (const item of timeline.items) {
    if (item.kind !== "clip" || item.file !== file) continue;
    start = Math.min(start, item.trimBefore / timeline.fps);
    end = Math.max(end, (item.trimBefore + item.durationInFrames) / timeline.fps);
  }
  if (!Number.isFinite(start)) return undefined;
  const ceiling = fileSeconds ?? Infinity;
  /* A whole number of frames, so the offset the renderer is given times the frame rate is a whole number of frames (24 fps included). */
  const startSeconds = Math.max(0, Math.floor(Math.round((start - CONFORM_PAD_SECONDS) * timeline.fps * 1e6) / 1e6) / timeline.fps);
  const endSeconds = Math.min(ceiling, Math.round((end + CONFORM_PAD_SECONDS) * 1000) / 1000);
  return { startSeconds, endSeconds };
}

/** The props with `offsetSeconds` set on every source that uses a windowed copy (a copy of just the stretch of the file the export uses). */
export function withSourceOffsets(id: CompositionId, props: Record<string, unknown>, offsets: ReadonlyMap<string, number>): Record<string, unknown> {
  const next = structuredClone(props) as Record<string, unknown>;
  const mark = (holder: unknown) => {
    const source = (holder as { source?: { file?: string; offsetSeconds?: number } } | undefined)?.source;
    const offset = source?.file ? offsets.get(source.file) : undefined;
    if (source && offset !== undefined && offset > 0) source.offsetSeconds = offset;
  };
  if (id === "captions" || id === "reframe") mark(next.clip);
  else if (id === "cutdown") mark(next);
  else if (id === "final") for (const clip of (next.clips as unknown[] | undefined) ?? []) mark(clip);
  return next;
}

/** Longest a declared length may differ from the file's. */
export const DURATION_TOLERANCE_SECONDS = 0.1;

/** Compare every declared fact with the file. Returns one plain reason per contradiction. */
export async function contradictions(declared: Declared[], inputDir: string, prober: Prober, collect?: Map<string, MediaFacts>): Promise<string[]> {
  const reasons: string[] = [];
  for (const d of declared) {
    let facts;
    try {
      facts = await prober.probe(path.join(inputDir, d.file));
    } catch (error) {
      reasons.push(`input/${d.file}: ${(error as Error).message}`);
      continue;
    }
    collect?.set(d.file, facts);
    if (d.kind === "video") {
      if (!facts.hasVideo) reasons.push(`input/${d.file}: has no picture`);
      else if (facts.width !== d.width || facts.height !== d.height) reasons.push(`input/${d.file}: is ${facts.width}x${facts.height}, the request says ${d.width}x${d.height}`);
      // Asking for the sound of a file that has none is a contradiction. Not using the sound of a file that has some is
      // the request's own choice (it is how a clip is muted), so that is not refused.
      if (d.hasAudio === true && !facts.hasAudio) reasons.push(`input/${d.file}: has no audio, the request says it has`);
    } else if (!facts.hasAudio) reasons.push(`input/${d.file}: has no audio`);
    if (Math.abs(facts.durationSeconds - d.durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      reasons.push(`input/${d.file}: is ${facts.durationSeconds.toFixed(2)} s, the request says ${d.durationSeconds} s`);
    }
  }
  return reasons;
}

/** Every input file a timeline needs, once each, as relative paths. */
export function inputFilesOf(timeline: Timeline): string[] {
  const files = new Set<string>();
  for (const item of timeline.items) {
    if (item.kind === "clip") files.add(item.file);
    else if (item.card.logo) files.add(item.card.logo.file);
  }
  if (timeline.music) files.add(timeline.music.file);
  for (const line of timeline.voiceover) files.add(line.file);
  return [...files];
}

export function checkSpec(spec: unknown, limits: ExportLimits = DEFAULT_LIMITS):
  | { ok: true; id: CompositionId; props: Record<string, unknown>; timeline: Timeline; video: boolean; format: VideoFormat; stills: number[]; subtitles: SubtitleFormat[]; conform: ConformMode }
  | ExportFailure {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return fail("spec_invalid", ["spec: must be an object"]);
  const rec = spec as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(rec)) if (!["version", "composition", "props", "output"].includes(key)) errors.push(`spec.${key}: is not allowed`);
  if (rec.version !== 1) errors.push("spec.version: must be 1");
  if (!isCompositionId(rec.composition)) errors.push("spec.composition: unknown composition");
  let video = true;
  let format: VideoFormat = "h264";
  let stills: number[] = [];
  let subtitles: SubtitleFormat[] = [];
  let conform: ConformMode = DEFAULT_CONFORM;
  if (rec.output !== undefined) {
    const out = rec.output as Record<string, unknown> | null;
    if (typeof out !== "object" || out === null || Array.isArray(out)) errors.push("spec.output: must be an object");
    else {
      for (const key of Object.keys(out)) if (!["video", "format", "stills", "subtitles", "conform"].includes(key)) errors.push(`spec.output.${key}: is not allowed`);
      if (out.format !== undefined) {
        const asked = typeof out.format === "string" ? out.format.trim().toLowerCase() : "";
        if (H265_NAMES.includes(asked)) errors.push("spec.output.format: H.265 is not available.");
        else if (!(VIDEO_FORMATS as readonly string[]).includes(asked)) errors.push(`spec.output.format: must be one of ${VIDEO_FORMATS.join(", ")}`);
        else format = asked as VideoFormat;
        if (out.video === false) errors.push("spec.output.format: needs the video (output.video is false)");
      }
      if (out.video !== undefined && typeof out.video !== "boolean") errors.push("spec.output.video: must be true or false");
      if (out.video === false) video = false;
      if (out.conform !== undefined) {
        if (typeof out.conform !== "string" || !(CONFORM_MODES as readonly string[]).includes(out.conform.trim().toLowerCase())) errors.push(`spec.output.conform: must be ${CONFORM_MODES.join(" or ")}`);
        else conform = out.conform.trim().toLowerCase() as ConformMode;
      }
      if (out.subtitles !== undefined) {
        const asked = Array.isArray(out.subtitles) && out.subtitles.length <= 8 ? [...new Set(out.subtitles.map((f) => (typeof f === "string" ? f.trim().toLowerCase() : "")))] : null;
        if (!asked || asked.length === 0 || asked.some((f) => !(SUBTITLE_FORMATS as readonly string[]).includes(f))) {
          errors.push(`spec.output.subtitles: must be a list of ${SUBTITLE_FORMATS.join(" and/or ")}`);
        } else subtitles = asked as SubtitleFormat[];
      }
      if (out.stills !== undefined) {
        if (!Array.isArray(out.stills) || out.stills.length > limits.maxStills || out.stills.some((n) => !Number.isInteger(n) || n < 0)) {
          errors.push(`spec.output.stills: must be a list of at most ${limits.maxStills} frame numbers`);
        } else stills = [...new Set(out.stills as number[])];
      }
    }
  }
  if (!video && stills.length === 0 && subtitles.length === 0) errors.push("spec.output: asks for nothing");
  if (errors.length || !isCompositionId(rec.composition)) return fail("spec_invalid", errors);
  const id = rec.composition;
  const checked = validateProps(id, rec.props, limits);
  if (!checked.ok) return fail("spec_invalid", checked.errors);
  let timeline: Timeline;
  try {
    timeline = toTimeline(id, checked.value as never, limits);
  } catch (error) {
    return fail(error instanceof ExportTooLong ? "too_long" : "spec_invalid", [(error as Error).message]);
  }
  if (video && isProRes(format) && timeline.durationInFrames > PRORES_MAX_FRAMES) {
    const seconds = timeline.durationInFrames / timeline.fps;
    return fail("too_long", [`A ProRes export can be at most ${PRORES_MAX_FRAMES} frames (60 s at 30 fps, 30 s at 60 fps); this one is ${timeline.durationInFrames} frames (${seconds.toFixed(1)} s at ${timeline.fps} fps). Use H.264 for a longer one.`]);
  }
  if (subtitles.length && subtitleCuesOf(timeline).length === 0) {
    return fail("spec_invalid", ["spec.output.subtitles: the export has no caption text (no cues) to write"]);
  }
  if (subtitles.length && speakableCues(timeline).length === 0) {
    return fail("spec_invalid", ["spec.output.subtitles: every caption in this export is only styling, so there is no text to write"]);
  }
  const outOfRange = stills.filter((frame) => frame >= timeline.durationInFrames);
  if (outOfRange.length) return fail("spec_invalid", [`spec.output.stills: frame ${outOfRange[0]} is past the end (${timeline.durationInFrames} frames)`]);
  return { ok: true, id, props: checked.value as unknown as Record<string, unknown>, timeline, video, format, stills, subtitles, conform };
}

/** True when `child` is `parent` or inside it, by real path (a symlink cannot lead out). */
async function insideReal(parent: string, child: string): Promise<boolean> {
  const [p, c] = await Promise.all([realpath(parent), realpath(child)]);
  return c === p || c.startsWith(p + path.sep);
}

async function missingInputs(inputDir: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    const full = path.join(inputDir, file);
    try {
      const info = await lstat(full);
      if (!info.isFile() || info.size === 0 || !(await insideReal(inputDir, full))) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  return missing;
}

/** Mirror a folder with hard links (a copy where the folders are on different disks). Symlinks are not followed or made: the renderer's file server answers 404 for them. */
async function mirror(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await mirror(source, target);
    else if (entry.isFile()) {
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target);
      }
    }
  }
}

/**
 * A folder the renderer can serve: the bundle's files, and a `public/` holding the bundled fonts and,
 * as `input/`, the session's files. Files are hard-linked, so nothing large is copied and the bundle
 * itself is never written to.
 */
export async function prepareServeDir(bundleDir: string, inputDir: string, serveDir: string): Promise<void> {
  await mirror(bundleDir, serveDir);
  await mirror(inputDir, path.join(serveDir, "public", "input"));
}

/** The sidecar subtitle files, written from the timeline's cues. Plain text: no renderer and no media file is needed. */
async function writeSubtitles(timeline: Timeline, formats: SubtitleFormat[], outputDir: string, files: ExportSuccess["files"]): Promise<void> {
  const cues = subtitleCuesOf(timeline);
  for (const format of formats) {
    const file = SUBTITLE_FILE[format];
    const target = path.join(outputDir, file.name);
    await writeFile(target, subtitleText(format, cues), "utf8");
    files.push({ name: file.name, kind: "subtitle", bytes: (await stat(target)).size, format, mime: file.mime });
  }
}

export async function runExport(args: RunExportArgs): Promise<ExportResult> {
  const limits = args.limits ?? DEFAULT_LIMITS;
  const first = checkSpec(args.spec, limits);
  if (!first.ok) return first;
  let checked = first;
  /* Subtitles alone need no picture: no input file is opened, the renderer is not started, and nothing is probed or served. */
  if (!checked.video && checked.stills.length === 0) {
    await mkdir(args.outputDir, { recursive: true });
    const t = checked.timeline;
    const files: ExportSuccess["files"] = [];
    await writeSubtitles(t, checked.subtitles, args.outputDir, files);
    const success: ExportSuccess = { ok: true, composition: checked.id, width: t.width, height: t.height, fps: t.fps, durationInFrames: t.durationInFrames, seconds: t.durationInFrames / t.fps, files };
    await writeFile(path.join(args.outputDir, "result.json"), JSON.stringify(success, null, 2));
    return success;
  }
  const missing = await missingInputs(args.inputDir, inputFilesOf(checked.timeline));
  if (missing.length) return fail("input_missing", missing.map((file) => `input/${file}: not found`));
  // A declared length or size the file contradicts is refused, never rendered from.
  const probed = new Map<string, MediaFacts>();
  const wrong = await contradictions(declaredOf(checked.id, checked.props), args.inputDir, args.prober, probed);
  if (wrong.length) return fail("input_mismatch", wrong);

  /* A silence-aware cutdown: the quiet stretches of the source's sound are found, the spoken ones are added to `keep`, and the cut is planned again from the result. */
  let silenceReport: ExportSuccess["silence"];
  if (checked.id === "cutdown" && (checked.props as unknown as CutdownProps).silence === "keep-speech") {
    const p = checked.props as unknown as CutdownProps;
    if (!args.silenceDetector) return fail("spec_invalid", ["props.silence: silence detection is not available here"]);
    if (!p.source.hasAudio) return fail("spec_invalid", ["props.silence: the source has no sound to find silence in"]);
    let silences: Range[];
    try {
      silences = await args.silenceDetector.detect(path.join(args.inputDir, p.source.file), p.source.durationSeconds);
    } catch (error) {
      /* Its own code (not "an input is wrong"): the file is fine as far as the request says, the detector could not read its sound. */
      return fail("silence_failed", [`input/${p.source.file}: ${(error as Error).message}`]);
    }
    const speech = speechRanges(silences, p.source.durationSeconds);
    /* Two fallbacks, both reported: no quiet stretch at all means "speech" would be the whole file, which marks nothing; all quiet means no speech. Either way nothing is added and the cut is planned from the explicit ranges or the even spread. */
    const fallback: "no_silence_found" | "all_silent" | undefined = silences.length === 0 ? "no_silence_found" : speech.length === 0 ? "all_silent" : undefined;
    const explicit = mergeKeep(p.keep, []);
    const room = Math.max(0, p.targetSeconds - explicit.reduce((sum, r) => sum + (r.endSeconds - r.startSeconds), 0));
    const chosen = fallback ? [] : chooseSpeech(speech, room);
    const kept = mergeKeep(p.keep, chosen);
    const next = checkSpec({ ...(args.spec as object), props: { ...checked.props, keep: kept, silence: "off" } }, limits);
    if (!next.ok) return next;
    checked = next;
    silenceReport = { file: p.source.file, silentSeconds: Math.round(silences.reduce((sum, r) => sum + (r.endSeconds - r.startSeconds), 0) * 1000) / 1000, speech: fallback ? [] : speech, chosen, kept, ...(fallback ? { fallback } : {}) };
  }

  await mkdir(args.outputDir, { recursive: true });
  await rm(args.workDir, { recursive: true, force: true });
  const serveDir = path.join(args.workDir, "serve");
  try {
    await prepareServeDir(args.bundleDir, args.inputDir, serveDir);
    /* The constant-frame-rate pre-pass: only variable-rate pictures, once each, into the work folder; the render reads the copy and the original in input/ is never changed. */
    const videoInputs = [...probed.entries()].filter(([, facts]) => facts.hasVideo).map(([file, facts]) => ({ file, facts }));
    const conformed = new Set<string>();
    const failed = new Set<string>();
    const offsets = new Map<string, number>();
    if (args.conformer) {
      let n = 0;
      const budget = Math.min(args.conformBudgetMs ?? CONFORM_BUDGET_MS, CONFORM_BUDGET_MS);
      const clock = args.conformClock ?? Date.now;
      const began = clock();
      for (const file of filesToConform(videoInputs, checked.conform)) {
        const left = budget - (clock() - began);
        /* Out of time: the render reads the original (it resamples by time, as it always has) and result.json says so. */
        if (left < 5_000) { failed.add(file); continue; }
        const copy = path.join(args.workDir, "conformed", `${n++}.mp4`);
        try {
          await mkdir(path.dirname(copy), { recursive: true });
          const window = usedWindow(checked.timeline, file, probed.get(file)?.durationSeconds);
          await args.conformer.conform(path.join(args.inputDir, file), copy, checked.timeline.fps, { window, timeoutMs: Math.min(CONFORM_FILE_MS, left) });
          /* The copy is moved into the served folder, not copied: it is large, and it is the only copy. */
          const target = path.join(serveDir, "public", "input", file);
          await rm(target, { force: true });
          await rename(copy, target);
          conformed.add(file);
          const startedAt = window?.startSeconds ?? 0;
          if (startedAt > 0) offsets.set(file, startedAt);
        } catch {
          failed.add(file);
          await rm(copy, { force: true }).catch(() => {});
        }
      }
    }
    await args.renderer.prepare();
    /* The renderer is told where each windowed copy starts in its source, so trims and cues (in source time) still land on the right frame. */
    const renderProps = offsets.size ? withSourceOffsets(checked.id, checked.props, offsets) : checked.props;
    const composition = await args.renderer.selectComposition({ serveUrl: serveDir, id: checked.id, inputProps: renderProps });
    const t = checked.timeline;
    if (composition.width !== t.width || composition.height !== t.height || composition.fps !== t.fps || composition.durationInFrames !== t.durationInFrames) {
      return fail("render_failed", [`The composition measured ${composition.width}x${composition.height} @${composition.fps} for ${composition.durationInFrames} frames; the timeline says ${t.width}x${t.height} @${t.fps} for ${t.durationInFrames}.`]);
    }
    const files: ExportSuccess["files"] = [];
    if (checked.video) {
      const file = FORMAT_FILE[checked.format];
      const outputLocation = path.join(args.outputDir, file.name);
      await args.renderer.renderVideo({ serveUrl: serveDir, composition, inputProps: renderProps, outputLocation, format: checked.format, concurrency: args.concurrency ?? 2, onProgress: args.onProgress });
      files.push({ name: file.name, kind: "video", bytes: (await stat(outputLocation)).size, format: checked.format, mime: file.mime });
    }
    for (const frame of checked.stills) {
      const name = `still-${frame}.png`;
      const outputLocation = path.join(args.outputDir, name);
      await args.renderer.renderStill({ serveUrl: serveDir, composition, inputProps: renderProps, frame, outputLocation });
      files.push({ name, kind: "still", frame, bytes: (await stat(outputLocation)).size });
    }
    await writeSubtitles(t, checked.subtitles, args.outputDir, files);
    const success: ExportSuccess = { ok: true, composition: checked.id, width: t.width, height: t.height, fps: t.fps, durationInFrames: t.durationInFrames, seconds: t.durationInFrames / t.fps, inputs: reportInputs(videoInputs, t.fps, conformed, failed, checked.conform), ...(silenceReport ? { silence: silenceReport } : {}), files };
    await writeFile(path.join(args.outputDir, "result.json"), JSON.stringify(success, null, 2));
    return success;
  } catch (error) {
    return fail("render_failed", [(error as Error).message.slice(0, 2000)]);
  } finally {
    await rm(args.workDir, { recursive: true, force: true });
  }
}
