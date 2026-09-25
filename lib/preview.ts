/**
 * Owner, 25 September: "wherever there is an asset shown, there should be a
 * preview available for it." One convention, read by one layer
 * (components/PreviewLayer): any element that shows an asset carries
 * `data-preview-url` (and kind, name, mime). LazyMedia sets them on every
 * thumbnail; other surfaces spread `previewAttrs(...)`. The layer adds the
 * hover ⤢ button, double-click, Space on a focused tile and long-press on
 * touch, and opens a full-size viewer that steps through its neighbours.
 *
 * The same attributes name the asset for drag and drop (`assetIdFromUrl`),
 * so a thumbnail that can be previewed can also be dragged.
 */
export type PreviewKind = "image" | "video" | "audio" | "document" | "file";
export type PreviewItem = { url: string; kind: PreviewKind; name?: string; mime?: string };

const ID = "[A-Za-z0-9_-]{1,160}";
const PATTERNS: [RegExp, "generation" | "upload"][] = [
  [new RegExp(`^/api/media/(${ID})(?:[/?#]|$)`), "generation"],
  [new RegExp(`^/api/workbench/preview/generation/(${ID})(?:[/?#]|$)`), "generation"],
  [new RegExp(`^/api/uploads/(${ID})(?:[/?#]|$)`), "upload"],
  [new RegExp(`^/api/workbench/preview/upload/(${ID})(?:[/?#]|$)`), "upload"],
];

/** Upload routes that are not an asset (the chunked upload protocol). */
const RESERVED = new Set(["session", "chunk", "finish", "metadata"]);

function path(url: string): string {
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    if (typeof location === "undefined" || u.origin !== location.origin) return "";
    return u.pathname + u.search;
  } catch { return ""; }
}

/** The Library id a Particl media URL names — `generation:<id>` or `upload:<id>` — or null for anything else. */
export function assetIdFromUrl(url: string | null | undefined): string | null {
  const p = path(String(url ?? ""));
  for (const [re, kind] of PATTERNS) {
    const m = re.exec(p);
    if (m && !RESERVED.has(m[1])) return `${kind}:${m[1]}`;
  }
  return null;
}

/** The full-size original behind a thumbnail URL (the 640px preview route shows images only). */
export function originalUrl(url: string): string {
  const id = assetIdFromUrl(url);
  if (!id) return url;
  const [kind, raw] = id.split(":");
  return kind === "generation" ? `/api/media/${raw}` : `/api/uploads/${raw}`;
}

/** Where "Download original" points: the same file, as an attachment with its name. */
export function downloadUrl(url: string): string {
  const original = originalUrl(url);
  if (!assetIdFromUrl(original)) return original;
  return `${original}${original.includes("?") ? "&" : "?"}download=1`;
}

export function previewKindOf(kind: string | null | undefined, mime?: string | null, name?: string | null): PreviewKind {
  const k = String(kind ?? "").toLowerCase(), m = String(mime ?? "").toLowerCase(), n = String(name ?? "").toLowerCase();
  if (k === "image" || m.startsWith("image/")) return "image";
  if (k === "video" || m.startsWith("video/")) return "video";
  if (k === "audio" || m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || m.startsWith("text/") || /\.(pdf|txt|fountain|fdx|md|srt|vtt|csv|json)$/.test(n) || k === "document" || k === "script") return "document";
  return "file";
}

/** The data attributes the preview layer reads; spread onto any element that shows an asset. */
export function previewAttrs(item: PreviewItem | null | undefined): Record<string, string> {
  if (!item?.url) return {};
  return {
    "data-preview-url": item.url, "data-preview-kind": item.kind,
    ...(item.name ? { "data-preview-name": item.name } : {}), ...(item.mime ? { "data-preview-mime": item.mime } : {}),
  };
}

/** A project asset (lib/workbench/studio Asset) as something to preview. */
export function assetPreview(asset: { url?: string; kind?: string; mime?: string; name?: string; generationId?: string; uploadId?: string } | null | undefined): PreviewItem | null {
  if (!asset) return null;
  const url = asset.generationId ? `/api/media/${asset.generationId}` : asset.uploadId ? `/api/uploads/${asset.uploadId}` : asset.url || "";
  if (!url) return null;
  return { url, kind: previewKindOf(asset.kind, asset.mime, asset.name), ...(asset.name ? { name: asset.name } : {}), ...(asset.mime ? { mime: asset.mime } : {}) };
}

/** Read the item an element carries. */
export function readPreview(el: Element): PreviewItem | null {
  const url = el.getAttribute("data-preview-url");
  if (!url) return null;
  const kind = (el.getAttribute("data-preview-kind") as PreviewKind | null) ?? "image";
  const name = el.getAttribute("data-preview-name") ?? undefined, mime = el.getAttribute("data-preview-mime") ?? undefined;
  return { url, kind, ...(name ? { name } : {}), ...(mime ? { mime } : {}) };
}

/**
 * The gallery an element belongs to: every previewable element in its nearest
 * `[data-preview-group]` (else the whole page), in reading order, one per
 * original — so a tile and its own inspector preview are not counted twice.
 */
export function galleryOf(el: Element, root: ParentNode = document): { items: PreviewItem[]; index: number } {
  const scope = el.closest("[data-preview-group]") ?? root;
  const all = Array.from(scope.querySelectorAll("[data-preview-url]"));
  const items: PreviewItem[] = [], seen = new Map<string, number>();
  let index = 0;
  for (const node of all) {
    const item = readPreview(node);
    if (!item) continue;
    const key = originalUrl(item.url);
    if (!seen.has(key)) { seen.set(key, items.length); items.push(item); }
    if (node === el) index = seen.get(key)!;
  }
  if (!items.length) { const own = readPreview(el); if (own) items.push(own); }
  return { items, index };
}

/**
 * A Library entry (lib/workspace/library LibraryEntry) as something to
 * preview. Pictures, video and sound use the entry's own URL; a ready upload
 * the browser cannot show inline (a PDF script, a text file, a .blend) is
 * still previewable from its upload URL — the viewer reads documents itself.
 */
export function entryPreview(entry: { url: string | null; media: "image" | "video" | "audio" | null; take: { id: string; name: string }; asset: { origin: "generation" | "upload"; value: { mime?: string | null; status?: string } } } | null | undefined): PreviewItem | null {
  if (!entry) return null;
  const mime = entry.asset.value.mime ?? undefined;
  if (entry.url && entry.media) return { url: entry.url, kind: entry.media, name: entry.take.name, ...(mime ? { mime } : {}) };
  const id = /^upload:(.+)$/.exec(entry.take.id)?.[1];
  if (!id || entry.asset.origin !== "upload") return null;
  return { url: `/api/uploads/${id}`, kind: previewKindOf(null, mime, entry.take.name), name: entry.take.name, ...(mime ? { mime } : {}) };
}
