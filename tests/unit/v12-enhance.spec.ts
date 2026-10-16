import { test, expect } from "@playwright/test";
import { ENHANCE_TIP_LINE, ENHANCE_TIP_NAME, enhanceOffered, takeEnhance, workspaceEnhance } from "../../lib/v12/enhance";
import { ENHANCE_DEFAULT_OPTIONS, settingProblem } from "../../lib/settingValues";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { DEFAULTS } from "../../lib/settings";
import { recreatePreset } from "../../lib/shell/recipe";

/** Make's Enhance button as data (lib/v12/enhance.ts): where it applies, whether the workspace offers it, what a take records. */

test("the tooltip says what the button does: the words go in the box, and Make sends the box as it is", () => {
  expect(`${ENHANCE_TIP_NAME} — ${ENHANCE_TIP_LINE}`).toBe("Enhance — Particl rewrites your prompt for the chosen engine (light, camera, detail) and puts it in the box, so you can edit it. Make sends the box exactly as it is.");
});

test("it applies to stills and clips; sound and a spoken line go as written", () => {
  expect(enhanceOffered("image")).toBe(true);
  expect(enhanceOffered("video")).toBe(true);
  expect(enhanceOffered("audio")).toBe(false);
});

test("the workspace offers Enhance unless an admin set it Off, and its setting is a closed choice", () => {
  expect(workspaceEnhance(undefined)).toBe(true);
  expect(workspaceEnhance("on")).toBe(true);
  expect(workspaceEnhance("off")).toBe(false);
  expect(DEFAULTS.enhanceDefault).toBe("on");
  expect(ENHANCE_DEFAULT_OPTIONS.map(([id]) => id)).toEqual(["on", "off"]);
  expect(settingProblem("enhanceDefault", "on")).toBeNull();
  expect(settingProblem("enhanceDefault", "off")).toBeNull();
  expect(settingProblem("enhanceDefault", "sometimes")).toMatch(/on or off/);
});

test("a take says Enhanced (with the words typed) or Raw, and an older take says nothing; rawPrompt is not read", () => {
  expect(takeEnhance({ enhanced: true, enhancedFrom: "a kite over the sea", rawPrompt: "something else" })).toEqual({ label: "Enhanced", original: "a kite over the sea" });
  expect(takeEnhance({ enhanced: true, rawPrompt: "x" })).toEqual({ label: "Enhanced", original: null });
  expect(takeEnhance({ enhanced: false, enhancedFrom: "x" })).toEqual({ label: "Raw" });
  expect(takeEnhance({ rawPrompt: "x" })).toBeNull();
  expect(takeEnhance(null)).toBeNull();
});

test("the request carries the label and nothing else changes with it", () => {
  const base = { prompt: "words", kind: "image" as const, model: { id: "m" }, mapping: { productionProjectId: "p" }, ratio: "16:9", resolution: "1K", duration: 5, references: [], maxCredits: 7 };
  const plain = generationRequestBody(base);
  expect("enhanced" in plain).toBe(false);
  expect(generationRequestBody({ ...base, enhanced: false })).toEqual({ ...plain, enhanced: false });
  expect(generationRequestBody({ ...base, enhanced: { from: "typed" } })).toEqual({ ...plain, enhanced: { from: "typed" } });
});

test("Reuse of an Enhanced take marks the loaded words as already enhanced, and any other take does not", () => {
  const take = (params: Record<string, unknown>) => ({ id: "gen_1", kind: "image", model: "m", prompt: "A paper kite drifts over a grey sea, low sun.", params: { ratio: "16:9", resolution: "1K", ...params } }) as never;
  expect(recreatePreset(take({ enhanced: true, enhancedFrom: "a kite over the sea" }), { name: "x" }).enhancedFrom).toBe("a kite over the sea");
  expect(recreatePreset(take({ enhanced: false, enhancedFrom: "a kite over the sea" }), { name: "x" }).enhancedFrom).toBeUndefined();
  expect(recreatePreset(take({}), { name: "x" }).enhancedFrom).toBeUndefined();
  expect(recreatePreset(take({ enhanced: true }), { name: "x" }).enhancedFrom).toBeUndefined();
});
