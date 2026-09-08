import { test, expect } from "@playwright/test";
import { engineSuggestion, parentOf, lineageOf, editDepth, freshPrompt, typedWords, PLATEAU_AFTER } from "../../lib/uiRules";

/** The engine rule as a suggestion (brief 2.5): only for video, only for a generate, only when the engine in hand is not Kling. */
test("water, cloth and physics suggest Kling in one tap, and nothing else does", () => {
  const s = engineSuggestion({ prompt: "a red silk dress in the rain", kind: "video", family: "seedance-2", task: null });
  expect(s?.modelId).toBe("fal-ai/kling-video/v3/standard");
  expect(s?.label).toBe("Kling for silk — switch");
  expect(engineSuggestion({ prompt: "a red silk dress in the rain", kind: "video", family: "kling-3", task: null })).toBeNull();
  expect(engineSuggestion({ prompt: "a red silk dress in the rain", kind: "image", family: "nano-banana", task: null })).toBeNull();
  expect(engineSuggestion({ prompt: "a red silk dress in the rain", kind: "video", family: "seedance-2", task: "edit" })).toBeNull();
  expect(engineSuggestion({ prompt: "a courier crosses a quiet street", kind: "video", family: "seedance-2", task: null })).toBeNull();
});

/** The plateau (brief 2.5): a still edited from a still edited from a still is two passes in; the fresh prompt is the first look plus every edit since. */
test("a still's edit passes are counted through its references, and the fresh prompt writes the whole look out", () => {
  const rows = [
    { id: "a", kind: "image", prompt: "a man on a bench at dusk, 35mm\n\nNo lettering, captions, logos or text of any kind appears in the frame.", params: { rawPrompt: "a man on a bench at dusk, 35mm" } },
    { id: "b", kind: "image", prompt: "make him smaller", params: { references: [{ genId: "a", kind: "image" }] } },
    { id: "c", kind: "image", prompt: "fade the colours a notch", params: { references: [{ genId: "b", kind: "image" }] } },
    { id: "v", kind: "video", prompt: "x", params: { references: [{ genId: "c", kind: "image" }] } },
  ];
  expect(parentOf(rows[2], rows)?.id).toBe("b");
  expect(parentOf(rows[0], rows)).toBeNull();
  expect(lineageOf(rows[2], rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  expect(editDepth(rows[2], rows)).toBe(2);
  expect(editDepth(rows[1], rows)).toBe(1);
  expect(editDepth(rows[2], rows) >= PLATEAU_AFTER).toBe(true);
  expect(freshPrompt([...lineageOf(rows[2], rows), { id: "next", prompt: "warmer skin" }])).toBe("a man on a bench at dusk, 35mm. Then: make him smaller; fade the colours a notch; warmer skin.");
  expect(freshPrompt([rows[0]])).toBe("a man on a bench at dusk, 35mm");
  // The rule library's own lines are compiled in; they must not come back in the fresh prompt.
  expect(typedWords(rows[0])).toBe("a man on a bench at dusk, 35mm");
  // A take from before the raw prompt was recorded: the compiled tail follows a blank line.
  expect(typedWords({ id: "old", prompt: "a lantern over a river\n\nNo lettering, captions, logos or text of any kind appears in the frame." })).toBe("a lantern over a river");
  expect(freshPrompt(lineageOf(rows[2], rows))).not.toContain("No lettering");
  expect(freshPrompt([])).toBe("");
});
