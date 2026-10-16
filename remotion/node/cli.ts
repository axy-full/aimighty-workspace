/**
 * THE fixed export command. The worker runs exactly this, with the session folder as the working directory:
 *
 *   node cli.mjs
 *
 * reads ./spec.json, ./input/*, writes ./output/*. It takes no arguments, and everything it may be tuned by
 * comes from the worker's own environment, never from the spec:
 *   REMOTION_BUNDLE_DIR          the built bundle (default: bundle/ next to this file)
 *   REMOTION_CONCURRENCY         frames rendered at once (default 2)
 *   REMOTION_MAX_SECONDS         longest export (default 120)
 *   REMOTION_BROWSER_EXECUTABLE  a specific Chrome (default: the one downloaded at image build)
 *   REMOTION_DNX_FFMPEG          the full ffmpeg build that writes DNxHR (default /opt/ffmpeg-dnx/ffmpeg, where the image puts it). A developer's render tests name another;
 *                                the worker's own environment never sets it.
 *   REMOTION_RUNTIME_DIR         the folder holding package.json and node_modules/.remotion (the Chrome download).
 *                                Remotion looks for its Chrome under the working directory's nearest package.json,
 *                                and the working directory here is the session folder, so the command moves to this
 *                                folder once it has read its session paths (all of them are absolute).
 * Exit codes: 0 done, 2 spec invalid or too long, 3 an input file is missing or is not what the spec says it is
 * (ffprobe reads every clip and music file; a different length (over 0.1 s), a different size, or sound the request says is there but is not, is refused), 4 the render failed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS } from "../src/lib/limits";
import { runExport } from "./export";
import { bundledFfmpeg, bundledFfprobe } from "./ffprobe-path";
import { createFfmpegConformer } from "./conform";
import { createFfmpegSilenceDetector } from "./silence";
import { createFfprobe } from "./probe";
import { createRealRenderer } from "./renderer";

const EXIT = { spec_invalid: 2, too_long: 2, input_missing: 3, input_mismatch: 3, render_failed: 4, silence_failed: 5 } as const;

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

async function main(): Promise<number> {
  const session = process.cwd();
  if (process.env.REMOTION_RUNTIME_DIR) process.chdir(process.env.REMOTION_RUNTIME_DIR);
  const outputDir = path.join(session, "output");
  await mkdir(outputDir, { recursive: true });
  let spec: unknown;
  try {
    spec = JSON.parse(await readFile(path.join(session, "spec.json"), "utf8"));
  } catch (error) {
    const result = { ok: false, code: "spec_invalid", errors: [`spec.json: ${(error as Error).message}`] };
    await writeFile(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result));
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const limits = {
    ...DEFAULT_LIMITS,
    maxSeconds: Math.min(DEFAULT_LIMITS.maxSeconds, intEnv("REMOTION_MAX_SECONDS", DEFAULT_LIMITS.maxSeconds, 1, 3600)),
  };
  const result = await runExport({
    spec,
    inputDir: path.join(session, "input"),
    outputDir,
    bundleDir: process.env.REMOTION_BUNDLE_DIR || path.join(here, "bundle"),
    workDir: path.join(session, "work"),
    prober: createFfprobe(bundledFfprobe()),
    conformer: createFfmpegConformer(bundledFfmpeg()),
    silenceDetector: createFfmpegSilenceDetector(bundledFfmpeg()),
    renderer: createRealRenderer({ browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || null, dnxFfmpeg: process.env.REMOTION_DNX_FFMPEG || null }),
    limits,
    concurrency: intEnv("REMOTION_CONCURRENCY", 2, 1, 8),
    onProgress: (done, total) => {
      if (done % 30 === 0 || done === total) console.log(`progress ${done}/${total}`);
    },
  });
  if (result.ok) {
    console.log(`done ${result.durationInFrames} frames, ${result.files.map((f) => f.name).join(", ")}`);
    return 0;
  }
  await writeFile(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result));
  return EXIT[result.code];
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(JSON.stringify({ ok: false, code: "render_failed", errors: [String(error?.message ?? error).slice(0, 2000)] }));
    process.exit(4);
  },
);
