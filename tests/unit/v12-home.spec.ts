import { test, expect } from "@playwright/test";
import type { Generation } from "../../lib/jobs";
import {
  BOARD_FILTERS, FIRST_BOARDS, WALL_TILES, boardKindIn, filterBoards, pickedBrief, startQuote, waitingShown, wallLayout, wallRow, wallTile, wallTiles,
} from "../../lib/v12/home";
import { GOAL_MAX, startFigure } from "../../components/graphite/home/home-model";

/**
 * Home in the new interface (lib/v12/home.ts): the wall is the workspace's own stored stills and clips on the
 * prototype's mosaic, a picked tile's words, the boards' kind filters and the Waiting strip's count. Pure.
 */
const T0 = 1_760_000_000_000;
const gen = (fields: Partial<Generation> & { id: string }): Generation => ({
  projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
  approvedBy: null, approvedAt: null, model: "gemini-3.1-flash-image", prompt: "A lighthouse at dusk, slow push-in", title: null,
  params: { ratio: "16:9" }, status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${fields.id}`, totalTokens: null, costUsd: null,
  refineCostUsd: null, providerCreditQuote: null, creditsBilled: null, refineModel: null, refineInTokens: null, refineOutTokens: null,
  error: null, failure: null, createdBy: "me", authorName: null, shotId: null, shotCode: null, shotScene: null, shotTitle: null, version: 1,
  durationMs: null, durationS: null, provider: "google", attempts: 1, task: "generate", sourceGenId: null, createdAt: T0, updatedAt: T0,
  ...fields,
} as Generation);

test.describe("the wall", () => {
  test("a stored still or clip becomes a tile with its kind and name; anything else is left out", () => {
    expect(wallTile(gen({ id: "a" }))).toMatchObject({ id: "a", url: "/api/media/a", media: "image", type: "Still · 16:9", title: "A lighthouse at dusk, slow push-in" });
    expect(wallTile(gen({ id: "v", kind: "video", durationS: 5.04, title: "Mirror test" }))).toMatchObject({ media: "video", type: "Video · 5 s", title: "Mirror test" });
    expect(wallTile(gen({ id: "s", kind: "audio" }))).toBeNull();
    expect(wallTile(gen({ id: "r", status: "running" }))).toBeNull();
    expect(wallTile(gen({ id: "n", storedUrl: null }))).toBeNull();
  });

  test("its words are the ones typed, not with the platform's rules added for the engine", () => {
    const tile = wallTile(gen({ id: "w", prompt: "Waves on black sand No lettering, captions, logos or text of any kind appears in the frame.", params: { ratio: "9:16", rawPrompt: "Waves on black sand" } }))!;
    expect(tile.title).toBe("Waves on black sand");
    expect(tile.prompt).toBe("Waves on black sand");
  });

  test("only Particl's own media route, never a provider's address", () => {
    expect(wallTile(gen({ id: "p", storedUrl: "https://provider.example/x.png" }))?.url).toBe("/api/media/p");
  });

  test("a long name is cut at a word", () => {
    const title = wallTile(gen({ id: "l", prompt: "A very long description of a scene that keeps going well past what a tile label can hold" }))!.title;
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith("…")).toBe(true);
  });

  test("newest first, at most six, no repeats", () => {
    const list = Array.from({ length: 10 }, (_, i) => gen({ id: `g${i}`, createdAt: T0 + i }));
    const tiles = wallTiles([...list, list[9], gen({ id: "audio", kind: "audio", createdAt: T0 + 99 })]);
    expect(tiles.map((t) => t.id)).toEqual(["g9", "g8", "g7", "g6", "g5", "g4"]);
    expect(WALL_TILES).toBe(6);
  });

  test("six tiles take the prototype's mosaic; fewer fill the same four rows with no holes", () => {
    expect(wallLayout(6)).toEqual([
      { col: "1 / span 2", row: "1 / span 4" }, { col: "3 / span 2", row: "1 / span 2" }, { col: "5 / span 1", row: "1 / span 4" },
      { col: "6 / span 1", row: "1 / span 2" }, { col: "3 / span 2", row: "3 / span 2" }, { col: "6 / span 1", row: "3 / span 2" },
    ]);
    const area = (cells: { col: string; row: string }[]) => cells.reduce((sum, c) => sum + Number(c.col.split("span ")[1]) * Number(c.row.split("span ")[1]), 0);
    for (const n of [3, 4, 5, 6]) expect(area(wallLayout(n)), `${n} tiles`).toBe(24);
    expect(wallLayout(0)).toEqual([]);
    expect(wallLayout(9)).toHaveLength(6);
  });

  test("row height grows when the Waiting strip is hidden (the prototype's 100 / 118)", () => {
    expect(wallRow(true)).toBe(100);
    expect(wallRow(false)).toBe(118);
  });

  test("a picked tile's words: what the person added, then the tile's own", () => {
    const tile = { title: "Mirror test", prompt: "A mirror sphere in the desert" };
    expect(pickedBrief(tile, "")).toBe("Make one like “Mirror test”: A mirror sphere in the desert");
    expect(pickedBrief(tile, "  but at night ")).toBe("but at night\n\nMake one like “Mirror test”: A mirror sphere in the desert");
    expect(pickedBrief({ title: "Untitled", prompt: "" }, "")).toBe("Make one like “Untitled”.");
    expect(pickedBrief({ title: "Long", prompt: "word ".repeat(1000) }, "").length).toBeLessThanOrEqual(GOAL_MAX);
  });
});

test.describe("your boards", () => {
  const boards = [
    { id: "f", name: "Film", kind: "studio" as const }, { id: "a", name: "Ad", kind: "ads" as const },
    { id: "s", name: "Social", kind: "social" as const }, { id: "old", name: "Old" }, { id: "n", name: "Null", kind: null },
  ];
  test("kind filters in the prototype's words, Pre-vis waiting for P2's kinds", () => {
    expect(BOARD_FILTERS.map((f) => f.label)).toEqual(["All", "Films", "Campaigns", "Social"]);
  });
  test("a board with no kind kept opens as a film", () => {
    expect(boardKindIn({})).toBe("studio");
    expect(filterBoards(boards, "all").map((b) => b.id)).toEqual(["f", "a", "s", "old", "n"]);
    expect(filterBoards(boards, "studio").map((b) => b.id)).toEqual(["f", "old", "n"]);
    expect(filterBoards(boards, "ads").map((b) => b.id)).toEqual(["a"]);
    expect(filterBoards(boards, "social").map((b) => b.id)).toEqual(["s"]);
    expect(FIRST_BOARDS).toBe(12);
  });
});

test("Waiting for you shows two items from 1400 px, else one", () => {
  expect(waitingShown(true)).toBe(2);
  expect(waitingShown(false)).toBe(1);
});

test.describe("Start's figure: shown equals approved", () => {
  const ready = { state: "ready", credits: 9 };
  test("the planner's figure for a new board, or the newer one the server gave for the same words", () => {
    expect(startFigure(null, ready, "a film")).toBe(9);
    /* After "Press Start again to approve it": the higher figure, for those words only. */
    expect(startFigure({ text: "a film", figure: 14 }, ready, "a film")).toBe(14);
    expect(startFigure({ text: "a film", figure: 14 }, ready, "another film")).toBe(9);
    expect(startFigure({ text: "a film", figure: null }, ready, "a film")).toBe(9);
    expect(startFigure(null, { state: "loading" }, "a film")).toBeNull();
    expect(startFigure({ text: "a film", figure: 14 }, { state: "error" }, "a film")).toBe(14);
  });

  test("credits read up to N cr from that one figure", () => {
    expect(startQuote({ spendOff: false, figure: 14, thinking: ready, dollars: false, creditUsd: 0.1 }))
      .toEqual({ state: "ready", price: { unit: "cr", value: { kind: "up-to", credits: 14 } } });
  });

  test("the house workspace sees the same figure in dollars (N × the price of a credit), never a second quote", () => {
    const q = startQuote({ spendOff: false, figure: 14, thinking: ready, dollars: true, creditUsd: 0.1 });
    expect(q.state).toBe("ready");
    if (q.state !== "ready" || q.price.unit !== "usd") throw new Error("expected dollars");
    expect(q.price.usd).toBeCloseTo(1.4, 10);
    expect(q.price.upTo).toBe(true);
    /* The newer figure moves the dollars with it. */
    const after = startQuote({ spendOff: false, figure: startFigure({ text: "w", figure: 20 }, ready, "w"), thinking: ready, dollars: true, creditUsd: 0.1 });
    expect(after.state === "ready" && after.price.unit === "usd" ? after.price.usd : null).toBeCloseTo(2, 10);
    expect(startQuote({ spendOff: false, figure: 14, thinking: ready, dollars: true, creditUsd: null }).state).toBe("error");
  });

  test("no figure: loading, or why not; the sample workspace shows none", () => {
    expect(startQuote({ spendOff: false, figure: null, thinking: { state: "loading" }, dollars: false, creditUsd: 0.1 }).state).toBe("loading");
    expect(startQuote({ spendOff: false, figure: null, thinking: { state: "error", message: "No read." }, dollars: false, creditUsd: 0.1 })).toEqual({ state: "error", message: "No read." });
    expect(startQuote({ spendOff: false, figure: null, thinking: { state: "off" }, dollars: false, creditUsd: 0.1 })).toEqual({ state: "error", message: "Atomik isn't on for this workspace yet." });
    expect(startQuote({ spendOff: true, figure: 14, thinking: ready, dollars: false, creditUsd: 0.1 }).state).toBe("idle");
  });
});
