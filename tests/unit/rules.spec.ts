import { test, expect } from "@playwright/test";
import { mergeRules, rulesBlock, DEFAULT_RULES } from "../../lib/platformLayer";

/** The rule library per workspace: platform rules inherited and switchable off, the team's own after them, every rule with its source. */
test("a workspace inherits the platform's rules, switches one off, and adds its own", () => {
  const own = [{ id: "rule_a", text: "Our brand never shows logos in the first frame.", scope: "video" as const, apply: "prompt" as const, on: true }];
  const merged = mergeRules(DEFAULT_RULES, own, ["one-move", "not-a-rule"]);
  expect(merged.length).toBe(DEFAULT_RULES.length + 1);
  expect(merged.filter((r) => r.source === "platform").length).toBe(DEFAULT_RULES.length);
  expect(merged.find((r) => r.id === "one-move")).toMatchObject({ on: false, source: "platform" });
  expect(merged.find((r) => r.id === "positive")).toMatchObject({ on: true, source: "platform" });
  expect(merged[merged.length - 1]).toMatchObject({ id: "rule_a", source: "workspace", on: true });
  // A switched-off rule is listed but not applied; the workspace's own is appended in scope.
  expect(rulesBlock(merged, "video", "writer", "seedance-2")).not.toContain("One camera move");
  expect(rulesBlock(merged, "video", "prompt", "seedance-2")).toContain("Our brand never shows logos");
  expect(rulesBlock(merged, "image", "prompt", "nano-banana")).not.toContain("Our brand never shows logos");
  expect(mergeRules(DEFAULT_RULES, [], []).every((r) => r.on === DEFAULT_RULES.find((d) => d.id === r.id)!.on)).toBe(true);
});
