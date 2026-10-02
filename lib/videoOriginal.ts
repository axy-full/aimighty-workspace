import { CONSUMER_VIDEO_BYTES } from "./workbench/product-fetch";

/**
 * A provider's finished video, checked before Particl keeps it (the API-key
 * Higgsfield collector, lib/genjutsuVideo.ts: Genjutsu and Cinema Studio).
 * Moved here from the retired account code, unchanged.
 */

/** The longest video original Particl keeps. */
export const VIDEO_ORIGINAL_SECONDS = 600;

export class VideoOriginalError extends Error {
  constructor(readonly code: "invalid_video" | "timeout") {
    super(
      code === "invalid_video"
        ? "The original must be an MP4 video up to 100 MB and 10 minutes with valid dimensions."
        : "Original video collection reached its time limit. Its receipt remains available for recovery.",
    );
    this.name = "VideoOriginalError";
  }
}

/** Metadata/packet inspection only, never transcoding or fetching references. */
export async function inspectVideoOriginal(
  bytes: Buffer,
): Promise<{ width: number; height: number; seconds: number }> {
  if (!bytes.length || bytes.length > CONSUMER_VIDEO_BYTES)
    throw new VideoOriginalError("invalid_video");
  const { Input, BufferSource, MP4, EncodedPacketSink } =
    await import("mediabunny");
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Running out of inspection time says nothing about the bytes; only a real
  // inspection verdict may call an original invalid.
  const outOfTime = new VideoOriginalError("timeout");
  try {
    return await Promise.race([
      (async () => {
        if ((await input.getFormat()) !== MP4)
          throw new VideoOriginalError("invalid_video");
        const track = await input.getPrimaryVideoTrack();
        if (!track || !track.codec)
          throw new VideoOriginalError("invalid_video");
        const packets = new EncodedPacketSink(track);
        const [first, end, packet, lastPacket] = await Promise.all([
          track.getFirstTimestamp(),
          track.computeDuration({ skipLiveWait: true }),
          packets.getFirstPacket(),
          packets.getPacket(Infinity),
        ]);
        const width = track.displayWidth,
          height = track.displayHeight,
          seconds = end - Math.min(0, first);
        if (
          !packet?.data.byteLength ||
          !lastPacket?.data.byteLength ||
          ![width, height, seconds].every(
            (value) => Number.isFinite(value) && value > 0,
          ) ||
          seconds > VIDEO_ORIGINAL_SECONDS ||
          width > 16384 ||
          height > 16384 ||
          width * height > 40_000_000
        )
          throw new VideoOriginalError("invalid_video");
        return { width, height, seconds };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(outOfTime), 15_000);
      }),
    ]);
  } catch (error) {
    if (error === outOfTime) throw outOfTime;
    throw new VideoOriginalError("invalid_video");
  } finally {
    clearTimeout(timer);
    input.dispose();
  }
}
