import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { MAX_TOTAL, MAX_VERSIONS, keepScript, restoreScript, scriptVersionsSchema, trimVersions, versionsOf, withScript, type ScriptVersion } from "../../lib/production/script-versions";

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
  expect(projectSchema.safeParse(q).success).toBe(true);
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

const entry = (i: number, size: number): ScriptVersion => ({ id: `v${i}`, text: "x".repeat(size), at: at(i), note: "n" });

test("the list never makes a save fail: one that is too long or too big is trimmed to the limits, the newest first kept, by the schema itself", () => {
  const plain = newProject("Script fixture");
  const many = Array.from({ length: MAX_VERSIONS + 4 }, (_, i) => entry(i, 10));
  const a = projectSchema.safeParse({ ...plain, scriptVersions: many });
  expect(a.success, JSON.stringify(a.error?.issues[0])).toBe(true);
  expect(a.success && a.data.scriptVersions?.map((v) => v.id)).toEqual(many.slice(0, MAX_VERSIONS).map((v) => v.id));
  const big = Array.from({ length: 6 }, (_, i) => entry(i, 900_000));
  const b = projectSchema.safeParse({ ...plain, scriptVersions: big });
  expect(b.success, JSON.stringify(b.error?.issues[0])).toBe(true);
  const kept = b.success ? b.data.scriptVersions! : [];
  expect(kept.map((v) => v.id)).toEqual(["v0", "v1", "v2"]);
  expect(kept.reduce((n, v) => n + v.text.length, 0)).toBeLessThanOrEqual(MAX_TOTAL);
  /* A list inside the limits comes back unchanged. */
  const ok = [entry(0, 100), entry(1, 100)];
  const c = scriptVersionsSchema.safeParse(ok);
  expect(c.success && c.data).toEqual(ok);
});

test("one huge script: the longest script a project can hold is kept as the current script, the list stays inside the limits, and a script longer than the whole limit keeps no versions", () => {
  const huge = "x".repeat(1_000_000);
  let p: Project = project(huge);
  for (let i = 0; i < 5; i++) p = withScript(p, huge.slice(0, 999_990) + i, "n", at(i));
  expect(p.script!.length).toBeGreaterThan(900_000);
  expect(versionsOf(p).reduce((n, v) => n + v.text.length, 0)).toBeLessThanOrEqual(MAX_TOTAL);
  expect(projectSchema.safeParse(p).success).toBe(true);
  /* Restoring a huge one also stays inside the limits. */
  const back = restoreScript(p, versionsOf(p)[0].id, at(9))!;
  expect(versionsOf(back).reduce((n, v) => n + v.text.length, 0)).toBeLessThanOrEqual(MAX_TOTAL);
  expect(projectSchema.safeParse(back).success).toBe(true);
  /* A script that alone is longer than the whole limit: no version at all. */
  expect(trimVersions([entry(0, MAX_TOTAL + 1)])).toEqual([]);
  expect(trimVersions([entry(0, 10), entry(1, MAX_TOTAL + 1)])).toEqual([entry(0, 10)]);
});

test("a body written with both fields (3D blocking and earlier scripts) is accepted and comes back unchanged", () => {
  const scene = { schemaVersion: 1, name: "Shot blocking", objects: [], lights: [], camera: { position: [0, -6, 1.6], target: [0, 0, 1.3], focalLength: 85 }, world: { color: "#23262c", strength: 0.6 }, timeline: { start: 1, end: 120, fps: 24 }, render: { width: 1280, height: 720, samples: 32, transparent: false } };
  const body = {
    ...project("Current script."),
    scriptVersions: [{ id: "script-aaaaaaaa", text: "An earlier script.", at: at(1), note: "Replaced by a transcript" }],
    production: { blocking: { "node-shot1": { scene, move: { kind: "push", meters: 1.2, seconds: 5 }, savedAt: at(2), frameAssetId: "blocking-up1" } } },
  };
  const parsed = projectSchema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues[0])).toBe(true);
  expect(parsed.success && parsed.data.scriptVersions).toEqual(body.scriptVersions);
  expect(parsed.success && parsed.data.production?.blocking).toEqual(body.production.blocking);
  /* Byte for byte: what a build with only the schema returns is what was written. */
  expect(parsed.success && JSON.stringify(parsed.data.production?.blocking)).toBe(JSON.stringify(body.production.blocking));
  expect(parsed.success && JSON.stringify(parsed.data.scriptVersions)).toBe(JSON.stringify(body.scriptVersions));
});
