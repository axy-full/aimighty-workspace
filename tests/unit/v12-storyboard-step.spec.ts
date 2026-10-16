import { test, expect } from "@playwright/test";
import { FRAME_REASONS, SHEET_SIZES, frameCards, redoShots, sheetPages, storyboardLine, styleOf, takesOf, withFramePrompt, withPick, withStyle } from "../../lib/v12/board/storyboard-step";
import { withMark } from "../../lib/v12/board/text-steps";
import { stagePage } from "../../lib/v12/board/stages";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";

/**
 * Storyboard cards (lib/v12/board/storyboard-step.ts; demo plan PR 18): one per shot of the beat sheet, drawn on the path that exists,
 * ✓ and ✕ given for the picture they were for, and the board sheet cut into pages.
 */
const shot = (id: string, d: string, duration?: number) => ({ id, description: d, framing: "Wide", movement: "Held", lighting: "", sound: "", ...(duration ? { duration } : {}) });
const sheet: BeatSheet = {
  scriptSha256: "a".repeat(64), updatedAt: "2026-10-16T00:00:00.000Z",
  scenes: [{ id: "s1", heading: "Camp", summary: "", beats: [], characters: [], locations: [], props: [], shots: [shot("sh1", "Camp at night", 4), shot("sh2", "Maya arrives", 3), shot("sh3", "At the water", 3), shot("sh4", "The drink", 5)] }],
};
const take = (genId: string) => ({ genId, style: "live" as const, at: "2026-10-16T00:00:00.000Z" });
function board(): Project {
  return {
    ...newProject("x"),
    production: { beats: sheet, boards: { style: "live", model: "gemini-3.1-flash-image" as never, frames: {
      sh1: { prompt: "", takes: [take("g1")], selected: "g1" },
      sh2: { prompt: "", takes: [take("g2b"), take("g2a")] },
      sh3: { prompt: "", takes: [], pending: [{ jobId: "j3", style: "live", at: "2026-10-16T00:00:00.000Z" }] },
    } } },
  };
}

test("Storyboard is a page of a Film board, and of no other", () => {
  expect(stagePage("storyboard", "film")).toBe("storyboard");
  expect(stagePage("storyboard", "previs")).toBeNull();
});

test("a frame per shot: drawn is Ready (v2 with two takes), being drawn is Making, no frame is Not started", () => {
  const c = frameCards(board());
  expect(c.map((x) => x.status)).toEqual(["ready", "ready", "making", "none"]);
  expect(c[1]).toMatchObject({ genId: "g2b", version: 2 });
  expect(c[0].version).toBeUndefined();
  expect(c[0].name).toBe("Shot 1 · Wide");
  expect(c[3].genId).toBeNull();
});

test("✓ and ✕ hold for the picture they were given for; a new take makes them stale; a ✕ is on the list to draw again", () => {
  let p = board();
  p = { ...p, boardMarks: withMark(p.boardMarks, "sh1", "g1", "approved", 1) };
  p = { ...p, boardMarks: withMark(p.boardMarks, "sh2", "g2b", "rejected", 2, "Framing") };
  expect(frameCards(p).map((x) => x.status)).toEqual(["approved", "rejected", "making", "none"]);
  expect(frameCards(p)[1].reason).toBe("Framing");
  expect(redoShots(p)).toEqual(["sh2"]);
  /* The redraw lands: sh2 shows a new take, so the ✕ no longer applies and nothing is left to draw again. */
  const landed = { ...p, production: { ...p.production, boards: { ...p.production!.boards!, frames: { ...p.production!.boards!.frames, sh2: { prompt: "", takes: [take("g2c"), take("g2b"), take("g2a")], selected: "g2c" } } } } };
  expect(frameCards(landed)[1].status).toBe("ready");
  expect(redoShots(landed)).toEqual([]);
  /* A frame being drawn again is not on the list twice. */
  const again = { ...p, production: { ...p.production, boards: { ...p.production!.boards!, frames: { ...p.production!.boards!.frames, sh2: { ...p.production!.boards!.frames.sh2, pending: [{ jobId: "j9", style: "live" as const, at: "2026-10-16T00:00:00.000Z" }] } } } } };
  expect(redoShots(again)).toEqual([]);
});

test("the style, a frame's words and a pick are kept in the draft the Boards stage always used", () => {
  const p = board();
  expect(styleOf(p)).toBe("live");
  const s = withStyle(p, "bw-sketch");
  expect(styleOf(s)).toBe("bw-sketch");
  expect(withStyle(s, "bw-sketch")).toBe(s);
  const w = withFramePrompt(p, "sh4", "The bottle, close, dawn light.");
  expect(w.production!.boards!.frames.sh4.prompt).toBe("The bottle, close, dawn light.");
  expect(frameCards(w)[3].prompt).toBe("The bottle, close, dawn light.");
  expect(takesOf(p, "sh2")).toEqual(["g2b", "g2a"]);
  expect(frameCards(withPick(p, "sh2", "g2a"))[1].genId).toBe("g2a");
  expect(withPick(p, "sh2", "nope")).toBe(p);
  expect(projectSchema.safeParse(w).success).toBe(true);
});

test("the board sheet cuts the frames into pages of four, six or nine; every shot keeps its place", () => {
  const eight = Array.from({ length: 8 }, (_, i) => i);
  expect(SHEET_SIZES).toEqual([4, 6, 9]);
  expect(sheetPages(eight, 6).map((p) => p.length)).toEqual([6, 2]);
  expect(sheetPages(eight, 4).map((p) => p.length)).toEqual([4, 4]);
  expect(sheetPages(eight, 9).map((p) => p.length)).toEqual([8]);
  expect(sheetPages([], 6)).toEqual([]);
  expect(sheetPages(eight, 6).flat()).toEqual(eight);
});

test("the line says how many are drawn; reasons are the step's own", () => {
  expect(storyboardLine(board())).toContain("of 4 frames");
  expect(FRAME_REASONS).toEqual(["Framing", "Subject", "Light", "Style"]);
});
