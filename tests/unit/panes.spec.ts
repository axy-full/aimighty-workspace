import { test, expect } from "@playwright/test";
import { clampWidth, PANES } from "../../lib/panes";

const composer = PANES.composer;   // def 400, min 320, max 720

test("a width is held between the surface's own stops", () => {
  expect(clampWidth(composer, 10)).toBe(composer.min);
  expect(clampWidth(composer, 9999)).toBe(composer.max);
  expect(clampWidth(composer, 512)).toBe(512);
});

test("the window is a second ceiling: a rail never takes half the screen", () => {
  /* A split chosen on a 27" display should not swallow a laptop. Past half
     the viewport the rail is the work surface and the work surface is the
     rail, so that is the hard stop whatever the spec allows. */
  expect(clampWidth(composer, 700, 1100)).toBe(550);
  // Given room, the spec's own ceiling is the one that binds — not half of a
  // very wide screen, which would be 1280 here.
  expect(clampWidth(composer, 9999, 2560)).toBe(composer.max);
});

test("a viewport narrower than the minimum still yields the minimum", () => {
  // Below 1024 the divider is not rendered at all, but the number must stay
  // usable rather than collapsing to something a pane cannot be drawn at.
  expect(clampWidth(composer, 400, 600)).toBe(composer.min);
});

test("nonsense is the default, not NaN", () => {
  expect(clampWidth(composer, Number.NaN)).toBe(composer.def);
  expect(clampWidth(composer, Number.POSITIVE_INFINITY)).toBe(composer.def);
});

test("a width is a whole number of pixels", () => {
  expect(clampWidth(composer, 421.7)).toBe(422);
});

test("every surface's default sits inside its own stops", () => {
  for (const [name, spec] of Object.entries(PANES)) {
    expect(spec.min, `${name} min`).toBeLessThan(spec.def);
    expect(spec.def, `${name} def`).toBeLessThan(spec.max);
    expect(clampWidth(spec, spec.def), `${name} default survives its own clamp`).toBe(spec.def);
  }
});
