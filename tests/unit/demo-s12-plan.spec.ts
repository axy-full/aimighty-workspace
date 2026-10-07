import { test, expect } from "@playwright/test";
import { chosenTake, samplePlan, stepMeta, type RecordedJob } from "../../lib/demo/plan";
import { castLine, clock, sampleCast, sampleCut } from "../../lib/demo/content";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";

/**
 * The sample's plan from the ledger's RECORDED prices (lib/demo/plan.ts) and its cast and cut from the owner's draft
 * (lib/demo/content.ts). Pure. Every figure below is a number the fixtures carry; the plan adds none of its own.
 */
const job = (over: Partial<RecordedJob> & { id: string }): RecordedJob => ({
  kind: "video", model: "seedance-2-5", shotId: null, version: 1, approved: false, seconds: 5, resolution: "1080p", createdAt: 1, credits: null, settled: true, ...over,
});
const shots = [{ id: "s2", position: 1 }, { id: "s1", position: 0 }, { id: "s3", position: 2 }];

test("one step per shot in production order, each at the credits the ledger recorded for its chosen take", () => {
  const plan = samplePlan(shots, [
    job({ id: "a", shotId: "s1", credits: 43, approved: true }),
    job({ id: "b", shotId: "s2", credits: 43, approved: true }),
    job({ id: "c", shotId: "s3", model: "kling-3-0-standard", credits: 7, approved: false }),
  ]);
  expect(plan.steps.map((s) => [s.title, s.credits, s.kind])).toEqual([["Shot 1", 43, "take"], ["Shot 2", 43, "take"], ["Shot 3", 7, "take"]]);
  expect(plan.steps.reduce((n, s) => n + s.credits, 0)).toBe(93);
  expect(plan.unpriced).toEqual([]);
  expect(plan.steps[0].meta).toMatch(/· 5 s · 1080p$/);
  /* No shot code or SH-style id anywhere in the card's words. */
  expect(JSON.stringify(plan.steps)).not.toMatch(/SH\d|s1|s2|s3/);
});

test("the chosen take is the latest approved version, else the newest; a fix that was not approved never replaces it", () => {
  const takes = [
    job({ id: "v1", version: 1, credits: 43, approved: true }),
    job({ id: "v2", version: 2, credits: 52, approved: false }),
  ];
  expect(chosenTake(takes)?.id).toBe("v1");
  expect(chosenTake(takes.map((t) => ({ ...t, approved: false })))?.id).toBe("v2");
  expect(chosenTake([])).toBeNull();
});

test("a price the ledger never recorded is left off, not guessed; the shot is named so it can be said", () => {
  const plan = samplePlan(shots, [
    job({ id: "a", shotId: "s1", credits: 43, approved: true }),
    job({ id: "b", shotId: "s2", credits: null, approved: true }),
  ]);
  expect(plan.steps.map((s) => s.title)).toEqual(["Shot 1"]);
  expect(plan.unpriced).toEqual(["Shot 2"]);
});

test("a shot with no take has no step, and a still or a track is never a step", () => {
  const plan = samplePlan(shots, [
    job({ id: "look", kind: "image", shotId: null, credits: 3 }),
    job({ id: "music", kind: "audio", shotId: null, credits: 1 }),
    job({ id: "a", shotId: "s1", credits: 43, approved: true }),
  ]);
  expect(plan.steps).toHaveLength(1);
  /* But everything the ledger recorded across the production counts, split into settled charges and open quotes. */
  expect(plan.recorded).toEqual({ settled: 47, quoted: 0 });
});

test("settled charges and still-reserved quotes are told apart, and the totals add what the rows say", () => {
  const plan = samplePlan(shots, [
    job({ id: "a", shotId: "s1", credits: 43, settled: true }),
    job({ id: "b", shotId: "s2", credits: 43, settled: false }),
  ]);
  expect(plan.recorded).toEqual({ settled: 43, quoted: 43 });
  expect(samplePlan(shots, []).recorded).toEqual({ settled: 0, quoted: 0 });
  expect(samplePlan([], []).steps).toEqual([]);
});

test("a step's line names the engine as the app does, with the take's own length and size, and drops what is not known", () => {
  expect(stepMeta({ model: "seedance-2-5", seconds: 5, resolution: "1080p" })).toMatch(/^Seedance 2\.5 · 5 s · 1080p$/);
  expect(stepMeta({ model: "seedance-2-5", seconds: null, resolution: null })).toBe("Seedance 2.5");
  expect(stepMeta({ model: "seedance-2-5", seconds: 4.25, resolution: "720p" })).toBe("Seedance 2.5 · 4.3 s · 720p");
});

/* ── cast and cut ────────────────────────────────────────────────────── */

const video = (id: string, over: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "video", category: "Shot", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: `gen-${id}`, ...over });

function film(): Project {
  const base = newProject("Neutral film");
  return {
    ...base, fps: 24,
    assets: [video("t1", { status: "Selected" }), video("t2"), video("t3"), { ...video("still"), kind: "image" }],
    shots: [
      { id: "c1", name: "Shot 1", assetId: "t1", duration: 120, sourceIn: 0, note: "" },
      { id: "c2", name: "Shot 2", assetId: "t2", duration: 120, sourceIn: 0, note: "" },
      { id: "c3", name: "Shot 3", assetId: "t3", duration: 120, sourceIn: 0, note: "" },
      { id: "c4", name: "Shot 4", assetId: "still", duration: 48, sourceIn: 0, note: "" },
      { id: "c5", name: "Shot 5", assetId: "", duration: 24, sourceIn: 0, note: "" },
    ],
    production: { cast: { entries: [
      { id: "k1", name: "Lead", kind: "character", description: "ivory suit,\n  short dark bob", prompt: "", takes: [] },
      { id: "k2", name: "Sphere", kind: "element", description: "", prompt: "", takes: [] },
      { id: "k3", name: "", kind: "element", description: "", prompt: "", takes: [] },
    ] } },
  };
}

test("the cast reads in the owner's wording, name then description on one line, and nothing is added", () => {
  expect(castLine("Lead", "ivory suit, short dark bob")).toBe("Lead · ivory suit, short dark bob");
  expect(castLine(" Lead ", "")).toBe("Lead");
  const cast = sampleCast(film());
  expect(cast.map((c) => c.line)).toEqual(["Lead · ivory suit, short dark bob", "Sphere"]);
  expect(cast[0]).toMatchObject({ id: "k1", name: "Lead", kind: "character" });
  expect(sampleCast(newProject("No cast"))).toEqual([]);
});

test("the cut comes from project.shots: slots in order, their takes, approved ones counted, a slot with no video waits", () => {
  const cut = sampleCut(film(), new Set(["gen-t2"]));
  expect(cut.shots.map((s) => [s.index, s.seconds, s.assetId, s.approved])).toEqual([
    [1, 5, "t1", true], [2, 5, "t2", true], [3, 5, "t3", false], [4, 2, null, false], [5, 1, null, false],
  ]);
  expect(cut.approved).toBe(2);
  expect(cut.approvedSeconds).toBe(10);
  expect(cut.seconds).toBe(18);
  expect(cut.waiting).toBe(3);
  expect(clock(cut.approvedSeconds)).toBe("0:10");
  expect(clock(75)).toBe("1:15");
  /* With no approved set, only a Selected take counts. */
  expect(sampleCut(film()).approved).toBe(1);
});
