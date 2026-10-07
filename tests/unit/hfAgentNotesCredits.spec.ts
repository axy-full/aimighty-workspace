import { test, expect } from "@playwright/test";
import { NOTES_LIMIT, clearSentNotes, notesBack, notesOf, notesSent, withNotes } from "../../lib/production/notes";
import { BEAT_LIMITS, newBeat, newScene, newShot, removalName, removeFromSheet, restoreRefusal, restoreToSheet, type BeatScene, type BeatSheet } from "../../lib/production/beats";
import { UNDO_HINT, popUndo, pushUndo, splitUndoHint, undoneLabel, withUndoHint, type UndoEntry } from "../../lib/shell/undo";
import { productionSchema } from "../../lib/workbench/studio-schema";
import { mergeDraft } from "../../lib/workbench/draft-merge";
import { noteTakenOut, recordMade, type MadeRecords } from "../../lib/workbench/merge";
import { beatSheetFrom } from "../../lib/production/beats";
import { newProject, type Project } from "../../lib/workbench/studio";

/**
 * Agent stages keep the director's notes and speak in credits; Beats deletes
 * go through the shell's undo stack. The pure halves, without a browser.
 */

function scene(heading: string, beats = 3, shots = 2): BeatScene {
  const s = newScene();
  return { ...s, heading, beats: Array.from({ length: beats }, (_, i) => ({ ...newBeat(), text: `${heading} beat ${i + 1}` })), shots: Array.from({ length: shots }, (_, i) => ({ ...newShot(), description: `${heading} shot ${i + 1}` })) };
}
function sheetOf(...scenes: BeatScene[]): BeatSheet {
  return { scriptSha256: "a".repeat(64), updatedAt: "2026-09-25T00:00:00.000Z", scenes };
}



/* ── Notes ───────────────────────────────────────────────────────────────── */

test("notes live on the project, per box, within the limit", () => {
  const project: { production?: { notes?: { draft?: string; beats?: string } } } = {};
  expect(notesOf(project, "draft")).toBe("");
  const one = withNotes(project, "draft", "Let the fox come back.");
  expect(notesOf(one, "draft")).toBe("Let the fox come back.");
  expect(notesOf(one, "beats")).toBe("");
  expect(withNotes(one, "draft", "Let the fox come back.")).toBe(one);
  const both = withNotes(one, "beats", "Shorter second act.");
  expect(both.production?.notes).toEqual({ draft: "Let the fox come back.", beats: "Shorter second act." });
  expect(notesOf(withNotes(both, "draft", "x".repeat(NOTES_LIMIT + 50)), "draft")).toHaveLength(NOTES_LIMIT);
  /* The project's schema keeps them, and nothing else under that key. */
  expect(productionSchema.safeParse({ notes: both.production!.notes }).success).toBe(true);
  expect(productionSchema.safeParse({ notes: { draft: "x".repeat(NOTES_LIMIT + 1) } }).success).toBe(false);
  expect(productionSchema.safeParse({ notes: { other: "x" } }).success).toBe(false);
});

test("notes leave their box only when they are what the held run carried", () => {
  expect(notesSent({ instructions: "Let the fox come back." }, "Let the fox come back.")).toBe(true);
  expect(notesSent({ instructions: "Let the fox come back." }, "  Let the fox come back.\n")).toBe(true);
  /* The director kept typing while it started: their new words stay. */
  expect(notesSent({ instructions: "Let the fox come back." }, "Let the fox come back. And the lamp.")).toBe(false);
  expect(notesSent({}, "")).toBe(false);
  expect(notesSent(null, "anything")).toBe(false);
  expect(notesSent({ instructions: "" }, "")).toBe(false);
  const project = withNotes({}, "draft", "Let the fox come back.");
  expect(notesOf(clearSentNotes(project, "draft", { instructions: "Let the fox come back." }), "draft")).toBe("");
  expect(clearSentNotes(project, "draft", { instructions: "Something else" })).toBe(project);
});

test("a failed run's notes come back: into an empty box as they were, after what is there, never twice or over the limit", () => {
  expect(notesBack("", "Let the fox come back.")).toBe("Let the fox come back.");
  expect(notesBack("And the lamp.", "Let the fox come back.")).toBe("And the lamp.\n\nLet the fox come back.");
  expect(notesBack("Let the fox come back.", "Let the fox come back.")).toBeNull();
  expect(notesBack("x", "   ")).toBeNull();
  expect(notesBack("x".repeat(NOTES_LIMIT - 5), "Let the fox come back.")).toBeNull();
});

/* ── Beats: delete and put back ──────────────────────────────────────────── */

test("a deleted scene, beat or shot goes back where it was", () => {
  const a = scene("INT. HUT"), b = scene("EXT. ICE"), c = scene("EXT. ROAD");
  const sheet = sheetOf(a, b, c);

  const s = removeFromSheet(sheet, { kind: "scene", id: b.id })!;
  expect(s.sheet.scenes.map((x) => x.heading)).toEqual(["INT. HUT", "EXT. ROAD"]);
  expect(removalName(s.removal)).toBe("Scene 2");
  expect(restoreToSheet(s.sheet, s.removal)!.scenes.map((x) => x.heading)).toEqual(["INT. HUT", "EXT. ICE", "EXT. ROAD"]);

  const bt = removeFromSheet(sheet, { kind: "beat", sceneId: a.id, id: a.beats[1].id })!;
  expect(bt.sheet.scenes[0].beats.map((x) => x.text)).toEqual(["INT. HUT beat 1", "INT. HUT beat 3"]);
  expect(removalName(bt.removal)).toBe("Beat 2 of scene 1");
  expect(restoreToSheet(bt.sheet, bt.removal)!.scenes[0].beats.map((x) => x.text)).toEqual(["INT. HUT beat 1", "INT. HUT beat 2", "INT. HUT beat 3"]);

  const sh = removeFromSheet(sheet, { kind: "shot", sceneId: c.id, id: c.shots[0].id })!;
  expect(removalName(sh.removal)).toBe("Shot 3.1");
  expect(restoreToSheet(sh.sheet, sh.removal)!.scenes[2].shots.map((x) => x.description)).toEqual(["EXT. ROAD shot 1", "EXT. ROAD shot 2"]);

  /* The original is never mutated. */
  expect(sheet.scenes).toHaveLength(3);
  expect(sheet.scenes[0].beats).toHaveLength(3);
});

test("a restore survives later edits, and never duplicates", () => {
  const a = scene("INT. HUT", 4);
  const taken = removeFromSheet(sheetOf(a), { kind: "beat", sceneId: a.id, id: a.beats[3].id })!;
  /* Two more beats deleted after it: the last beat goes back at the end. */
  const shrunk = { ...taken.sheet, scenes: [{ ...taken.sheet.scenes[0], beats: taken.sheet.scenes[0].beats.slice(0, 1) }] };
  expect(restoreToSheet(shrunk, taken.removal)!.scenes[0].beats.map((x) => x.text)).toEqual(["INT. HUT beat 1", "INT. HUT beat 4"]);
  /* Already back: unchanged, the same object. */
  const back = restoreToSheet(taken.sheet, taken.removal)!;
  expect(restoreToSheet(back, taken.removal)).toBe(back);
});

test("what cannot go back says why", () => {
  const a = scene("INT. HUT"), b = scene("EXT. ICE");
  const sheet = sheetOf(a, b);
  const beat = removeFromSheet(sheet, { kind: "beat", sceneId: b.id, id: b.beats[0].id })!;
  const noScene = removeFromSheet(beat.sheet, { kind: "scene", id: b.id })!.sheet;
  expect(restoreToSheet(noScene, beat.removal)).toBeNull();
  expect(restoreRefusal(noScene, beat.removal)).toBe("its scene is gone");
  expect(restoreToSheet(null, beat.removal)).toBeNull();
  expect(restoreRefusal(null, beat.removal)).toBe("the beat sheet is gone");
  const full = { ...sheet, scenes: [{ ...b, beats: Array.from({ length: BEAT_LIMITS.beats }, () => newBeat()) }] };
  expect(restoreToSheet(full, beat.removal)).toBeNull();
  expect(restoreRefusal(full, beat.removal)).toBe(`its scene already has ${BEAT_LIMITS.beats} beats`);
  expect(removeFromSheet(sheet, { kind: "shot", sceneId: a.id, id: "missing" })).toBeNull();
  expect(removeFromSheet(sheet, { kind: "scene", id: "missing" })).toBeNull();
});

test("a deleted scene never goes back into a beat sheet that was replaced since (a new breakdown)", () => {
  const a = scene("INT. HUT"), b = scene("EXT. ICE");
  const taken = removeFromSheet(sheetOf(a, b), { kind: "scene", id: b.id })!;
  const fresh = sheetOf(scene("EXT. NEW ROAD"), scene("INT. NEW HALL"));
  expect(restoreToSheet(fresh, taken.removal)).toBeNull();
  expect(restoreRefusal(fresh, taken.removal)).toBe("the beat sheet was replaced since");
  /* Hand edits since — a scene added, another moved — are not a replacement. */
  const edited = { ...taken.sheet, scenes: [scene("EXT. ADDED"), ...taken.sheet.scenes] };
  expect(restoreToSheet(edited, taken.removal)!.scenes.map((x) => x.heading)).toEqual(["EXT. ADDED", "EXT. ICE", "INT. HUT"]);
  /* The last scene of a sheet had no neighbours: it goes back into the empty sheet. */
  const last = removeFromSheet(sheetOf(a), { kind: "scene", id: a.id })!;
  expect(restoreToSheet(last.sheet, last.removal)!.scenes.map((x) => x.heading)).toEqual(["INT. HUT"]);
});

/* ── The shell's undo toast ──────────────────────────────────────────────── */

test("the undo toast: its keyboard half splits off, and an undo can say what really happened", () => {
  const text = withUndoHint("Scene 2 deleted");
  expect(text).toBe("Scene 2 deleted · ⌘Z to undo");
  expect(splitUndoHint(text)).toEqual({ lead: "Scene 2 deleted", hint: UNDO_HINT });
  expect(splitUndoHint("Saved")).toEqual({ lead: "Saved", hint: "" });
  const entry: UndoEntry = { label: "Scene 2 is back", undo: () => {} };
  expect(undoneLabel(entry, undefined)).toBe("Scene 2 is back");
  expect(undoneLabel(entry, "Scene 2 could not go back: the beat sheet is gone.")).toBe("Scene 2 could not go back: the beat sheet is gone.");
  expect(undoneLabel(entry, "  ")).toBe("Scene 2 is back");
  /* A spent step is taken off the stack; a step for another project waits. */
  const other: UndoEntry = { label: "Shot back", undo: () => {}, projectId: "p-2" };
  const mine: UndoEntry = { ...entry, projectId: "p-1" };
  const stack = pushUndo(pushUndo([], mine), other);
  expect(popUndo(stack, "p-1")?.entry).toBe(mine);
  expect(popUndo(stack, "p-1")?.rest).toEqual([other]);
});

/* ── Notes and deletes in #387's three-way merge ─────────────────────────── */

function drafted(shape: (p: Project) => void = () => {}): Project {
  const p = newProject("Notes merge");
  p.id = "project-notes-merge";
  p.createdAt = "2026-09-26T00:00:00Z";
  shape(p);
  return p;
}

test("notes three-way merge like any text: two windows' lines both stay, and a sent note leaves while another window's new line stays", () => {
  const base = drafted((p) => { p.production = { notes: { draft: "Let the fox come back.\nShorter second act." } }; });
  const mine = withNotes(base, "draft", "Let the fox come back at night.\nShorter second act.");
  const theirs = withNotes(base, "draft", "Let the fox come back.\nShorter second act.\nNo narration.");
  expect(notesOf(mergeDraft(base, mine, theirs), "draft")).toBe("Let the fox come back at night.\nShorter second act.\nNo narration.");
  /* The boxes are separate: Brief's here, Beats' there. */
  const beats = withNotes(base, "beats", "Keep it wordless.");
  const merged = mergeDraft(base, beats, theirs);
  expect(merged.production?.notes).toEqual({ draft: "Let the fox come back.\nShorter second act.\nNo narration.", beats: "Keep it wordless." });
  /* This window's redraft was held: its notes leave; the line the other window added meanwhile stays. */
  const sent = clearSentNotes(base, "draft", { instructions: "Let the fox come back.\nShorter second act." });
  expect(notesOf(mergeDraft(base, sent, theirs), "draft").trim()).toBe("No narration.");
});

test("notes merged past 5,000 characters keep the saved text, and this window is told in the box's own name", () => {
  const line = (c: string) => c.repeat(2400);
  const base = drafted((p) => { p.production = { notes: { draft: line("a") } }; });
  const mine = withNotes(base, "draft", `${line("a")}\n${line("m")}`);
  const theirs = withNotes(base, "draft", `${line("t")}\n${line("a")}`);
  const notes: string[] = [];
  const merged = mergeDraft(base, mine, theirs, { notes });
  expect(notesOf(merged, "draft")).toBe(notesOf(theirs, "draft"));
  expect(notes).toEqual(["The notes box holds 5,000 characters, and another window's text filled it first: your edit to it was not added."]);
});

test("a Beats delete undone survives the merge once: the scene another window left alone is back, beside that window's edit", () => {
  const sheet = beatSheetFrom([0, 1].map((i) => ({ id: `s${i}`, heading: `SCENE ${i + 1}`, sourceStart: 0, sourceEnd: 1, summary: "", beats: ["A beat."], shots: [], characters: [], props: [], locations: [], productionNotes: [] })), "a".repeat(64), "wb_development_job-7");
  const base = drafted((p) => { p.production = { beats: sheet }; });
  const made: MadeRecords = new Map();
  /* As the editor does it: every change notes what it took out and what it made. */
  const edit = (from: Project, fn: (p: Project) => Project) => { const next = noteTakenOut(from, fn(from)); recordMade(made, from, next); return next; };
  const deleted = edit(base, (p) => ({ ...p, production: { ...p.production, beats: removeFromSheet(p.production!.beats!, { kind: "scene", id: sheet.scenes[1].id })!.sheet } }));
  expect(deleted.takenOut).toEqual([sheet.scenes[1].id]);
  const removal = removeFromSheet(base.production!.beats!, { kind: "scene", id: sheet.scenes[1].id })!.removal;
  const undone = edit(deleted, (p) => ({ ...p, production: { ...p.production, beats: restoreToSheet(p.production!.beats, removal)! } }));
  /* Another window renamed scene 1 meanwhile. */
  const theirs = clone(base); theirs.production!.beats!.scenes[0].heading = "SCENE ONE";
  const merged = mergeDraft(base, undone, theirs, { made });
  expect(merged.production?.beats?.scenes.map((s) => [s.id, s.heading])).toEqual([[sheet.scenes[0].id, "SCENE ONE"], [sheet.scenes[1].id, "SCENE 2"]]);
});

const clone = <T,>(value: T): T => structuredClone(value);
