import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as resume from "../../lib/higgsfield-consumer/resume";

/**
 * The tray's words for a connected-account job (lib/higgsfield-consumer/resume.ts).
 * Its sign-in is gone and nothing reads an account job back any more, so only
 * the words the jobs tray still says are left: how long ago, and a name cut on
 * a word. No state is "rendering" or "confirming"; the tray says what Usage
 * says (tests/unit/jobsTray.spec.ts).
 */

test("only the tray's words are left: no status read, follow-up or reconnect words", () => {
  expect(Object.keys(resume).filter((name) => typeof (resume as Record<string, unknown>)[name] === "function").sort()).toEqual(["resumeAge", "shortName"]);
  const source = readFileSync("lib/higgsfield-consumer/resume.ts", "utf8");
  expect(source).not.toMatch(/Rendering|Confirming|Reconnect|Can't be checked|never sent twice|canProgress|resumeProblem/);
});

test("an age reads just now, minutes, hours, then days", () => {
  expect([0, 59_000, 4 * 60_000, 3 * 3_600_000, 5 * 86_400_000].map((ms) => resume.resumeAge(0, ms))).toEqual(["just now", "just now", "4 min", "3 h", "5 d"]);
  expect(resume.resumeAge(10_000, 0)).toBe("just now");
});

test("names are cut on a word with an ellipsis, never mid-word", () => {
  const prompt = "A slow dolly push across the wet harbour at blue hour, lanterns swaying over the moored boats";
  expect(resume.shortName(prompt, 60)).toBe("A slow dolly push across the wet harbour at blue hour…");
  expect(resume.shortName("  Short   and\nplain ", 60)).toBe("Short and plain");
  expect(resume.shortName("x".repeat(90), 60)).toBe(`${"x".repeat(59)}…`);
  expect(resume.shortName("", 60)).toBe("");
  expect(resume.shortName(prompt, 80).length).toBeLessThanOrEqual(80);
});
