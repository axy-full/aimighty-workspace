import { test, expect } from "@playwright/test";
import type { Generation } from "../../lib/jobs";
import {
  EDIT_OPS, MAKE_MODES, REMIX_OPS, aspectOf, makeQuote, byDay, dayLabel, justify, modeFromParam, modeType, placeholderFor, resultTile, resultTiles, resultsCount,
} from "../../lib/v12/make";

/**
 * Make as a page in the new interface (lib/v12/make.ts): result tiles from the workspace's takes, justified rows that
 * keep each take's shape and fill the width, day dividers by date (not by row, the prototype's bug), the modes and
 * their words, and the Remix and Edit ops as far as Make offers them. Pure.
 */
const T0 = new Date(2026, 9, 9, 15, 0, 0).getTime();
const DAY = 86_400_000;
const gen = (fields: Partial<Generation> & { id: string }): Generation => ({
  projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
  approvedBy: null, approvedAt: null, model: "gemini-3.1-flash-image", prompt: "A lighthouse at dusk No lettering.", title: null,
  params: { ratio: "16:9", rawPrompt: "A lighthouse at dusk" }, status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${fields.id}`, totalTokens: null,
  costUsd: null, refineCostUsd: null, providerCreditQuote: null, creditsBilled: 2, refineModel: null, refineInTokens: null, refineOutTokens: null,
  error: null, failure: null, createdBy: "me", authorName: null, shotId: null, shotCode: null, shotScene: null, shotTitle: null, version: 1,
  durationMs: null, durationS: null, provider: "google", attempts: 1, task: "generate", sourceGenId: null, createdAt: T0, updatedAt: T0,
  ...fields,
} as Generation);

test.describe("result tiles", () => {
  test("a finished still: its media, its shape, its words as typed", () => {
    expect(resultTile(gen({ id: "a" }))).toMatchObject({ id: "a", url: "/api/media/a", kind: "image", type: "Image · 16:9", prompt: "A lighthouse at dusk" });
    expect(resultTile(gen({ id: "a" }))!.aspect).toBeCloseTo(16 / 9, 5);
  });
  test("a take in flight or failed has no media yet, and is still a result", () => {
    expect(resultTile(gen({ id: "r", status: "running", storedUrl: null }))).toMatchObject({ url: null });
    expect(resultTile(gen({ id: "f", status: "failed", storedUrl: null }))).toMatchObject({ url: null });
  });
  test("only Particl's own media route; 3D is not Make's", () => {
    expect(resultTile(gen({ id: "p", storedUrl: "https://vendor.example/x.png" }))?.url).toBe("/api/media/p");
    expect(resultTile(gen({ id: "m", kind: "model" }))).toBeNull();
  });
  test("shape: pixel size first, then the ratio, clamped; sound is wide", () => {
    expect(aspectOf(gen({ id: "w", params: { width: 1080, height: 1920 } }))).toBeCloseTo(0.5625, 4);
    expect(aspectOf(gen({ id: "r", params: { ratio: "1:1" } }))).toBe(1);
    expect(aspectOf(gen({ id: "x", params: { ratio: "21:1" } }))).toBe(3);
    expect(aspectOf(gen({ id: "n", params: {} }))).toBeCloseTo(16 / 9, 5);
    expect(aspectOf(gen({ id: "s", kind: "audio" }))).toBe(2);
  });
  test("newest first, each once; the count", () => {
    const tiles = resultTiles([gen({ id: "a", createdAt: T0 }), gen({ id: "b", createdAt: T0 + 5 }), gen({ id: "a", createdAt: T0 })]);
    expect(tiles.map((t) => t.id)).toEqual(["b", "a"]);
    expect(resultsCount(1)).toBe("1 result");
    expect(resultsCount(3)).toBe("3 results");
  });
});

test.describe("justified rows", () => {
  const items = [16 / 9, 9 / 16, 1, 16 / 9, 16 / 9, 1, 9 / 16];
  test("full rows fill the width exactly; every tile keeps its shape", () => {
    const rows = justify(items, (a) => a, 1200);
    for (const row of rows.slice(0, -1)) {
      const used = row.items.reduce((sum, p) => sum + p.width, 0) + 8 * (row.items.length - 1);
      expect(used).toBe(1200);
      for (const p of row.items.slice(0, -1)) expect(Math.abs(p.width - p.item * row.height)).toBeLessThanOrEqual(2);
      /* Each full row breaks where its height is closest to the target: the other break would have been further off. */
      expect(row.height).toBeGreaterThanOrEqual(120);
      expect(row.height).toBeLessThan(400);
    }
    expect(rows.flatMap((r) => r.items.map((p) => p.item))).toEqual(items);
  });
  test("a row breaks where its height comes closest to the target, not always after it", () => {
    /* 16:9, 9:16, 16:9, 1:1, 9:16, 16:9 in 1232 px: five tiles make a 211 px row, six a 160 px one; five is nearer 200. */
    const shapes = [16 / 9, 9 / 16, 16 / 9, 1, 9 / 16, 16 / 9];
    const rows = justify(shapes, (a) => a, 1232);
    expect(rows.map((r) => r.items.length)).toEqual([5, 1]);
    expect(rows[0].height).toBe(211);
    const used = rows[0].items.reduce((sum, p) => sum + p.width, 0) + 8 * 4;
    expect(used).toBe(1232);
    expect(rows[1].height).toBe(200);
  });
  test("a short last row keeps the target height instead of stretching", () => {
    const rows = justify([16 / 9], (a) => a, 1200);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBe(200);
    expect(rows[0].items[0].width).toBe(356);
  });
  test("no width, no rows", () => {
    expect(justify(items, (a) => a, 0)).toEqual([]);
    expect(justify([], (a: number) => a, 1200)).toEqual([]);
  });
});

test.describe("day dividers", () => {
  test("Today, Yesterday, then the date", () => {
    expect(dayLabel(T0 - 3_600_000, T0)).toBe("Today");
    expect(dayLabel(T0 - DAY, T0)).toBe("Yesterday");
    expect(dayLabel(T0 - 5 * DAY, T0)).toBe("4 Oct");
    expect(dayLabel(new Date(2025, 11, 30).getTime(), T0)).toBe("30 Dec 2025");
  });
  test("grouped by each take's own date, never by row", () => {
    const groups = byDay([{ createdAt: T0 }, { createdAt: T0 - 60_000 }, { createdAt: T0 - DAY }, { createdAt: T0 - 2 * DAY }], T0);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([["Today", 2], ["Yesterday", 1], ["7 Oct", 1]]);
  });
});

test.describe("modes and their words", () => {
  test("the six modes, and `mk=` read in any case", () => {
    expect(MAKE_MODES.map((m) => m.label)).toEqual(["Auto", "Image", "Video", "Audio", "Remix", "Edit"]);
    expect(modeFromParam("Remix")).toBe("remix");
    expect(modeFromParam("image")).toBe("image");
    expect(modeFromParam("Seed")).toBeNull();
    expect(modeType("video")).toBe("video");
    expect(modeType("auto")).toBeNull();
    expect(modeType("edit")).toBeNull();
  });
  test("placeholders, the video one naming its engine and length", () => {
    expect(placeholderFor("auto")).toBe("Describe anything · Atomik picks the model and settings");
    expect(placeholderFor("image")).toBe("Describe a still · @ to pull from the library");
    expect(placeholderFor("video", { engine: "Kling 3.0", seconds: 5 })).toBe("Describe a clip · 5 s on Kling 3.0");
    expect(placeholderFor("audio")).toBe("A line, a cue or a sound");
    expect(placeholderFor("edit")).toBe("What to change in the last result (optional)");
    expect(placeholderFor("remix")).toBe("Paste a video link, or drop a file here");
  });
  test("Remix and Edit: an op opens a tool that prices itself, or says why it is not here", () => {
    expect(REMIX_OPS.map((o) => o.label)).toEqual(["Cut into clips", "Transfer motion", "Swap an object", "Add an effect"]);
    expect(EDIT_OPS.map((o) => o.label)).toEqual(["Upscale", "Reframe / outpaint", "Remove background", "Relight", "Lip-sync", "Motion transfer"]);
    for (const op of [...REMIX_OPS, ...EDIT_OPS]) expect(Boolean(op.tool) !== Boolean(op.why), op.label).toBe(true);
    expect(REMIX_OPS.filter((o) => o.tool).map((o) => o.tool)).toEqual(["motion", "swap"]);
    expect(EDIT_OPS.filter((o) => o.tool).map((o) => o.tool)).toEqual(["upscale", "motion"]);
  });
});

test.describe("Reuse seed (NEEDS AKSHAY: the seed rides in the priced request)", () => {
  test("a clip's request carries the seed when one is set; a still's, or none, carries no seed", async () => {
    const { generationRequestBody } = await import("../../lib/workbench/generation-request");
    const request = { prompt: "a wave", kind: "video" as const, model: { id: "dreamina-seedance-2-5-260628" }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "1080p", duration: 5, references: [] };
    expect(generationRequestBody({ ...request, seed: 8841 })).toMatchObject({ seed: 8841, model: "dreamina-seedance-2-5-260628" });
    expect(generationRequestBody({ ...request, seed: 0 })).toMatchObject({ seed: 0 });
    for (const seed of [undefined, null, Number.NaN])
      expect(generationRequestBody({ ...request, seed }), String(seed)).not.toHaveProperty("seed");
    expect(generationRequestBody({ ...request, kind: "image", seed: 8841 })).not.toHaveProperty("seed");
    /* The quote and the send are built from the same input, so the fingerprint the press approves covers the seed. */
    const quoted = generationRequestBody({ ...request, seed: 8841 });
    const sent = generationRequestBody({ ...request, seed: 8841, maxCredits: 43, quoteFingerprint: "f" });
    expect(sent.seed).toBe(quoted.seed);
  });
});

test.describe("Make's prices in the workspace's unit", () => {
  test("credits as the server gave them; dollars at the credit's price for the workspace that pays in dollars", () => {
    const credits = { dollars: false, creditUsd: 0.1 };
    const dollars = { dollars: true, creditUsd: 0.1 };
    expect(makeQuote({ kind: "exact", credits: 8 }, credits)).toEqual({ state: "ready", price: { unit: "cr", value: { kind: "exact", credits: 8 } } });
    expect(makeQuote({ kind: "exact", credits: 8 }, dollars)).toMatchObject({ state: "ready", price: { unit: "usd", upTo: false } });
    expect((makeQuote({ kind: "exact", credits: 8 }, dollars) as { price: { usd: number } }).price.usd).toBeCloseTo(0.8, 6);
    expect(makeQuote({ kind: "up-to", credits: 43 }, dollars)).toMatchObject({ price: { unit: "usd", upTo: true } });
    expect(makeQuote({ kind: "free" }, dollars)).toEqual({ state: "ready", price: { unit: "cr", value: { kind: "free" } } });
    /* No figure, or no credit price to turn it into dollars: never a number. */
    expect(makeQuote(null, credits).state).toBe("error");
    expect(makeQuote({ kind: "exact", credits: 8 }, { dollars: true, creditUsd: null }).state).toBe("error");
  });
});
