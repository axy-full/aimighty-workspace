"use client";
import { useMemo } from "react";
import LazyMedia from "@/components/LazyMedia";
import { inlineSafe } from "@/lib/serveType";
import { libraryKind, libraryUrl } from "@/lib/genLibrary";
import type { UploadedFile } from "@/lib/uploadClient";
import "./library-tile.css";

/** What a Library tile shows: a still, a video's frame, or (sound, a document, anything else) the tile's plain black. */
export type TileMediaKind = "image" | "video" | "audio" | null;

/**
 * A Library tile's picture (the board's Library drawer): a still as itself, a stored video as its poster frame
 * (components/LazyMedia), anything else as the tile's black.
 */
export function TileMedia({ url, media }: { url: string | null; media: TileMediaKind }) {
  return (
    <span className="bd-tile-media">
      {media === "video" && url ? <LazyMedia url={url} kind="video" preview={false} />
        /* eslint-disable-next-line @next/next/no-img-element */
        : media === "image" && url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
    </span>
  );
}

/** An upload as the Library shows it (lib/workspace/library libraryEntries): its stored URL when the browser may show it in place. */
export function uploadTile(upload: UploadedFile): { url: string | null; media: TileMediaKind } {
  const kind = libraryKind({ origin: "upload", value: { ...upload, createdAt: 0 } });
  const media = inlineSafe(upload.mime) && (kind === "image" || kind === "video" || kind === "audio") ? kind : null;
  return { url: media ? libraryUrl({ origin: "upload", value: { ...upload, createdAt: 0 } }) : null, media };
}

/** Point a still or a video at a file on this device: an object URL made when the element mounts, revoked when it goes. */
function objectUrlRef(file: File) {
  return (el: HTMLImageElement | HTMLVideoElement | null) => {
    if (!el) return;
    const url = URL.createObjectURL(file);
    el.src = el instanceof HTMLVideoElement ? `${url}#t=0.1` : url;
    return () => URL.revokeObjectURL(url);
  };
}

/** A file on this device (not uploaded yet) as a Library tile's picture: a still as itself, a video by the browser's own first frame. */
export function LocalTileMedia({ file }: { file: File }) {
  /* One ref per file, so a re-render (a word typed in the box) keeps the URL it made. */
  const ref = useMemo(() => objectUrlRef(file), [file]);
  return (
    <span className="bd-tile-media">
      {file.type.startsWith("video/") ? <video ref={ref} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
        /* A local file's preview (an object URL), not a served image: next/image has nothing to optimise. */
        /* eslint-disable-next-line @next/next/no-img-element */
        : file.type.startsWith("image/") ? <img ref={ref} alt="" decoding="async" draggable={false} /> : null}
    </span>
  );
}
