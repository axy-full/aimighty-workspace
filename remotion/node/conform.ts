import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import type { MediaFacts } from "./probe";

/**
 * Constant frame rate (spec.output.conform). A phone clip or a screen recording can carry frames that are not evenly spaced
 * (variable frame rate). The render picks frames by time, so it copes, but a cut or a mezzanine made from such a file can drift
 * against its sound. The conform pre-pass re-encodes only those files, once, to a constant rate equal to the export's own, and
 * the render reads that copy. A file already at a constant rate is never touched, even if the rate differs from the export's
 * (the render resamples it by time, as it always has); it is only reported.
 *
 * "off" (the default: the owner can turn it on) never converts; "auto" conforms a variable-frame-rate video, and only the stretch of it
 * the export actually uses. A ProRes, 10-bit or alpha source is never flattened to 8-bit 4:2:0: it is left alone and reported. The
 * pre-pass has a total time budget, and the original in input/ is never changed.
 */
export const CONFORM_MODES = ["auto", "off"] as const;
export type ConformMode = (typeof CONFORM_MODES)[number];
export const DEFAULT_CONFORM: ConformMode = "off";

/** All the pre-pass may take, in total: it runs inside the worker's 900 s run deadline and leaves the render the rest. */
export const CONFORM_BUDGET_MS = 300_000;
/** One file's share, at most. */
export const CONFORM_FILE_MS = 150_000;
/** Extra picture kept before and after the used stretch, so a seek never lands short. */
export const CONFORM_PAD_SECONDS = 0.25;

export type InputReport = {
  file: string;
  /** The file's own average rate, when it says. */
  fps: number | null;
  variableFrameRate: boolean;
  /** The export's rate. */
  targetFps: number;
  /** The render read a constant-rate copy made by the pre-pass. */
  conformed: boolean;
  /** The file was not at the export's rate (constant or variable) and is resampled by the render. */
  resampled: boolean;
  /** The pre-pass was asked for and could not be made (or ran out of time); the render reads the original. */
  conformFailed?: boolean;
  /** Why a variable-rate file was left alone: it is a high-quality source (ProRes, 10-bit or alpha) that 8-bit 4:2:0 would flatten. */
  skipped?: "high-quality source";
};

const HIGH_QUALITY_CODECS = ["prores", "dnxhd", "dnxhr", "cfhd", "ffv1", "v210", "v410", "png", "qtrle", "huffyuv"];
/** ProRes, DNxHD and the like, any 10 bits or more, or any alpha channel: converting these to 8-bit 4:2:0 would throw quality away. */
export function highQualitySource(facts: MediaFacts): boolean {
  if (facts.videoCodec && HIGH_QUALITY_CODECS.includes(facts.videoCodec)) return true;
  const format = facts.pixFmt ?? "";
  const tenBitOrMore = /(?:10|12|14|16)(?:le|be)$/.test(format) || /^p0?(?:10|12|16)/.test(format);
  const alpha = /^(?:yuva|ya\d|rgba|bgra|argb|abgr|gbrap|ayuv|ya)/.test(format);
  return tenBitOrMore || alpha;
}

/** Which of the inputs the pre-pass must convert: variable-frame-rate pictures, in "auto". */
export function filesToConform(inputs: { file: string; facts: MediaFacts }[], mode: ConformMode): string[] {
  if (mode === "off") return [];
  return inputs.filter(({ facts }) => facts.hasVideo && facts.variableFrameRate === true && !highQualitySource(facts)).map(({ file }) => file);
}

/** One line per picture input, for result.json. `conformed` and `failed` say what the pre-pass did. */
export function reportInputs(inputs: { file: string; facts: MediaFacts }[], targetFps: number, conformed: ReadonlySet<string>, failed: ReadonlySet<string>, mode: ConformMode = "auto"): InputReport[] {
  return inputs
    .filter(({ facts }) => facts.hasVideo)
    .map(({ file, facts }) => ({
      file,
      fps: facts.fps ?? null,
      variableFrameRate: facts.variableFrameRate === true,
      targetFps,
      conformed: conformed.has(file),
      resampled: !conformed.has(file) && (facts.variableFrameRate === true || (facts.fps !== undefined && Math.abs(facts.fps - targetFps) > 0.01)),
      ...(failed.has(file) ? { conformFailed: true } : {}),
      ...(mode === "auto" && facts.variableFrameRate === true && highQualitySource(facts) ? { skipped: "high-quality source" as const } : {}),
    }));
}

/** The stretch of the source the export uses, in source seconds: only this is converted. */
export type ConformWindow = { startSeconds: number; endSeconds: number };

/** Writes a constant-rate copy of `input` at `fps` to `output`, of just `window` when given. The tests substitute a fake. */
export type Conformer = { conform(input: string, output: string, fps: number, options?: { window?: ConformWindow; timeoutMs?: number }): Promise<void> };

/**
 * ffmpeg from Remotion's compositor package: only the used stretch of the picture, at a constant `fps` (x264 CRF 14, 4:2:0, a
 * high-quality intermediate the render then reads), the sound re-encoded as AAC. The copy keeps the SOURCE's own clock
 * (`-output_ts_offset`: it starts at its window's start, not at zero), so the render's trim points and the cues stay valid unchanged.
 * Only mov, mp4, m4a, matroska and webm are read, from a local file; no network. A copy that fails is removed.
 */
type Run = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }, done: (error: Error | null) => void) => unknown;

export const CONFORM_FORMATS = "mov,mp4,m4a,matroska,webm";

export function createFfmpegConformer(binary: string, defaultTimeoutMs = CONFORM_FILE_MS, run: Run = execFile as unknown as Run): Conformer {
  return {
    conform(input, output, fps, options = {}) {
      const window = options.window;
      const clock = window ? ["-ss", String(window.startSeconds), "-t", String(Math.max(0.1, window.endSeconds - window.startSeconds))] : [];
      const offset = window ? ["-output_ts_offset", String(window.startSeconds)] : [];
      return new Promise((resolve, reject) => {
        run(
          binary,
          ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-format_whitelist", CONFORM_FORMATS, ...clock, "-i", input, "-map", "0:v:0", "-map", "0:a?", ...offset, "-r", String(fps), "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output],
          { timeout: options.timeoutMs ?? defaultTimeoutMs, maxBuffer: 1024 * 1024, env: {} as NodeJS.ProcessEnv },
          (error: Error | null) => {
            if (!error) return resolve();
            rm(output, { force: true }).catch(() => {}).finally(() => reject(new Error("could not be conformed to a constant frame rate")));
          },
        );
      });
    },
  };
}
