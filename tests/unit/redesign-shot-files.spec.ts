import { test, expect } from "@playwright/test";
import { OWNER_SIZES, OWNER_WINDOWS, sizeProjects, sizeTag } from "../helpers/ownerSizes";
import { screenScale } from "../../lib/v12/board/screen-scale";

const shots = () => import("../../scripts/redesign/shot-files.mjs") as Promise<{
  SHOT_FILE: RegExp;
  compareTags: (a: string, b: string) => number;
  tagsOf: (files: string[]) => string[];
  tableFor: (a: { tag: string; info: { app: string; prototype: string; dpr?: number }; files: string[]; raw: (f: string) => string }) => string[];
}>;

/* The owner's seven captures (16 Oct 2026, 15:05 and 15:50): one list. */
test("the owner's seven captures are one shared list, 2560x1440 at both ratios and 3008x1692 at 2, named with @2x", () => {
  expect(OWNER_SIZES).toEqual([[1280, 800, 1], [1440, 900, 1], [1728, 1117, 1], [1920, 1080, 1], [2560, 1440, 1], [2560, 1440, 2], [3008, 1692, 2]]);
  expect(OWNER_SIZES.map(([w, h, d]) => sizeTag(w, h, d))).toEqual(["1280x800", "1440x900", "1728x1117", "1920x1080", "2560x1440", "2560x1440@2x", "3008x1692@2x"]);
  const projects = sizeProjects("redesign");
  expect(projects.map((p) => p.name)).toEqual(["redesign-1280x800", "redesign-1440x900", "redesign-1728x1117", "redesign-1920x1080", "redesign-2560x1440", "redesign-2560x1440@2x", "redesign-3008x1692@2x"]);
  expect(projects.map((p) => p.use.deviceScaleFactor)).toEqual([1, 1, 1, 1, 1, 2, 2]);
  expect(projects[6].use.viewport).toEqual({ width: 3008, height: 1692 });
  /* The window sizes, once each, for the walks that resize one page. */
  expect(OWNER_WINDOWS).toEqual([[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440], [3008, 1692]]);
});

test("the Pro Display's canvas scale is 1.88: its height, not its width, limits it", () => {
  expect(screenScale(3008, 1692)).toBe(1.88);
});

test("publish-shots picks up @2x PNGs, WebPs and notes, and nothing else", async () => {
  const { SHOT_FILE } = await shots();
  for (const ok of ["1440x900.json", "1440x900-app.png", "1440x900-beside.png", "2560x1440@2x.json", "2560x1440@2x-app.png", "2560x1440@2x-proto.png", "3008x1692@2x-beside.webp", "1440x900-app.webp"]) expect(SHOT_FILE.test(ok), ok).toBe(true);
  for (const no of ["notes.md", "1440x900-app.jpg", "1440x900@2-app.png", "x/1440x900-app.png", "1440x900-other.png", "2560x1440@2x-app.png.bak"]) expect(SHOT_FILE.test(no), no).toBe(false);
});

test("tags sort smallest first, a pixel ratio of 2 after the same size at 1", async () => {
  const { tagsOf, compareTags } = await shots();
  expect(tagsOf(["3008x1692@2x.json", "1440x900.json", "2560x1440@2x.json", "1920x1080.json", "1280x800.json", "1440x900-app.png", "1440x900@2x.json"])).toEqual(["1280x800", "1440x900", "1440x900@2x", "1920x1080", "2560x1440@2x", "3008x1692@2x"]);
  expect(compareTags("1728x1117", "1920x1080")).toBeLessThan(0);
});

test("the PR table shows downscaled WebPs that link to the full PNGs, and falls back to the PNG when there is no WebP", async () => {
  const { tableFor } = await shots();
  const raw = (f: string) => `https://raw.test/${encodeURIComponent(f)}`;
  const files = ["2560x1440@2x.json", "2560x1440@2x-app.png", "2560x1440@2x-proto.png", "2560x1440@2x-app.webp", "2560x1440@2x-proto.webp", "2560x1440@2x-beside.webp", "1440x900-app.png", "1440x900-proto.png"];
  const retina = tableFor({ tag: "2560x1440@2x", info: { app: "/suites", prototype: "?x=1", dpr: 2 }, files, raw }).join("\n");
  expect(retina).toContain(`[![build 2560x1440@2x](${raw("2560x1440@2x-app.webp")})](${raw("2560x1440@2x-app.png")})`);
  expect(retina).toContain(`[![prototype 2560x1440@2x](${raw("2560x1440@2x-proto.webp")})](${raw("2560x1440@2x-proto.png")})`);
  expect(retina).toContain("pixel ratio 2");
  const old = tableFor({ tag: "1440x900", info: { app: "/suites", prototype: "" }, files, raw }).join("\n");
  expect(old).toContain(`![build 1440x900](${raw("1440x900-app.png")})`);
  expect(old).not.toContain("pixel ratio");
});
