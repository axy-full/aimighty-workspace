import { test, expect } from "@playwright/test";
import { SCRIPT_TABS, TEXT_REASONS, beatLines, breakdownLines, briefCard, fingerprint, scriptCard, specChips, withMark, withoutMark } from "../../lib/v12/board/text-steps";
import { stagePage } from "../../lib/v12/board/stages";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";

/**
 * Brief and Script cards (lib/v12/board/text-steps.ts; demo plan PR 11): text cards over the draft's own words, a mark that goes stale
 * when the words change, and the Script's Beats and Breakdown tabs read from the beat sheet.
 */
const sheet: BeatSheet = {
  scriptSha256: "a".repeat(64), updatedAt: "2026-10-16T00:00:00.000Z",
  scenes: [
    { id: "s1", heading: "Arrive", summary: "", beats: [], shots: [{ id: "a", description: "", framing: "", movement: "", lighting: "", sound: "", duration: 3 }, { id: "b", description: "", framing: "", movement: "", lighting: "", sound: "" }], characters: ["MAYA", "GUIDE"], locations: ["Desert camp"], props: ["Bottle"] },
    { id: "s2", heading: "", summary: "She drinks at the water", beats: [], shots: [{ id: "c", description: "", framing: "", movement: "", lighting: "", sound: "", duration: 4 }], characters: ["MAYA"], locations: ["Water's edge"], props: ["Bottle", "Fire bowls"] },
  ],
};

test("Brief and Script are pages of the Film board's steps, and of no other board's", () => {
  expect(stagePage("brief", "film")).toBe("brief");
  expect(stagePage("script", "film")).toBe("script");
  expect(stagePage("script", "narrated")).toBeNull();
  expect(stagePage("brief", "previs")).toBeNull();
});

test("a card is Not started with no words, Ready with some, and says what ✕ was given", () => {
  const p = { ...newProject("x"), brief: "", script: "" };
  expect(briefCard(p).status).toBe("none");
  expect(scriptCard(p).status).toBe("none");
  const q = { ...p, brief: "A 30 s ad.", script: "PICTURE: a camp." };
  expect(briefCard(q).status).toBe("ready");
  const marks = withMark(q.boardMarks, "brief", q.brief, "rejected", 5, "Tone · warmer");
  expect(briefCard({ ...q, boardMarks: marks })).toMatchObject({ status: "rejected", reason: "Tone · warmer" });
});

test("a mark holds for the words it was given for, and goes stale when they change", () => {
  const p = { ...newProject("x"), script: "PICTURE: a camp." };
  const marks = withMark(undefined, "script", p.script!, "approved", 1);
  expect(scriptCard({ ...p, boardMarks: marks }).status).toBe("approved");
  expect(scriptCard({ ...p, script: `${p.script}\nVO: hello`, boardMarks: marks }).status).toBe("ready");
  expect(scriptCard({ ...p, boardMarks: withoutMark(marks, "script") }).status).toBe("ready");
  expect(fingerprint("a")).not.toBe(fingerprint("b"));
});

test("marks never stack: a verdict replaces the one before, for its own card only", () => {
  let marks = withMark(undefined, "brief", "x", "approved", 1);
  marks = withMark(marks, "script", "y", "rejected", 2, "Pacing");
  marks = withMark(marks, "brief", "x", "rejected", 3);
  expect(Object.keys(marks).sort()).toEqual(["brief", "script"]);
  expect(marks.brief.s).toBe("rejected");
  expect(marks.brief.reason).toBeUndefined();
  expect(marks.script.reason).toBe("Pacing");
});

test("the draft's schema keeps the marks and refuses nonsense", () => {
  const project = { ...newProject("x"), boardMarks: withMark(undefined, "brief", "x", "approved", 1) };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardMarks: { brief: { s: "maybe", fp: "x", at: 1 } } }).success).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardMarks: { "bad id": { s: "approved", fp: "x", at: 1 } } }).success).toBe(false);
});

test("the brief's chips are its spec, a length only when the deliverables read as one", () => {
  expect(specChips({ aspect: "16:9", fps: 24, deliverables: "30 s" }).map((c) => c.label)).toEqual(["30 s", "16:9", "24 fps"]);
  expect(specChips({ aspect: "9:16", fps: 24, deliverables: "A cut for the website, a cut for Reels" }).map((c) => c.label)).toEqual(["9:16", "24 fps"]);
});

test("Beats and Breakdown read the beat sheet; with none they are empty, and the script card counts its scenes and shots", () => {
  const p = { ...newProject("x"), script: "S", production: { beats: sheet } };
  expect(beatLines(p)).toEqual(["I · Arrive — 2 shots", "II · She drinks at the water — 1 shot"]);
  expect(breakdownLines(p)).toEqual(["Characters: MAYA, GUIDE", "Locations: Desert camp, Water's edge", "Props: Bottle, Fire bowls", "Shots: 3 · 7 s"]);
  expect(scriptCard(p).chips.map((c) => c.label)).toEqual(["2 scenes", "3 shots"]);
  expect(beatLines(newProject("y"))).toEqual([]);
  expect(breakdownLines(newProject("y"))).toEqual([]);
  expect(SCRIPT_TABS).toEqual(["Script", "Beats", "Breakdown"]);
});

test("a script with earlier versions reads as the next one, and each text step has its own reasons", () => {
  const p = { ...newProject("x"), script: "S", scriptVersions: [{ id: "v1", text: "old", at: "2026-10-15T00:00:00.000Z", note: "Replaced" }] };
  expect(scriptCard(p).version).toBe(2);
  expect(TEXT_REASONS.brief).not.toContain("Other");
  expect(TEXT_REASONS.script.length).toBeGreaterThan(2);
});
