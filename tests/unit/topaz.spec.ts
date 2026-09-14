import { test, expect } from "@playwright/test";
import {
  DEFAULT_TOPAZ_IMAGE,
  topazImageInput,
  topazImageOutput,
  topazImageSettings,
} from "../../lib/topaz";
test("Topaz precision bounds use output pixel count and never crop or invent face detail", () => {
  expect(topazImageOutput(6000, 4000, 1).resolution).toBe("24MP");
  expect(topazImageOutput(2000, 1000, 4)).toEqual({
    width: 8000,
    height: 4000,
    resolution: "48MP",
  });
  for (const dims of [
    [6000, 4000, 2],
    [0, 500, 2],
    [Infinity, 500, 2],
    [17000, 1, 1],
    [2000, 1000, 3],
  ])
    expect(() =>
      topazImageOutput(...(dims as [number, number, number])),
    ).toThrow();
  expect(topazImageInput("original-url", DEFAULT_TOPAZ_IMAGE)).toEqual({
    image_url: "original-url",
    model: "High Fidelity V2",
    upscale_factor: 2,
    output_format: "png",
    crop_to_fill: false,
    face_enhancement: false,
    face_enhancement_strength: 0.5,
    face_enhancement_creativity: 0,
  });
  for (const value of [
    undefined,
    [],
    { ...DEFAULT_TOPAZ_IMAGE, factor: "2" },
    { ...DEFAULT_TOPAZ_IMAGE, faceStrength: NaN },
    { ...DEFAULT_TOPAZ_IMAGE, model: "Wonder 3" },
  ])
    expect(() => topazImageSettings(value)).toThrow();
});
