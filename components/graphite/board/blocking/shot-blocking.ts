import { blockingOf, moveWords } from "@/lib/production/blocking";
import type { Project } from "@/lib/workbench/studio";

/** What a shot's own card shows of its saved 3D blocking: the frame, the lens, the move and when it was saved. Pure. */
export type ShotBlockingView = { frameUploadId: string | null; lens: number; move: string; savedAt: string };

/** The strip's height on a shot card (CSS px): the frame and its words, then Remake and Open. */
export const STRIP_HEIGHT = 128;

export function shotBlockingView(project: Project, nodeId: string): ShotBlockingView | null {
  const entry = blockingOf(project, nodeId);
  if (!entry) return null;
  const asset = entry.frameAssetId ? [...project.assets, ...(project.sharedAssets ?? [])].find((a) => a.id === entry.frameAssetId) : undefined;
  return { frameUploadId: asset?.uploadId ?? null, lens: entry.scene.camera.focalLength, move: moveWords(entry.move), savedAt: entry.savedAt };
}

/** "10:20", in the viewer's own time, as a saved time reads on a card. */
export function savedTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
}
