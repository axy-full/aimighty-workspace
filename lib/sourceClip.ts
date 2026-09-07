import type { RefItem } from "@/components/References";

/**
 * An uploaded clip as the thing an edit works on.
 *
 * A locked task — edit, extend, motion, upscale, reframe — needs a source
 * clip. It used to have to be a render from the wall; a clip a client sent
 * over is just as much a source. When the task is on, no render is chosen,
 * and the tray holds exactly one video, that video is the source. Two
 * videos is a question the person has to answer; none is the old message.
 * Pure; the composer and the route both read it.
 */
export type TaskState = { id: string; gen: { id: string } | null } | null;

export function uploadSource(taskOn: TaskState, refs: RefItem[]): RefItem | null {
  if (!taskOn || taskOn.gen) return null;
  const videos = refs.filter((r) => r.kind === "video");
  return videos.length === 1 ? videos[0] : null;
}

/** The label the vendor's rules speak in, from a clip's height. */
export function resolutionOfHeight(height: number | null | undefined): string | undefined {
  if (!height) return undefined;
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return "480p";
}

/** What the source checks need to know about an uploaded clip. */
export function uploadSourceParams(ref: { durationS: number | null; height: number | null }): { duration?: number; resolution?: string } {
  return {
    ...(typeof ref.durationS === "number" ? { duration: Math.round(ref.durationS * 10) / 10 } : {}),
    ...(resolutionOfHeight(ref.height) ? { resolution: resolutionOfHeight(ref.height) } : {}),
  };
}
