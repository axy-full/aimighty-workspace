import { test, expect } from "@playwright/test";
import { DEFAULT_STAGES } from "../../lib/runs";

/**
 * The eight stages a production is written down as (SOW §9, surface 1a) —
 * and, more to the point, the EDGES between them.
 *
 * `createRecipe` had zero callers for as long as it existed, so nothing had
 * ever handed it a stage list and nothing had ever written the `inputs`
 * column. A recipe drew as a column of cards with no wires, which is what
 * made the whole node layer read as unbuilt.
 */
test("the eight stages are §9's eight, in order", () => {
  expect(DEFAULT_STAGES.map((s) => s.name)).toEqual([
    "Brief", "Scene", "Shot list", "Keyframes", "Motion", "Post", "Audio", "Assembly",
  ]);
  expect(DEFAULT_STAGES.map((s) => s.num)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("it is a graph, not a list", () => {
  const by = new Map(DEFAULT_STAGES.map((s) => [s.num, s]));
  /* The two facts the `inputs` column's own comment gives as the reason it
     exists: audio does not wait for the picture, and assembly waits for
     both. Neither is expressible as an order, which is the whole point. */
  expect(by.get(7)!.inputs, "Audio branches off the shot list").toEqual([3]);
  expect(by.get(8)!.inputs, "Assembly joins Post and Audio").toEqual([6, 7]);
  // ...so exactly one stage feeds two others, and exactly one is fed by two.
  const fedBy = new Map<number, number>();
  for (const s of DEFAULT_STAGES) for (const i of s.inputs ?? []) fedBy.set(i, (fedBy.get(i) ?? 0) + 1);
  expect([...fedBy.entries()].filter(([, n]) => n > 1).map(([n]) => n), "one branch").toEqual([3]);
  expect(DEFAULT_STAGES.filter((s) => (s.inputs ?? []).length > 1).map((s) => s.num), "one join").toEqual([8]);
});

test("every edge points backwards, so the recipe can be run", () => {
  /* A stage fed by a later one is a cycle, and a run would wait for ever.
     Also every input must name a stage that exists: `createRecipe` drops a
     num it cannot resolve rather than writing a dangling id, so a typo here
     would silently lose a wire instead of failing. */
  const nums = new Set(DEFAULT_STAGES.map((s) => s.num));
  for (const s of DEFAULT_STAGES) {
    for (const i of s.inputs ?? []) {
      expect(nums.has(i), `stage ${s.num} names a stage that exists`).toBe(true);
      expect(i, `stage ${s.num} is fed by an earlier stage`).toBeLessThan(s.num);
    }
  }
});

test("exactly one stage starts the recipe", () => {
  expect(DEFAULT_STAGES.filter((s) => (s.inputs ?? []).length === 0).map((s) => s.num)).toEqual([1]);
});

test("the kinds are the three the schema allows, and assembly assembles", () => {
  for (const s of DEFAULT_STAGES) expect(["write", "render", "assemble"]).toContain(s.kind);
  expect(DEFAULT_STAGES.filter((s) => s.kind === "assemble").map((s) => s.name)).toEqual(["Assembly"]);
  // No engine is named: §7A routes stages to engines by price band and that
  // routing is not built. Writing ids in now would invent the behaviour.
  for (const s of DEFAULT_STAGES) expect(s.engine ?? "").toBe("");
});
