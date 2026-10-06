import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { BLOCKING_MAX_ENTRIES, BLOCKING_TOO_MANY, blockingSchema, type BlockingEntry } from "../../lib/production/blocking-schema";
import { BRANCH_MARKER, branchCopyProblem, branchWriteProblem } from "../helpers/blockingBranch";

/*
 * `production.blocking` (3D blocking per shot): the schema alone. Additive and optional, so a project saved before it parses exactly as
 * it did and nothing else about a project changes; a project that holds it is accepted on read and on write. Neutral names only.
 */
const scene = (): BlockingEntry["scene"] => ({
  schemaVersion: 1, name: "Shot blocking",
  objects: [{ id: "fig-1", name: "Figure 1", type: "cylinder", position: [0, 0, 0.85], rotation: [0, 0, 0], scale: [0.45, 0.45, 1.7], visible: true, locked: false, material: { color: "#c9ccd4", metalness: 0, roughness: 0.6 }, keyframes: [] }],
  lights: [], camera: { position: [0, -6, 1.6], target: [0, 0, 1.3], focalLength: 85 }, world: { color: "#23262c", strength: 0.6 },
  timeline: { start: 1, end: 120, fps: 24 }, render: { width: 1280, height: 720, samples: 32, transparent: false },
});
const entry = (): BlockingEntry => ({ scene: scene(), move: { kind: "push", meters: 1.2, seconds: 5 }, savedAt: "2026-10-06T10:20:00.000Z" });
const withBlocking = (blocking: unknown): Project => ({ ...newProject("Blocking fixture"), production: { blocking } as Project["production"] });

test("a project from before parses as it did; the same project with blocking parses, keeps it, and changes nothing else", () => {
  const plain = newProject("Blocking fixture");
  const before = projectSchema.safeParse(plain);
  expect(before.success, JSON.stringify(before.error?.issues[0])).toBe(true);
  expect(projectSchema.safeParse({ ...plain, production: {} }).success).toBe(true);
  expect(projectSchema.safeParse({ ...plain, production: { blocking: undefined } }).success).toBe(true);
  const withIt = { ...plain, production: { blocking: { "node-shot1": { ...entry(), frameAssetId: "f1" } } } };
  const parsed = projectSchema.safeParse(withIt);
  expect(parsed.success, JSON.stringify(parsed.error?.issues[0])).toBe(true);
  expect(parsed.success && parsed.data.production?.blocking?.["node-shot1"]?.move).toEqual(entry().move);
  if (parsed.success && before.success) expect({ ...parsed.data, production: undefined }).toEqual({ ...before.data, production: undefined });
});

test("a bad entry is refused with the field's own words: an unknown move, an extra key, a bad shot id, a prototype key", () => {
  const bad = (blocking: unknown) => projectSchema.safeParse(withBlocking(blocking)).success;
  expect(bad({ "node-shot1": { ...entry(), move: { kind: "spin", meters: 1, seconds: 5 } } })).toBe(false);
  expect(bad({ "node-shot1": { ...entry(), extra: 1 } })).toBe(false);
  expect(bad({ "../x": entry() })).toBe(false);
  expect(bad({ "": entry() })).toBe(false);
  for (const key of ["__proto__", "constructor", "prototype"]) expect(blockingSchema.safeParse(JSON.parse(`{"${key}": ${JSON.stringify(entry())}}`)).success, key).toBe(false);
  expect(blockingSchema.safeParse({ "node-shot1": { ...entry(), savedAt: "yesterday" } }).success).toBe(false);
});

test("a feature project's worth of shots still saves: the limit is the project's own shot maximum, and past it the refusal says so", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`node-shot${i}`, entry()]));
  expect(BLOCKING_MAX_ENTRIES).toBeGreaterThanOrEqual(1500);
  expect(blockingSchema.safeParse(many(201)).success).toBe(true);
  expect(blockingSchema.safeParse(many(BLOCKING_MAX_ENTRIES)).success).toBe(true);
  const over = blockingSchema.safeParse(many(BLOCKING_MAX_ENTRIES + 1));
  expect(over.success).toBe(false);
  expect(over.success ? "" : over.error.issues[0].message).toBe(BLOCKING_TOO_MANY);
});

test("the branch-copy guard: only a copy that carries the owner's marker, never a live database, and no write on a deployment", () => {
  const url = `libsql://cdn-${BRANCH_MARKER}-someorg.turso.io`;
  expect(branchCopyProblem(url, {})).toBeNull();
  expect(branchCopyProblem(`file:/private/tmp/${BRANCH_MARKER}.db`, {})).toBeNull();
  expect(branchCopyProblem(undefined, {})).toMatch(/Set BLOCKING_BRANCH_DB_URL/);
  expect(branchCopyProblem("libsql://some-database-someorg.turso.io", {})).toMatch(/not a branch copy/);
  expect(branchCopyProblem(url, { TURSO_DATABASE_URL: url })).toMatch(/live database/);
  expect(branchCopyProblem(url, { BLOCKING_PRODUCTION_NAMES: `x, ${url}` })).toMatch(/live database/);
  expect(branchCopyProblem(`libsql://prod-${BRANCH_MARKER}.turso.io`, {})).toMatch(/production/);
  expect(branchCopyProblem(`libsql://${BRANCH_MARKER}-production.turso.io`, {})).toMatch(/production/);
  expect(branchWriteProblem({})).toBeNull();
  expect(branchWriteProblem({ VERCEL_ENV: "production" })).toMatch(/VERCEL_ENV/);
  expect(branchWriteProblem({ VERCEL_ENV: "preview" })).toMatch(/VERCEL_ENV/);
  expect(branchWriteProblem({ NODE_ENV: "production" })).toMatch(/NODE_ENV/);
});
