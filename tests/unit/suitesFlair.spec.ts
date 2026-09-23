import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPT_COLORS, KIND_DOT, SUITE_LOOK, posterOf } from "../../components/graphite/icons";
import { HEADER_SEGMENT } from "../../lib/shell/ia";

/** FINAL_SPEC §6: the flair layer's fixed values, and that it stays additive. */
test("every header tab has a suite colour and glyph from the prototype", () => {
  for (const s of HEADER_SEGMENT) expect(SUITE_LOOK[s.id], s.id).toBeTruthy();
  expect(SUITE_LOOK.studio).toEqual({ color: "#0A84FF", glyph: "clap" });
  expect(SUITE_LOOK.business).toEqual({ color: "#FF9F0A", glyph: "tag" });
  expect(SUITE_LOOK.viral).toEqual({ color: "#FF453A", glyph: "bolt" });
  expect(SUITE_LOOK.atomik).toEqual({ color: "#30D158", glyph: "atom" });
  expect(SUITE_LOOK.crew).toEqual({ color: "#BF5AF2", glyph: "crew" });
  expect(DEPT_COLORS).toEqual(["#0A84FF", "#BF5AF2", "#FF9F0A", "#30D158", "#64D2FF", "#FF453A"]);
  expect(KIND_DOT).toEqual({ Images: "#0A84FF", Video: "#30D158", Audio: "#BF5AF2", Uploads: "#FF9F0A", Cast: "#FF453A", Elements: "#64D2FF" });
});

test("project posters: the sample palette for the sample names, a stable tint otherwise", () => {
  expect(posterOf("Dune Studies")).toEqual({ from: "#7A5A34", to: "#1A120B", glow: "#F0B23E" });
  expect(posterOf("Northline")).toEqual({ from: "#2E4A6A", to: "#0B1420", glow: "#0A84FF" });
  expect(posterOf("")).toEqual({ from: "#3A3A40", to: "#141416", glow: "#8E8E93" });
  expect(posterOf("Coastal light study")).toEqual(posterOf("Coastal light study"));
  expect(posterOf("Coastal light study")).not.toEqual(posterOf("Night market"));
});

test("the flair layer never redefines a base token and keeps the prototype's fixed values", () => {
  const flair = readFileSync(join(process.cwd(), "app", "flair.css"), "utf8");
  expect(flair.match(/^\s*--gx-[\w-]+\s*:/gm) ?? []).toEqual([]);
  for (const needle of [
    "rgba(10, 132, 255, .55)", "rgba(255, 159, 10, .45)", "rgba(255, 69, 58, .4)", "rgba(48, 209, 88, .4)", "rgba(191, 90, 242, .5)", "rgba(100, 210, 255, .4)",
    "linear-gradient(160deg, #4C9DFF, #0A84FF 55%, #0064D6)", "linear-gradient(180deg, #1B1B20, #141417)", "linear-gradient(180deg, #45454C, #2E2E34)",
    "0 0 16px rgba(10, 132, 255, .25)", "cubic-bezier(.2, .7, .2, 1)", "max-width: 1179px", "om-drift 12s", "om-drift2 14s", "om-breathe 3.2s",
  ]) expect(flair, needle).toContain(needle);
});
