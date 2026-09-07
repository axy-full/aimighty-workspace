import { test, expect } from "@playwright/test";
import { mergeLayer, cleanSetup, cleanRules, cleanCaps, rulesBlock, starterShotsWithSetup, DEFAULT_LAYER, DEFAULT_SETUP } from "../../lib/platformLayer";

/** The platform layer: defaults in code, overrides validated, nothing unreadable survives. */
test("a Setup keeps only real Studio options", () => {
  expect(cleanSetup({ shot: "cu", angle: "sideways", nonsense: "x", time: "dawn" })).toEqual({ shot: "cu", time: "dawn" });
  expect(mergeLayer({ setup: { shot: "nope" } }).setup).toEqual(DEFAULT_SETUP);
});

test("rules are cleaned, deduplicated and scoped; the block picks by kind and audience", () => {
  const rules = cleanRules([
    { id: "a", text: " No lettering. ", scope: "image", apply: "prompt" },
    { id: "a", text: "One move.", scope: "video" },
    { text: "", scope: "all" },
    { id: "off", text: "Off rule", scope: "all", on: false },
    "junk",
  ])!;
  expect(rules.map((r) => r.id)).toEqual(["a", "a-x", "off"]);
  expect(rulesBlock(rules, "image", "prompt")).toBe("No lettering.");
  expect(rulesBlock(rules, "video", "writer")).toBe("One move.");
  expect(rulesBlock(rules, "image", "writer")).toBe("");
  expect(rulesBlock(DEFAULT_LAYER.rules, "image", "prompt")).toContain("No lettering");
  expect(rulesBlock(DEFAULT_LAYER.rules, "video", "prompt")).toBe("");
});

test("caps are numbers or nothing", () => {
  expect(cleanCaps({ defaultCapCredits: "2000", signupCredits: 100, warnPct: 250 })).toMatchObject({ defaultCapCredits: 2000, signupCredits: 100, warnPct: 80, concurrency: 4, rendersPerHour: 60, storageGb: 50 });
  expect(cleanCaps({ defaultCapCredits: -5, signupCredits: null, warnPct: 70, concurrency: 8, rendersPerHour: 0, storageGb: 2.5 })).toMatchObject({ defaultCapCredits: null, signupCredits: null, warnPct: 70, concurrency: 8, rendersPerHour: 60, storageGb: 2.5 });
});

test("the starter's shots inherit the default Setup under their own", () => {
  const layer = mergeLayer({ setup: { ...DEFAULT_SETUP, look: "16mm" } });
  const shots = starterShotsWithSetup(layer);
  expect(shots[0].setup.look).toBe("16mm");
  expect(shots[0].setup.shot).toBe("evs");
  expect(shots[1].setup.move).toBe("push");
  const bad = mergeLayer({ starter: { name: "", shots: [] } });
  expect(bad.starter.name).toBe(DEFAULT_LAYER.starter.name);
});
