import { execFile } from "node:child_process";
import { access, constants, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CompositionInfo, Renderer } from "./export";
import { isDnxhr, type VideoFormat } from "../src/lib/types";

/**
 * How each format is encoded. H.264 as before (CRF 20, AAC). ProRes 422 or 422 HQ in a .mov: 10-bit 4:2:2 pictures and 16-bit
 * PCM sound. Remotion's `proResProfile` names are 'standard' (ProRes 422) and 'hq' (ProRes 422 HQ); an unknown name falls back
 * to HQ without a word, so the names are pinned by a test.
 * DNxHR: Remotion cannot write it, so the picture is first rendered as a ProRes 422 intermediate (below the same, 10-bit 4:2:2 with 16-bit PCM sound) and
 * transcoded by the full ffmpeg build (`dnxhrArgs`); the intermediate is deleted.
 */
export function encodingFor(format: VideoFormat): Record<string, string | number> {
  if (isDnxhr(format)) return { codec: "prores", proResProfile: "standard", audioCodec: "pcm-16", pixelFormat: "yuv422p10le" };
  if (format === "h264") return { codec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", crf: 20, x264Preset: "medium" };
  return { codec: "prores", proResProfile: format === "prores-422-hq" ? "hq" : "standard", audioCodec: "pcm-16", pixelFormat: "yuv422p10le" };
}

/** Where the image keeps the full ffmpeg build that writes DNxHR (ops/remotion-worker/Dockerfile). Remotion's own, bundled ffmpeg is never replaced. */
export const DNX_FFMPEG_PATH = "/opt/ffmpeg-dnx/ffmpeg";
/** Longest the DNxHR transcode may take, ms (it runs faster than real time; this only stops a stuck one). */
export const DNX_TRANSCODE_TIMEOUT_MS = 300_000;

/**
 * The exact ffmpeg arguments that turn the ProRes intermediate into the DNxHR file. The intermediate is the only input and is read as a QuickTime file and nothing else (the
 * same protocol and format rules as every other ffmpeg call here); picture 4:2:2 at 8 bits for HQ and 10 bits for HQX; the sound as 16-bit PCM; the colour tags carry over.
 */
export function dnxhrArgs(format: VideoFormat, input: string, output: string): string[] {
  const hqx = format === "dnxhr-hqx";
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", "file", "-format_whitelist", "mov", "-i", input,
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "dnxhd", "-profile:v", hqx ? "dnxhr_hqx" : "dnxhr_hq", "-pix_fmt", hqx ? "yuv422p10le" : "yuv422p",
    "-c:a", "pcm_s16le", "-f", "mov", output,
  ];
}

/** Runs the transcode; only tests substitute it. Resolves on exit 0, rejects with the end of ffmpeg's own words otherwise. */
export type Transcode = (ffmpeg: string, args: string[]) => Promise<void>;
const runFfmpeg: Transcode = (ffmpeg, args) =>
  new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: DNX_TRANSCODE_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const said = String(stderr || error.message).trim().split("\n").slice(-3).join(" ").slice(0, 300);
      reject(new Error(`The DNxHR file could not be written${said ? `: ${said}` : "."}`));
    });
  });

export type RealRendererOptions = {
  /** The full ffmpeg build that writes DNxHR. Absent: DNX_FFMPEG_PATH. Only a developer machine running the render tests names another. */
  dnxFfmpeg?: string | null;
  /** Runs the DNxHR transcode; only tests substitute it. */
  transcode?: Transcode;
  /**
   * The Chrome Headless Shell to use. In the worker image this is always set (REMOTION_BROWSER_EXECUTABLE) to the exact file
   * installed at build time: a missing file is an error, and the worker never downloads a browser. Only when it is absent (a
   * developer machine running the render tests) does Remotion look for, and if need be download, its own.
   */
  browserExecutable?: string | null;
  /** Hard stop for one frame, ms. */
  frameTimeoutMs?: number;
  /** Cache for video frames, bytes. */
  offthreadVideoCacheSizeInBytes?: number;
  /** Loads the renderer module; only tests substitute it. */
  loadModule?: () => Promise<unknown>;
};

/**
 * @remotion/renderer, loaded lazily so the tests (and the app) never need it installed.
 * NO licenseKey and NO apiKey is ever passed (owner decision, 14 Oct 2026): server-side with no key the
 * renderer sends nothing to Remotion, which is allowed under the Free License. The worker stays sealed (no
 * internet). tests/unit/remotionLicense.spec.ts fails if a key or a usage call appears here.
 */
export function createRealRenderer(options: RealRendererOptions = {}): Renderer {
  const moduleName = "@remotion/renderer";
  let mod: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const load = async () => (mod ??= await (options.loadModule ? options.loadModule() : import(/* @vite-ignore */ moduleName)));
  const common = () => ({
    browserExecutable: options.browserExecutable ?? undefined,
    chromeMode: "headless-shell" as const,
    logLevel: "warn" as const,
    timeoutInMilliseconds: options.frameTimeoutMs ?? 60_000,
    offthreadVideoCacheSizeInBytes: options.offthreadVideoCacheSizeInBytes ?? 512 * 1024 * 1024,
    chromiumOptions: { gl: "swangle" as const },
  });
  return {
    async prepare() {
      if (options.browserExecutable) {
        try {
          await access(options.browserExecutable, constants.X_OK);
        } catch {
          throw new Error(`The browser is missing at ${options.browserExecutable}. This worker never downloads one.`);
        }
        return;
      }
      const { ensureBrowser } = await load();
      await ensureBrowser({ chromeMode: "headless-shell" });
    },
    async selectComposition({ serveUrl, id, inputProps }) {
      const { selectComposition } = await load();
      const comp = await selectComposition({ serveUrl, id, inputProps, ...common() });
      return comp as CompositionInfo;
    },
    async renderVideo({ serveUrl, composition, inputProps, outputLocation, format, concurrency, onProgress }) {
      const { renderMedia } = await load();
      const encode = encodingFor(format);
      /* DNxHR is made from an intermediate beside the file; the full ffmpeg must be there BEFORE a frame is rendered, so a worker without it fails at once and plainly. */
      const dnx = isDnxhr(format);
      const ffmpeg = options.dnxFfmpeg || DNX_FFMPEG_PATH;
      if (dnx) {
        try { await access(ffmpeg, constants.X_OK); } catch { throw new Error("DNxHR needs the full ffmpeg build, which this worker does not have."); }
      }
      const rendered = dnx ? path.join(path.dirname(outputLocation), `.intermediate-${path.basename(outputLocation)}`) : outputLocation;
      try {
        await renderMedia({
          serveUrl,
          composition,
          inputProps,
          outputLocation: rendered,
          ...encode,
          concurrency,
          overwrite: true,
          onProgress: onProgress ? (p: { renderedFrames: number }) => onProgress(p.renderedFrames, composition.durationInFrames) : undefined,
          ...common(),
        });
        if (dnx) {
          await (options.transcode ?? runFfmpeg)(ffmpeg, dnxhrArgs(format, rendered, outputLocation));
          if (!((await stat(outputLocation)).size > 0)) throw new Error("The DNxHR file could not be written: it came out empty.");
        }
      } catch (error) {
        if (dnx) await rm(outputLocation, { force: true }).catch(() => {});
        throw error;
      } finally {
        if (dnx) await rm(rendered, { force: true }).catch(() => {});
      }
    },
    async renderStill({ serveUrl, composition, inputProps, frame, outputLocation }) {
      const { renderStill } = await load();
      await renderStill({ serveUrl, composition, inputProps, frame, output: outputLocation, imageFormat: "png", overwrite: true, ...common() });
    },
  };
}
