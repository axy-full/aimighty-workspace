import { blockingOf } from "@/lib/production/blocking";
import type { BoardCard, BoardSource } from "@/lib/board/types";
import type { RigShot } from "@/lib/workspace/shots";

/*
 * What the 3D blocking card says (gap screens): which shot it is for, and whether that shot has blocking saved. Pure and cheap.
 * The card is for the first shot with no blocking yet, else the first shot; the overlay's own picker switches shots.
 */

export type BlockingCardData = {
  nodeId: string;
  index: number;
  name: string;
  /** The saved frame's upload id (its file), or null when nothing is saved to the shot. */
  frameUploadId: string | null;
  saved: boolean;
  /** "Lead, Mirror sphere, Dune ridge": the objects' names as saved. */
  objects: string;
  lens: number | null;
};

export const BLOCKING_GROUP_REGIONS = ["shots", "storyboard"] as const;

export function pickShot(project: BoardSource["project"], shots: readonly RigShot[]): RigShot | null {
  return shots.find((s) => !blockingOf(project, s.id)) ?? shots[0] ?? null;
}

export function blockingCardData(project: BoardSource["project"], shot: RigShot): BlockingCardData {
  const entry = blockingOf(project, shot.id);
  const asset = entry?.frameAssetId ? [...project.assets, ...(project.sharedAssets ?? [])].find((a) => a.id === entry.frameAssetId) : undefined;
  return {
    nodeId: shot.id, index: shot.index, name: shot.name, saved: Boolean(entry), frameUploadId: asset?.uploadId ?? null,
    objects: entry ? entry.scene.objects.filter((o) => !o.id.startsWith("set-")).map((o) => o.name).join(", ") : "",
    lens: entry ? entry.scene.camera.focalLength : null,
  };
}

/** The card in each of the Storyboard and Shots regions, once the production has a shot to block. */
export function deriveBlocking(src: BoardSource): BoardCard<BlockingCardData>[] {
  if (src.kind !== "studio") return [];
  const shot = pickShot(src.project, src.shots);
  if (!shot) return [];
  const data = blockingCardData(src.project, shot);
  return BLOCKING_GROUP_REGIONS.map((region, i) => ({
    id: `blocking:${region}`, kind: "blocking", region, order: 9000 + i, state: data.saved ? "done" : "empty",
    summary: data.saved ? `3D blocking · saved to Shot ${data.index}` : `3D blocking · Shot ${data.index}`, data,
  }));
}
