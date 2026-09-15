"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { isAssetDrag, readDrag, type DraggedAsset } from "./dnd";
import type { UploadedFile } from "./uploadClient";
import type { RefItem } from "./refs";
import { generatedReferenceSeconds } from "./referenceDuration";

export const GEN_ASSETS_CHANGED = "particl:assets-changed";

export type GenAssetInputHandle = {
  useAsset: (asset: DraggedAsset) => Promise<boolean>;
  useFiles: (files: FileList | File[]) => Promise<void>;
};
export type GenInputAsset = {
  key: string;
  id: string;
  name: string;
  url: string;
  origin: "upload" | "generation";
  kind: "image" | "video" | "audio" | "file";
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  seconds: number | null;
  sha256: string;
};
const validId = /^[A-Za-z0-9_-]{1,160}$/;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function inputFromUpload(upload: UploadedFile): GenInputAsset {
  if (!validId.test(upload.id)) throw Error("This upload has an invalid identity.");
  return {
    key: `upload:${upload.id}`, id: upload.id, name: upload.filename,
    url: `/api/uploads/${encodeURIComponent(upload.id)}`, origin: "upload",
    kind: upload.kind === "image" || upload.kind === "video" ? upload.kind : upload.mime?.startsWith("audio/") ? "audio" : "file",
    mime: upload.mime, bytes: finite(upload.bytes) ?? 0,
    width: finite(upload.width), height: finite(upload.height),
    seconds: finite(upload.durationS), sha256: upload.sha256 ?? "",
  };
}

/** Payloads supply identity only. All media metadata is resolved in the current tenant. */
export async function resolveGenInput(
  payload: DraggedAsset | string,
  scope: string,
  transport: typeof fetch = fetch,
): Promise<GenInputAsset> {
  if (!scope) throw Error("Sign in to the intended workspace first.");
  let origin: "upload" | "generation", id: string;
  if (typeof payload === "string") {
    const match = /^(upload|generation):(.+)$/.exec(payload);
    origin = match?.[1] === "generation" ? "generation" : "upload";
    id = match ? match[2] : payload;
  } else if (payload.kind === "gen") {
    origin = "generation"; id = payload.gen.id;
  } else if (payload.kind === "upload") {
    origin = "upload"; id = payload.upload.id;
  } else if (payload.kind === "cast" && payload.uploadId) {
    origin = "upload"; id = payload.uploadId;
  } else throw Error("This asset has no saved image or video to use.");
  if (typeof id !== "string" || !validId.test(id)) throw Error("This asset has an invalid identity.");
  const url = origin === "upload" ? `/api/uploads/${encodeURIComponent(id)}/metadata` : `/api/jobs/${encodeURIComponent(id)}?sync=0`;
  const response = await transport(url, { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || "This asset is unavailable in the current workspace.");
  if (origin === "upload") {
    if (!result.upload || result.upload.id !== id) throw Error("The upload could not be verified.");
    return inputFromUpload(result.upload);
  }
  const g = result.generation;
  if (!g || g.id !== id || g.status !== "succeeded" || !g.storedUrl)
    throw Error("Choose a completed take with a saved output.");
  if (!["image", "video", "audio"].includes(g.kind)) throw Error("This take has an unsupported media type.");
  return {
    key: `generation:${id}`, id, origin, kind: g.kind,
    name: g.title || String(g.params?.rawPrompt || g.prompt || id).slice(0, 120),
    url: `/api/media/${encodeURIComponent(id)}`, mime: g.kind === "image" ? "image/png" : g.kind === "video" ? "video/mp4" : "audio/mpeg",
    bytes: finite(g.outputBytes) ?? 0, width: null, height: null,
    seconds: g.kind === "video" ? generatedReferenceSeconds(g.params) : null, sha256: "",
  };
}

export function inputAsReference(asset: GenInputAsset, role: RefItem["role"]): RefItem {
  if (asset.kind !== "image" && asset.kind !== "video") throw Error("Choose an image or video reference.");
  return {
    id: asset.id, origin: asset.origin, filename: asset.name, url: asset.url,
    mime: asset.mime, kind: asset.kind, bytes: asset.bytes, width: asset.width,
    height: asset.height, durationS: asset.seconds, sha256: asset.sha256,
    base64Bytes: 0, role, verified: true,
  };
}
export function referenceIdentity(ref: Pick<RefItem, "id" | "origin">) {
  return ref.origin === "generation" ? { genId: ref.id } : { uploadId: ref.id };
}

/** Serializes intake and ignores results after the receiving workspace unmounts. */
export function useGenAssetInput(options: {
  scope?: string | null;
  locked: boolean;
  initialSource?: string | null;
  acceptFile: (file: File, target?: "source" | "reference") => void;
  upload: (file: File) => Promise<UploadedFile>;
  onAsset: (asset: GenInputAsset, target?: "source" | "reference") => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(false), pending = useRef(false), seeded = useRef(""), epoch = useRef(0);
  useEffect(() => {
    alive.current = true;
    const mountedEpoch = epoch.current;
    return () => { alive.current = false; epoch.current = mountedEpoch + 1; seeded.current = ""; };
  }, [options.scope]);
  async function run(action: (current: () => boolean) => Promise<void>) {
    if (!options.scope || options.locked || pending.current) {
      options.onError(!options.scope ? "Sign in before adding assets." : "Finish or recover the current request before changing its assets.");
      return false;
    }
    pending.current = true;
    const started = epoch.current;
    const current = () => alive.current && epoch.current === started;
    setBusy(true);
    try { await action(current); return current(); }
    catch (error) { if (current()) options.onError(error instanceof Error ? error.message : "The asset could not be added."); return false; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function addAsset(payload: DraggedAsset | string, target?: "source" | "reference") {
    return run(async (current) => {
      const asset = await resolveGenInput(payload, options.scope!);
      if (current()) options.onAsset(asset, target);
    });
  }
  async function addFiles(files: FileList | File[], target?: "source" | "reference") {
    await run(async (current) => {
      const list = Array.from(files);
      if (list.length > 8) throw Error("Add up to eight files at a time.");
      for (const file of list) {
        if (!current()) return;
        options.acceptFile(file, target);
        const asset = inputFromUpload(await options.upload(file));
        if (current()) {
          window.dispatchEvent(new CustomEvent(GEN_ASSETS_CHANGED, { detail: { scope: options.scope } }));
          options.onAsset(asset, target);
        }
      }
    });
  }
  useEffect(() => {
    if (!options.initialSource || !options.scope || options.locked || pending.current || seeded.current === options.initialSource) return;
    seeded.current = options.initialSource;
    void addAsset(options.initialSource);
  });
  function onDragOver(event: DragEvent) {
    if (isAssetDrag(event) || Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = options.locked || busy ? "none" : "copy";
    }
  }
  function onDrop(event: DragEvent, target?: "source" | "reference") {
    event.preventDefault(); event.stopPropagation();
    const payload = readDrag(event);
    if (payload) void addAsset(payload, target);
    else if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files, target);
    else options.onError("Drag a saved workspace asset or a file from your device.");
  }
  return { busy, useAsset: addAsset, useFiles: addFiles, onDragOver, onDrop };
}
