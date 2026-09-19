import { test, expect } from "@playwright/test";
import { isTypingTarget, legend, resolveKey, SHELL_BINDINGS, type KeyBinding } from "../../lib/workspace/keys";
import { INITIAL_STATE } from "../../lib/workspace/navigation";

const studio = { state: { ...INITIAL_STATE, view: "studio" as const }, pageCount: 8 };

test("single-key handlers bail while typing", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) expect(isTypingTarget({ tagName })).toBe(true);
  expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
  expect(resolveKey(SHELL_BINDINGS, { key: "i", target: { tagName: "INPUT" } }, studio)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "3", target: { tagName: "TEXTAREA" } }, studio)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "i", target: { tagName: "DIV", isContentEditable: true } }, studio)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "i", target: { tagName: "BODY" } }, studio)?.id).toBe("inspector");
});

test("1–9 go to the nth page, within the suite's page count, studio only", () => {
  const hit = resolveKey(SHELL_BINDINGS, { key: "5" }, studio);
  expect(hit?.action({ key: "5" }, studio)).toEqual({ type: "page", index: 4 });
  expect(resolveKey(SHELL_BINDINGS, { key: "9" }, studio)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "0" }, studio)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "1" }, { ...studio, state: INITIAL_STATE })).toBeNull();
  /* Modified keys belong to the browser (⌘1 switches tabs). */
  expect(resolveKey(SHELL_BINDINGS, { key: "1", metaKey: true }, studio)).toBeNull();
  expect(resolveKey(SHELL_BINDINGS, { key: "I", ctrlKey: true }, studio)).toBeNull();
});

test("later bindings can opt in to inputs and modifiers; the legend lists what works", () => {
  const palette: KeyBinding<string> = {
    id: "palette", inInputs: true, modified: true,
    match: (e) => (e.metaKey || e.ctrlKey) === true && e.key.toLowerCase() === "k",
    action: () => "palette",
    hint: () => ({ key: "⌘K", label: "commands" }),
  };
  expect(resolveKey([palette], { key: "k", metaKey: true, target: { tagName: "INPUT" } }, studio)?.id).toBe("palette");
  expect(legend([...SHELL_BINDINGS, palette] as KeyBinding<unknown>[], studio)).toEqual([
    { key: "1–8", label: "stage" }, { key: "I", label: "inspector" }, { key: "⌘K", label: "commands" },
  ]);
  expect(legend(SHELL_BINDINGS, { ...studio, state: INITIAL_STATE })).toEqual([]);
});
