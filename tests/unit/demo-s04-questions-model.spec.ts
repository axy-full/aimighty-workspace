import { test, expect } from "@playwright/test";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import { NO_ANSWERS, aspectOf, castPicks, castReference, judgement, lookWords, questionsFor, showQuestions, withChip, withWords } from "../../components/graphite/board/cards/questions/model";

/* Atomik's questions before the looks (design/particl-graphite/README.md § 3.1 b), built from today's project. */

const NOW = "2026-10-05T10:00:00.000Z";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const beats: BeatSheet = { scriptSha256: SHA, updatedAt: NOW, scenes: [{ id: "s", heading: "", summary: "", beats: [], characters: [], locations: [], props: [],
  shots: [{ id: "a", description: "", framing: "", movement: "", lighting: "", sound: "", duration: 10 }, { id: "b", description: "", framing: "", movement: "", lighting: "", sound: "", duration: 5 }] }] };
const still: Asset = { id: "gen-face", generationId: "gen-face", kind: "image", category: "Cast", name: "Lead", url: "/api/media/gen-face", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
const project = (over: Partial<Project> = {}): Project => ({
  ...newProject("Test film"), aspect: "16:9", assets: [still],
  production: {
    beats,
    cast: { entries: [
      { id: "lead", name: "The runner", kind: "character", description: "", prompt: "", takes: [{ genId: "gen-face", at: NOW }], selected: "gen-face" },
      { id: "prop", name: "A lantern", kind: "element", description: "", prompt: "", takes: [] },
      { id: "nobody", name: "Unseen", kind: "character", description: "", prompt: "", takes: [] },
    ] },
  },
  ...over,
});

test("three questions, the design's chips, from the project's own aspect, length and cast", () => {
  const qs = questionsFor(project());
  expect(qs.map((q) => [q.text, q.chips.map((c) => c.label), q.placeholder])).toEqual([
    ["Format", ["16:9 · 15 s", "9:16 · 15 s", "Both"], "Or say it"],
    ["Cast references", ["Use The runner", "I’ll upload", "Cast someone new"], "A name, a link or a note"],
    ["One direction, or variations?", ["One direction", "Two variations", "Three"], "Which parts may vary?"],
  ]);
  /* Without a running time the format chips are the aspects alone; only characters with a picture are offered. */
  expect(questionsFor(project({ production: undefined }))[0].chips.map((c) => c.label)).toEqual(["16:9", "9:16", "Both"]);
  expect(castPicks(project()).map((c) => c.name)).toEqual(["The runner"]);
});

test("Use your judgement fills the defaults and nothing else", () => {
  expect(judgement(project())).toEqual({ chips: { format: "16:9", cast: "cast:lead", direction: "one" }, words: {} });
  expect(judgement(project({ aspect: "1:1", production: undefined }))).toEqual({ chips: { direction: "one" }, words: {} });
});

test("answers set the aspect, the cast reference and the looks' words", () => {
  let a = withChip(NO_ANSWERS, "format", "9:16");
  expect(aspectOf(a)).toBe("9:16");
  expect(aspectOf(withChip(a, "format", "both"))).toBe("16:9");
  expect(aspectOf(withChip(a, "format", "9:16"))).toBeNull(); /* chosen again: cleared */
  a = withChip(a, "cast", "cast:lead");
  expect(castReference(project(), a)?.id).toBe("gen-face");
  expect(castReference(project(), withChip(a, "cast", "upload"))).toBeNull();
  a = withWords(withChip(a, "direction", "two"), "direction", "  The light may vary.  ");
  expect(lookWords(a)).toBe("Two variations of the direction. The light may vary.");
  expect(lookWords(NO_ANSWERS)).toBe("");
});

test("the questions are asked while there is a brief, no look and no live run", () => {
  const brief = { brief: "A runner at dawn.", production: undefined };
  expect(showQuestions(brief, null)).toBe(true);
  expect(showQuestions(brief, { state: "done" })).toBe(true);
  expect(showQuestions(brief, { state: "awaiting_approval" })).toBe(false);
  expect(showQuestions({ brief: "  ", production: undefined }, null)).toBe(false);
  const made = { brief: "A runner at dawn.", production: { boards: { style: "live", model: "m", frames: {}, looks: { "golden-hour": { name: "Golden hour", prompt: "p", takes: [] } } } } };
  expect(showQuestions(made as never, null)).toBe(false);
});
