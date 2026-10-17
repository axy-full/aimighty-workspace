import { test, expect } from "@playwright/test";
import { ENHANCE_HINT, ENHANCE_HINT_AFTER_MS, ENHANCE_MARK_MS, ENHANCE_PROGRESS_MS, ENHANCE_TIP_LINE, ENHANCE_TIP_NAME, ENHANCE_UNDO, ENHANCE_WORKING, changedWords, enhanceOffered, takeEnhance, workspaceEnhance } from "../../lib/v12/enhance";
import { ENHANCE_DEFAULT_OPTIONS, settingProblem } from "../../lib/settingValues";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { DEFAULTS } from "../../lib/settings";
import { recreatePreset } from "../../lib/shell/recipe";

/** Make's Enhance button as data (lib/v12/enhance.ts): where it applies, whether the workspace offers it, what a take records. */

test("the owner's tooltip, word for word (16 Oct 2026)", () => {
  expect(`${ENHANCE_TIP_NAME} — ${ENHANCE_TIP_LINE}`).toBe("Enhance — Particl rewrites your prompt for the chosen engine (light, camera, detail) and puts it in the box for you to edit. 1 credit per press, free if it fails. Make sends the box exactly as it is.");
});

test("the loader's words and timings: the hint at 2 s names no engine, the progress runs toward 8 s, the marks last a moment", () => {
  expect(ENHANCE_WORKING).toBe("Enhancing…");
  expect(ENHANCE_HINT).toBe("Rewriting for the chosen engine: light, camera, detail");
  expect(ENHANCE_HINT).not.toMatch(/seedance|kling|veo|banana|runway|nano/i);
  expect(ENHANCE_HINT_AFTER_MS).toBe(2_000);
  expect(ENHANCE_PROGRESS_MS).toBe(8_000);
  expect(ENHANCE_UNDO).toBe("Undo enhance");
  expect(ENHANCE_MARK_MS).toBeGreaterThan(1_000);
});

test("the changed words are the ones the typed words did not have; case and edge punctuation are not changes", () => {
  const pieces = changedWords("a kite over a grey sea", "A paper kite, drifting over a grey sea at dusk.");
  expect(pieces.map((p) => p.text).join("")).toBe("A paper kite, drifting over a grey sea at dusk.");
  expect(pieces.filter((p) => p.changed).map((p) => p.text.trim())).toEqual(["paper", "drifting", "at", "dusk."]);
  /* A word used twice in the rewrite but once in the original: the second is new. */
  expect(changedWords("kite", "kite kite").map((p) => p.changed)).toEqual([false, true]);
  expect(changedWords("", "A kite").every((p) => p.changed)).toBe(true);
  expect(changedWords("@Image1 a fox", "@Image1 a red fox").filter((p) => p.changed).map((p) => p.text.trim())).toEqual(["red"]);
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
