import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import {
  BRIEF_DOC_WIDTH, DOC_LIMITS, briefDoc, briefDocHeight, clock, runningTime, sheetLength, shotRows, withBriefField, withNewShot, withShotBack, withShotDuration, withShotField, withoutShot,
} from "../../components/graphite/board/cards/doc/model";

/* The board's documents (design/particl-graphite/README.md § 3.1 d, § 1.2): the brief card and the shot list. */

const NOW = "2026-10-05T10:00:00.000Z";
const LATER = "2026-10-05T10:05:00.000Z";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sheet(): BeatSheet {
  return {
    scriptSha256: SHA, updatedAt: NOW,
    scenes: [{
      id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
      shots: [
        { id: "shot-1", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "Wind", duration: 4 },
        { id: "shot-2", description: "A runner crests the hill.", framing: "Medium", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 6 },
        { id: "shot-3", description: "Her breath in the cold air.", framing: "Close-up", movement: "Held · 85mm", lighting: "", sound: "", duration: 5 },
      ],
    }],
  };
}

function project(over: Partial<Project> = {}): Project {
  return { ...newProject("Test film"), aspect: "16:9", fps: 24, brief: "A runner at dawn.", direction: "Cold light, long lenses.", production: { beats: sheet() }, ...over };
}

test("the brief card reads the draft: name, brief, direction as the look, and aspect · fps · running time", () => {
  const doc = briefDoc(project());
  expect(doc.title).toBe("Test film");
  expect(doc.brief).toBe("A runner at dawn.");
  expect(doc.look).toBe("Cold light, long lenses.");
  expect(doc.footer).toBe("16:9 · 24 fps · 15 s");
  expect(doc.state).toBe("done");
  expect(doc.summary).toBe("Brief · 1 document");
});

test("a running time shows only when every shot has a length; an empty brief is empty on the rail", () => {
  const unsure = sheet();
  delete unsure.scenes[0].shots[1].duration;
  expect(sheetLength(unsure)).toBeNull();
  const doc = briefDoc(project({ brief: "", direction: "", production: { beats: unsure } }));
  expect(doc.footer).toBe("16:9 · 24 fps");
  expect(doc.state).toBe("empty");
  expect(doc.summary).toBe("Nothing yet");
  expect(briefDoc(project({ production: undefined })).footer).toBe("16:9 · 24 fps");
});

test("times read as the design writes them", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(4)).toBe("0:04");
  expect(clock(75.5)).toBe("1:15");
  expect(runningTime(15)).toBe("15 s");
  expect(runningTime(4.5)).toBe("4.5 s");
  expect(runningTime(90)).toBe("1:30");
});

test("the shot list numbers shots across the film with cumulative times", () => {
  const rows = shotRows(sheet());
  expect(rows.map((r) => [r.n, r.time, r.action, r.size, r.camera])).toEqual([
    ["01", "0:00 · 4 s", "Fog lifts off the valley.", "Extreme wide", "Locked off · 24mm"],
    ["02", "0:04 · 6 s", "A runner crests the hill.", "Medium", "Slow push · 35mm"],
    ["03", "0:10 · 5 s", "Her breath in the cold air.", "Close-up", "Held · 85mm"],
  ]);
  expect(shotRows(null)).toEqual([]);
});

test("after a shot with no length, later starts are unknown and say only their own length", () => {
  const s = sheet();
  delete s.scenes[0].shots[0].duration;
  const rows = shotRows(s);
  expect(rows.map((r) => r.time)).toEqual(["", "6 s", "5 s"]);
  expect(rows.map((r) => r.start)).toEqual([0, null, null]);
});

test("brief edits replace one field, cut to the draft's limit, and change nothing when equal", () => {
  const p = project();
  expect(withBriefField(p, "brief", "A runner at dawn.")).toBe(p);
  expect(withBriefField(p, "direction", "Warm light.").direction).toBe("Warm light.");
  expect(withBriefField(p, "brief", "x".repeat(DOC_LIMITS.brief + 10)).brief.length).toBe(DOC_LIMITS.brief);
});

test("shot edits find the shot in any scene, keep the sheet's limits, and stamp the sheet", () => {
  const p = project();
  const next = withShotField(p, "shot-2", "framing", "Wide", LATER);
  expect(next.production?.beats?.scenes[0].shots[1].framing).toBe("Wide");
  expect(next.production?.beats?.updatedAt).toBe(LATER);
  expect(withShotField(p, "shot-2", "framing", "Medium", LATER)).toBe(p);
  expect(withShotField(p, "missing", "framing", "Wide", LATER)).toBe(p);
  expect(withShotField(p, "shot-1", "framing", "y".repeat(500), LATER).production?.beats?.scenes[0].shots[0].framing.length).toBe(200);
});

test("a shot's length is 0.5–600 s in halves, and clearing it removes the field", () => {
  const p = project();
  expect(withShotDuration(p, "shot-1", 7.3, LATER).production?.beats?.scenes[0].shots[0].duration).toBe(7.5);
  expect(withShotDuration(p, "shot-1", 0, LATER).production?.beats?.scenes[0].shots[0].duration).toBe(0.5);
  expect(withShotDuration(p, "shot-1", 9999, LATER).production?.beats?.scenes[0].shots[0].duration).toBe(600);
  const cleared = withShotDuration(p, "shot-1", null, LATER).production?.beats?.scenes[0].shots[0];
  expect(cleared && "duration" in cleared).toBe(false);
  expect(withShotDuration(p, "shot-1", Number.NaN, LATER)).toBe(p);
});

test("a new shot goes at the end of the last scene, or starts the sheet", () => {
  const added = withNewShot(project(), SHA, LATER)!;
  const shots = added.project.production!.beats!.scenes[0].shots;
  expect(shots).toHaveLength(4);
  expect(shots[3].id).toBe(added.id);
  const fresh = withNewShot(project({ production: undefined }), SHA, LATER)!;
  expect(fresh.project.production?.beats?.scriptSha256).toBe(SHA);
  expect(fresh.project.production?.beats?.scenes[0].shots.map((s) => s.id)).toEqual([fresh.id]);
});

test("a shot taken out comes back at its place (Undo), and only into its own scene", () => {
  const p = project();
  const out = withoutShot(p, "shot-2", LATER)!;
  expect(out.project.production?.beats?.scenes[0].shots.map((s) => s.id)).toEqual(["shot-1", "shot-3"]);
  const back = withShotBack(out.project, out.removal, LATER)!;
  expect(back.production?.beats?.scenes[0].shots.map((s) => s.id)).toEqual(["shot-1", "shot-2", "shot-3"]);
  expect(withoutShot(p, "missing", LATER)).toBeNull();
  const gone = { ...out.project, production: { ...out.project.production, beats: { ...out.project.production!.beats!, scenes: [] } } };
  expect(withShotBack(gone, out.removal, LATER)).toBeNull();
});

test("the brief card's height grows with its words, within 200–720", () => {
  const short = briefDocHeight({ title: "Test film", brief: "A runner at dawn.", look: "Cold light.", footer: "16:9 · 24 fps" });
  const long = briefDocHeight({ title: "Test film", brief: "word ".repeat(200), look: "Cold light.", footer: "16:9 · 24 fps" });
  expect(BRIEF_DOC_WIDTH).toBe(220);
  expect(short).toBeGreaterThanOrEqual(200);
  expect(long).toBeGreaterThan(short);
  expect(briefDocHeight({ title: "x", brief: "word ".repeat(5000), look: "", footer: "" })).toBe(720);
});
