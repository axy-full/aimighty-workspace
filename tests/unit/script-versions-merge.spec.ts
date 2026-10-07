import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { mergeDraft } from "../../lib/workbench/draft-merge";
import { MAX_TOTAL, MAX_VERSIONS, versionsOf, withScript, type ScriptVersion } from "../../lib/production/script-versions";

/*
 * Earlier scripts must never lock a project: two windows that each kept a script, with long lists, merge into a draft that still saves,
 * newest first, within 10 entries and 3,000,000 characters. Neutral words only.
 */
const at = (n: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, n)).toISOString();
const entry = (id: string, n: number, size: number): ScriptVersion => ({ id, text: "x".repeat(size) + id, at: at(n), note: "Replaced by a transcript" });
const total = (p: Project) => versionsOf(p).reduce((n, v) => n + v.text.length, 0);
const saves = (p: Project) => { const r = saveSchema.safeParse({ project: p, revision: 0 }); expect(r.success, JSON.stringify(r.error?.issues[0])).toBe(true); };

test("two long lists merge into one that saves: newest first, each once, inside the limits", () => {
  const base: Project = { ...newProject("Merge fixture"), script: "Base.", scriptVersions: [entry("s5", 5, 900_000), entry("s4", 4, 900_000), entry("s3", 3, 900_000)] };
  /* One window keeps its script (a new version at 20), the other keeps two (at 30 and 31): together far over 3,000,000 characters. */
  const mine = withScript({ ...base, script: "x".repeat(900_000) }, "Mine.", "Replaced by a transcript", at(20));
  let theirs: Project = withScript({ ...base, script: "y".repeat(900_000) }, "Theirs one.", "Replaced by a transcript", at(30));
  theirs = withScript(theirs, "Theirs two.", "Replaced by a transcript", at(31));
  /* Each side alone fits; their union does not. */
  expect(total(mine)).toBeLessThanOrEqual(MAX_TOTAL);
  expect(total(theirs)).toBeLessThanOrEqual(MAX_TOTAL);
  expect(new Set([...versionsOf(mine), ...versionsOf(theirs)].map((v) => v.id)).size && [...new Map([...versionsOf(mine), ...versionsOf(theirs)].map((v) => [v.id, v.text.length])).values()].reduce((n, x) => n + x, 0)).toBeGreaterThan(MAX_TOTAL);
  const merged = mergeDraft(base, mine, theirs);
  saves(merged);
  expect(total(merged)).toBeLessThanOrEqual(MAX_TOTAL);
  const ats = versionsOf(merged).map((v) => v.at);
  expect([...ats].sort().reverse()).toEqual(ats);
  expect(new Set(versionsOf(merged).map((v) => v.id)).size).toBe(versionsOf(merged).length);
  /* The newest kept script (theirs two) is there; the oldest are what went. */
  expect(versionsOf(merged)[0].at).toBe(at(31));
});

test("two lists of many short scripts merge into at most 10, newest first", () => {
  const some = (prefix: string, from: number, n: number) => Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`, from + i, 20));
  const base: Project = { ...newProject("Merge fixture"), script: "Base.", scriptVersions: some("b", 0, 6) };
  const mine: Project = { ...base, scriptVersions: [...some("m", 40, 6), ...base.scriptVersions!].slice(0, MAX_VERSIONS) };
  const theirs: Project = { ...base, scriptVersions: [...some("t", 60, 6), ...base.scriptVersions!].slice(0, MAX_VERSIONS) };
  const merged = mergeDraft(base, mine, theirs);
  saves(merged);
  expect(versionsOf(merged)).toHaveLength(MAX_VERSIONS);
  expect(versionsOf(merged).map((v) => v.at)).toEqual(versionsOf(merged).map((v) => v.at).sort().reverse());
  expect(versionsOf(merged)[0].id).toBe("t5");
});

test("a merge with no list, or a list already in order, is left exactly as it is", () => {
  const base: Project = { ...newProject("Merge fixture"), script: "Base." };
  const mine: Project = { ...base, brief: "Mine." };
  const theirs: Project = { ...base, direction: "Theirs." };
  const merged = mergeDraft(base, mine, theirs);
  expect(merged.scriptVersions).toBeUndefined();
  saves(merged);
});
