import { entryPreview, validAssetId, type PreviewItem } from "@/lib/preview";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * The shell's side of the site's one previewer (components/PreviewLayer),
 * idea 26. The layer is mounted in the root layout, outside the shell's
 * providers, so it never reads them: the shell registers a binder here (with
 * cleanup), and each surface that shows a list of takes publishes the list it
 * shows — whole, filtered and in its order, not the tiles a windowed grid
 * happens to have mounted. A preview opened from one of those surfaces (or
 * from the Inspector, which uses the page's list) walks that list, moves the
 * shell's selection with its arrows, and offers Recreate, Use as reference and
 * Copy link through the shell's own command path.
 *
 * Everywhere else the layer keeps reading the page's `data-preview-*` tiles.
 */

/** The surfaces that publish their list: the Library's Assets and the Takes desk. The Inspector reads theirs. */
export type GallerySurface = "library" | "takes";
export const INSPECTOR_SURFACE = "inspector";
export type Gallery = { projectId: string; entries: readonly LibraryEntry[] };

const galleries = new Map<GallerySurface, Gallery>();

/** A surface's list as it is shown now; the returned cleanup withdraws it (only if it is still this one). */
export function publishGallery(surface: GallerySurface, gallery: Gallery): () => void {
  galleries.set(surface, gallery);
  return () => { if (galleries.get(surface) === gallery) galleries.delete(surface); };
}
export function publishedGallery(surface: GallerySurface): Gallery | null {
  return galleries.get(surface) ?? null;
}

export type GalleryItem = { id: string; item: PreviewItem };

/** The takes of a list the viewer can show, in the list's order, once each; a take with nothing to show (failed, in flight) is left out, as its tile has no preview. */
export function galleryItems(entries: readonly LibraryEntry[]): GalleryItem[] {
  const out: GalleryItem[] = [], seen = new Set<string>();
  for (const entry of entries) {
    const id = validAssetId(entry.take.id);
    const item = id ? entryPreview(entry) : null;
    if (!id || !item || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, item: { ...item, asset: id } });
  }
  return out;
}

/**
 * Which published list a preview walks: the surface it was opened from, or,
 * from the Inspector, the page's own list first (Takes), then the Library's —
 * the first that holds the take. Null when none does (the layer then shows
 * what it was given).
 */
export function pickGallery(surface: string | null, asset: string | null, lists: Partial<Record<GallerySurface, Gallery>>, projectId: string | null): { surface: GallerySurface; items: GalleryItem[]; index: number } | null {
  const id = validAssetId(asset);
  if (!id || !projectId) return null;
  const order: GallerySurface[] = surface === INSPECTOR_SURFACE ? ["takes", "library"] : surface === "takes" || surface === "library" ? [surface] : [];
  for (const name of order) {
    const gallery = lists[name];
    if (!gallery || gallery.projectId !== projectId) continue;
    const items = galleryItems(gallery.entries);
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) return { surface: name, items, index };
  }
  return null;
}

/** The viewer's buttons for a take. */
export type BoundAction = "recreate" | "reference" | "link";
export type ActionState = { enabled: boolean; why?: string };
/** What pressing one did: close the viewer (it went to Gen), and/or a line to say in the viewer. */
export type ActResult = { close?: boolean; said?: string };

/** A viewer bound to the shell's selection and commands. */
export type Binding = {
  items: GalleryItem[];
  index: number;
  /** The arrows moved to this take: the shell selects it (rewriting the history entry). */
  step: (id: string) => void;
  actions: (id: string) => Partial<Record<BoundAction, ActionState>>;
  act: (action: BoundAction, id: string) => Promise<ActResult>;
};

type Binder = (request: { surface: string | null; asset: string | null }) => Binding | null;
let binder: Binder | null = null;

/** The shell registers how a preview binds (SuitesShell); the cleanup lets go only of its own. */
export function setPreviewBinder(next: Binder): () => void {
  binder = next;
  return () => { if (binder === next) binder = null; };
}
/** Asked by the layer when a preview opens: a binding when the shell has the list, else null. */
export function bindPreview(surface: string | null, asset: string | null): Binding | null {
  if (!binder) return null;
  try { return binder({ surface, asset: validAssetId(asset) }); } catch { return null; }
}

/* A viewer bound to a scope and project closes when the shell leaves either. */
const enders = new Set<() => void>();
export function onBindingsEnded(listener: () => void): () => void {
  enders.add(listener);
  return () => { enders.delete(listener); };
}
export function endBindings() {
  for (const listener of [...enders]) listener();
}
