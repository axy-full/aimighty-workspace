import { test, expect } from "@playwright/test";
import { GENJUTSU_LIMITS, GENJUTSU_RESOLUTIONS } from "../../lib/genjutsuTypes";
import { genjutsuSourceProblem } from "../../lib/genjutsu";
import { INITIAL_VIRAL, REFERENCE_MAX, SOURCE_SECONDS, SOURCE_WHY, addMedia, moveReferenceTo, viralBlock, type ViralMedia, type ViralState } from "../../lib/shell/viral";

/* Motion transfer and Object swap, Release 1: a source clip of 4 to 8 s, 720p by default, 1080p allowed, references 1 to 8 in the order sent. */
const video = (id: string, seconds: number | null): ViralMedia => ({ id: `upload:${id}`, sourceId: id, origin: "upload", kind: "video", name: `${id}.mp4`, url: `/api/uploads/${id}`, seconds });
const still = (id: string): ViralMedia => ({ id: `upload:${id}`, sourceId: id, origin: "upload", kind: "image", name: `${id}.png`, url: `/api/uploads/${id}`, seconds: null });

test("the source window is 4 to 8 s, read by the picker and the server from one number; 720p is the default and 1080p is allowed", () => {
  expect(GENJUTSU_LIMITS.minSeconds).toBe(4);
  expect(GENJUTSU_LIMITS.maxSeconds).toBe(8);
  expect(SOURCE_SECONDS).toEqual({ min: 4, max: 8 });
  expect(INITIAL_VIRAL.resolution).toBe("720p");
  expect(GENJUTSU_RESOLUTIONS).toContain("1080p");
  /* The server's own check, which the quote and the send both run (lib/generationAdmission.ts). */
  for (const seconds of [4, 6, 8]) expect(genjutsuSourceProblem(seconds), String(seconds)).toBeNull();
  for (const seconds of [0, 3.999, 8.001, 9, 30, Number.NaN, Infinity]) expect(genjutsuSourceProblem(seconds), String(seconds)).toBe("Transform needs an original video between 4 and 8 seconds.");
});

test("the picker refuses a longer source with a plain reason, and nothing is added", () => {
  const long = addMedia(INITIAL_VIRAL, video("long", 12));
  expect(long.state).toBe(INITIAL_VIRAL);
  expect(long.note).toBe(`The source video must be 4–8 s; this one is 12 s. ${SOURCE_WHY}`);
  expect(SOURCE_WHY).toMatch(/up to 8 s for now/);
  expect(addMedia(INITIAL_VIRAL, video("edge", 8)).state.source?.sourceId).toBe("edge");
  expect(addMedia(INITIAL_VIRAL, video("short", 3)).state.source).toBeNull();
  expect(viralBlock(INITIAL_VIRAL, { hasProject: true, saved: true })).toBe("Add one source video (4–8 s).");
});

test("references are dragged into a new place: one to eight, the others keep their order", () => {
  const refs = ["a", "b", "c", "d"].map(still);
  const state: ViralState = { ...INITIAL_VIRAL, source: video("s", 6), references: refs };
  const names = (s: ViralState) => s.references.map((r) => r.sourceId).join("");
  expect(names(moveReferenceTo(state, "upload:d", 0))).toBe("dabc");
  expect(names(moveReferenceTo(state, "upload:a", 2))).toBe("bca" + "d");
  expect(names(moveReferenceTo(state, "upload:a", 99))).toBe("bcda");
  expect(moveReferenceTo(state, "upload:b", 1)).toBe(state);
  expect(moveReferenceTo(state, "upload:zz", 0)).toBe(state);
  let full = state;
  for (let i = 0; i < REFERENCE_MAX; i++) full = addMedia(full, still(`x${i}`)).state;
  expect(full.references).toHaveLength(REFERENCE_MAX);
  expect(addMedia(full, still("one-more")).note).toBe(`Up to ${REFERENCE_MAX} reference images.`);
});
