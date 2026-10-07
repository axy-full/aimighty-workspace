import { BOARD_STYLES, DEFAULT_BOARDS, boardShots, emptyFrame, shotPrompt, type BoardFrame, type Boards, type FramePending, type NumberedShot } from "@/lib/production/boards";
import type { BeatSheet } from "@/lib/production/beats";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import type { Asset, Project } from "@/lib/workbench/studio";
import { clock, seconds } from "../doc/model";

/*
 * The Storyboard group (design/particl-graphite/README.md § 3.1 d): one frame per shot of the shot list,
 * read from the draft as it is today: the beat sheet's shots (production.beats) and their storyboard
 * frames (production.boards.frames, the pictures the Boards stage files). Pure: what to draw, and which
 * shots still have no frame. Drawing a frame is the existing paid path (./use-frames.ts).
 */

/** Rail statuses (stream 3's CardState). */
export type RegionState = "empty" | "working" | "needs" | "done";

export type FrameTile = {
  shotId: string;
  /** 1-based, across the whole film. */
  index: number;
  /** "Shot 1 · Extreme wide" */
  name: string;
  /** "1 · 0:00 · 4 s · Locked off": the shot's place, start, length and camera, with what is missing left out. */
  line: string;
  /** The picture: the frame's pick, else its newest take. */
  genId: string | null;
  /** A frame of it is on its way. */
  rendering: boolean;
};

export type Storyboard = {
  title: string;
  /** "Live action · 3 frames", "1 of 3 frames", "3 shots · no frames yet" */
  meta: string;
  frames: FrameTile[];
  /** Shots with no frame and none on its way: what drawing the storyboard draws, in order. */
  missing: string[];
  state: RegionState;
  /** The rail's one-line summary. */
  summary: string;
};

/** The frame a shot shows: its pick when it still has it, else its newest take. */
export function framePicture(frame: BoardFrame | undefined): string | null {
  if (!frame?.takes.length) return null;
  return frame.selected && frame.takes.some((take) => take.genId === frame.selected) ? frame.selected : frame.takes[0].genId;
}

/** The words a frame tile carries for a shot: a name from its framing, else from what it shows. */
export function shotName(shot: NumberedShot["shot"], index: number): string {
  const label = shot.framing.trim() || shot.description.trim().split(/\s+/).slice(0, 6).join(" ");
  return label ? `Shot ${index} · ${label}` : `Shot ${index}`;
}

/** Every shot with where it starts, from the lengths before it (null once one is missing). */
function timed(sheet: BeatSheet | null | undefined): { shot: NumberedShot; index: number; start: number | null }[] {
  let at: number | null = 0;
  return boardShots(sheet).map((shot, i) => {
    const start = at;
    at = at == null || !shot.shot.duration ? null : at + shot.shot.duration;
    return { shot, index: i + 1, start };
  });
}

/**
 * The Storyboard group. `look` is the look the frames are drawn in (a picked look's name); without
 * one, the board's frame style ("Live action") names it. `approved` is true once the shots have been
 * approved to render (the plan), which makes the storyboard done.
 */
export function storyboard(project: Project, opts: { look?: string | null; approved?: boolean } = {}): Storyboard {
  const boards: Boards = project.production?.boards ?? DEFAULT_BOARDS;
  const rows = timed(project.production?.beats);
  const frames: FrameTile[] = rows.map(({ shot, index, start }) => {
    const frame = boards.frames[shot.id];
    const length = shot.shot.duration ? seconds(shot.shot.duration) : null;
    const line = [String(index), start != null && length ? clock(start) : null, length, shot.shot.movement.trim() || null].filter(Boolean).join(" · ");
    return { shotId: shot.id, index, name: shotName(shot.shot, index), line, genId: framePicture(frame), rendering: Boolean(frame?.pending?.length) };
  });
  const missing = frames.filter((f) => !f.genId && !f.rendering).map((f) => f.shotId);
  const drawn = frames.filter((f) => f.genId).length;
  const rendering = frames.filter((f) => f.rendering).length;
  const look = opts.look?.trim() || BOARD_STYLES.find((s) => s.id === boards.style)?.label || "";
  const total = frames.length;
  const meta = !total ? ""
    : drawn === total ? [look, plural(total, "frame")].filter(Boolean).join(" · ")
    : drawn ? `${drawn} of ${plural(total, "frame")}`
    : `${plural(total, "shot")} · no frames yet`;
  const state: RegionState = !total ? "empty" : rendering ? "working" : opts.approved && drawn === total ? "done" : "needs";
  const summary = !total ? "Nothing yet"
    : rendering ? `Drawing ${plural(rendering, "frame")}`
    : drawn === total ? (opts.approved ? `${plural(total, "frame")} · approved` : `${plural(total, "frame")} · approve to make shots`)
    : drawn ? `${drawn} of ${plural(total, "frame")} drawn`
    : `${plural(total, "shot")} · no frames yet`;
  return { title: "Storyboard", meta, frames, missing, state, summary };
}

/** The frame a missing shot sends: its own prompt, or one started from the shot itself (as the Boards stage does). */
export function frameToDraw(project: Project, shotId: string): BoardFrame | null {
  const shot = boardShots(project.production?.beats).find((s) => s.id === shotId);
  if (!shot) return null;
  const frame = project.production?.boards?.frames[shotId] ?? emptyFrame();
  return frame.prompt.trim() ? frame : { ...frame, prompt: shotPrompt(shot) };
}

/**
 * The draft once a frame was sent: the frame as it was sent (its prompt, when it had none, is the one started
 * from the shot) and the job on its way. As the Boards stage records it; unchanged when that job is already there.
 */
export function withPendingFrame(project: Project, shotId: string, sent: BoardFrame, pending: FramePending): Project {
  const boards = project.production?.boards ?? DEFAULT_BOARDS;
  const was = boards.frames[shotId] ?? emptyFrame();
  if (was.pending?.some((p) => p.jobId === pending.jobId)) return project;
  const frame: BoardFrame = { ...was, ...(was.prompt.trim() ? {} : { prompt: sent.prompt }), pending: [...(was.pending ?? []), pending] };
  return { ...project, production: { ...project.production, boards: { ...boards, frames: { ...boards.frames, [shotId]: frame } } } };
}

/**
 * The draft once a frame's job ended: off the pending list; when it rendered, its picture is the frame's newest
 * take and its pick, and is filed on the project as a Storyboard asset (once, while the project has room) — as
 * the Boards stage files it. Unchanged when the job is not pending on that frame.
 */
export function withLandedFrame(project: Project, shotId: string, jobId: string, genId: string | null, at: string): Project {
  const boards = project.production?.boards ?? DEFAULT_BOARDS;
  const f = boards.frames[shotId];
  const pend = f?.pending?.find((p) => p.jobId === jobId);
  if (!f || !pend) return project;
  const rows = timed(project.production?.beats);
  const row = rows.find((r) => r.shot.id === shotId);
  const frame: BoardFrame = {
    ...f, pending: (f.pending ?? []).filter((p) => p.jobId !== jobId),
    ...(genId ? { takes: [{ genId, style: pend.style, at }, ...f.takes].slice(0, 20), selected: genId } : {}),
  };
  const asset: Asset | null = genId ? {
    id: genId, generationId: genId, kind: "image", category: "Storyboard", name: row ? `Frame ${row.shot.number}` : "Storyboard frame",
    url: `/api/media/${genId}`, description: row?.shot.scene ?? "", prompt: f.prompt, status: "Draft", locked: false, version: f.takes.length + 1, refs: [],
  } : null;
  const assets = asset && !project.assets.some((a) => a.id === asset.id) && project.assets.length < PROJECT_LIMITS.assets ? [...project.assets, asset] : project.assets;
  return { ...project, assets, production: { ...project.production, boards: { ...boards, frames: { ...boards.frames, [shotId]: frame } } } };
}

/** Every frame job on its way, with its shot. */
export function pendingFrames(project: Project): { shotId: string; jobId: string }[] {
  const frames = project.production?.boards?.frames ?? {};
  return Object.entries(frames).flatMap(([shotId, frame]) => (frame.pending ?? []).map((p) => ({ shotId, jobId: p.jobId })));
}

/** The List view's State column until the Shots cards give a richer one: a frame drawn, being drawn, or not yet. */
export function frameState(project: Project, shotId: string): { label: string; tone: "quiet" | "accent" } {
  const frame = project.production?.boards?.frames[shotId];
  if (frame?.pending?.length) return { label: "Drawing", tone: "accent" };
  return framePicture(frame) ? { label: "Storyboarded", tone: "quiet" } : { label: "Planned", tone: "quiet" };
}

function plural(n: number, one: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;
}
