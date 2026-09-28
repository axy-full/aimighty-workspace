import { test, expect } from "@playwright/test";
import type { Generation } from "../../lib/jobs";
import type { LibraryUpload } from "../../lib/genLibrary";
import { libraryEntries } from "../../lib/workspace/library";
import { INSPECTOR_SURFACE, bindPreview, endBindings, galleryItems, onBindingsEnded, pickGallery, publishGallery, publishedGallery, setPreviewBinder, type Binding } from "../../lib/shell/preview-bridge";
import { previewAttrs, readPreview } from "../../lib/preview";

/* Idea 26: the viewer walks a surface's whole, filtered, ordered list — not the tiles a windowed grid has mounted. */
const gen = (id: string, over: Partial<Generation> = {}) => ({
  id, projectId: "prod", kind: "image", model: "m", prompt: id, title: id, params: {}, status: "succeeded", storedUrl: `/api/media/${id}`,
  reviewState: "", createdAt: 1_000, updatedAt: 1_000, ...over,
}) as Generation;
const up = (id: string, over: Partial<LibraryUpload> = {}) => ({ id, filename: `${id}.png`, mime: "image/png", kind: "image", bytes: 1, width: 1, height: 1, durationS: null, sha256: "", url: `/api/uploads/${id}`, createdAt: 900, ...over }) as LibraryUpload;

const entries = libraryEntries({
  generations: [
    gen("g1", { createdAt: 5_000 }),
    gen("g_fail", { createdAt: 4_000, status: "failed", storedUrl: null }),
    gen("g_live", { createdAt: 3_000, status: "running", storedUrl: null }),
    gen("g_clip", { createdAt: 2_000, kind: "video" }),
  ],
  uploads: [up("u_doc", { filename: "script.pdf", mime: "application/pdf", kind: "file", createdAt: 1_500 }), up("u_plate", { createdAt: 1_000 })],
});

test("a list's gallery is its previewable takes, in its order, once each, each naming its take", () => {
  const items = galleryItems([...entries, entries[0]]);
  expect(items.map((i) => i.id)).toEqual(["generation:g1", "generation:g_clip", "upload:u_doc", "upload:u_plate"]);
  expect(items.map((i) => i.item.kind)).toEqual(["image", "video", "document", "image"]);
  expect(items.every((i) => i.item.asset === i.id)).toBe(true);
  /* The tile carries the take too, so a preview opened from it knows where it is. */
  const el = { attrs: previewAttrs(items[1].item), getAttribute(name: string) { return (this.attrs as Record<string, string>)[name] ?? null; } };
  expect(el.attrs["data-preview-asset"]).toBe("generation:g_clip");
  expect(readPreview(el as unknown as Element)?.asset).toBe("generation:g_clip");
});

test("a preview walks the surface it was opened from; the Inspector walks the page's list first, then the Library's", () => {
  const takes = { projectId: "d1", entries: entries.filter((e) => e.media === "image") };
  const library = { projectId: "d1", entries };
  const lists = { takes, library };
  expect(pickGallery("library", "generation:g_clip", lists, "d1")).toMatchObject({ surface: "library", index: 1 });
  expect(pickGallery("takes", "upload:u_plate", lists, "d1")).toMatchObject({ surface: "takes", index: 1 });
  expect(pickGallery(INSPECTOR_SURFACE, "upload:u_plate", lists, "d1")).toMatchObject({ surface: "takes", index: 1 });
  /* Not in Takes' filtered list: the Library's holds it. */
  expect(pickGallery(INSPECTOR_SURFACE, "generation:g_clip", lists, "d1")).toMatchObject({ surface: "library", index: 1 });
  /* A list published for another project, a take in neither, an unknown surface and a malformed id bind nothing. */
  expect(pickGallery("library", "generation:g1", lists, "d2")).toBeNull();
  expect(pickGallery("library", "generation:g_fail", lists, "d1")).toBeNull();
  expect(pickGallery("gen", "generation:g1", lists, "d1")).toBeNull();
  expect(pickGallery("library", "g1", lists, "d1")).toBeNull();
});

test("a surface withdraws only its own list; the shell's binder is let go only by its own cleanup; ended bindings are announced", () => {
  const first = publishGallery("takes", { projectId: "d1", entries });
  const second = publishGallery("takes", { projectId: "d1", entries: entries.slice(0, 1) });
  first();
  expect(publishedGallery("takes")?.entries).toHaveLength(1);
  second();
  expect(publishedGallery("takes")).toBeNull();

  const binding: Binding = { items: galleryItems(entries), index: 0, step: () => {}, actions: () => ({}), act: async () => ({}) };
  const a = setPreviewBinder(() => binding);
  const b = setPreviewBinder(() => null);
  a();
  expect(bindPreview("library", "generation:g1")).toBeNull();
  b();
  const c = setPreviewBinder(() => { throw new Error("a binder that fails binds nothing"); });
  expect(bindPreview("library", "generation:g1")).toBeNull();
  c();

  let ended = 0;
  const stop = onBindingsEnded(() => { ended++; });
  endBindings();
  stop();
  endBindings();
  expect(ended).toBe(1);
});
