import { test, expect } from "@playwright/test";
import { MAKE_SHOWS_CINEMA, buttonFigure, cinemaParts, figureWords, hiddenInMake, makeFigure } from "../../lib/shell/make-price";
import { RECENT_CHIPS, againAsk, askAgain, canAgain, recentEntries, recentMeta } from "../../lib/shell/make-recent";
import { quoteKeyFor, composerSettings, type ComposerModel } from "../../lib/workspace/composer";
import { generation } from "../helpers/workspaceFixtures";
import { libraryEntries } from "../../lib/workspace/library";
import { CINEMA_STUDIO_MODEL_ID } from "../../lib/cinemaStudioTypes";

/* D0 review items 6-8: the words and the reads behind Make's prices. Every figure is an input, as the server would quote it. */

const SEEDANCE: ComposerModel = { id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", type: "video", ratios: ["16:9", "9:16"], resolutions: ["480p", "1080p"], durations: [5, 10] };
const BANANA: ComposerModel = { id: "gemini-3.1-flash-image", label: "Nano Banana 2", type: "image", ratios: ["16:9"], resolutions: ["1K", "2K"], durations: [] };
const entries = (...gens: ReturnType<typeof generation>[]) => libraryEntries({ uploads: [], generations: gens } as never);

test("a figure is the server's, worded once: exact, or Cinema Studio's approximate", () => {
  expect(figureWords(makeFigure(43))).toBe("43 cr");
  expect(figureWords(makeFigure(1234))).toBe("1,234 cr");
  expect(figureWords(makeFigure(31, true))).toBe(cinemaParts(31).join(" "));
  expect(makeFigure(null)).toBeNull();
  expect(makeFigure(Number.NaN)).toBeNull();
  expect(makeFigure(-1)).toBeNull();
});

test("the button's figure is the live quote times its takes, and nothing for a stale or missing quote", () => {
  const settings = composerSettings(SEEDANCE, undefined, {});
  const key = quoteKeyFor({ type: "video", modelId: SEEDANCE.id, settings, references: [], prompt: "", seconds: 10, instrumental: false, voiceId: "" });
  const quote = { key, credits: 14, state: "ready" as const, reason: null };
  expect(figureWords(buttonFigure(quote, key, 1))).toBe("14 cr");
  expect(figureWords(buttonFigure(quote, key, 3))).toBe("42 cr");
  expect(buttonFigure(quote, "other", 1)).toBeNull();
  expect(buttonFigure(null, key, 1)).toBeNull();
});

test("Cinema Studio is hidden from Make by one flag (off while its hold is unmerged)", () => {
  expect(hiddenInMake(CINEMA_STUDIO_MODEL_ID)).toBe(!MAKE_SHOWS_CINEMA);
  expect(hiddenInMake(SEEDANCE.id)).toBe(false);
});

test("Recent's chips are All, Takes, Unfiled, Filed, and filter by the shot a take is filed on", () => {
  expect([...RECENT_CHIPS]).toEqual(["All", "Takes", "Unfiled", "Filed"]);
  const list = entries(generation({ id: "a", shotId: null }), generation({ id: "b", shotId: "shot_1" }));
  expect(recentEntries(list, "All")).toHaveLength(2);
  expect(recentEntries(list, "Takes")).toHaveLength(2);
  expect(recentEntries(list, "Unfiled").map((e) => e.take.sourceId)).toEqual(["a"]);
  expect(recentEntries(list, "Filed").map((e) => e.take.sourceId)).toEqual(["b"]);
});

test("a card names its engine in full, never the Rig column's short name", () => {
  const [still] = entries(generation({ id: "s", kind: "image", model: BANANA.id, params: { resolution: "1K" } }));
  expect(recentMeta(still)).toBe("Nano Banana 2 · 1K");
  const [clip] = entries(generation({ id: "c", kind: "video", model: SEEDANCE.id, durationS: 5, params: { resolution: "1080p" } }));
  expect(recentMeta(clip)).toBe("Seedance 2.5 · 5 s");
  expect(recentMeta(still)).not.toMatch(/NB 2/);
});

test("Again asks the server for the take's own settings, as the composer's quote does, and says nothing for an engine not offered", () => {
  const [clip] = entries(generation({ id: "c", kind: "video", model: SEEDANCE.id, params: { resolution: "1080p", ratio: "16:9", duration: 5 } }));
  expect(canAgain(clip)).toBe(true);
  const ask = againAsk(clip, [SEEDANCE, BANANA], "16:9");
  expect(ask?.kind).toBe("engine");
  const url = new URL(`http://x${(ask as { url: string }).url}`);
  expect(url.pathname).toBe("/api/workbench/engines");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ model: SEEDANCE.id, resolution: "1080p", ratio: "16:9", duration: "5" });
  expect(againAsk(clip, [BANANA], "16:9")).toBeNull();
});

test("an Again price is the server's figure, or nothing", async () => {
  const [clip] = entries(generation({ id: "c", kind: "video", model: SEEDANCE.id, params: { resolution: "1080p", ratio: "16:9", duration: 5 } }));
  const ask = againAsk(clip, [SEEDANCE], "16:9")!;
  const reply = (body: unknown, ok = true) => async () => ({ ok, json: async () => body }) as unknown as Response;
  expect(await askAgain(ask, reply({ credits: 43 }))).toEqual({ credits: 43, approximate: false });
  expect(await askAgain(ask, reply({ credits: 31, approximate: true }))).toEqual({ credits: 31, approximate: true });
  expect(await askAgain(ask, reply({ credits: null }))).toBeNull();
  expect(await askAgain(ask, reply({ error: "no" }, false))).toBeNull();
});
