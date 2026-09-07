import { test, expect } from "@playwright/test";
import { mergeLayer, cleanSetup, cleanRules, cleanCaps, cleanModels, resolveModels, rulesBlock, writerRulesByScope, starterShotsWithSetup, textModelFor, DEFAULT_LAYER, DEFAULT_SETUP, DEFAULT_MODELS, DEFAULT_RULES, DEFAULT_TEXT_MODELS } from "../../lib/platformLayer";

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

test("the default engine per kind: only a real, visible engine of that kind survives, and a workspace's own choice wins", () => {
  expect(cleanModels({ video: "gemini-3-pro-image", image: "dreamina-seedance-2-5-260628" })).toEqual(DEFAULT_MODELS);
  expect(cleanModels({ video: "fal-ai/kling-video/v3/standard" })).toEqual({ ...DEFAULT_MODELS, video: "fal-ai/kling-video/v3/standard" });
  expect(cleanModels("junk")).toEqual(DEFAULT_MODELS);
  expect(mergeLayer({ models: { video: "fal-ai/kling-video/v3/standard" } }).models.image).toBe(DEFAULT_MODELS.image);
  const layer = { models: { ...DEFAULT_MODELS, video: "dreamina-seedance-2-0-260128" } };
  expect(resolveModels({}, layer)).toEqual(layer.models);
  expect(resolveModels({ defaultVideoModel: "", defaultImageModel: "" }, layer)).toEqual(layer.models);
  expect(resolveModels({ defaultVideoModel: "fal-ai/kling-video/v3/pro" }, layer).video).toBe("fal-ai/kling-video/v3/pro");
  expect(resolveModels({ defaultVideoModel: "gemini-3-pro-image" }, layer).video).toBe("dreamina-seedance-2-0-260128");
  expect(resolveModels({ defaultImageModel: "fal-ai/flux-lora" }, layer).image).toBe(DEFAULT_MODELS.image);
});

test("an engine-scoped rule is that engine's dialect: picked for its family only, and Atomik gets one line per scope", () => {
  const rules = cleanRules([
    { id: "k", text: "Kling only.", scope: "kling-3", apply: "writer" },
    { id: "v", text: "Every video.", scope: "video", apply: "writer" },
    { id: "z", text: "Typo scope.", scope: "nope", apply: "writer" },
  ])!;
  expect(rules.map((r) => r.scope)).toEqual(["kling-3", "video", "all"]);
  expect(rulesBlock(rules, "video", "writer", "kling-3")).toBe("Kling only. Every video. Typo scope.");
  expect(rulesBlock(rules, "video", "writer", "seedance-2")).toBe("Every video. Typo scope.");
  expect(rulesBlock(rules, "video", "writer")).toBe("Every video. Typo scope.");
  expect(rulesBlock(rules, "image", "writer", "kling-3")).toBe("Kling only. Typo scope.");
  const digest = writerRulesByScope(DEFAULT_RULES);
  expect(digest).toContain("Kling: Kling reads one plain paragraph");
  expect(digest).toContain("Nano Banana: Nano Banana wants the one scene");
  expect(digest).not.toContain("No lettering"); // a prompt rule is the render's job, not the writer's
  expect(rulesBlock(DEFAULT_RULES, "image", "prompt", "nano-banana")).toContain("No lettering");
});

test("text jobs route to known models: enhancement fast and cheap by default, ideas and shots stronger; an unknown id loses to the default", () => {
  expect(DEFAULT_TEXT_MODELS.enhance).toBe("anthropic/claude-sonnet-5");
  expect(DEFAULT_TEXT_MODELS.idea).toBe("anthropic/claude-opus-5");
  const m = cleanModels({ text: { enhance: "anthropic/claude-haiku-4.5", idea: "not-a-model", shot: 7 } });
  expect(m.text).toEqual({ enhance: "anthropic/claude-haiku-4.5", idea: DEFAULT_TEXT_MODELS.idea, shot: DEFAULT_TEXT_MODELS.shot });
  expect(cleanModels("junk").text).toEqual(DEFAULT_TEXT_MODELS);
  expect(textModelFor(m, "enhance")).toBe("anthropic/claude-haiku-4.5");
  expect(textModelFor(null, "shot")).toBe(DEFAULT_TEXT_MODELS.shot);
  expect(mergeLayer({ models: { video: "fal-ai/kling-video/v3/standard" } }).models.text).toEqual(DEFAULT_TEXT_MODELS);
  expect(resolveModels({}, { models: DEFAULT_MODELS }).text).toEqual(DEFAULT_TEXT_MODELS);
});
