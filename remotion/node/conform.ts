import { execFile } from "node:child_process";
import type { MediaFacts } from "./probe";

/**
 * Constant frame rate (spec.output.conform). A phone clip or a screen recording can carry frames that are not evenly spaced
 * (variable frame rate). The render picks frames by time, so it copes, but a cut or a mezzanine made from such a file can drift
 * against its sound. The conform pre-pass re-encodes only those files, once, to a constant rate equal to the export's own, and
 * the render reads that copy. A file already at a constant rate is never touched, even if the rate differs from the export's
 * (the render resamples it by time, as it always has); it is only reported.
 *
 * "auto" (the default) conforms a variable-frame-rate video; "off" never does. The original in input/ is never changed.
 */
export const CONFORM_MODES = ["auto", "off"] as const;
export type ConformMode = (typeof CONFORM_MODES)[number];

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
  /** The pre-pass was asked for and could not be made; the render reads the original. */
  conformFailed?: boolean;
};

/** Which of the inputs the pre-pass must convert: variable-frame-rate pictures, in "auto". */
export function filesToConform(inputs: { file: string; facts: MediaFacts }[], mode: ConformMode): string[] {
  if (mode === "off") return [];
  return inputs.filter(({ facts }) => facts.hasVideo && facts.variableFrameRate === true).map(({ file }) => file);
}

/** One line per picture input, for result.json. `conformed` and `failed` say what the pre-pass did. */
export function reportInputs(inputs: { file: string; facts: MediaFacts }[], targetFps: number, conformed: ReadonlySet<string>, failed: ReadonlySet<string>): InputReport[] {
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
    }));
}

/** Writes a constant-rate copy of `input` at `fps` to `output`. The tests substitute a fake. */
export type Conformer = { conform(input: string, output: string, fps: number): Promise<void> };

/**
 * ffmpeg from Remotion's compositor package: the picture at a constant `fps` (x264 CRF 14, 4:2:0, a high-quality intermediate
 * the render then reads), the sound re-encoded as AAC (all of its tracks kept), the container's duration unchanged. No network.
 */
type Run = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }, done: (error: Error | null) => void) => unknown;

export function createFfmpegConformer(binary: string, timeoutMs = 300_000, run: Run = execFile as unknown as Run): Conformer {
  return {
    conform(input, output, fps) {
      return new Promise((resolve, reject) => {
        run(
          binary,
          ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-r", String(fps), "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output],
          { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: {} as NodeJS.ProcessEnv },
          (error: Error | null) => (error ? reject(new Error("could not be conformed to a constant frame rate")) : resolve()),
        );
      });
    },
  };
}
