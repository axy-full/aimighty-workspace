import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { MAX_TOTAL, MAX_VERSIONS, TOO_MUCH, keepScript, restoreScript, scriptVersionsSchema, versionsOf, withScript } from "../../lib/production/script-versions";

/* Earlier scripts (owner decision 11): the script a replacement takes away is kept as a bounded version; additive and optional, so old bodies parse. Neutral words only. */
const at = (n: number) => `2026-10-06T10:${String(n).padStart(2, "0")}:00.000Z`;
const project = (script: string): Project => ({ ...newProject("Script fixture"), script });

test("a project from before parses as it did; one with earlier scripts parses and keeps them; bad lists are refused", () => {
  const plain = newProject("Script fixture");
  const before = projectSchema.safeParse(plain);
  expect(before.success, JSON.stringify(before.error?.issues[0])).toBe(true);
  const kept = withScript({ ...plain, script: "A first draft." }, "A second.", "Replaced by a transcript", at(1));
  const parsed = projectSchema.safeParse(kept);
  expect(parsed.success, JSON.stringify(parsed.error?.issues[0])).toBe(true);
  expect(parsed.success && parsed.data.scriptVersions?.map((v) => v.text)).toEqual(["A first draft."]);
  if (parsed.success && before.success) expect({ ...parsed.data, script: undefined, scriptVersions: undefined }).toEqual({ ...before.data, script: undefined, scriptVersions: undefined });
  expect(projectSchema.safeParse({ ...plain, scriptVersions: undefined }).success).toBe(true);
  expect(projectSchema.safeParse({ ...plain, scriptVersions: [{ id: "x", text: "t", at: at(1), note: "n", extra: 1 }] }).success).toBe(false);
  expect(projectSchema.safeParse({ ...plain, scriptVersions: [{ id: "bad id", text: "t", at: at(1), note: "n" }] }).success).toBe(false);
  expect(scriptVersionsSchema.safeParse(Array.from({ length: MAX_VERSIONS + 1 }, (_, i) => ({ id: `v${i}`, text: "t", at: at(1), note: "n" }))).success).toBe(false);
});

test("a replacement keeps the old script first; a blank or repeated script is not kept; the list is bounded", () => {
  expect(withScript(project("   "), "New.", "n").scriptVersions).toBeUndefined();
  const one = withScript(project("Old."), "New.", "Replaced by a transcript", at(1));
  expect(one.script).toBe("New.");
  expect(versionsOf(one).map((v) => [v.text, v.note])).toEqual([["Old.", "Replaced by a transcript"]]);
  /* The same script kept twice in a row is one version. */
  expect(versionsOf(keepScript({ ...one, script: "Old." }, "again"))).toHaveLength(1);
  let p = project("v0");
  for (let i = 1; i <= MAX_VERSIONS + 5; i++) p = withScript(p, `v${i}`, "n", at(i));
  expect(versionsOf(p)).toHaveLength(MAX_VERSIONS);
  expect(versionsOf(p)[0].text).toBe(`v${MAX_VERSIONS + 4}`);
  expect(projectSchema.safeParse(p).success).toBe(true);
  /* The total is bounded too: the oldest go first, the newest always stays. */
  const huge = "x".repeat(900_000);
  let q = project(huge);
  for (let i = 0; i < 6; i++) q = withScript(q, huge + i, "n", at(i));
  expect(versionsOf(q).reduce((n, v) => n + v.text.length, 0)).toBeLessThanOrEqual(MAX_TOTAL);
  expect(versionsOf(q).length).toBeGreaterThanOrEqual(1);
  expect(projectSchema.safeParse(q).success, TOO_MUCH).toBe(true);
});

test("restore goes back to an earlier script, keeps the current one as a version too, and the restored one leaves the list", () => {
  let p = withScript(project("First."), "Second.", "Replaced by a transcript", at(1));
  const id = versionsOf(p)[0].id;
  const back = restoreScript(p, id, at(2))!;
  expect(back.script).toBe("First.");
  expect(versionsOf(back).map((v) => [v.text, v.note])).toEqual([["Second.", "Before restoring an earlier script"]]);
  /* And again: the restore can itself be undone. */
  const forward = restoreScript(back, versionsOf(back)[0].id, at(3))!;
  expect(forward.script).toBe("Second.");
  expect(versionsOf(forward).map((v) => v.text)).toEqual(["First."]);
  expect(restoreScript(p, "nope")).toBeNull();
  /* Restoring over a blank script keeps nothing extra. */
  p = { ...p, script: "" };
  expect(versionsOf(restoreScript(p, id, at(2))!)).toHaveLength(0);
});
