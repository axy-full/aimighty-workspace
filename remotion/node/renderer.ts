import type { CompositionInfo, Renderer } from "./export";

export type RealRendererOptions = {
  /** A Chrome/Chromium to use; when absent, the one Remotion downloaded into node_modules. */
  browserExecutable?: string | null;
  /** Hard stop for one frame, ms. */
  frameTimeoutMs?: number;
  /** Cache for video frames, bytes. */
  offthreadVideoCacheSizeInBytes?: number;
};

/**
 * @remotion/renderer, loaded lazily so the tests (and the app) never need it installed.
 * No licenseKey is passed: the Free License needs none, and passing "free-license" would make
 * the renderer call remotion.pro, which the worker cannot reach and must not try to.
 */
export function createRealRenderer(options: RealRendererOptions = {}): Renderer {
  const moduleName = "@remotion/renderer";
  let mod: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const load = async () => (mod ??= await import(/* @vite-ignore */ moduleName));
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
