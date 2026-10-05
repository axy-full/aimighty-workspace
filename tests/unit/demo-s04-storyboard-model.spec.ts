import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import { DEFAULT_BOARDS, frameRequest, type Boards } from "../../lib/production/boards";
import { frameState, frameToDraw, framePicture, pendingFrames, shotName, storyboard, withLandedFrame, withPendingFrame } from "../../components/graphite/board/cards/storyboard/model";
import { frameTileHeight, ratioOf } from "../../components/graphite/board/cards/storyboard/FrameTile";

/* The Storyboard group (design/particl-graphite/README.md § 3.1 d): a frame per shot, read from the draft. */

const NOW = "2026-10-05T10:00:00.000Z";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const beats: BeatSheet = {
  scriptSha256: SHA, updatedAt: NOW,
  scenes: [{
    id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-1", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 4 },
      { id: "shot-2", description: "A runner crests the hill.", framing: "Medium push", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 6 },
      { id: "shot-3", description: "Her breath in the cold air.", framing: "", movement: "", lighting: "", sound: "", duration: 5 },
    ],
  }],
};

function project(boards?: Boards, over: Partial<Project> = {}): Project {
  return { ...newProject("Test film"), aspect: "16:9", productionProjectId: "prod-1", production: { beats, ...(boards ? { boards } : {}) }, ...over };
}

const drawn = (genId: string) => ({ prompt: "p", takes: [{ genId, style: "live" as const, at: NOW }] });

test("every shot is a frame tile: its number, framing and the line the design writes", () => {
  const board = storyboard(project());
  expect(board.title).toBe("Storyboard");
  expect(board.frames.map((f) => [f.name, f.line])).toEqual([
    ["Shot 1 · Extreme wide", "1 · 0:00 · 4 s · Locked off · 24mm"],
    ["Shot 2 · Medium push", "2 · 0:04 · 6 s · Slow push · 35mm"],
    ["Shot 3 · Her breath in the cold air.", "3 · 0:10 · 5 s"],
  ]);
  expect(board.missing).toEqual(["shot-1", "shot-2", "shot-3"]);
  expect(board.meta).toBe("3 shots · no frames yet");
  expect(board.state).toBe("needs");
});

test("frames drawn: the look names the group, and the rail asks for the approval", () => {
  const boards: Boards = { ...DEFAULT_BOARDS, frames: { "shot-1": drawn("g1"), "shot-2": drawn("g2"), "shot-3": drawn("g3") } };
  const board = storyboard(project(boards), { look: "Warm dawn" });
  expect(board.meta).toBe("Warm dawn · 3 frames");
  expect(board.summary).toBe("3 frames · approve to make shots");
  expect(board.frames.map((f) => f.genId)).toEqual(["g1", "g2", "g3"]);
  expect(board.missing).toEqual([]);
  /* Without a picked look, the board's own frame style names it. */
  expect(storyboard(project(boards)).meta).toBe("Live action · 3 frames");
  const approved = storyboard(project(boards), { approved: true });
  expect([approved.state, approved.summary]).toEqual(["done", "3 frames · approved"]);
});

test("a frame on its way makes the group working; part-drawn says how many", () => {
  const boards: Boards = { ...DEFAULT_BOARDS, frames: { "shot-1": drawn("g1"), "shot-2": { prompt: "p", takes: [], pending: [{ jobId: "job-2", style: "live", at: NOW }] } } };
  const board = storyboard(project(boards));
  expect(board.state).toBe("working");
  expect(board.summary).toBe("Drawing 1 frame");
  expect(board.meta).toBe("1 of 3 frames");
  expect(board.missing).toEqual(["shot-3"]);
  expect(board.frames[1].rendering).toBe(true);
});

test("no shots: an empty region", () => {
  const board = storyboard(project(undefined, { production: undefined }));
  expect([board.state, board.summary, board.meta, board.frames.length]).toEqual(["empty", "Nothing yet", "", 0]);
});

test("the picture is the frame's pick while it has it, else its newest take", () => {
  expect(framePicture(undefined)).toBeNull();
  expect(framePicture({ prompt: "", takes: [] })).toBeNull();
  const two = { prompt: "", takes: [{ genId: "new", style: "live" as const, at: NOW }, { genId: "old", style: "live" as const, at: NOW }] };
  expect(framePicture(two)).toBe("new");
  expect(framePicture({ ...two, selected: "old" })).toBe("old");
  expect(framePicture({ ...two, selected: "gone" })).toBe("new");
});

test("a shot with no framing is named by what it shows, cut short", () => {
  expect(shotName({ id: "x", description: "", framing: "", movement: "", lighting: "", sound: "" }, 4)).toBe("Shot 4");
  expect(shotName({ id: "x", description: "one two three four five six seven", framing: "", movement: "", lighting: "", sound: "" }, 1)).toBe("Shot 1 · one two three four five six");
});

test("drawing a missing frame sends its own prompt, or one started from the shot, as the existing frame request", () => {
  const p = project();
  const frame = frameToDraw(p, "shot-1")!;
  expect(frame.prompt).toContain("Fog lifts off the valley.");
  expect(frame.prompt).toContain("Framing: Extreme wide.");
  const body = frameRequest(p, DEFAULT_BOARDS, frame)!;
  expect(body.kind).toBe("image");
  expect(body.model.id).toBe(DEFAULT_BOARDS.model);
  expect(body.ratio).toBe("16:9");
  expect(body.mapping).toEqual({ shotId: "", productionProjectId: "prod-1" });
  const own = project({ ...DEFAULT_BOARDS, frames: { "shot-2": { prompt: "My own words.", takes: [] } } });
  expect(frameToDraw(own, "shot-2")!.prompt).toBe("My own words.");
  expect(frameToDraw(p, "missing")).toBeNull();
  /* No production yet: nothing can be sent. */
  expect(frameRequest(project(undefined, { productionProjectId: undefined }), DEFAULT_BOARDS, frame)).toBeNull();
});

test("the List view's state until the Shots cards say more", () => {
  const boards: Boards = { ...DEFAULT_BOARDS, frames: { "shot-1": drawn("g1"), "shot-2": { prompt: "p", takes: [], pending: [{ jobId: "j", style: "live", at: NOW }] } } };
  const p = project(boards);
  expect(frameState(p, "shot-1")).toEqual({ label: "Storyboarded", tone: "quiet" });
  expect(frameState(p, "shot-2")).toEqual({ label: "Drawing", tone: "accent" });
  expect(frameState(p, "shot-3")).toEqual({ label: "Planned", tone: "quiet" });
});

test("a frame sent keeps the prompt it went with and its job; the job's end files the picture once", async () => {
  const p = project();
  const sent = frameToDraw(p, "shot-1")!;
  const pending = withPendingFrame(p, "shot-1", sent, { jobId: "job-1", style: "live", at: NOW });
  expect(pendingFrames(pending)).toEqual([{ shotId: "shot-1", jobId: "job-1" }]);
  expect(pending.production?.boards?.frames["shot-1"].prompt).toBe(sent.prompt);
  /* The same job twice changes nothing. */
  expect(withPendingFrame(pending, "shot-1", sent, { jobId: "job-1", style: "live", at: NOW })).toBe(pending);
  const landed = withLandedFrame(pending, "shot-1", "job-1", "gen-1", "2026-10-05T10:01:00.000Z");
  const frame = landed.production!.boards!.frames["shot-1"];
  expect(frame.pending).toEqual([]);
  expect(frame.takes.map((t) => t.genId)).toEqual(["gen-1"]);
  expect(frame.selected).toBe("gen-1");
  expect(landed.assets.filter((a) => a.id === "gen-1").map((a) => [a.category, a.name, a.url])).toEqual([["Storyboard", "Frame 1.1", "/api/media/gen-1"]]);
  /* Landing again (another window read it too) files nothing twice. */
  expect(withLandedFrame(landed, "shot-1", "job-1", "gen-1", NOW)).toBe(landed);
  expect(storyboard(landed).frames[0].genId).toBe("gen-1");
});

test("a job that did not render leaves the frame empty and files nothing", () => {
  const p = project();
  const pending = withPendingFrame(p, "shot-2", frameToDraw(p, "shot-2")!, { jobId: "job-2", style: "live", at: NOW });
  const failed = withLandedFrame(pending, "shot-2", "job-2", null, NOW);
  expect(failed.production?.boards?.frames["shot-2"].takes).toEqual([]);
  expect(failed.assets).toEqual(pending.assets);
  expect(storyboard(failed).missing).toContain("shot-2");
});

test("a tile's box follows the project's aspect", () => {
  expect(ratioOf("16:9")).toBe("16 / 9");
  expect(ratioOf("9:16")).toBe("9 / 16");
  expect(ratioOf("nonsense")).toBe("16 / 9");
  expect(frameTileHeight(340, "16:9")).toBe(267);
  expect(frameTileHeight(340, "1:1")).toBe(415);
});
