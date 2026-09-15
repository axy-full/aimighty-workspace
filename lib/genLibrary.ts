import type { Generation } from "./jobs";
import type { UploadedFile } from "./uploadClient";
import type { DraggedAsset } from "./dnd";

export const ASSET_GROUPS = [
  { kind: "image", label: "Images" },
  { kind: "video", label: "Videos" },
  { kind: "audio", label: "Audio" },
  { kind: "document", label: "Documents" },
  { kind: "file", label: "Other files" },
] as const;
export type LibraryKind = (typeof ASSET_GROUPS)[number]["kind"];
export type LibraryUpload = UploadedFile & { createdAt: number };
export type LibraryAsset =
  | { origin: "generation"; value: Generation }
  | { origin: "upload"; value: LibraryUpload };

/** Classification is for the library only; it never changes serving MIME or engine eligibility. */
export function libraryKind(asset: LibraryAsset): LibraryKind {
  if (asset.origin === "generation") return asset.value.kind;
  const upload = asset.value;
  if (upload.kind === "image" || upload.kind === "video") return upload.kind;
  if (/\.(?:wav|wave|mp3|aif|aiff|flac|m4a|ogg|opus)$/i.test(upload.filename)) return "audio";
  if (/\.(?:pdf|txt|fountain|fdx|doc|docx|rtf|md)$/i.test(upload.filename)) return "document";
  return "file";
}
export const libraryId = (asset: LibraryAsset) => `${asset.origin}:${asset.value.id}`;
export function libraryName(asset: LibraryAsset) {
  return asset.origin === "upload"
    ? asset.value.filename
    : asset.value.title || asset.value.prompt || "Untitled take";
}
export function libraryUrl(asset: LibraryAsset) {
  const id = encodeURIComponent(asset.value.id);
  return asset.origin === "generation" ? `/api/media/${id}?stream=1` : `/api/uploads/${id}`;
}
export function libraryInput(asset: LibraryAsset): DraggedAsset {
  return asset.origin === "generation"
    ? { kind: "gen", gen: asset.value }
    : { kind: "upload", upload: asset.value };
}
export function libraryReady(asset: LibraryAsset) {
  return asset.origin === "upload" || (asset.value.status === "succeeded" && Boolean(asset.value.storedUrl));
}
