import { test, expect } from "@playwright/test";
import {
  DEFAULT_ENHANCER, ENHANCER_MODELS, ENHANCER_PROVIDERS, citationsIn, enhancerMessages, enhancerSystem, isEnhancerProvider, isRawPrompt,
  parseEnhanced, pickEnhancerModel, stripRaw,
} from "../../lib/shell/enhancer";
import { isAtomikModel } from "../../lib/atomikModelPolicy";
import { DEFAULTS } from "../../lib/settings";

test("Higgsfield is the default enhancer, in the request and in the workspace setting", () => {
  expect(DEFAULT_ENHANCER).toBe("higgsfield");
  expect(DEFAULTS.promptEnhancer).toBe("higgsfield");
  expect([...ENHANCER_PROVIDERS]).toEqual(["higgsfield", "claude", "openai"]);
  expect(isEnhancerProvider("claude")).toBe(true);
  expect(isEnhancerProvider("gemini")).toBe(false);
});

test("raw: is never enhanced, whatever its case or leading space", () => {
  for (const p of ["raw: a fox", "  RAW:a fox", "Raw:  a fox"]) expect(isRawPrompt(p)).toBe(true);
  for (const p of ["a raw: fox", "rawhide", "draw: a fox"]) expect(isRawPrompt(p)).toBe(false);
  expect(stripRaw("  RAW:  a fox")).toBe("a fox");
});

test("the instruction follows the published order and adapts to what anchors the picture", () => {
  const video = enhancerSystem({ mode: "video" });
  expect(video).toContain("subject + setting + style; camera");
  expect(video).toContain("motion verbs");
  expect(video).toContain("under 80 words");
  expect(video).toContain("Phrase negatives positively");
  expect(video).toContain("@Image1");
  expect(video).not.toContain("describe the MOTION");
  expect(enhancerSystem({ mode: "video", anchored: true })).toContain("describe the MOTION");
  expect(enhancerSystem({ mode: "image", editing: true })).toContain("describe WHAT CHANGES");
  expect(enhancerSystem({ mode: "image" })).not.toContain("motion verbs");
  expect(enhancerSystem({ mode: "video", engine: "Seedance 2.5" })).toContain("It will be sent to Seedance 2.5.");
  /* The person's words are the whole user message: nothing of ours is mixed in. */
  expect(enhancerMessages("  a fox at dawn  ", { mode: "image" })[1]).toEqual({ role: "user", content: "a fox at dawn" });
});

test("an answer is read from JSON, a fence or plain text", () => {
  expect(parseEnhanced('{"prompt":"A red fox curled in snow, golden hour."}', "fox")).toEqual({ ok: true, prompt: "A red fox curled in snow, golden hour." });
  expect(parseEnhanced('```json\n{"prompt": "Tack sharp fox."}\n```', "fox")).toEqual({ ok: true, prompt: "Tack sharp fox." });
  expect(parseEnhanced('"A fox,\n  tack sharp."', "fox")).toEqual({ ok: true, prompt: "A fox, tack sharp." });
  expect(parseEnhanced('{"logline":"x"}', "fox").ok).toBe(false);
  expect(parseEnhanced("   ", "fox").ok).toBe(false);
});

test("a rewrite that drops a citation is refused, not repaired", () => {
  const original = "@Image1 walks toward @lead-actor, then @Image1 turns";
  expect(citationsIn(original)).toEqual(["@Image1", "@lead-actor"]);
  expect(parseEnhanced('{"prompt":"@Image1 strides toward @lead-actor, slow push in, rim light."}', original).ok).toBe(true);
  const dropped = parseEnhanced('{"prompt":"A figure strides toward @lead-actor."}', original);
  expect(dropped).toEqual({ ok: false, reason: "The rewrite dropped @Image1. Your prompt is unchanged; try once more." });
});

test("each provider writes on its own family, lightest first; Higgsfield rides the routed writer", () => {
  for (const ids of Object.values(ENHANCER_MODELS)) for (const id of ids) expect(isAtomikModel(id), id).toBe(true);
  expect(ENHANCER_MODELS.claude.every((id) => id.startsWith("anthropic/"))).toBe(true);
  expect(ENHANCER_MODELS.openai.every((id) => id.startsWith("openai/"))).toBe(true);
  const served = ["anthropic/claude-sonnet-5", "openai/gpt-5-mini", "google/gemini-3.5-flash"];
  expect(pickEnhancerModel("claude", served)).toBe("anthropic/claude-sonnet-5");
  expect(pickEnhancerModel("openai", served)).toBe("openai/gpt-5-mini");
  expect(pickEnhancerModel("higgsfield", served, "anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  expect(pickEnhancerModel("higgsfield", served, "not/served")).toBe("google/gemini-3.5-flash");
  /* A chosen provider never silently becomes another one. */
  expect(pickEnhancerModel("openai", ["anthropic/claude-sonnet-5"], "anthropic/claude-sonnet-5")).toBeNull();
});
