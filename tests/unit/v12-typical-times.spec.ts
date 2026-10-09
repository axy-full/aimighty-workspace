import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fmtTypical, parseTypicalTimes, quantile, rangeFromSamples, samplesByModel, typicalFor, typicalTable,
} from "../../lib/v12/typicalTimes";
import { MIN_TYPICAL_SAMPLES, TYPICAL_DEFAULTS_BY_KIND, TYPICAL_DEFAULTS_BY_MODEL, defaultTypical } from "../../lib/v12/typicalTimeDefaults";

/**
 * Typical render times (lib/v12/typicalTimes.ts): the middle half of recent
 * history per engine, the platform's first and the workspace's second, with
 * the prototype's placeholder ranges (one config file) below ten samples; and
 * the queue place a waiting take shows (lib/v12/queuePosition.ts). Pure.
 */
const S = 1_000;
const MIN = 60 * S;
const SEEDANCE = "dreamina-seedance-2-5-260628";
const KLING = "fal-ai/kling-video/v3/standard";
const NANO = "gemini-3.1-flash-image";
const range = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => from + i * step);

test.describe("measuring", () => {
  test("quantiles interpolate", () => {
    expect(quantile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(quantile([10, 20, 30, 40], 0.75)).toBe(32.5);
    expect(quantile([7], 0.5)).toBe(7);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  test("the middle half of the durations, to the second", () => {
    /* 100 s … 280 s in 20 s steps: p25 = 145 s, p75 = 235 s. */
    expect(rangeFromSamples(range(10, 100 * S, 20 * S))).toEqual({ lowMs: 145 * S, highMs: 235 * S });
    /* Order does not matter; junk is dropped before counting. */
    expect(rangeFromSamples([...range(10, 100 * S, 20 * S)].reverse().concat([NaN, -5, 0]))).toEqual({ lowMs: 145 * S, highMs: 235 * S });
  });

  test("fewer than ten samples is not history", () => {
    expect(MIN_TYPICAL_SAMPLES).toBe(10);
    expect(rangeFromSamples(range(9, 100 * S, 20 * S))).toBeNull();
    expect(rangeFromSamples(range(9, 100 * S, 20 * S).concat([0, NaN]))).toBeNull();
    expect(rangeFromSamples(range(10, 100 * S, 20 * S))).not.toBeNull();
  });

  test("the platform's history first, the workspace's own for an engine the platform has too little of", () => {
    const platform = samplesByModel([
      ...range(12, 60 * S, 5 * S).map((ms) => ({ model: SEEDANCE, ms })),
      ...range(3, 30 * S, S).map((ms) => ({ model: KLING, ms })),
    ]);
    const workspace = samplesByModel([
      ...range(12, 200 * S, 5 * S).map((ms) => ({ model: SEEDANCE, ms })),
      ...range(11, 70 * S, 2 * S).map((ms) => ({ model: KLING, ms })),
      ...range(4, 10 * S, S).map((ms) => ({ model: NANO, ms })),
    ]);
    const table = typicalTable(platform, workspace);
    expect(Object.keys(table).sort()).toEqual([KLING, SEEDANCE].sort());
    expect(table[SEEDANCE]).toEqual({ ...rangeFromSamples(platform.get(SEEDANCE)!)!, source: "history" });
    expect(table[KLING]).toEqual({ ...rangeFromSamples(workspace.get(KLING)!)!, source: "history" });
  });
});

test.describe("the fallback", () => {
  test("the prototype's placeholders live in one config", () => {
    expect(fmtTypical(TYPICAL_DEFAULTS_BY_MODEL[SEEDANCE])).toBe("2–4 min");
    expect(fmtTypical(TYPICAL_DEFAULTS_BY_MODEL[KLING])).toBe("1–2 min");
    expect(fmtTypical(TYPICAL_DEFAULTS_BY_MODEL[NANO])).toBe("20–40 s");
    expect(fmtTypical(TYPICAL_DEFAULTS_BY_KIND.audio)).toBe("about 15 s");
  });

  test("an engine with no history gets its config row, else its kind's", () => {
    expect(typicalFor(SEEDANCE, "video", { models: {} })).toEqual({ ...TYPICAL_DEFAULTS_BY_MODEL[SEEDANCE], source: "default" });
    expect(typicalFor("fal-ai/kling-video/v3/pro", "video", null)).toEqual({ ...TYPICAL_DEFAULTS_BY_KIND.video, source: "default" });
    expect(typicalFor("eleven_v3", "audio")).toEqual({ ...TYPICAL_DEFAULTS_BY_KIND.audio, source: "default" });
    expect(typicalFor(null, "model")).toEqual({ ...TYPICAL_DEFAULTS_BY_KIND.other, source: "default" });
    expect(defaultTypical("constructor", "video")).toEqual(TYPICAL_DEFAULTS_BY_KIND.video);
  });

  test("measured history wins over the config", () => {
    const reply = { models: { [SEEDANCE]: { lowMs: 90 * S, highMs: 150 * S, source: "history" as const } } };
    expect(typicalFor(SEEDANCE, "video", reply)).toEqual({ lowMs: 90 * S, highMs: 150 * S, source: "history" });
  });

  test("a reply is checked row by row", () => {
    const parsed = parseTypicalTimes({ models: {
      a: { lowMs: 10 * S, highMs: 20 * S, source: "history", workspaceId: "ws_x", samples: 99 },
      b: { lowMs: 30 * S, highMs: 10 * S }, c: { lowMs: "1", highMs: 2 }, d: null, e: { lowMs: 0, highMs: 5 },
    } });
    expect(parsed).toEqual({ models: { a: { lowMs: 10 * S, highMs: 20 * S, source: "history" } } });
    expect(parseTypicalTimes(null)).toEqual({ models: {} });
    expect(parseTypicalTimes({ models: "x" })).toEqual({ models: {} });
  });
});

test.describe("words", () => {
  test("ranges the way a person says them", () => {
    expect(fmtTypical({ lowMs: 2 * MIN, highMs: 4 * MIN })).toBe("2–4 min");
    expect(fmtTypical({ lowMs: 95 * S, highMs: 230 * S })).toBe("2–4 min");
    expect(fmtTypical({ lowMs: 20 * S, highMs: 40 * S })).toBe("20–40 s");
    expect(fmtTypical({ lowMs: 21 * S, highMs: 38 * S })).toBe("20–40 s");
    expect(fmtTypical({ lowMs: 15 * S, highMs: 15 * S })).toBe("about 15 s");
    expect(fmtTypical({ lowMs: 40 * S, highMs: 90 * S })).toBe("40 s–2 min");
    expect(fmtTypical({ lowMs: 3 * MIN, highMs: 3 * MIN })).toBe("about 3 min");
    expect(fmtTypical({ lowMs: 1 * S, highMs: 2 * S })).toBe("about 5 s");
  });
});

test.describe("queue place", () => {
  test.beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "particl-v12-queue-"));
    process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
  });

  test("the workspace's slot line: oldest first, only takes held for a slot", async () => {
    const { slotLinePositions } = await import("../../lib/v12/queuePosition");
    const positions = slotLinePositions([
      { id: "c", createdAt: 30, why: "slots" },
      { id: "a", createdAt: 10, why: "slots" },
      { id: "credits", createdAt: 5, why: "credits" },
      { id: "pool", createdAt: 1, why: "slots", pool: "shared" },
      { id: "b", createdAt: 20, why: "slots" },
    ], "shared");
    expect([...positions]).toEqual([["a", 1], ["b", 2], ["c", 3]]);
  });

  test("the shared pool's line: served fairly across workspaces, only a number comes back", async () => {
    const { poolPosition } = await import("../../lib/v12/queuePosition");
    const state = {
      running: { wsA: 2, wsB: 0 },
      waiters: [
        { id: "a1", workspaceId: "wsA", queuedAt: 1 },
        { id: "b1", workspaceId: "wsB", queuedAt: 2 },
        { id: "a2", workspaceId: "wsA", queuedAt: 3 },
        { id: "b2", workspaceId: "wsB", queuedAt: 4 },
      ],
    };
    /* wsB has nothing in flight, so its takes are served before wsA's, which already holds two slots. */
    expect(poolPosition(state, { id: "b1", workspaceId: "wsB", queuedAt: 2 })).toBe(1);
    expect(poolPosition(state, { id: "b2", workspaceId: "wsB", queuedAt: 4 })).toBe(2);
    expect(poolPosition(state, { id: "a1", workspaceId: "wsA", queuedAt: 1 })).toBe(3);
    expect(poolPosition(state, { id: "a2", workspaceId: "wsA", queuedAt: 3 })).toBe(4);
    expect(poolPosition({ running: {}, waiters: [] }, { id: "x", workspaceId: "wsA", queuedAt: 9 })).toBe(1);
  });
});
