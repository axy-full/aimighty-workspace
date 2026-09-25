"use client";
import { DRAG_TYPE } from "./dnd";
import { assetIdFromUrl } from "./preview";

/**
 * Owner, 25 September: "anything should be draggable and droppable across the
 * site." One payload and one reader.
 *
 * Every drag of an asset carries its Library id (`generation:<id>` or
 * `upload:<id>`) three ways: `text/plain` (what the Suites wells always read),
 * `application/x-particl-id` (unambiguous), and the JSON `DRAG_TYPE` that
 * Seedance Edit and the composer's file panel read — so any tile can be
 * dropped on any target. `readDrop` answers every target the same way:
 * Library ids (Rig library keys and project asset ids normalised, stray text
 * refused) and desktop files.
 */
export const ID_TYPE = "application/x-particl-id";
const LIBRARY_ID = /^(generation|upload):[A-Za-z0-9_-]{1,160}$/;

export type DragMeta = { name?: string; url?: string; kind?: string; mime?: string };

/** Write the one payload every target reads. Safe to call twice (the second call wins). */
export function writeAssetDrag(dt: DataTransfer, id: string, meta: DragMeta = {}): void {
  if (!LIBRARY_ID.test(id)) return;
  const [origin, raw] = id.split(":") as ["generation" | "upload", string];
  const url = meta.url ?? (origin === "generation" ? `/api/media/${raw}` : `/api/uploads/${raw}`);
  try {
    dt.setData("text/plain", id);
    dt.setData(ID_TYPE, id);
    dt.setData(DRAG_TYPE, JSON.stringify(origin === "generation"
      ? { kind: "gen", gen: { id: raw, kind: meta.kind ?? "image", storedUrl: url, sourceUrl: null, prompt: meta.name ?? "", title: meta.name ?? "", status: "succeeded", params: {}, projectId: null } }
      : { kind: "upload", upload: { id: raw, filename: meta.name ?? raw, mime: meta.mime ?? "", kind: meta.kind ?? "file", bytes: 0, width: null, height: null, durationS: null, sha256: "", url } }));
    if (dt.effectAllowed === "uninitialized" || dt.effectAllowed === "none") dt.effectAllowed = "copyMove";
  } catch { /* a read-only DataTransfer (not in dragstart) */ }
}

/** The attributes that make an element a drag source for an asset (the drag layer writes the payload). */
export function dragAttrs(id: string | null | undefined, meta: DragMeta = {}): Record<string, string> {
  if (!id || !LIBRARY_ID.test(id)) return {};
  return { draggable: "true", "data-drag-id": id, ...(meta.name ? { "data-drag-name": meta.name } : {}), ...(meta.kind ? { "data-drag-kind": meta.kind } : {}) };
}

/**
 * One raw payload to a Library id, or null when it is not one of ours:
 * `generation:x` / `upload:x`; the Rig library's `take:generation:x`;
 * a project asset id (`asset:<id>` or bare) through `assets`; a Particl media URL.
 */
export function normaliseDragId(raw: string | null | undefined, assets: readonly { id: string; generationId?: string; uploadId?: string }[] = []): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 400) return null;
  if (LIBRARY_ID.test(value)) return value;
  const take = /^take:((?:generation|upload):[A-Za-z0-9_-]{1,160})$/.exec(value);
  if (take) return take[1];
  const assetId = /^asset:(.+)$/.exec(value)?.[1] ?? value;
  const asset = assets.find((a) => a.id === assetId);
  if (asset?.generationId) return `generation:${asset.generationId}`;
  if (asset?.uploadId) return `upload:${asset.uploadId}`;
  return assetIdFromUrl(value);
}

export type DropPayload = {
  /** Library ids, in the order dragged. */
  ids: string[];
  /** Files from the device. */
  files: File[];
  /** The raw text/plain when it is not an asset (a Rig brief key, a dragged sentence). */
  text: string | null;
};

export function readDrop(dt: DataTransfer | null, assets: readonly { id: string; generationId?: string; uploadId?: string }[] = []): DropPayload {
  if (!dt) return { ids: [], files: [], text: null };
  const files = Array.from(dt.files ?? []);
  const ids: string[] = [];
  const push = (id: string | null) => { if (id && !ids.includes(id)) ids.push(id); };
  push(normaliseDragId(safeGet(dt, ID_TYPE), assets));
  if (!ids.length) {
    try {
      const json = JSON.parse(safeGet(dt, DRAG_TYPE) || "null") as { kind?: string; gen?: { id?: string }; upload?: { id?: string }; uploadId?: string | null } | null;
      if (json?.kind === "gen" && json.gen?.id) push(`generation:${json.gen.id}`);
      else if (json?.kind === "upload" && json.upload?.id) push(`upload:${json.upload.id}`);
      else if (json?.kind === "cast" && json.uploadId) push(`upload:${json.uploadId}`);
    } catch { /* not ours */ }
  }
  const text = safeGet(dt, "text/plain");
  if (!ids.length) push(normaliseDragId(text, assets));
  return { ids, files, text: ids.length ? null : text || null };
}

function safeGet(dt: DataTransfer, type: string): string {
  try { return dt.getData(type) ?? ""; } catch { return ""; }
}

/** On dragover (data unreadable until the drop): might this be an asset (refused at the drop if not) or, when `files`, device files? */
export function isDroppable(dt: DataTransfer | null, { files = true }: { files?: boolean } = {}): boolean {
  const types = Array.from(dt?.types ?? []);
  return types.includes(ID_TYPE) || types.includes(DRAG_TYPE) || types.includes("text/plain") || (files && types.includes("Files"));
}

/** Files from the device are in this drag. */
export const hasFiles = (dt: DataTransfer | null) => Array.from(dt?.types ?? []).includes("Files");

/**
 * A drop's assets as Library ids: the ids dragged, then every device file
 * uploaded into the project (lib/workspace/library uploadFilesToProject) and
 * named by its new id — so a well treats a file from the desktop exactly like
 * a tile from the Library. Read the payload with `readDrop` inside the drop
 * event (the browser empties it afterwards), then call this.
 */
export async function dropToIds(payload: DropPayload, ctx: { scope: string; projectId: string | null | undefined }): Promise<{ ids: string[]; notes: string[] }> {
  const ids = [...payload.ids], notes: string[] = [];
  if (payload.files.length) {
    if (!ctx.projectId) throw new Error("Open a project first; dropped files are kept in its Library.");
    const { uploadFilesToProject } = await import("./workspace/library");
    const done = await uploadFilesToProject(ctx.scope, ctx.projectId, payload.files);
    ids.push(...done.ids);
    notes.push(...done.notes);
  }
  return { ids, notes };
}
