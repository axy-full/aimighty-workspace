import { test, expect } from "@playwright/test";
import type { Generation } from "../../lib/jobs";
import type { LibraryUpload } from "../../lib/genLibrary";
import { libraryEntries, type LibraryEntry } from "../../lib/workspace/library";
import { nextActions } from "../../lib/shell/next-actions";

/* Idea 12, first slice: which existing tool each take goes on to — navigation only, never a price. */
const gen = (id: string, over: Partial<Generation> = {}) => ({
  id, projectId: "prod", kind: "image", model: "m", prompt: id, title: id, params: {}, status: "succeeded", storedUrl: `/api/media/${id}`,
  reviewState: "", createdAt: 1_000, updatedAt: 1_000, ...over,
}) as Generation;
const up = (id: string, over: Partial<LibraryUpload> = {}) => ({ id, filename: `${id}.png`, mime: "image/png", kind: "image", bytes: 1, width: 1, height: 1, durationS: null, sha256: "", url: `/api/uploads/${id}`, createdAt: 900, ...over }) as LibraryUpload;
const one = (generations: Generation[], uploads: LibraryUpload[] = []): LibraryEntry => libraryEntries({ generations, uploads })[0];
const saved = { saved: true };

test("a still is re-edited, a clip edited, a sound opens Edit & Sound — generated or uploaded alike", () => {
  expect(nextActions(one([gen("g_still")]), saved)).toEqual([{ id: "re-edit", label: "Re-edit", opens: "the take in Shots, on the board", enabled: true, why: null }]);
  expect(nextActions(one([gen("g_clip", { kind: "video" })]), saved)).toEqual([{ id: "edit", label: "Edit", opens: "the take in Shots, on the board", enabled: true, why: null }]);
  expect(nextActions(one([gen("g_voice", { kind: "audio" })]), saved)).toEqual([{ id: "edit-sound", label: "Edit & Sound", opens: "Edit & Sound", enabled: true, why: null }]);
  expect(nextActions(one([], [up("u_plate")]), saved).map((a) => [a.id, a.enabled])).toEqual([["re-edit", true]]);
  expect(nextActions(one([], [up("u_clip", { mime: "video/mp4", kind: "video", filename: "clip.mp4" })]), saved).map((a) => [a.id, a.enabled])).toEqual([["edit", true]]);
  expect(nextActions(one([], [up("u_tone", { mime: "audio/mpeg", kind: "audio", filename: "tone.mp3" })]), saved).map((a) => a.id)).toEqual(["edit-sound"]);
  /* No label carries a price; each names what it opens. */
  for (const a of [...nextActions(one([gen("g")]), saved), ...nextActions(one([gen("v", { kind: "video" })]), saved)]) expect(`${a.label} ${a.opens}`).not.toMatch(/\d|credit|\$/i);
});

test("only a stored original is actionable: a take in flight, held, failed, stopped or without its copy says why", () => {
  const why = (g: Partial<Generation>) => nextActions(one([gen("g", g)]), saved)[0];
  expect(why({ status: "running", storedUrl: null })).toMatchObject({ enabled: false, why: "It opens once it has rendered." });
  expect(why({ status: "held", storedUrl: null })).toMatchObject({ enabled: false, why: "It opens once it has rendered." });
  expect(why({ status: "failed", storedUrl: null, error: "refused" })).toMatchObject({ enabled: false, why: "It did not render, so there is nothing to edit." });
  expect(why({ status: "succeeded", storedUrl: null })).toMatchObject({ enabled: false, why: "Its stored copy is not here yet." });
  expect(nextActions(one([gen("v", { kind: "video", status: "failed", storedUrl: null })]), saved)[0]).toMatchObject({ id: "edit", enabled: false });
  /* A sound's Edit & Sound opens the project's editor, which does not take the sound as an input: nothing to wait for. */
  expect(nextActions(one([gen("a", { kind: "audio", status: "running", storedUrl: null })]), saved)[0]).toMatchObject({ id: "edit-sound", enabled: true });
});

test("an unsaved project cannot re-edit or edit yet; a file with no picture or sound has no next tool; unknown kinds none", () => {
  expect(nextActions(one([gen("g")]), { saved: false })[0]).toMatchObject({ enabled: false, why: "Saving this project…" });
  expect(nextActions(one([gen("v", { kind: "video" })]), { saved: false })[0]).toMatchObject({ enabled: false, why: "Saving this project…" });
  expect(nextActions(one([], [up("u_doc", { mime: "application/pdf", kind: "file", filename: "script.pdf" })]), saved)).toEqual([]);
  expect(nextActions(one([gen("m", { kind: "model" })]), saved)).toEqual([]);
  /* An upload the browser cannot show inline has no stored picture to open the tools on. */
  expect(nextActions(one([], [up("u_raw", { mime: "image/x-canon-cr2", filename: "plate.cr2" })]), saved)[0]).toMatchObject({ id: "re-edit", enabled: false, why: "This file type cannot be edited here." });
});
