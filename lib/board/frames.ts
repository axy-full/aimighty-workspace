import type { RegionId } from "./types";

/*
 * The design's frame letters (README § 1.1: `?view=board&frame=a…p`, `f2`) as places on a real board: the region the
 * master shows each frame at (its own `inView` map), and the drawer frames o and p open. Old Studio stage links land
 * on a region the same way (`region=`). Frames k, l, m and n are other streams' panels (the Inspector, review mode,
 * Crew review, the Project record); on the board they land on Shots.
 */
const FRAME_REGION: Record<string, RegionId> = {
  a: "brief", b: "brief", c: "looks", d: "storyboard", o: "storyboard", e: "shots", f: "shots", f2: "shots", g: "shots", k: "shots", l: "shots",
  m: "shots", n: "shots", p: "shots", h: "cast", i: "cut", j: "deliver",
};
const FRAME_DRAWER: Record<string, "library" | "history"> = { o: "library", p: "history" };

export function frameRegion(frame: string | null | undefined): RegionId | null {
  return frame && Object.hasOwn(FRAME_REGION, frame) ? FRAME_REGION[frame] : null;
}
export function frameDrawer(frame: string | null | undefined): "library" | "history" | null {
  return frame && Object.hasOwn(FRAME_DRAWER, frame) ? FRAME_DRAWER[frame] : null;
}
