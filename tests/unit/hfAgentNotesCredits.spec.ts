import { test, expect } from "@playwright/test";
import { agentCharged, agentPrice, notesSent } from "../../lib/production/agent";
import { BEAT_LIMITS, newBeat, newScene, newShot, removalName, removeFromSheet, restoreRefusal, restoreToSheet, type BeatScene, type BeatSheet } from "../../lib/production/beats";
import { attachBeatsStage, undoBeatRemoval } from "../../lib/production/beats-undo";
import { UNDO_HINT, splitUndoHint, undoneLabel, withUndoHint } from "../../lib/shell/undo";

/**
 * Agent stages keep the director's notes and speak in credits; Beats deletes
 * go through the shell's undo stack. The pure halves, without a browser.
 */

function scene(heading: string, beats = 3, shots = 2): BeatScene {
  const s = newScene();
  return { ...s, heading, beats: Array.from({ length: beats }, (_, i) => ({ ...newBeat(), text: `${heading} beat ${i + 1}` })), shots: Array.from({ length: shots }, (_, i) => ({ ...newShot(), description: `${heading} shot ${i + 1}` })) };
}
function sheetOf(...scenes: BeatScene[]): BeatSheet {
  return { scriptSha256: "sha", updatedAt: "2026-09-25T00:00:00.000Z", scenes };
}

/* ── Price in the workspace's unit ───────────────────────────────────────── */

test("a credit workspace sees credits only — even when a dollar figure arrives with the quote", () => {
  expect(agentPrice({ estimateCredits: 12 }, true)).toBe("12 cr");
  expect(agentPrice({ estimateCredits: 12, estimateUsd: 0.0312 }, true)).toBe("12 cr");
  expect(agentPrice({ estimateCredits: 1234 }, true)).toBe("1,234 cr");
  expect(agentPrice({ estimateCredits: 12, estimateUsd: 0.0312 }, true)).not.toContain("$");
});

test("a workspace that pays its vendors in dollars sees the dollar ceiling, never '0 credits'", () => {
  expect(agentPrice({ estimateCredits: 0, estimateUsd: 0.0312 }, false)).toBe("$0.0312");
  expect(agentPrice({ estimateCredits: 0, estimateUsd: 2.5 }, false)).toBe("$2.50");
  /* No dollar figure (an older reply): the credit figure is all there is. */
  expect(agentPrice({ estimateCredits: 7 }, false)).toBe("7 cr");
});

test("a finished run's charge: credits, dollars, or still settling", () => {
  expect(agentCharged({ credits: 9, costUsd: 0.02 }, true)).toBe("9 cr");
  expect(agentCharged({ credits: null }, true)).toBeNull();
  expect(agentCharged({ credits: 0, costUsd: 0.0213 }, false)).toBe("$0.0213");
  /* A dollar workspace never falls back to its 0-credit figure. */
  expect(agentCharged({ credits: 0, costUsd: null }, false)).toBeNull();
});

/* ── Notes ───────────────────────────────────────────────────────────────── */

test("notes are cleared only when they are what the confirmed request carried", () => {
  expect(notesSent({ instructions: "Let the fox come back." }, "Let the fox come back.")).toBe(true);
  expect(notesSent({ instructions: "Let the fox come back." }, "  Let the fox come back.\n")).toBe(true);
  /* The director kept typing while it started: their new words stay. */
  expect(notesSent({ instructions: "Let the fox come back." }, "Let the fox come back. And the lamp.")).toBe(false);
  expect(notesSent({}, "")).toBe(false);
  expect(notesSent(null, "anything")).toBe(false);
  expect(notesSent({ instructions: "" }, "")).toBe(false);
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

/* ── Beats: where an undo lands ──────────────────────────────────────────── */

test("an undo goes through the open Beats stage; with none open it waits for the next one", () => {
  const projectId = `p-${Math.random()}`;
  const a = scene("INT. HUT"), b = scene("EXT. ICE");
  let sheet: BeatSheet = sheetOf(a, b);
  const restore = (removal: Parameters<typeof restoreToSheet>[1]) => {
    const next = restoreToSheet(sheet, removal);
    if (!next) return restoreRefusal(sheet, removal);
    sheet = next;
    return null;
  };

  /* Open: restored at once. */
  const first = attachBeatsStage(projectId, restore);
  expect(first.missed).toEqual([]);
  let taken = removeFromSheet(sheet, { kind: "scene", id: b.id })!;
  sheet = taken.sheet;
  expect(undoBeatRemoval(projectId, taken.removal)).toEqual({ done: "restored" });
  expect(sheet.scenes.map((x) => x.heading)).toEqual(["INT. HUT", "EXT. ICE"]);

  /* Closed (the director moved to Brief): held, never written by the closed stage. */
  first.detach();
  taken = removeFromSheet(sheet, { kind: "beat", sceneId: a.id, id: a.beats[0].id })!;
  sheet = taken.sheet;
  expect(undoBeatRemoval(projectId, taken.removal)).toEqual({ done: "held" });
  expect(sheet.scenes[0].beats).toHaveLength(2);

  /* The next Beats stage for the project puts it back as it opens. */
  const second = attachBeatsStage(projectId, restore);
  expect(second.missed).toEqual([]);
  expect(sheet.scenes[0].beats.map((x) => x.text)).toEqual(["INT. HUT beat 1", "INT. HUT beat 2", "INT. HUT beat 3"]);

  /* A stale stage's detach does not close the newer one. */
  first.detach();
  taken = removeFromSheet(sheet, { kind: "shot", sceneId: b.id, id: b.shots[1].id })!;
  sheet = taken.sheet;
  expect(undoBeatRemoval(projectId, taken.removal)).toEqual({ done: "restored" });

  /* Its scene is gone: it says so. */
  taken = removeFromSheet(sheet, { kind: "shot", sceneId: b.id, id: b.shots[0].id })!;
  sheet = removeFromSheet(taken.sheet, { kind: "scene", id: b.id })!.sheet;
  expect(undoBeatRemoval(projectId, taken.removal)).toEqual({ done: "missed", why: "its scene is gone" });
  second.detach();
});

test("another project's undo is held for that project, not applied to the open one", () => {
  const open = `p-open-${Math.random()}`, other = `p-other-${Math.random()}`;
  const seen: string[] = [];
  const stage = attachBeatsStage(open, (removal) => { seen.push(removal.kind); return null; });
  const a = scene("INT. HUT");
  const taken = removeFromSheet(sheetOf(a), { kind: "scene", id: a.id })!;
  expect(undoBeatRemoval(other, taken.removal)).toEqual({ done: "held" });
  expect(seen).toEqual([]);
  const later = attachBeatsStage(other, (removal) => { seen.push(`other:${removal.kind}`); return null; });
  expect(seen).toEqual(["other:scene"]);
  later.detach(); stage.detach();
});

/* ── The shell's undo toast ──────────────────────────────────────────────── */

test("the undo toast: its keyboard half splits off, and an undo can say what really happened", () => {
  const text = withUndoHint("Scene 2 deleted");
  expect(text).toBe("Scene 2 deleted · ⌘Z to undo");
  expect(splitUndoHint(text)).toEqual({ lead: "Scene 2 deleted", hint: UNDO_HINT });
  expect(splitUndoHint("Saved")).toEqual({ lead: "Saved", hint: "" });
  const entry = { label: "Scene 2 is back", undo: () => {} };
  expect(undoneLabel(entry, undefined)).toBe("Scene 2 is back");
  expect(undoneLabel(entry, "Scene 2 could not go back: the beat sheet is gone.")).toBe("Scene 2 could not go back: the beat sheet is gone.");
  expect(undoneLabel(entry, "  ")).toBe("Scene 2 is back");
});
