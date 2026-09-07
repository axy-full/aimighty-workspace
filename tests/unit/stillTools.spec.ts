import { test, expect } from "@playwright/test";
import { getModel, estimateImageCostUsd } from "../../lib/models";
import { billCredits } from "../../lib/creditTerms";
import { canvasFor, falImageInput, stillToolFor, STILL_TOOLS } from "../../lib/stillTools";

/** The still post tools (brief 1.2): Bria on fal, flat per image, one still of ours in, a take out. */
test("outpaint and cutout resolve to Bria rows at fal's flat prices, and build the vendor's input", () => {
  expect(STILL_TOOLS.map((t) => t.id)).toEqual(["outpaint", "cutout"]);
  const expand = getModel("fal-ai/bria/expand"); const rmbg = getModel("fal-ai/bria/background/remove");
  expect(expand.hidden && rmbg.hidden).toBe(true);
  expect(stillToolFor(expand.id)).toBe("outpaint"); expect(stillToolFor(rmbg.id)).toBe("cutout"); expect(stillToolFor("gemini-3-pro-image")).toBeNull();
  expect(estimateImageCostUsd(expand.id, "adaptive", 0)?.net).toBe(0.04);
  expect(estimateImageCostUsd(rmbg.id, "adaptive", 0)?.net).toBe(0.018);
  expect(billCredits(0.04, expand.id)).toBe(1); // 0.04 × 1.4 / 0.10 = 0.56 → 1 whole credit
  expect(billCredits(0.018, rmbg.id)).toBe(1);
  expect(canvasFor("9:16")).toEqual([1152, 2048]);
  expect(canvasFor("16:9")).toEqual([2048, 1152]);
  expect(canvasFor("1:1")).toEqual([2048, 2048]);
  expect(canvasFor("4:5")).toEqual([1638, 2048]);
  const out = falImageInput("outpaint", "https://x/still.png", "9:16", "  ");
  expect(out.endpoint).toBe("fal-ai/bria/expand");
  expect(out.input).toEqual({ image_url: "https://x/still.png", canvas_size: [1152, 2048], aspect_ratio: "9:16" });
  expect(falImageInput("outpaint", "u", "7:3").input.aspect_ratio).toBe("9:16"); // an aspect Bria lacks falls to the default
  expect(falImageInput("cutout", "u", "9:16")).toEqual({ endpoint: "fal-ai/bria/background/remove", input: { image_url: "u" } });
});
