import { execFile } from "node:child_process";
import { SILENCE_MIN_SECONDS, SILENCE_NOISE_DB, parseSilence } from "../src/lib/silence";
import type { Range } from "../src/lib/types";

/** The quiet stretches of a source's sound. The tests substitute a fake. */
export type SilenceDetector = { detect(file: string, durationSeconds: number): Promise<Range[]> };

type Run = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }, done: (error: Error | null, stdout: string, stderr: string) => void) => unknown;

/** ffmpeg's `silencedetect` over the first sound track of a local file, decoded and thrown away: no output file, no network. */
export function createFfmpegSilenceDetector(binary: string, timeoutMs = 180_000, run: Run = execFile as unknown as Run): SilenceDetector {
  return {
    detect(file, durationSeconds) {
      return new Promise((resolve, reject) => {
        run(
          binary,
          ["-hide_banner", "-nostats", "-protocol_whitelist", "file", "-i", file, "-vn", "-map", "0:a:0", "-af", `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`, "-f", "null", "-"],
          { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: {} as NodeJS.ProcessEnv },
          (error: Error | null, _stdout: string, stderr: string) => {
            if (error) return reject(new Error("could not be read for silence"));
            resolve(parseSilence(String(stderr), durationSeconds));
          },
        );
      });
    },
  };
}
