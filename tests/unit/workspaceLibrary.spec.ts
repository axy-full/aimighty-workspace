import { test, expect } from "@playwright/test";
import { libraryEntries } from "../../lib/workspace/library";
import type { Generation } from "../../lib/jobs";
import type { LibraryUpload } from "../../lib/genLibrary";


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
