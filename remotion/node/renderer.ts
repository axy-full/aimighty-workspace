import type { CompositionInfo, Renderer } from "./export";

export type RealRendererOptions = {
  /** A Chrome/Chromium to use; when absent, the one Remotion downloaded into node_modules. */
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
      const { ensureBrowser } = await load();
      await ensureBrowser({ browserExecutable: options.browserExecutable ?? undefined, chromeMode: "headless-shell" });
    },
    async selectComposition({ serveUrl, id, inputProps }) {
      const { selectComposition } = await load();
      const comp = await selectComposition({ serveUrl, id, inputProps, ...common() });
      return comp as CompositionInfo;
    },
    async renderVideo({ serveUrl, composition, inputProps, outputLocation, concurrency, onProgress }) {
      const { renderMedia } = await load();
      await renderMedia({
        serveUrl,
        composition,
        inputProps,
        outputLocation,
        codec: "h264",
        audioCodec: "aac",
        pixelFormat: "yuv420p",
        crf: 20,
        x264Preset: "medium",
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
