import { test, expect } from "@playwright/test";
import { ENHANCE_ASWRITTEN, ENHANCE_TIP_LINE, ENHANCE_TIP_NAME, enhanceKey, enhanceOffered, readEnhance, takeEnhance, workspaceEnhance, writeEnhance } from "../../lib/v12/enhance";
import { ENHANCE_DEFAULT_OPTIONS, settingProblem } from "../../lib/settingValues";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { DEFAULTS } from "../../lib/settings";

/** Make's Enhance toggle as data (lib/v12/enhance.ts): where it applies, what a person last chose, what a take records. */
const store = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};

test("the owner's tooltip, word for word", () => {
  expect(`${ENHANCE_TIP_NAME} — ${ENHANCE_TIP_LINE}`).toBe("Enhance — On: Particl rewrites your prompt for the chosen engine (light, camera, detail) before it runs. Its small cost is included in the price shown. Off: your prompt is sent exactly as you typed it.");
});

test("it applies to what is made from words, never to a spoken line", () => {
  expect(enhanceOffered("image", null)).toBe(true);
  expect(enhanceOffered("video", null)).toBe(true);
  expect(enhanceOffered("audio", "sound")).toBe(true);
  expect(enhanceOffered("audio", "music")).toBe(true);
  expect(enhanceOffered("audio", "speech")).toBe(false);
  expect(enhanceOffered("audio", null)).toBe(false);
});

test("a person's own choice is kept per person, and overrides the workspace's default; nothing is chosen for them", () => {
  const s = store();
  expect(readEnhance(s, "u1")).toBe(true);
  expect(readEnhance(s, "u1", false)).toBe(false);
  writeEnhance(s, "u1", false);
  expect(s.data[enhanceKey("u1")]).toBe("0");
  expect(readEnhance(s, "u1", true)).toBe(false);
  expect(readEnhance(s, "u2", true)).toBe(true);
  writeEnhance(s, "u1", true);
  expect(readEnhance(s, "u1", false)).toBe(true);
  expect(readEnhance(null, "u1", false)).toBe(false);
});

test("the workspace's default is On unless an admin set it Off, and its setting is a closed choice", () => {
  expect(workspaceEnhance(undefined)).toBe(true);
  expect(workspaceEnhance("on")).toBe(true);
  expect(workspaceEnhance("off")).toBe(false);
  expect(DEFAULTS.enhanceDefault).toBe("on");
  expect(ENHANCE_DEFAULT_OPTIONS.map(([id]) => id)).toEqual(["on", "off"]);
  expect(settingProblem("enhanceDefault", "on")).toBeNull();
  expect(settingProblem("enhanceDefault", "off")).toBeNull();
  expect(settingProblem("enhanceDefault", "sometimes")).toMatch(/on or off/);
});

test("a take says Enhanced (with its original words) or Raw, and an older take says nothing", () => {
  expect(takeEnhance({ enhanced: true, rawPrompt: "a kite over the sea" })).toEqual({ label: "Enhanced", original: "a kite over the sea" });
  expect(takeEnhance({ enhanced: true })).toEqual({ label: "Enhanced", original: null });
  expect(takeEnhance({ enhanced: false, rawPrompt: "x" })).toEqual({ label: "Raw" });
  expect(takeEnhance({ rawPrompt: "x" })).toBeNull();
  expect(takeEnhance(null)).toBeNull();
});

test("the request carries the label and nothing else changes with it", () => {
  const base = { prompt: "words", kind: "image" as const, model: { id: "m" }, mapping: { productionProjectId: "p" }, ratio: "16:9", resolution: "1K", duration: 5, references: [], maxCredits: 7 };
  const plain = generationRequestBody(base);
  expect("enhanced" in plain).toBe(false);
  expect(generationRequestBody({ ...base, enhanced: false })).toEqual({ ...plain, enhanced: false });
  expect(generationRequestBody({ ...base, enhanced: { from: "typed" } })).toEqual({ ...plain, enhanced: { from: "typed" } });
  expect(ENHANCE_ASWRITTEN).toMatch(/as written/);
});
