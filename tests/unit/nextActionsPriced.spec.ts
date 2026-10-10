import { test, expect } from "@playwright/test";
import type { Generation } from "../../lib/jobs";
import type { LibraryUpload } from "../../lib/genLibrary";
import { libraryEntries, type LibraryEntry } from "../../lib/workspace/library";
import {
  DRAFT_WHY, SEEDANCE_25, UNREAD_LENGTH, aboutCredits, extendPrompt, madeFrom, nearestRatio, nextActionBody, nextActions, nextDefaults, nextEngine, nextProblem, nextRatios, nextShotOf,
  nextSourceOf, notOfferedLine, pricedActions, repricedNote, sourceFacts, topazScales, type NextSettings,
} from "../../lib/shell/next-actions";
import { getModel } from "../../lib/models";
import { getTask, hasTrigger, sourceProblem } from "../../lib/tasks";
import { ASTRA_MODEL, DEFAULT_ASTRA } from "../../lib/astra";
import { DEFAULT_TOPAZ_IMAGE, TOPAZ_IMAGE_MODEL } from "../../lib/topaz";

/*
 * Idea 12, second slice: the priced Next actions. Which engine each runs on (engines Particl already calls directly), what a
 * take cannot have and why, the exact request each sends to the quote and then the paid route, where the new take is filed,
 * and how a take records what it was made from. Pure; nothing here is sent.
 */
const gen = (id: string, over: Partial<Generation> = {}) => ({
  id, projectId: "prod", kind: "image", model: "gemini-3.1-flash-image", prompt: id, title: id, params: {}, status: "succeeded",
  storedUrl: `/api/media/${id}`, reviewState: "", createdAt: 1_000, updatedAt: 1_000, shotId: null, task: "generate", sourceGenId: null, ...over,
}) as Generation;
const up = (id: string, over: Partial<LibraryUpload> = {}) => ({
  id, filename: `${id}.png`, mime: "image/png", kind: "image", bytes: 400_000, width: 1920, height: 1080, durationS: null, sha256: "", url: `/api/uploads/${id}`, createdAt: 900, ...over,
}) as LibraryUpload;
const one = (generations: Generation[], uploads: LibraryUpload[] = []): LibraryEntry => libraryEntries({ generations, uploads })[0];
const saved = { saved: true };
const clip = (over: Partial<Generation> = {}) => gen("g_clip", { kind: "video", model: SEEDANCE_25, params: { resolution: "720p", duration: 8, ratio: "16:9" }, ...over });

test("each kind of take is offered the actions an engine here does, on that engine; a sound's are said as not offered", () => {
  const still = pricedActions(one([gen("g_still")]), saved);
  expect(still.map((a) => [a.id, a.label, a.engine, a.offered, a.enabled])).toEqual([
    ["upscale", "Upscale", "Topaz Image Upscale", true, true],
    ["outpaint", "Outpaint", "Bria Expand", true, true],
    ["animate", "Animate", "Seedance 2.5", true, true],
  ]);
  const video = pricedActions(one([clip()]), saved);
  expect(video.map((a) => [a.id, a.engine, a.offered, a.enabled])).toEqual([
    ["upscale", "Topaz Astra 2", true, true],
    ["reframe", "Luma Ray 2", true, true],
    ["extend", "Seedance 2.5", true, true],
  ]);
  /* The engines are the registry's own rows, each serving exactly that work. */
  expect(nextEngine("image", "upscale")?.id).toBe(TOPAZ_IMAGE_MODEL);
  expect(nextEngine("image", "outpaint")?.stillTask).toBe("outpaint");
  expect(nextEngine("video", "upscale")?.id).toBe(ASTRA_MODEL);
  expect(nextEngine("video", "reframe")?.supportsTasks).toContain("reframe");
  expect(nextEngine("video", "extend")?.supportsTasks).toContain("extend");
  expect(nextEngine("image", "extend")).toBeNull();
  expect(nextEngine("audio", "upscale")).toBeNull();
  /* Cut out is not here: the Rig's own cut-out path brings it. */
  expect([...still, ...video].map((a) => a.id)).not.toContain("cutout");

  const sound = pricedActions(one([gen("g_voice", { kind: "audio", model: "eleven_v3" })]), saved);
  expect(sound.map((a) => [a.id, a.offered, a.enabled, a.engine])).toEqual([["upscale", false, false, null], ["extend", false, false, null]]);
  expect(notOfferedLine(sound)).toBe("Upscale and Extend are not offered: no engine Particl uses upscales or extends sound.");
  expect(notOfferedLine(still)).toBeNull();
  /* A file with no picture or sound has none at all. */
  expect(pricedActions(one([], [up("u_doc", { mime: "application/pdf", kind: "file", filename: "script.pdf" })]), saved)).toEqual([]);
  /* No label carries a price: the estimate is on the action's own button, once it is opened. */
  for (const a of [...still, ...video, ...sound]) expect(a.label).not.toMatch(/\d|cr\b|credit/i);
});

test("a take that cannot go yet says why, once for the whole row; the engine's own limits on a source say why for that action", () => {
  const whys = (g: Partial<Generation>, context = saved) => pricedActions(one([gen("g", g)]), context).map((a) => [a.enabled, a.why]);
  expect(whys({ status: "running", storedUrl: null })).toEqual(Array(3).fill([false, "It opens once it has rendered."]));
  expect(whys({ status: "failed", storedUrl: null, error: "refused" })).toEqual(Array(3).fill([false, "It did not render, so there is nothing to edit."]));
  expect(whys({ status: "succeeded", storedUrl: null })).toEqual(Array(3).fill([false, "Its stored copy is not here yet."]));
  expect(whys({}, { saved: false })).toEqual(Array(3).fill([false, "Saving this project…"]));

  /* Extend reads 480p or 720p clips of 4 to 30 seconds (the vendor's rule, lib/tasks.ts sourceProblem); Reframe and Upscale take five minutes. */
  const clipWhy = (params: Record<string, unknown>) => Object.fromEntries(pricedActions(one([clip({ params })]), saved).map((a) => [a.id, a.why]));
  expect(clipWhy({ resolution: "1080p", duration: 8 })).toEqual({ upscale: null, reframe: null, extend: "Extend takes a 480p or 720p clip; this one is 1080p." });
  expect(clipWhy({ resolution: "4k", duration: 8 }).extend).toBe("Extend takes a 480p or 720p clip; this one is 4K.");
  expect(clipWhy({ resolution: "720p", duration: 3 })).toEqual({ upscale: null, reframe: null, extend: "Extend takes a clip of 4 seconds or more; this one is 3s." });
  expect(clipWhy({ resolution: "480p", duration: 45 })).toEqual({ upscale: null, reframe: null, extend: "Extend takes a clip of 30 seconds or less; this one is 45s." });
  expect(clipWhy({ resolution: "720p", duration: 400 })).toEqual({
    upscale: "Topaz takes clips of five minutes or less; this one is 400s.",
    reframe: "Reframe takes clips of five minutes or less; this one is 400s.",
    extend: "Extend takes a clip of 30 seconds or less; this one is 400s.",
  });
  /* Unknown settings do not block: the quote asks the server, which measures the original. */
  expect(clipWhy({})).toEqual({ upscale: null, reframe: null, extend: null });
  /* A draft carries the engine's watermark: nothing paid is made from it; its final is the take to go on from. Its Edit still opens. */
  const draft = one([clip({ params: { draft: true, resolution: "480p", duration: 5, ratio: "16:9" } })]);
  expect(pricedActions(draft, saved).map((a) => [a.id, a.enabled, a.why])).toEqual([["upscale", false, DRAFT_WHY], ["reframe", false, DRAFT_WHY], ["extend", false, DRAFT_WHY]]);
  expect(nextActions(draft, saved).map((a) => a.enabled)).toEqual([true]);
  expect(pricedActions(one([clip({ params: { finalOf: "g_draft", resolution: "1080p", duration: 5, ratio: "16:9" } })]), saved).find((a) => a.id === "upscale")!.enabled).toBe(true);
  /* Extend's words only restate the vendor's rule: it blocks exactly where sourceProblem does. */
  for (const resolution of ["480p", "720p", "1080p", "4k", undefined]) for (const duration of [2, 4, 8, 30, 31, undefined]) {
    const blocked = pricedActions(one([clip({ params: { resolution, duration } })]), saved).find((a) => a.id === "extend")!.enabled === false;
    expect(blocked, `${resolution} ${duration}`).toBe(Boolean(sourceProblem(getTask("extend"), { resolution, duration })));
  }

  /* An uploaded clip is priced by its own seconds: a length its size cannot back is not guessed at (lib/clipTrust.ts). */
  const upClip = (over: Partial<LibraryUpload>) => pricedActions(one([], [up("u_clip", { mime: "video/mp4", kind: "video", filename: "clip.mp4", width: 1280, height: 720, ...over })]), saved);
  expect(upClip({ durationS: null }).map((a) => [a.id, a.enabled])).toEqual([["upscale", true], ["reframe", false], ["extend", false]]);
  /* One reason for both: the row says it once. */
  expect(upClip({ durationS: null }).filter((a) => !a.enabled).map((a) => a.why)).toEqual([UNREAD_LENGTH, UNREAD_LENGTH]);
  expect(UNREAD_LENGTH).toBe("This clip's length could not be read, so it can only be upscaled. Re-export it as an MP4 and upload it again.");
  expect(upClip({ durationS: 8, bytes: 4_000_000 }).every((a) => a.enabled)).toBe(true);
  /* A still already over Topaz's 48 megapixels cannot be upscaled at all; the scales it cannot take are named in the panel. */
  const huge = one([], [up("u_huge", { width: 9000, height: 6000 })]);
  expect(pricedActions(huge, saved).find((a) => a.id === "upscale")).toMatchObject({ enabled: false, why: "Upscale: this still is already over the 48-megapixel limit." });
  expect(topazScales(sourceFacts(one([], [up("u_big", { width: 4000, height: 3000 })]))).map((s) => [s.factor, s.why])).toEqual([[1, null], [2, null], [4, "Over the 48-megapixel limit for this still"]]);
  expect(topazScales(sourceFacts(one([gen("g")]))).every((s) => s.why === null)).toBe(true);
});

const PROD = "prod";
const body = (settings: NextSettings, entry: LibraryEntry, extra: { reason?: string; maxCredits?: number; quoteFingerprint?: string } = {}) =>
  nextActionBody({ settings, source: nextSourceOf(entry), productionProjectId: PROD, shotId: nextShotOf(entry, PROD), ...extra });

test("each action's request: the engine, the source by its stored identity, the settings, and where the new take is filed", () => {
  const still = one([gen("g_still", { shotId: "shot_1", params: { ratio: "16:9" } })]);
  expect(body(nextDefaults("upscale", still), still)).toEqual({
    projectId: PROD, shotId: "shot_1", refine: false, model: TOPAZ_IMAGE_MODEL, task: "generate", prompt: "", resolution: "24MP", ratio: "adaptive",
    topaz: DEFAULT_TOPAZ_IMAGE, references: [{ genId: "g_still", role: "reference_image" }],
  });
  expect(body({ action: "outpaint", ratio: "9:16", prompt: "  more sky  " }, still)).toEqual({
    projectId: PROD, shotId: "shot_1", refine: false, model: "fal-ai/bria/expand", prompt: "more sky", ratio: "9:16", resolution: "adaptive",
    references: [{ genId: "g_still", role: "reference_image" }],
  });
  /* Animate: the still is the clip's FIRST FRAME, never an ordinary reference; the shape is a real one, so it can be priced. */
  expect(body({ action: "animate", prompt: "She turns", ratio: "16:9", resolution: "720p", duration: 5, audio: false }, still)).toEqual({
    projectId: PROD, shotId: "shot_1", refine: false, model: SEEDANCE_25, task: "generate", prompt: "She turns", ratio: "16:9", resolution: "720p", duration: 5,
    generateAudio: false, references: [{ genId: "g_still", role: "first_frame" }],
  });

  const video = one([clip({ shotId: "shot_2" })]);
  expect(body(nextDefaults("upscale", video), video)).toEqual({
    projectId: PROD, shotId: "shot_2", refine: false, model: ASTRA_MODEL, task: "upscale", prompt: "", resolution: "4k", fps60: false,
    astra: { ...DEFAULT_ASTRA, fps: 30 }, sourceGenId: "g_clip", references: [],
  });
  expect(body({ action: "upscale", media: "video", fps: 60 }, video)).toMatchObject({ fps60: true, astra: { fps: 60 } });
  expect(body({ action: "reframe", ratio: "1:1", prompt: "" }, video)).toEqual({
    projectId: PROD, shotId: "shot_2", refine: false, model: "fal-ai/luma-dream-machine/ray-2-flash/reframe", task: "reframe", prompt: "", ratio: "1:1",
    resolution: "adaptive", sourceGenId: "g_clip", references: [],
  });
  const forward = body({ action: "extend", direction: "forward", prompt: "the ferry clears the harbour", resolution: "720p", duration: 6, audio: true }, video);
  expect(forward).toEqual({
    projectId: PROD, shotId: "shot_2", refine: false, model: SEEDANCE_25, task: "extend", prompt: "Continue from the final frame: the ferry clears the harbour",
    ratio: "adaptive", resolution: "720p", duration: 6, generateAudio: true, sourceGenId: "g_clip", references: [],
  });
  /* The vendor reads the intent from the words: both directions carry its own trigger. */
  expect(extendPrompt("backward", " she walks up ")).toBe("Extend backward: she walks up");
  for (const direction of ["forward", "backward"] as const) expect(hasTrigger(getTask("extend"), extendPrompt(direction, "x"))).toBe(true);

  /* An upload is cited as an upload, never re-uploaded, and has no shot. */
  const plate = one([], [up("u_plate")]);
  expect(body(nextDefaults("outpaint", plate), plate)).toMatchObject({ shotId: "", references: [{ uploadId: "u_plate", role: "reference_image" }] });
  const upClip = one([], [up("u_clip", { mime: "video/mp4", kind: "video", filename: "c.mp4", durationS: 8 })]);
  expect(body(nextDefaults("extend", upClip), upClip)).toMatchObject({ sourceUploadId: "u_clip", shotId: "" });
  expect(body(nextDefaults("extend", upClip), upClip)).not.toHaveProperty("sourceGenId");

  /* A take filed in another production keeps its shot to itself. */
  expect(nextShotOf(one([gen("g_else", { projectId: "other", shotId: "shot_9" })]), PROD)).toBe("");
  /* The approved shot's reason, cleaned as admission stores it; the approval of a fresh quote, only when sent. */
  expect(body(nextDefaults("upscale", still), still, { reason: "  for   delivery " })).toMatchObject({ reason: "for delivery" });
  expect(body(nextDefaults("upscale", still), still, { reason: "no" })).not.toHaveProperty("reason");
  expect(body(nextDefaults("upscale", still), still, { maxCredits: 12, quoteFingerprint: "f".repeat(64) })).toMatchObject({ maxCredits: 12, quoteFingerprint: "f".repeat(64) });
  expect(body(nextDefaults("upscale", still), still)).not.toHaveProperty("maxCredits");
  /* The original is kept: a request names its source only to read it; nothing in it replaces, finalises or deletes a take. */
  for (const b of [forward, body(nextDefaults("upscale", still), still)]) for (const key of ["finalOf", "trashed", "delete", "replace", "id"]) expect(b).not.toHaveProperty(key);
});

test("where each action starts: the engine's usual settings, shaped to the source; words are asked for where the engine needs them", () => {
  const wide = one([gen("g_wide", { params: { ratio: "16:9" } })]);
  const tall = one([], [up("u_tall", { width: 1080, height: 1920 })]);
  expect(nextDefaults("outpaint", wide)).toEqual({ action: "outpaint", ratio: "9:16", prompt: "" });
  expect(nextDefaults("outpaint", tall)).toEqual({ action: "outpaint", ratio: "16:9", prompt: "" });
  expect(nextDefaults("animate", tall)).toMatchObject({ ratio: "9:16", resolution: "720p", duration: 5, audio: false });
  expect(nextDefaults("animate", one([gen("g_unknown")]))).toMatchObject({ ratio: "16:9" });
  expect(nextDefaults("upscale", one([], [up("u_big", { width: 5000, height: 4000 })]))).toMatchObject({ topaz: { factor: 1 } });
  expect(nextDefaults("extend", one([clip({ params: { resolution: "480p", duration: 6 } })]))).toEqual({ action: "extend", direction: "forward", prompt: "", resolution: "480p", duration: 5, audio: true });
  expect(nextDefaults("reframe", one([clip()]))).toEqual({ action: "reframe", ratio: "9:16", prompt: "" });
  /* Only a real shape prices a first frame, and each list is the engine's own. */
  expect(nextRatios("animate")).not.toContain("adaptive");
  expect(nextRatios("animate")).toEqual(getModel(SEEDANCE_25).ratios.filter((r) => r !== "adaptive"));
  expect(nextRatios("reframe")).toEqual(getModel("fal-ai/luma-dream-machine/ray-2-flash/reframe").ratios);
  expect(nearestRatio("4:5", ["16:9", "9:16", "1:1"])).toBe("1:1");
  expect(nearestRatio(null, ["16:9"])).toBeNull();
  expect(nextProblem({ action: "animate", prompt: " ", ratio: "16:9", resolution: "720p", duration: 5, audio: false })).toBe("Write what moves.");
  expect(nextProblem({ action: "extend", direction: "backward", prompt: "", resolution: "720p", duration: 5, audio: true })).toBe("Write what happens next.");
  expect(nextProblem({ action: "outpaint", ratio: "1:1", prompt: "" })).toBeNull();
});

test("a new take names what it was made from — a still tool's still, a clip task's source, a clip's first frame — and nothing else does", () => {
  /* As admission records each: a still tool's one still in params.references; a clip task's source in its column or params; a first frame by its role. */
  expect(madeFrom(gen("g_up", { model: TOPAZ_IMAGE_MODEL, params: { references: [{ genId: "g_still", role: "reference_image", kind: "image" }] } }))).toEqual({ source: "generation:g_still", action: "upscale" });
  expect(madeFrom(gen("g_out", { model: "fal-ai/bria/expand", params: { references: [{ uploadId: "u_plate", role: "reference_image", kind: "image" }] } }))).toEqual({ source: "upload:u_plate", action: "outpaint" });
  expect(madeFrom(gen("g_x", { kind: "video", model: SEEDANCE_25, task: "extend", sourceGenId: "g_clip", params: { task: "extend", sourceGenId: "g_clip" } }))).toEqual({ source: "generation:g_clip", action: "extend" });
  expect(madeFrom(gen("g_r", { kind: "video", model: "fal-ai/luma-dream-machine/ray-2-flash/reframe", task: "reframe", params: { task: "reframe", sourceUploadId: "u_clip" } }))).toEqual({ source: "upload:u_clip", action: "reframe" });
  expect(madeFrom(gen("g_a", { kind: "video", model: ASTRA_MODEL, task: "upscale", sourceGenId: "g_clip", params: { task: "upscale" } }))).toEqual({ source: "generation:g_clip", action: "upscale" });
  expect(madeFrom(gen("g_m", { kind: "video", model: SEEDANCE_25, params: { references: [{ genId: "g_still", role: "first_frame", kind: "image" }] } }))).toEqual({ source: "generation:g_still", action: "first frame" });
  /* A take made from words, or with ordinary references, came from no one take. */
  expect(madeFrom(gen("g_plain"))).toBeNull();
  expect(madeFrom(gen("g_ref", { params: { references: [{ genId: "g_still", role: "reference_image", kind: "image" }] } }))).toBeNull();
  expect(madeFrom(gen("g_v", { kind: "video", model: SEEDANCE_25, params: { references: [{ genId: "g_still", role: "reference_image", kind: "image" }] } }))).toBeNull();
});

test("money words: an estimate is 'about N cr'; a moved one is asked about again, naming the button", () => {
  expect(aboutCredits(1234)).toBe("about 1,234 cr");
  expect(repricedNote("Upscale", 14)).toBe("The estimate is now about 14 cr. Press Upscale again to approve it.");
  expect(repricedNote("Retry", 9)).toBe("The estimate is now about 9 cr. Press Retry again to approve it.");
});
