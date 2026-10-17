import { test, expect } from "@playwright/test";
import { ENHANCE_HINT, ENHANCE_HINT_AFTER_MS, ENHANCE_MARK_MS, ENHANCE_LABEL, ENHANCE_PROGRESS_MS, ENHANCE_TIP_NAME, ENHANCE_UNDO, ENHANCE_WORKING, changedWords, enhanceInMode, enhanceOffered, enhanceTipLine, takeEnhance, workspaceEnhance } from "../../lib/v12/enhance";
import { ENHANCE_DEFAULT_OPTIONS, settingProblem } from "../../lib/settingValues";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { DEFAULTS } from "../../lib/settings";
import { recreatePreset } from "../../lib/shell/recipe";

/** Make's Enhance button as data (lib/v12/enhance.ts): where it applies, whether the workspace offers it, what a take records. */

test("the owner's hover label, word for word (16 Oct 2026, decision 2b): \"Enhance prompt\", then \"1 credit · free if it fails\" from the server's price", () => {
  const usd = (n: number) => `$${n.toFixed(3)}`;
  expect(ENHANCE_LABEL).toBe("Enhance");
  expect(ENHANCE_TIP_NAME).toBe("Enhance prompt");
  /* A customer workspace, the server quoting 1 credit. */
  expect(enhanceTipLine({ credits: 1, usd: null, dollars: false }, usd)).toBe("1 credit · free if it fails");
  /* The figure is the server's, never typed: another quote reads as it is. */
  expect(enhanceTipLine({ credits: 2, usd: null, dollars: false }, usd)).toBe("2 credits · free if it fails");
  /* The house pays in dollars: the text model's own dollars, as every house price reads; never credits turned into dollars. */
  expect(enhanceTipLine({ credits: 1, usd: 0.0123, dollars: true }, usd)).toBe("$0.012 · free if it fails");
  expect(enhanceTipLine({ credits: 1, usd: null, dollars: true }, usd)).toBe("Free if it fails");
  /* Before the quote is in: no figure at all. */
  expect(enhanceTipLine({ credits: null, usd: null, dollars: false }, usd)).toBe("Free if it fails");
  /* The writer is never named, and nothing in the label says which engine. */
  for (const line of [ENHANCE_TIP_NAME, enhanceTipLine({ credits: 1, usd: null, dollars: false }, usd)]) expect(line).not.toMatch(/opus|sonnet|claude|anthropic|gpt|openai|gemini|writer|model/i);
});

test("Enhance is a Director tool: offered in Image and Video, never in Auto (where Atomik picks), nor Audio, Remix or Edit", () => {
  expect(enhanceInMode("image")).toBe(true);
  expect(enhanceInMode("video")).toBe(true);
  for (const mode of ["auto", "audio", "remix", "edit", ""]) expect(enhanceInMode(mode), mode).toBe(false);
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
