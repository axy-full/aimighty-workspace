import { access, constants } from "node:fs/promises";
import type { CompositionInfo, Renderer } from "./export";
import type { VideoFormat } from "../src/lib/types";

/**
 * How each format is encoded. H.264 as before (CRF 20, AAC). ProRes 422 or 422 HQ in a .mov: 10-bit 4:2:2 pictures and 16-bit
 * PCM sound. Remotion's `proResProfile` names are 'standard' (ProRes 422) and 'hq' (ProRes 422 HQ); an unknown name falls back
 * to HQ without a word, so the names are pinned by a test.
 */
export function encodingFor(format: VideoFormat): Record<string, string | number> {
  if (format === "h264") return { codec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", crf: 20, x264Preset: "medium" };
  return { codec: "prores", proResProfile: format === "prores-422-hq" ? "hq" : "standard", audioCodec: "pcm-16", pixelFormat: "yuv422p10le" };
}

export type RealRendererOptions = {
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
      await renderMedia({
        serveUrl,
        composition,
        inputProps,
        outputLocation,
        ...encode,
        concurrency,
        overwrite: true,
        onProgress: onProgress ? (p: { renderedFrames: number }) => onProgress(p.renderedFrames, composition.durationInFrames) : undefined,
        ...common(),
      });
    },
    async renderStill({ serveUrl, composition, inputProps, frame, outputLocation }) {
      const { renderStill } = await load();
      await renderStill({ serveUrl, composition, inputProps, frame, output: outputLocation, imageFormat: "png", overwrite: true, ...common() });
    },
  };
}
