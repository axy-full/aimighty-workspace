import { test, expect } from "@playwright/test";
import { INITIAL_STATE, stepSelection, withLibFilter } from "../../lib/workspace/navigation";
import { resolveKey, SHELL_BINDINGS } from "../../lib/workspace/keys";
import { libraryEntries } from "../../lib/workspace/library";
import type { AppState, SelectableItem } from "../../lib/workspace/types";
import type { Generation } from "../../lib/jobs";
import type { LibraryUpload } from "../../lib/genLibrary";

const takes: SelectableItem[] = [
  { id: "generation:a", name: "A", kind: "generation" },
  { id: "upload:b", name: "B", kind: "upload" },
  { id: "generation:c", name: "C", kind: "generation" },
  { id: "upload:d", name: "D", kind: "upload" },
];
const onTakes = (over: Partial<AppState> = {}): AppState =>
  ({ ...INITIAL_STATE, view: "studio", page: "takes", selKind: "take", selId: "upload:b", lists: { shots: null, takes, cast: null }, ...over });

test("← → walk only the visible list and stop at either end", () => {
  const uploads = withLibFilter(onTakes(), "Uploads");
  expect(uploads.selId).toBe("upload:b");
  expect(stepSelection(uploads, 1)).toBe("upload:d");
  expect(stepSelection({ ...uploads, selId: "upload:d" }, 1)).toBeNull();
  expect(stepSelection(uploads, -1)).toBeNull();
  expect(stepSelection(onTakes({ libFilter: "All" }), 1)).toBe("generation:c");
  /* A selection outside the visible list starts from its first item. */
  expect(stepSelection(onTakes({ libFilter: "Generations", selId: "upload:b" }), 1)).toBe("generation:a");
  expect(stepSelection(onTakes({ lists: { shots: null, takes: null, cast: null } }), 1)).toBeNull();
});

test("arrow keys are an item binding, never while typing and never on a page selection", () => {
  const ctx = { state: onTakes(), pageCount: 8 };
  const binding = resolveKey(SHELL_BINDINGS, { key: "ArrowRight" }, ctx);
  expect(binding?.action({ key: "ArrowRight" }, ctx)).toEqual({ type: "step", delta: 1 });
  expect(resolveKey(SHELL_BINDINGS, { key: "ArrowLeft", target: { tagName: "INPUT" } }, ctx)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "ArrowLeft" }, { ...ctx, state: { ...ctx.state, selKind: "page" } })).toBeNull();
});

test("library entries: newest first, media only where the browser can show it", () => {
  const gen = (id: string, createdAt: number, over: Partial<Generation> = {}) =>
    ({ id, createdAt, kind: "image", status: "succeeded", storedUrl: `/api/media/${id}`, model: "gemini-3.1-flash-image", params: {}, version: 1, reviewState: "", creditsBilled: 3, costUsd: null, title: id, prompt: "", ...over }) as unknown as Generation;
  const up = (id: string, createdAt: number, mime: string): LibraryUpload =>
    ({ id, createdAt, filename: `${id}.bin`, mime, kind: mime.startsWith("image/") ? "image" : "file", bytes: 1, width: null, height: null, durationS: null, sha256: "b".repeat(64), url: "" });
  const items = libraryEntries({
    generations: [gen("g1", 30), gen("g2", 10, { status: "running", storedUrl: null, kind: "video" })],
    uploads: [up("u1", 20, "image/png"), up("u2", 5, "application/zip")],
  });
  expect(items.map((i) => i.take.id)).toEqual(["generation:g1", "upload:u1", "generation:g2", "upload:u2"]);
  expect(items.map((i) => i.media)).toEqual(["image", "image", null, null]);
  expect(items[0].url).toBe("/api/media/g1?stream=1");
  expect(items[1].url).toBe("/api/uploads/u1");
});
