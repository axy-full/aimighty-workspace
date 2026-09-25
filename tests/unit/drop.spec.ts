import { test, expect } from "@playwright/test";
import { ID_TYPE, isDroppable, normaliseDragId, readDrop, writeAssetDrag } from "../../lib/drop";
import { DRAG_TYPE } from "../../lib/dnd";
import { assetIdFromUrl, originalUrl, downloadUrl, previewKindOf } from "../../lib/preview";

/** A DataTransfer good enough for the reader: typed strings and files. */
function fake(data: Record<string, string> = {}, files: File[] = []): DataTransfer {
  const store = new Map(Object.entries(data));
  return {
    get types() { return [...store.keys(), ...(files.length ? ["Files"] : [])]; },
    getData: (t: string) => store.get(t) ?? "",
    setData: (t: string, v: string) => { store.set(t, v); },
    files: files as unknown as FileList,
    effectAllowed: "uninitialized",
  } as unknown as DataTransfer;
}

test("one payload: writeAssetDrag writes the id three ways, and readDrop reads it back from any of them", () => {
  const dt = fake();
  writeAssetDrag(dt, "generation:gen_1", { name: "Wide", kind: "video" });
  expect(dt.getData("text/plain")).toBe("generation:gen_1");
  expect(dt.getData(ID_TYPE)).toBe("generation:gen_1");
  expect(JSON.parse(dt.getData(DRAG_TYPE))).toMatchObject({ kind: "gen", gen: { id: "gen_1", kind: "video", storedUrl: "/api/media/gen_1" } });
  expect(readDrop(dt)).toEqual({ ids: ["generation:gen_1"], files: [], text: null });
  /* The composer's file panel writes JSON only; the Suites wells used to write text only. */
  expect(readDrop(fake({ [DRAG_TYPE]: JSON.stringify({ kind: "upload", upload: { id: "up_9" } }) })).ids).toEqual(["upload:up_9"]);
  expect(readDrop(fake({ "text/plain": "upload:up_2" })).ids).toEqual(["upload:up_2"]);
  writeAssetDrag(dt, "not an id");
  expect(dt.getData(ID_TYPE)).toBe("generation:gen_1");
});

test("Rig keys, project asset ids and media URLs normalise to Library ids; stray text is refused, not guessed", () => {
  const assets = [{ id: "a-1", uploadId: "up_a" }, { id: "a-2", generationId: "gen_b" }];
  expect(normaliseDragId("take:generation:gen_x")).toBe("generation:gen_x");
  expect(normaliseDragId("asset:a-1", assets)).toBe("upload:up_a");
  expect(normaliseDragId("a-2", assets)).toBe("generation:gen_b");
  expect(normaliseDragId("/api/workbench/preview/upload/up_c")).toBe("upload:up_c");
  expect(normaliseDragId("brief:2")).toBeNull();
  expect(normaliseDragId("A sentence someone dragged from the page")).toBeNull();
  const text = readDrop(fake({ "text/plain": "brief:2" }));
  expect(text).toEqual({ ids: [], files: [], text: "brief:2" });
});

test("device files come through beside ids; dragover says what a target can take", () => {
  const file = new File([new Uint8Array(4)], "plate.png", { type: "image/png" });
  const dt = fake({}, [file]);
  expect(readDrop(dt).files).toEqual([file]);
  expect(isDroppable(dt)).toBe(true);
  expect(isDroppable(dt, { files: false })).toBe(false);
  expect(isDroppable(fake({ [ID_TYPE]: "upload:u" }), { files: false })).toBe(true);
  expect(isDroppable(fake())).toBe(false);
});

test("preview URLs: thumbnails map to their originals and downloads; kinds from mime or name", () => {
  expect(assetIdFromUrl("/api/media/gen_1?stream=1")).toBe("generation:gen_1");
  expect(assetIdFromUrl("/api/uploads/up_1/metadata")).toBe("upload:up_1");
  expect(assetIdFromUrl("/api/uploads/session")).toBeNull();
  expect(assetIdFromUrl("https://elsewhere.example/api/media/gen_1")).toBeNull();
  expect(originalUrl("/api/workbench/preview/generation/gen_1")).toBe("/api/media/gen_1");
  expect(downloadUrl("/api/workbench/preview/upload/up_1")).toBe("/api/uploads/up_1?download=1");
  expect(downloadUrl("blob:abc")).toBe("blob:abc");
  expect(previewKindOf(null, "application/pdf")).toBe("document");
  expect(previewKindOf("file", "", "draft.fountain")).toBe("document");
  expect(previewKindOf("file", "application/octet-stream", "scene.blend")).toBe("file");
  expect(previewKindOf(null, "audio/mpeg")).toBe("audio");
});
