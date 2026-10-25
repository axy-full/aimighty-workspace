import { test, expect } from "@playwright/test";
import { compositeMask, engineMask, eraserMask, fillMask, removalMask, wordsMask, type EngineMask, type SelectionMask } from "../../lib/maskPolarity";

/* A 4×4 selection: the middle 2×2 selected, two feathered pixels at (3, 1) and (1, 3), the rest unselected. */
const SELECTED = [5, 6, 9, 10], FEATHERED: Record<number, number> = { 7: 0.5, 13: 0.25 };
const selection = (): SelectionMask => {
  const coverage = new Float32Array(16);
  for (const i of SELECTED) coverage[i] = 1;
  for (const [i, c] of Object.entries(FEATHERED)) coverage[Number(i)] = c;
  return { width: 4, height: 4, coverage };
};

/* How much each kind of engine edits a pixel of the mask it is sent, written here from the engines' own rules, not
   from the module, so a flipped polarity fails. */
const EDITS = {
  black: (m: EngineMask, i: number) => 1 - m.rgba[i * 4] / 255,
  white: (m: EngineMask, i: number) => m.rgba[i * 4] / 255,
  transparent: (m: EngineMask, i: number) => 1 - m.rgba[i * 4 + 3] / 255,
};

/* A picture of 10s, edited to 250 by an engine that reads its mask by `rule`. */
const changed = (m: EngineMask, rule: keyof typeof EDITS) => {
  const before = new Array(16).fill(10);
  const after = before.map((v, i) => Math.round(v + (250 - v) * EDITS[rule](m, i)));
  return after.map((v, i) => v - before[i]);
};

const expectOnlyTheSelection = (m: EngineMask, rule: keyof typeof EDITS) => {
  expect(m.width).toBe(4);
  expect(m.height).toBe(4);
  const delta = changed(m, rule);
  for (let i = 0; i < 16; i++) {
    if (SELECTED.includes(i)) expect(delta[i], `pixel ${i} is selected`).toBe(240);
    /* A feathered pixel is edited by its coverage, within a byte's rounding, so a ramp running the wrong way fails at 0.25. */
    else if (i in FEATHERED) expect(Math.abs(delta[i] - 240 * FEATHERED[i]), `pixel ${i} blends by its coverage`).toBeLessThanOrEqual(1);
    else expect(delta[i], `pixel ${i} is outside the selection`).toBe(0);
  }
};

test("the words engine is sent the selection black: it edits the selection and nothing else", () => {
  const m = wordsMask(selection());
  expectOnlyTheSelection(m, "black");
  for (let i = 0; i < 16; i++) expect(m.rgba[i * 4 + 3]).toBe(255);
});

test("the fill engine is sent the selection white: it edits the selection and nothing else", () => {
  expectOnlyTheSelection(fillMask(selection()), "white");
});

test("the eraser engine is sent the selection white: it edits the selection and nothing else", () => {
  expectOnlyTheSelection(eraserMask(selection()), "white");
});

test("the second fill engine, used for removal, is sent the selection white: it edits the selection and nothing else", () => {
  expectOnlyTheSelection(removalMask(selection()), "white");
});

test("the product/composite engine is sent the selection transparent: it edits the selection and nothing else", () => {
  const m = compositeMask(selection());
  expectOnlyTheSelection(m, "transparent");
  for (const i of SELECTED) expect(m.rgba[i * 4 + 3]).toBe(0);
  expect(m.rgba[0 * 4 + 3]).toBe(255);
});

test("a mask that is not one whole, valid selection is refused", () => {
  const bad: SelectionMask[] = [
    { width: 4, height: 4, coverage: new Float32Array(15) },
    { width: 0, height: 4, coverage: new Float32Array(0) },
    { width: 2.5, height: 2, coverage: new Float32Array(5) },
    { width: 2, height: 2, coverage: Float32Array.from([0, 1, 1.5, 0]) },
    { width: 2, height: 2, coverage: Float32Array.from([0, -0.1, 1, 0]) },
    { width: 2, height: 2, coverage: Float32Array.from([0, NaN, 1, 0]) },
    { width: 2, height: 2, coverage: [0, 1, 1, 0] as unknown as Float32Array },
  ];
  for (const mask of bad) expect(() => engineMask(mask, "white"), JSON.stringify({ ...mask, coverage: Array.from(mask.coverage) })).toThrow();
});
