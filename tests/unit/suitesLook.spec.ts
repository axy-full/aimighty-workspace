import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPT_COLORS, KIND_DOT, SUITE_LOOK, posterOf } from "../../components/graphite/icons";
import { HEADER_SEGMENT } from "../../lib/shell/ia";

/** The Suites shell's fixed colours (components/graphite/icons.tsx), and that its sheets stay flat. */
const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8");

test("every header tab has a suite colour and glyph", () => {
  for (const s of HEADER_SEGMENT) expect(SUITE_LOOK[s.id], s.id).toBeTruthy();
  expect(SUITE_LOOK.studio).toEqual({ color: "#0A84FF", glyph: "clap" });
  expect(SUITE_LOOK.business).toEqual({ color: "#FF9F0A", glyph: "tag" });
  expect(SUITE_LOOK.viral).toEqual({ color: "#FF453A", glyph: "bolt" });
  expect(SUITE_LOOK.atomik).toEqual({ color: "#30D158", glyph: "atom" });
  expect(SUITE_LOOK.crew).toEqual({ color: "#BF5AF2", glyph: "crew" });
  expect(DEPT_COLORS).toEqual(["#0A84FF", "#BF5AF2", "#FF9F0A", "#30D158", "#64D2FF", "#FF453A"]);
  expect(KIND_DOT).toEqual({ Images: "#0A84FF", Video: "#30D158", Audio: "#BF5AF2", Uploads: "#FF9F0A", Cast: "#FF453A", Elements: "#64D2FF" });
});

test("project posters: the sample palette for the sample names, a stable swatch otherwise", () => {
  expect(posterOf("Dune Studies")).toEqual({ from: "#7A5A34", to: "#1A120B" });
  expect(posterOf("Northline")).toEqual({ from: "#2E4A6A", to: "#0B1420" });
  expect(posterOf("")).toEqual({ from: "#3A3A40", to: "#141416" });
  expect(posterOf("Coastal light study")).toEqual(posterOf("Coastal light study"));
  expect(posterOf("Coastal light study")).not.toEqual(posterOf("Night market"));
});

test("the shell's sheets are flat: no glass or flair layer, no blur, and a gradient only on a project swatch and an avatar", () => {
  for (const layer of ["glass", "flair"]) expect(existsSync(join(process.cwd(), "app", `${layer}.css`)), layer).toBe(false);
  const sheets = { shell: read("components", "graphite", "shell.css"), phone: read("components", "graphite", "phone.css"), fault: read("components", "graphite", "fault.css") };
  for (const [name, css] of Object.entries(sheets)) {
    /* No blur behind or on anything, and none of the two removed layers' variables or keyframes (gl-, om-). */
    expect(css, name).not.toMatch(/backdrop|blur\(|--(gl|om)-|\bom-[a-z]/);
    /* The token set is app/graphite.css alone: no sheet here declares a --gx-* value. */
    expect(css.match(/^\s*--gx-[\w-]+\s*:/gm) ?? [], name).toEqual([]);
  }
  const gradients = sheets.shell.split("\n").filter((line) => /gradient\(/.test(line)).map((line) => line.trim().split(" ")[0]);
  expect(gradients).toEqual([".gx-project-tile", ".wsx-initials"]);
  expect(sheets.phone).not.toMatch(/gradient\(/);
  expect(sheets.fault).not.toMatch(/gradient\(/);
});
