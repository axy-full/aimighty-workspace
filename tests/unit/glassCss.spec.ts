import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GLASS_SPEC §4: the glass layer keeps every `--gx-*` token and overrides only
 * background, border, box-shadow, border-radius and backdrop-filter — plus the
 * island geometry the spec names (the 10px gutters, the toolbar and stage
 * capsule heights, the 4px segment track) on those selectors alone.
 */
const css = readFileSync(join(process.cwd(), "app/glass.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const MATERIAL = /^(background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|box-shadow|border-radius|backdrop-filter|-webkit-backdrop-filter)$/;
const GEOMETRY = /^(height|margin|padding|padding-bottom|gap|top|right|bottom|left|position)$/;
/* The islands (§2) and the phone's floating bars and scroll regions (§3): the only selectors that may carry geometry. */
const ISLANDS = [".gx-header", ".gx-strip", ".gx-body", ".gx-panel--overlay", ".gx-panel--overlay.gx-library", ".gx-panel--overlay.gx-inspector", ".gx-seg", ".gx-header .gx-seg",
  ".gx-tabbar", ".gx-stage", ".gx-ws", ".gx-workspace", ".gx-tools", ".gx-assets", ".gx-insp-body", ".gx-sheet-list", ".cw-room", ".cw-page"];

function rules(source: string): { selector: string; declarations: string[] }[] {
  const out: { selector: string; declarations: string[] }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const selector = match[1].trim();
    if (selector.startsWith("@")) continue;
    const declarations = match[2].split(";").map((d) => d.trim()).filter(Boolean).map((d) => d.slice(0, d.indexOf(":")).trim());
    out.push({ selector, declarations });
  }
  return out;
}

test("the glass layer writes only the material, the island geometry and its own tokens", () => {
  const parsed = rules(css.replace(/@media[^{]*\{/g, "").replace(/@supports[^{]*\{/g, ""));
  expect(parsed.length).toBeGreaterThan(20);
  const offenders: string[] = [];
  for (const { selector, declarations } of parsed) {
    /* Every rule is scoped under `.gx` so the layer wins whatever order the sheets load in. */
    const selectors = selector.split(",").map((s) => s.trim().replace(/^\.gx\s+/, ""));
    const island = selectors.every((s) => ISLANDS.includes(s));
    for (const property of declarations) {
      if (property.startsWith("--gl-")) continue;
      if (MATERIAL.test(property)) continue;
      if (island && GEOMETRY.test(property)) continue;
      offenders.push(`${selector} › ${property}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("no --gx-* token is redefined and the tokens the spec names are present with a no-blur fallback", () => {
  expect(css.match(/--gx-[a-z0-9-]+\s*:/g) ?? []).toEqual([]);
  for (const token of ["--gl-wallpaper", "--gl-panel", "--gl-panel-2", "--gl-sheet", "--gl-overlay", "--gl-blur", "--gl-blur-sm", "--gl-scrim", "--gl-edge", "--gl-spec", "--gl-lift", "--gl-fill-1", "--gl-fill-2", "--gl-fill-3", "--gl-hover", "--gl-card-grad", "--gl-thumb", "--gl-dashed", "--gl-primary", "--gl-badge", "--gl-new"]) {
    expect(css, token).toContain(`${token}:`);
  }
  expect(css).toMatch(/@supports not \(backdrop-filter: blur\(1px\)\)/);
  /* Unprefixed only: the bundler's CSS pipeline drops the unprefixed declaration when a -webkit- twin carries the same var(). */
  expect(css).not.toContain("-webkit-backdrop-filter");
  expect(css).toContain("--gl-panel: rgba(28, 28, 34, .92)");
  expect(css).toContain("--gl-blur: none");
});
