import { uid, type Asset, type Project, type Shot } from "../workbench/studio";
import type { LibraryEntry } from "../workspace/library";

/**
 * Production › Timeline (owner's brief, 23 September): takes go into the cut.
 * A library take becomes a project asset (if it is not one yet) and a sequence
 * shot at its own length — a video its stored seconds, a still three seconds —
 * appended at the end. The cut's order and lengths are then edited in place.
 */
export const STILL_SECONDS = 3;
export const MAX_SHOTS = 250;

export function entrySeconds(entry: LibraryEntry): number {
  const value = entry.asset.value as { durationS?: number | null; params?: Record<string, unknown> };
  const length = value.durationS ?? (typeof value.params?.duration === "number" ? value.params.duration : null);
  return entry.media === "video" && length && length > 0 ? length : STILL_SECONDS;
}

/** The project asset a take is filed as: the same id the Rig and the Library use. */
export function entryAsset(entry: LibraryEntry): Asset {
  const generation = entry.asset.origin === "generation";
  return {
    id: entry.take.sourceId, ...(generation ? { generationId: entry.take.sourceId } : { uploadId: entry.take.sourceId }),
    kind: entry.media === "video" ? "video" : "image", category: "Take", name: entry.take.name.slice(0, 200), url: entry.url ?? `/api/media/${entry.take.sourceId}`,
    description: entry.take.meta.slice(0, 500), prompt: "", status: "Draft", locked: false, version: 1, refs: [],
  };
}

export function addTakeToCut(project: Project, entry: LibraryEntry): Project {
  if (entry.media !== "video" && entry.media !== "image") throw new Error("Only pictures and videos go on the picture track. Add sound in the lanes below.");
  if (project.shots.length >= MAX_SHOTS) throw new Error(`The cut holds ${MAX_SHOTS} shots.`);
  const known = project.assets.find((a) => a.id === entry.take.sourceId || a.generationId === entry.take.sourceId || a.uploadId === entry.take.sourceId);
  if (!known && project.assets.length >= 500) throw new Error("The asset library is full.");
  const asset = known ?? entryAsset(entry);
  const shot: Shot = { id: uid("shot"), name: `${String(project.shots.length + 1).padStart(2, "0")} — ${entry.take.name}`.slice(0, 200), assetId: asset.id, duration: Math.max(1, Math.round(entrySeconds(entry) * project.fps)), sourceIn: 0, note: "" };
  return { ...project, assets: known ? project.assets : [...project.assets, asset], shots: [...project.shots, shot] };
}

export function moveShot(project: Project, index: number, step: -1 | 1): Project {
  const to = index + step;
  if (to < 0 || to >= project.shots.length) return project;
  const shots = [...project.shots];
  [shots[index], shots[to]] = [shots[to], shots[index]];
  return { ...project, shots };
}
export function removeShot(project: Project, id: string): Project { return { ...project, shots: project.shots.filter((s) => s.id !== id) }; }
export function setShotSeconds(project: Project, id: string, seconds: number): Project {
  const frames = Math.max(1, Math.round(seconds * project.fps));
  return { ...project, shots: project.shots.map((s) => (s.id === id ? { ...s, duration: frames } : s)) };
}
