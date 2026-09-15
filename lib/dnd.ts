"use client";

/**
 * Anything can be dragged anywhere.
 *
 * One payload for every media card in the app — a render on the wall, in
 * the library, in the rail; a cast member in the Studio — and one reader
 * for every drop target: the composer takes a render as a reference and a
 * cast member as an @cite, the audio desk takes a clip's length, a shot on
 * the canvas takes a render as its next take. A card that can be dragged
 * is any card that is finished; a target that accepts the drag says so on
 * dragover, so the browser shows the copy cursor and nothing else.
 *
 * Kept small on purpose: the drop needs enough to act, and re-reads the
 * rest from the row.
 */
import type { Gen } from "@/components/GenCard";
import type { UploadedFile } from "./uploadClient";

export const DRAG_TYPE = "application/x-particl-asset";

export type DraggedGen = Pick<Gen, "id" | "kind" | "storedUrl" | "sourceUrl" | "prompt" | "title" | "status" | "params" | "projectId">;

export type DraggedAsset =
  | { kind: "gen"; gen: DraggedGen }
  | { kind: "upload"; upload: UploadedFile }
  | { kind: "cast"; castId: string; name: string; uploadId: string | null };

function write(e: React.DragEvent, payload: DraggedAsset): void {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copy";
}

/** A render leaves a card. */
export function startGenDrag(e: React.DragEvent, g: Gen): void {
  write(e, {
    kind: "gen",
    gen: {
      id: g.id, kind: g.kind, storedUrl: g.storedUrl, sourceUrl: g.sourceUrl,
      prompt: g.prompt, title: g.title, status: g.status,
      params: g.params, projectId: g.projectId,
    },
  });
}

export function startUploadDrag(e: React.DragEvent, upload: UploadedFile): void {
  write(e, { kind: "upload", upload });
}

/** A cast member leaves the Studio. */
export function startCastDrag(e: React.DragEvent, m: { id: string; name: string; uploadId?: string | null }): void {
  write(e, { kind: "cast", castId: m.id, name: m.name, uploadId: m.uploadId ?? null });
}

/** Is one of ours being dragged over? Cheap, and safe to call on dragover. */
export function isAssetDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
}

export function readDrag(e: React.DragEvent): DraggedAsset | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraggedAsset;
    if (parsed?.kind === "gen" && parsed.gen?.id) return parsed;
    if (parsed?.kind === "upload" && parsed.upload?.id) return parsed;
    if (parsed?.kind === "cast" && parsed.name) return parsed;
    return null;
  } catch {
    return null;   // a drag from somewhere else entirely
  }
}

/** A render drag out of a drop event, or null if it was something else. */
export function readDraggedAsset(e: React.DragEvent): Extract<DraggedAsset, { kind: "gen" }> | null {
  const d = readDrag(e);
  return d?.kind === "gen" ? d : null;
}

/** A cast drag out of a drop event, or null. */
export function readDraggedCast(e: React.DragEvent): Extract<DraggedAsset, { kind: "cast" }> | null {
  const d = readDrag(e);
  return d?.kind === "cast" ? d : null;
}
