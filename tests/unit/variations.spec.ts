import { test, expect } from "@playwright/test";
import { COUNTS, clampCount, maxCount, isBatchId, newBatchId, groupSiblings } from "../../lib/variations";

/** Batch variations (brief 1.6): 1–4 for video, 1–8 for stills; siblings of one press grouped on the wall, in order. */
test("counts are bounded per kind and a batch id is well formed", () => {
  expect(COUNTS.video).toEqual([1, 2, 3, 4]);
  expect(COUNTS.image).toEqual([1, 2, 4, 8]);
  expect(maxCount("video")).toBe(4); expect(maxCount("image")).toBe(8);
  expect(clampCount("video", 8)).toBe(1); expect(clampCount("image", 8)).toBe(8); expect(clampCount("video", 3)).toBe(3);
  expect(isBatchId(newBatchId())).toBe(true);
  expect(isBatchId("b_")).toBe(false); expect(isBatchId("gen_x")).toBe(false); expect(isBatchId(12)).toBe(false);
});

test("siblings gather into one strip in first-seen order; singles and lone batches stay single", () => {
  const takes = [
    { id: "a", params: {} }, { id: "b", params: { batchId: "b_abcd1" } }, { id: "c", params: { batchId: "b_zzzz9" } },
    { id: "d", params: { batchId: "b_abcd1" } }, { id: "e" }, { id: "f", params: { batchId: "b_abcd1" } },
  ];
  const strips = groupSiblings(takes);
  expect(strips.map((s) => s.kind)).toEqual(["one", "batch", "one", "one"]);
  expect((strips[1] as { takes: { id: string }[] }).takes.map((t) => t.id)).toEqual(["b", "d", "f"]);
  expect((strips[2] as { take: { id: string } }).take.id).toBe("c"); // a batch of one is just a take
});
