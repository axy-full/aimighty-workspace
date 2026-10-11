/**
 * The Library tray in the new interface, as data (docs/redesign-plan.md, item C4; docs/redesign/inventory.md § 5.10;
 * components/v12/library/LibraryTray.tsx). Pure: no React, no fetch.
 *
 * Where each part comes from today (docs/redesign/app-map.md § 1.4):
 *  - The items: one board's library, GET /api/workbench/library?projectId&source=uploads|generations (its uploads and
 *    generations), read through lib/workspace/library.ts libraryEntries. Search is that route's own `q`, run on the
 *    server, in this workspace's database and this board's filing only.
 *  - Uploaded or Generated: where the item lives (plan decision 11): a generation, or an upload the library marks as
 *    made from one (`librarySource: 'generation'`), is Generated; any other upload is Uploaded (lib/genLibrary.ts
 *    librarySource). No schema change.
 *  - Characters, Locations and Props: what the open board's reference cards say a file is (lib/workbench/ref-kind.ts:
 *    Cast, Environment, Element). Only the open board's cards are read, so another board's library shows these kinds
 *    empty until that board is open.
 *  - Products and Mandatories: no such kind exists in today's code. The chips are drawn and say so (STUB_KINDS).
 *  - Everything made: every Generated item.
 */
import { librarySource } from "@/lib/genLibrary";
import type { LibraryEntry } from "@/lib/workspace/library";
import { nodeRole } from "@/lib/board/regions";
import { refKindOf } from "@/lib/workbench/ref-kind";
import type { Project } from "@/lib/workbench/studio";

export const TRAY_KINDS = ["All", "Characters", "Locations", "Props", "Products", "Mandatories", "Everything made"] as const;
export type TrayKind = (typeof TRAY_KINDS)[number];
/** Kinds the code has no concept of yet: their chip is drawn, and its list says the kind is not in the Library yet. */
export const STUB_KINDS: readonly TrayKind[] = Object.freeze(["Products", "Mandatories"]);
export const TRAY_SOURCES = ["All", "Uploaded", "Generated"] as const;
export type TraySource = (typeof TRAY_SOURCES)[number];

/** What a board's reference card says a file is: lib/workbench/ref-kind.ts RefKind, to the tray's kind. */
export type CastKind = "Characters" | "Locations" | "Props";
export const REF_KIND_TO_TRAY: Readonly<Record<string, CastKind>> = Object.freeze({ cast: "Characters", environment: "Locations", element: "Props" });
/** Characters, Locations and Props on one board: each reference card's file (its Library id) and what the card says it is. */
export function castKindsOf(project: Pick<Project, "nodes" | "assets"> & Partial<Pick<Project, "sharedAssets">>): Map<string, CastKind> {
  const kinds = new Map<string, CastKind>();
  for (const node of project.nodes) {
    if (nodeRole(node, project.nodes, project).kind !== "cast" || !node.assetId) continue;
    const kind = REF_KIND_TO_TRAY[refKindOf(node, project) ?? ""];
    const asset = project.assets.find((a) => a.id === node.assetId);
    if (!kind || !asset) continue;
    if (asset.generationId) kinds.set(`generation:${asset.generationId}`, kind);
    if (asset.uploadId) kinds.set(`upload:${asset.uploadId}`, kind);
  }
  return kinds;
}

const SINGULAR: Record<CastKind, string> = { Characters: "Character", Locations: "Location", Props: "Prop" };

export type TrayItem = {
  /** The Library id, `generation:<id>` or `upload:<id>`: what every drop target reads (lib/drop.ts). */
  id: string;
  name: string;
  /** The kind line under the name: "Character", "Still", "Clip", "Sound", "File". */
  kindLine: string;
  cast: CastKind | null;
  source: "Uploaded" | "Generated";
  url: string | null;
  media: "image" | "video" | "audio" | null;
  /** The tile's picture area, as a CSS aspect ratio ("16 / 9"). */
  aspect: string;
};

const MEDIA_WORD: Record<string, string> = { image: "Still", video: "Clip", audio: "Sound" };

/** Width over height from what the item records, or null. */
function recordedRatio(entry: LibraryEntry): number | null {
  const v = entry.asset.value as { width?: unknown; height?: unknown; params?: unknown };
  const w = Number(v.width), h = Number(v.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
  const ratio = (v.params as { ratio?: unknown; aspectRatio?: unknown } | null | undefined)?.ratio ?? (v.params as { aspectRatio?: unknown } | null | undefined)?.aspectRatio;
  const m = typeof ratio === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio) : null;
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
}

/**
 * The tile's aspect: the item's own (clamped so one tile never towers over the column), else the prototype's by kind:
 * a character 4/5, anything else 16/9 (§ 5.10).
 */
export function tileAspect(entry: LibraryEntry, cast: CastKind | null): string {
  const ratio = recordedRatio(entry);
  if (ratio) {
    const r = Math.min(16 / 9, Math.max(9 / 16, ratio));
    return `${Math.round(r * 1000)} / 1000`;
  }
  return cast === "Characters" ? "4 / 5" : entry.media === "audio" ? "3 / 1" : "16 / 9";
}

const UNFINISHED = new Set(["rendering", "held", "failed"]);

/** The tray's items from the library's entries; `castOf` answers for a Library id from the open board's cards. */
export function trayItems(entries: readonly LibraryEntry[], castOf: (libraryId: string) => CastKind | null = () => null): TrayItem[] {
  /* Finished takes only: one still rendering, held for an approval or failed has nothing to drag or mention yet. */
  return entries.filter((e) => !UNFINISHED.has(e.take.status)).map((entry) => {
    const cast = castOf(entry.take.id);
    return {
      id: entry.take.id,
      /* A file's name reads without its extension ("Lead actor", not "Lead actor.webp"); the kind line says what it is. */
      name: entry.asset.origin === "upload" ? entry.take.name.replace(/\.[a-z0-9]{2,5}$/i, "") || entry.take.name : entry.take.name,
      kindLine: cast ? SINGULAR[cast] : MEDIA_WORD[entry.media ?? ""] ?? "File",
      cast,
      source: librarySource(entry.asset) === "generations" ? "Generated" : "Uploaded",
      url: entry.url,
      media: entry.media,
      aspect: tileAspect(entry, cast),
    };
  });
}

/** The items a source and a kind show. A stub kind shows nothing. */
export function filterTray(items: readonly TrayItem[], source: TraySource, kind: TrayKind): TrayItem[] {
  if (STUB_KINDS.includes(kind)) return [];
  return items.filter((item) => (source === "All" || item.source === source)
    && (kind === "All" || (kind === "Everything made" ? item.source === "Generated" : item.cast === kind)));
}

/** Height over width of an aspect written "w / h". */
const tall = (aspect: string) => { const [w, h] = aspect.split("/").map((n) => Number(n.trim())); return w > 0 && h > 0 ? h / w : 9 / 16; };

/**
 * Two columns of tiles at their true aspect (§ 5.10 "2-column masonry"), in order, each tile to the shorter column.
 * The name block under each picture counts as a fixed share of a tile's width.
 */
export function masonry<T extends { aspect: string }>(items: readonly T[], columns = 2, captionShare = 0.25): T[][] {
  const cols: T[][] = Array.from({ length: columns }, () => []);
  const heights = new Array(columns).fill(0);
  for (const item of items) {
    const at = heights.indexOf(Math.min(...heights));
    cols[at].push(item);
    heights[at] += tall(item.aspect) + captionShare;
  }
  return cols;
}

/** The tray's address (inventory § 1): open with `drawer=Library` or `lib=1`; `src=` the source; `libkind=` or `kind=` the kind. */
export type TrayParams = { open: boolean; source: TraySource; kind: TrayKind };
export function readTrayParams(search: string | URLSearchParams): TrayParams {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const source = q.get("src");
  const kind = q.get("libkind") ?? q.get("kind");
  return {
    open: q.get("drawer") === "Library" || q.get("lib") === "1",
    source: (TRAY_SOURCES as readonly string[]).includes(source ?? "") ? (source as TraySource) : "All",
    kind: (TRAY_KINDS as readonly string[]).includes(kind ?? "") ? (kind as TrayKind) : "All",
  };
}

/** The tray's address written back: only what differs from the default, so a closed tray leaves the address as it was. */
export function writeTrayParams(search: string, state: TrayParams): string {
  const q = new URLSearchParams(search);
  for (const key of ["drawer", "lib", "src", "libkind"]) if (key !== "drawer" || q.get("drawer") === "Library") q.delete(key);
  /* `kind=` is also the board's own kind (studio, ads, social): only a tray kind is the tray's to remove. */
  if ((TRAY_KINDS as readonly string[]).includes(q.get("kind") ?? "")) q.delete("kind");
  if (state.open) {
    q.set("drawer", "Library");
    if (state.source !== "All") q.set("src", state.source);
    if (state.kind !== "All") q.set("libkind", state.kind);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The footer line (§ 5.10): on a board, and anywhere else. */
export const TRAY_HINT = {
  board: "Drag onto the board to place it, onto the bar to @mention it.",
  other: "Drag onto a board or the bar to use it, or click to @mention it.",
} as const;
