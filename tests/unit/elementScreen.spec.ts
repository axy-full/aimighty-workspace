import { test, expect } from "@playwright/test";
import {
  attributeRows, wiredInto, usedByLine, spreadOf, sourceOf, versionMeta,
  lockLabel, lockNote, addLabel, hasPorts, EMPTY_USE,
  type ElementIn, type ElementUse,
} from "../../lib/elementScreen";

/* One element's ports (SOW §9, surface 2b). The screen's numbers are the ones
   the impact panel will price if a version is swapped, so what is tested here
   is that they mean the same thing on both sides — a row saying eight shots
   and a panel then charging for nine would make both untrustworthy, and the
   panel is the one that spends. */

const v = (id: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, status: "ready", ...extra });

const cass: ElementIn = {
  id: "el", kind: "character", name: "Cass", locked: false, fromShotId: null,
  attributes: [
    { id: "face", kind: "face", label: "face", currentId: "f3", locked: true,
      versions: [v("f1", ""), v("f2", ""), v("f3", "", { identityId: "id1" })] },
    { id: "hair", kind: "hair", label: "hair", currentId: "h1", locked: true,
      versions: [v("h1", "", { uploadId: "up1" })] },
    { id: "ward", kind: "wardrobe", label: "wardrobe", currentId: "w2", locked: false,
      versions: [v("w1", "waxed coat"), v("w2", "overalls", { genId: "g9" })] },
    { id: "voice", kind: "voice", label: "voice", currentId: "vo1", locked: false,
      versions: [v("vo1", "")] },
  ],
};

const use: ElementUse = {
  shots: 14,
  photos: { id1: 18 },
  from: { g9: "SH03 v2" },
  attributes: [
    { attributeId: "face", following: 14, versions: [
      { versionId: "f1", pinned: 0, takes: 0 },
      { versionId: "f2", pinned: 0, takes: 3 },
      { versionId: "f3", pinned: 0, takes: 11 }] },
    { attributeId: "hair", following: 14, versions: [{ versionId: "h1", pinned: 0, takes: 14 }] },
    { attributeId: "ward", following: 8, versions: [
      { versionId: "w1", pinned: 6, takes: 6 },
      { versionId: "w2", pinned: 0, takes: 8 }] },
    { attributeId: "voice", following: 14, versions: [{ versionId: "vo1", pinned: 0, takes: 0 }] },
  ],
};

test("the header counts the shots that cite the element at all", () => {
  expect(usedByLine(cass, use)).toBe("CHARACTER · USED BY 14 SHOTS");
  expect(usedByLine(cass, { ...use, shots: 1 })).toBe("CHARACTER · USED BY 1 SHOT");
  // Nothing yet is said plainly rather than as a zero.
  expect(usedByLine(cass, EMPTY_USE)).toBe("CHARACTER · NOT IN A SHOT YET");
});

test("the spread separates what MOVES from what stays", () => {
  /* The two halves are different facts. The first is what a swap costs; the
     second is what a swap does not touch. Running them together would put a
     number on the screen that the impact panel then refuses to charge for. */
  expect(spreadOf(cass.attributes[2], use)).toBe("8 shots on v2 · 6 held on v1");
  // Nothing pinned reads as one half only.
  expect(spreadOf(cass.attributes[0], use)).toBe("14 shots on v3");
  // An attribute nothing has counted says nothing rather than "0 shots".
  expect(spreadOf(cass.attributes[0], EMPTY_USE)).toBe("");
});

test("where a version came from is read off its one source column", () => {
  expect(sourceOf(cass.attributes[0].versions[2], use)).toBe("Trained from 18 photos");
  expect(sourceOf(cass.attributes[1].versions[0], use)).toBe("Uploaded");
  expect(sourceOf(cass.attributes[2].versions[1], use)).toBe("Promoted from SH03 v2");
  // An identity whose photo count has gone is not guessed at.
  expect(sourceOf(cass.attributes[0].versions[2], { ...use, photos: {} })).toBe("Trained identity");
  expect(sourceOf(cass.attributes[2].versions[1], { ...use, from: {} })).toBe("Promoted from a take");
  expect(sourceOf(null, use)).toBe("");
  // A version with no source at all says nothing rather than inventing one.
  expect(sourceOf({ id: "x", label: "" }, use)).toBe("");
});

test("a version says what is actually holding it", () => {
  expect(versionMeta(cass.attributes[2].versions[1], true, { versionId: "w2", pinned: 0, takes: 8 }))
    .toBe("in use · 8 takes");
  expect(versionMeta(cass.attributes[2].versions[0], false, { versionId: "w1", pinned: 6, takes: 6 }))
    .toBe("6 shots · 6 takes");
  expect(versionMeta(cass.attributes[3].versions[0], false, { versionId: "vo1", pinned: 0, takes: 0 }))
    .toBe("nothing yet");
  // Still rendering outranks everything: it is not a version you can pick.
  expect(versionMeta({ id: "p", label: "", status: "pending" }, true, { versionId: "p", pinned: 0, takes: 0 }))
    .toBe("still rendering");
  /* And failed is not pending: a version whose views never rendered will not
     render later, so saying "still rendering" leaves somebody waiting for a
     thing that already stopped. */
  expect(versionMeta({ id: "f", label: "", status: "failed" }, false, { versionId: "f", pinned: 0, takes: 0 }))
    .toBe("failed");
  expect(versionMeta({ id: "p", label: "", status: "ready" }, false, { versionId: "p", pinned: 1, takes: 0 }))
    .toBe("1 shot");
});

test("the element's own lock reaches every port", () => {
  const open = attributeRows(cass, use);
  expect(open.map((r) => r.locked)).toEqual([true, true, false, false]);

  /* Somebody who locked a character did not lock three quarters of one. */
  const shut = attributeRows({ ...cass, locked: true }, use);
  expect(shut.every((r) => r.locked)).toBe(true);
});

test("a row reads its port, its version and where both stand", () => {
  const rows = attributeRows(cass, use);
  expect(rows.map((r) => r.name)).toEqual(["FACE", "HAIR", "WARDROBE", "VOICE"]);
  expect(rows[2].at).toBe("v2 overalls");
  expect(rows[2].source).toBe("Promoted from SH03 v2");
  expect(rows[2].spread).toBe("8 shots on v2 · 6 held on v1");
  expect(rows[2].versions.map((x) => x.line)).toEqual(["v1 waxed coat", "v2 overalls"]);
  expect(rows[2].versions.find((x) => x.current)!.id).toBe("w2");

  // An attribute with no version at all says so rather than showing "v0".
  const bare = attributeRows(
    { ...cass, attributes: [{ id: "a", kind: "face", label: "face", currentId: null, locked: false, versions: [] }] },
    EMPTY_USE);
  expect(bare[0].at).toBe("");
  expect(bare[0].versions).toEqual([]);

  /* And versions made with none chosen is a THIRD state, not the same as the
     first: it used to read as "nothing has been made" when something had and
     nobody had picked it. */
  const unchosen = attributeRows(
    { ...cass, attributes: [{ id: "a", kind: "face", label: "face", currentId: null, locked: false,
      versions: [v("f1", ""), v("f2", "")] }] },
    EMPTY_USE);
  expect(unchosen[0].at).toBe("2 versions, none current");
  expect(unchosen[0].versions).toHaveLength(2);
  expect(unchosen[0].versions.some((x) => x.current)).toBe(false);
  expect(hasPorts({ ...cass, attributes: bare.length ? [] : [] })).toBe(false);
  expect(hasPorts(cass)).toBe(true);
});

test("what consumes a port is named from the recipe, not from a fixed list", () => {
  const stages = { visual: ["Keyframes", "Motion"], audio: ["Audio"] };
  const lines = wiredInto(cass, stages);
  expect(lines[0]).toEqual({ stages: "Keyframes · Motion", ports: "FACE · HAIR · WARDROBE", override: false });
  expect(lines[1]).toEqual({ stages: "Audio", ports: "VOICE", override: false });

  /* A production with no audio stage is not told its character's voice is
     wired into one. The stages a workspace runs are its own. */
  const noAudio = wiredInto(cass, { visual: ["Keyframes"], audio: [] });
  expect(noAudio).toHaveLength(1);
  expect(noAudio[0].ports).toBe("FACE · HAIR · WARDROBE");
});

test("every shot that stepped out of line is named, and marked", () => {
  const lines = wiredInto(cass, { visual: ["Keyframes"], audio: ["Audio"] },
    [{ shotCode: "SH03", attributeId: "ward", versionLabel: "v1" }]);
  const over = lines.filter((l) => l.override);
  expect(over).toHaveLength(1);
  expect(over[0]).toEqual({ stages: "SH03 only", ports: "WARDROBE v1", override: true });
});

test("the lock says what it will do, not what it is", () => {
  expect(lockLabel(cass)).toBe("Lock");
  expect(lockLabel({ ...cass, locked: true })).toBe("Unlock");
  expect(lockNote(cass)).toContain("no stage, scene or shot can move it");
  expect(lockNote({ ...cass, locked: true })).toContain("until it is unlocked");
});

test("adding a version is priced only when it would render something", () => {
  /* Free where the material already exists — an upload, or a take that has
     already been paid for. Quoting 12 cr for attaching a photograph somebody
     already owns would be charging for nothing. */
  expect(addLabel(null)).toBe("Add a version");
  expect(addLabel(0)).toBe("Add a version");
  expect(addLabel(12)).toBe("Add a version · 12 cr");
});
