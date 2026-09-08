import { test, expect } from "@playwright/test";
import { cleanAttachments, attachmentLine, seenByModel, stepReferences, MAX_ATTACHMENTS } from "../../lib/attachments";

const img = (id: string) => ({ uploadId: id, kind: "image", name: `${id}.png`, mime: "image/png" });

/** What a person hands the agent (attachments): read strictly, shown to the model, carried onto the render. */
test("attachments are read strictly: real ids, no repeats, a bounded number", () => {
  expect(cleanAttachments(null)).toEqual([]);
  expect(cleanAttachments([img("a"), img("a")]).length).toBe(1);
  expect(cleanAttachments([{ uploadId: "../etc/passwd" }, { uploadId: "" }, { nope: 1 }])).toEqual([]);
  expect(cleanAttachments(Array.from({ length: 9 }, (_, i) => img(`u${i}`))).length).toBe(MAX_ATTACHMENTS);
  expect(cleanAttachments([{ uploadId: "v1", kind: "video" }])[0]).toEqual({ uploadId: "v1", kind: "video", name: "", mime: "image/png" });
});

test("a still is shown to the model and a clip is not, and the line says which is which", () => {
  const list = cleanAttachments([img("a"), img("b"), { uploadId: "v1", kind: "video", name: "plate.mp4", mime: "video/mp4" }]);
  expect(list.filter(seenByModel).map((a) => a.uploadId)).toEqual(["a", "b"]);
  const line = attachmentLine(list);
  expect(line).toContain("2 stills attached and shown to you below");
  expect(line).toContain("1 clip attached, which you cannot watch");
  expect(line).toContain('"attachments": true');
  expect(attachmentLine([])).toBe("");
});

test("a step carries the files only when the model said this step is about them", () => {
  const list = cleanAttachments([img("a"), { uploadId: "v1", kind: "video", name: "plate.mp4", mime: "video/mp4" }]);
  expect(stepReferences(list, true)).toEqual([
    { uploadId: "a", role: "reference_image" },
    { uploadId: "v1", role: "reference_video" },
  ]);
  expect(stepReferences(list, false)).toEqual([]);
  expect(stepReferences(list, undefined)).toEqual([]);
  expect(stepReferences([], true)).toEqual([]);
});
