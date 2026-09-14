import type { Reference } from "./ark";
import { openUploadStream, openVideoStream } from "./storage";

export type VideoMetadata = {
  width: number;
  height: number;
  seconds: number;
  firstTimestamp: number;
};
export const VIDEO_INSPECTION_LIMIT = 200 * 1024 * 1024;
const METADATA_READ_LIMIT = 16 * 1024 * 1024;

/** Inspect the retained original, with a hard read/latency budget and no decoder or external media references. */
export async function inspectOriginalVideo(
  ref: Reference,
  bytes: number,
): Promise<VideoMetadata> {
  if (
    ref.kind !== "video" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > VIDEO_INSPECTION_LIMIT
  )
    throw new Error(
      "Use an original video up to 200 MB with a known stored length.",
    );
  const { Input, CustomSource, MP4, QTFF, WEBM } = await import("mediabunny");
  const abort = new AbortController(),
    timer = setTimeout(
      () =>
        abort.abort(
          new Error("Video metadata inspection timed out. Try a remuxed MP4."),
        ),
      20_000,
    );
  let readBytes = 0,
    reads = 0;
  const input = new Input({
    formats: [MP4, QTFF, WEBM],
    source: new CustomSource({
      getSize: () => bytes,
      maxCacheSize: 2 * 1024 * 1024,
      prefetchProfile: "none",
      read: async (start, end) => {
        abort.signal.throwIfAborted();
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end <= start ||
          end > bytes ||
          (readBytes += end - start) > METADATA_READ_LIMIT ||
          ++reads > 256
        )
          throw new Error(
            "This video's metadata exceeds the inspection budget. Remux it as a regular MP4 before upscaling.",
          );
        const range = { start, end: end - 1, total: bytes };
        const stream = ref.fromGeneration
          ? await openVideoStream(ref.id, range, abort.signal)
          : (
              await openUploadStream(
                ref.id,
                ref.ext,
                range,
                ref.storedUrl,
                abort.signal,
              )
            ).stream;
        const reader = stream.getReader(),
          result = new Uint8Array(end - start);
        let offset = 0;
        try {
          while (true) {
            abort.signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            if (offset + part.value.byteLength > result.length)
              throw new Error(
                "The original source returned an oversized metadata range.",
              );
            result.set(part.value, offset);
            offset += part.value.byteLength;
          }
          if (offset !== result.length)
            throw new Error(
              "The original source returned an incomplete metadata range.",
            );
          return result;
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
    }),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The original file has no video track.");
    const [first, end] = await Promise.all([
      track.getFirstTimestamp(),
      track.computeDuration(),
    ]);
    abort.signal.throwIfAborted();
    const seconds = end - Math.min(0, first),
      width = track.displayWidth,
      height = track.displayHeight;
    if (
      ![seconds, width, height].every((n) => Number.isFinite(n) && n > 0) ||
      seconds > 300 ||
      width > 16384 ||
      height > 16384
    )
      throw new Error(
        "Astra accepts video clips up to five minutes with valid source dimensions.",
      );
    return { width, height, seconds, firstTimestamp: first };
  } finally {
    clearTimeout(timer);
    abort.abort();
    input.dispose();
  }
}
