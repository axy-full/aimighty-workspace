import type { GuestBoard } from "./board";
/**
 * The sample production as a guest sees it (pure; the browser and the server share it). Until stream 12's sample
 * exists, the guest board shows the design's layout with this title and no media: nothing is faked.
 */
export type GuestSample = { title: string; board: GuestBoard | null };

/** The design's title for the sample until the real production names itself (lead decision 39 c). */
export const SAMPLE_TITLE = "A 15-second film";

/** A stored project name made safe to show: text only, trimmed, at most 100 characters; anything else is null. */
export function cleanSampleTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim().slice(0, 100);
  return t || null;
}
