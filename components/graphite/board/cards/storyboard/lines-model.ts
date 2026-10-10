import { DEFAULT_BOARDS, type BoardFrame, type BoardStyle } from "@/lib/production/boards";
import type { Project } from "@/lib/workbench/studio";

/*
 * Line drawings on a storyboard frame (gap screens, Line drawings). A frame's versions are its takes, oldest first: v1 is the
 * picture it was drawn with, and a line drawing is the next take, kept in the `bw-sketch` look. Pure: nothing here prices or sends.
 */

export type FrameVersion = { genId: string; style: BoardStyle; n: number; label: string };

/** "v1", "v2 · line drawing": the frame's takes oldest first. */
export function frameVersions(frame: Pick<BoardFrame, "takes"> | undefined, boardStyle: BoardStyle): FrameVersion[] {
  const takes = [...(frame?.takes ?? [])].reverse();
  return takes.map((take, i) => ({
    genId: take.genId, style: take.style, n: i + 1,
    label: `v${i + 1}${isLine(take.style, boardStyle) ? " · line drawing" : ""}`,
  }));
}

/** A take is a line drawing when it is in the sketch look and the board is not drawn in that look throughout. */
export const isLine = (style: BoardStyle, boardStyle: BoardStyle) => style === "bw-sketch" && boardStyle !== "bw-sketch";

export type LineState = {
  /** A line drawing is on offer: the frame has a stored picture, none is on its way, and it has no line drawing yet. */
  offer: boolean;
  /** A new take is on its way for a frame that already has a picture (a line drawing, or a revision). */
  running: boolean;
  versions: FrameVersion[];
  /** Whether the frame already has a line drawing. */
  has: boolean;
};

export function lineState(project: Project, shotId: string): LineState {
  const boards = project.production?.boards ?? DEFAULT_BOARDS;
  const frame = boards.frames[shotId];
  const versions = frameVersions(frame, boards.style);
  const pictured = versions.length > 0;
  const running = pictured && Boolean(frame?.pending?.length);
  const has = versions.some((v) => isLine(v.style, boards.style));
  return { offer: pictured && !running && !has && boards.style !== "bw-sketch", running, versions, has };
}

/** The height a frame's line-drawing area takes under its name and line (CSS px): the action, the running bar, or the chips. */
export function linesHeight(state: Pick<LineState, "offer" | "running" | "versions" | "has">): number {
  if (state.running) return 76;
  if (state.versions.length > 1) return 66;
  if (state.offer) return 40;
  return 0;
}
