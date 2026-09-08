import { test, expect } from "@playwright/test";
import { dimensionsFor, billedFrame, estimateTokens } from "../../lib/models";

/**
 * The file's frame and the billed frame are two numbers (the 1088 question).
 * The engine bills on a sixteen-pixel grid, so 1080p costs what 1088 costs —
 * but the master is 1080 tall, and the chip should say so.
 */
test("the size shown is the file's own, in both orientations", () => {
  expect(dimensionsFor("1080p", "16:9")).toEqual({ w: 1920, h: 1080 });
  expect(dimensionsFor("720p", "16:9")).toEqual({ w: 1280, h: 720 });
  expect(dimensionsFor("1080p", "9:16")).toEqual({ w: 1080, h: 1920 });
  expect(dimensionsFor("480p", "16:9")).toEqual({ w: 853, h: 480 });
  expect(dimensionsFor("1080p", "adaptive")).toBeNull();
  expect(dimensionsFor("nope", "16:9")).toBeNull();
});

test("the billed frame rounds each side up to sixteen, and the tokens follow it", () => {
  expect(billedFrame("1080p", "16:9")).toEqual({ w: 1920, h: 1088 });
  expect(billedFrame("720p", "16:9")).toEqual({ w: 1280, h: 720 });   // already on the grid
  expect(billedFrame("480p", "16:9")).toEqual({ w: 864, h: 480 });
  expect(billedFrame("1080p", "9:16")).toEqual({ w: 1088, h: 1920 });
  // The vendor's own published examples, unchanged by any of this.
  expect(estimateTokens("1080p", "16:9", 5, 0)).toBe(244_800);
  expect(estimateTokens("480p", "16:9", 5, 0)).toBe(48_600);
});
