/**
 * Whether a clip's declared length can be believed well enough to price it.
 *
 * An uploaded video's duration is read out of its own `moov > mvhd` box
 * (`lib/imagemeta.ts`), which is to say: out of bytes the uploader chose.
 * For most of the product that is harmless — a wrong duration makes a wrong
 * suggestion. For the LOCKED tasks it is money. Upscale and reframe are
 * priced per second of the SOURCE, so the number the uploader wrote in the
 * header is the number the platform pays against, and for fal engines that
 * same estimate is what the ledger records as the cost. A 300-second clip
 * declared as four buys $150 of Topaz for about five credits, and nothing
 * downstream ever learns the difference.
 *
 * There is no decoder here — no ffprobe, no ffmpeg — so this cannot measure
 * the truth. What it can do is refuse a declaration that is either absent or
 * impossible, which is the whole of the cheap attack.
 */

/**
 * The most video a container can plausibly carry per second.
 *
 * Deliberately generous: 120 Mbit/s is above 4K ProRes-in-mp4 territory and
 * far above anything a delivery codec produces, so a real file will not trip
 * it. The point is not to estimate the bitrate — it is that a file cannot
 * hold more seconds than its own size allows, so a DECLARED duration far
 * shorter than the bytes require is a claim the file itself contradicts.
 */
const MAX_BITS_PER_SECOND = 120_000_000;

/** Seconds the bytes could not possibly fit into fewer of. */
export function floorSeconds(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return (bytes * 8) / MAX_BITS_PER_SECOND;
}

export type ClipDoubt = "unknown" | "impossible" | null;

/**
 * Can this clip's length be priced against?
 *
 * `"unknown"` — nothing parsed a duration out of it. Today that sails past
 * every ceiling, because each is written `seconds != null && seconds > max`.
 * For a per-second task it has to fail closed instead: an unpriceable clip
 * is not a cheap clip.
 *
 * `"impossible"` — the declared length is shorter than the file's own size
 * permits. Not a heuristic about compression: at 120 Mbit/s a 150 MB file is
 * at least ten seconds of video whatever is in it, so four is a lie.
 */
export function clipDoubt(declaredSeconds: number | null | undefined, bytes: number | null | undefined): ClipDoubt {
  const s = typeof declaredSeconds === "number" && Number.isFinite(declaredSeconds) ? declaredSeconds : null;
  if (s == null || s <= 0) return "unknown";
  const b = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null;
  if (b == null || b <= 0) return null;          // no size to argue with
  return s + 0.5 < floorSeconds(b) ? "impossible" : null;
}

/** What to tell somebody whose clip cannot be priced, without teaching them the bound. */
export function clipDoubtMessage(doubt: Exclude<ClipDoubt, null>, taskLabel: string): string {
  return doubt === "unknown"
    ? `${taskLabel} is priced by the second, and this clip's length could not be read. Re-export it as an MP4 and upload it again.`
    : `This clip's length does not match its size, so ${taskLabel.toLowerCase()} cannot be priced from it. Re-export it as an MP4 and upload it again.`;
}
