"use client";
import { useEffect, useRef, useState } from "react";
import { hasFiles, ID_TYPE, writeAssetDrag } from "@/lib/drop";
import { DRAG_TYPE } from "@/lib/dnd";
import { assetIdFromUrl } from "@/lib/preview";

/** Files dropped where no target took them; a page that can keep them (the Suites shell, with a project open) sets `handled`. */
export type FilesDropDetail = { files: File[]; handled: boolean };
export const FILES_EVENT = "particl:files-dropped";

/**
 * The site's drag layer (owner, 25 September: "anything should be draggable
 * and droppable across the site"), mounted once in the root layout.
 *
 * 1. Every drag of an asset carries the one payload (lib/drop): whatever an
 *    element set itself is kept, and the Library id, the id type and the JSON
 *    are added — so a Library tile, a Rig input, a Storyboard take or a Gen
 *    result drops on any target, Seedance Edit included.
 * 2. A file from the device dropped where no target takes it is not opened
 *    by the browser in place of the app: it goes to the open project's
 *    Library, and while it is held over the page a hint says so.
 */
export default function DragLayer() {
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const depth = useRef(0);

  useEffect(() => {
    const start = (e: DragEvent) => {
      const dt = e.dataTransfer, t = e.target as Element | null;
      if (!dt || !t || !(t instanceof Element)) return;
      const types = Array.from(dt.types);
      if (types.includes(ID_TYPE)) return;
      const el = t.closest("[data-drag-id]") ?? t.closest("[data-preview-url]");
      const id = el?.getAttribute("data-drag-id") ?? assetIdFromUrl(el?.getAttribute("data-preview-url"));
      if (!el || !id) return;
      const meta = { name: el.getAttribute("data-drag-name") ?? el.getAttribute("data-preview-name") ?? undefined, kind: el.getAttribute("data-drag-kind") ?? el.getAttribute("data-preview-kind") ?? undefined };
      /* What the source set itself is what its own targets read (a Rig library key, a render's full JSON): keep it, add the rest. */
      const own = types.includes("text/plain") ? dt.getData("text/plain") : "";
      const json = types.includes(DRAG_TYPE) ? dt.getData(DRAG_TYPE) : "";
      writeAssetDrag(dt, id, meta);
      if (own) dt.setData("text/plain", own);
      if (json) dt.setData(DRAG_TYPE, json);
    };
    const enter = (e: DragEvent) => { if (hasFiles(e.dataTransfer)) { depth.current++; setOver(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e.dataTransfer) && --depth.current <= 0) { depth.current = 0; setOver(false); } };
    const overPage = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || e.defaultPrevented) return;
      /* No target took it: allow the drop here, so the browser does not open the file instead of the app. */
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      depth.current = 0; setOver(false);
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      const detail: FilesDropDetail = { files, handled: false };
      window.dispatchEvent(new CustomEvent(FILES_EVENT, { detail }));
      if (!detail.handled) { setNote("Open a project to keep dropped files in its Library."); setTimeout(() => setNote(null), 3500); }
    };
    const end = () => { depth.current = 0; setOver(false); };
    document.addEventListener("dragstart", start);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overPage);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      document.removeEventListener("dragstart", start);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overPage);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
    };
  }, []);

  return (
    <>
      {over ? <div className="dl-hint" data-testid="drop-hint" aria-hidden="true"><span>Drop to add to this project’s Library — or onto a well, a shot or a prompt to use it there</span></div> : null}
      {note ? <div className="dl-note" role="status" data-testid="drop-note">{note}</div> : null}
    </>
  );
}
