/**
 * The Storyboard step of a Film board in the new interface (design/particl-prototype-25 step "storyboard"; demo plan PR 18): one card per
 * shot of the beat sheet, drawn in the board's style, with a board sheet of them laid out in pages. Pure: no React, no fetch
 * (tests/unit/v12-storyboard-step.spec.ts).
 *
 * It reads and writes the draft the Boards stage always has (`production.boards`, lib/production/boards.ts) and draws on the path that
 * exists (components/graphite/board/cards/storyboard/use-frames.ts: each frame priced by the server, sent by a person's press at the figure
 * shown), so no money behaviour is new here. A frame's ✓ or ✕ is a mark in the draft (`boardMarks`), given for the picture it was for; a
 * ✕ puts the frame on the list to be drawn again (`redoShots`), and a new take makes the mark stale.
 */
import type { CardStatus } from "@/components/v12/board/card-model";
import { framePicture, storyboard } from "@/components/graphite/board/cards/storyboard/model";
import { BOARD_STYLES, DEFAULT_BOARDS, emptyFrame, type BoardStyle, type Boards } from "@/lib/production/boards";
import { statusOf } from "@/lib/v12/board/text-steps";
import type { Project } from "@/lib/workbench/studio";

/** ✕'s reasons on a frame (the card adds "Other"). */
export const FRAME_REASONS = ["Framing", "Subject", "Light", "Style"] as const;

export type FrameCardModel = {
  shotId: string;
  index: number;
  /** "Shot 1 · Extreme wide" */
  name: string;
  /** "1 · 0:00 · 4 s · Locked off" */
  line: string;
  genId: string | null;
  status: CardStatus;
  reason?: string;
  /** Takes made so far, when more than one. */
  version?: number;
  /** The words the frame is drawn from: its own, else started from the shot. */
  prompt: string;
};

const boardsOf = (project: Pick<Project, "production">): Boards => project.production?.boards ?? DEFAULT_BOARDS;

/** The frames, one per shot of the beat sheet, in order. */
export function frameCards(project: Project): FrameCardModel[] {
  const boards = boardsOf(project);
  return storyboard(project).frames.map((tile) => {
    const frame = boards.frames[tile.shotId];
    const verdict = tile.rendering ? { status: "making" as const } : tile.genId ? statusOf(project.boardMarks, tile.shotId, tile.genId) : { status: "none" as const };
    return {
      shotId: tile.shotId, index: tile.index, name: tile.name, line: tile.line, genId: tile.genId, status: verdict.status,
      ...("reason" in verdict && verdict.reason ? { reason: verdict.reason } : {}),
      ...(frame && frame.takes.length > 1 ? { version: frame.takes.length } : {}), prompt: frame?.prompt ?? "",
    };
  });
}

/** Frames a person marked ✕ for the picture they show and that are not already being drawn again: what "Draw again" sends. */
export function redoShots(project: Project): string[] {
  return frameCards(project).filter((c) => c.status === "rejected").map((c) => c.shotId);
}

/** The drawing style of the board, and its words. */
export const styleOf = (project: Pick<Project, "production">): BoardStyle => boardsOf(project).style;
export const STYLES = BOARD_STYLES;

/** The draft with the board's style changed: frames drawn from now on follow it (a drawn frame keeps its own). */
export function withStyle(project: Project, style: BoardStyle): Project {
  const boards = boardsOf(project);
  return boards.style === style ? project : { ...project, production: { ...project.production, boards: { ...boards, style } } };
}

/** The draft with a frame's own words. */
export function withFramePrompt(project: Project, shotId: string, prompt: string): Project {
  const boards = boardsOf(project);
  const was = boards.frames[shotId] ?? emptyFrame();
  return { ...project, production: { ...project.production, boards: { ...boards, frames: { ...boards.frames, [shotId]: { ...was, prompt: prompt.slice(0, 8000) } } } } };
}

/** The draft with a frame showing one of its takes. */
export function withPick(project: Project, shotId: string, genId: string): Project {
  const boards = boardsOf(project);
  const was = boards.frames[shotId];
  if (!was?.takes.some((t) => t.genId === genId) || framePicture(was) === genId) return project;
  return { ...project, production: { ...project.production, boards: { ...boards, frames: { ...boards.frames, [shotId]: { ...was, selected: genId } } } } };
}

/** A frame's takes, newest first, as the pictures a person can pick between. */
export function takesOf(project: Pick<Project, "production">, shotId: string): string[] {
  return boardsOf(project).frames[shotId]?.takes.map((t) => t.genId) ?? [];
}

/* ── The board sheet ───────────────────────────────────────────────────────────────────────────── */

export const SHEET_SIZES = [4, 6, 9] as const;
export type SheetSize = (typeof SHEET_SIZES)[number];
export const DEFAULT_SHEET_SIZE: SheetSize = 6;

/** The frames cut into pages of `perPage`, in order. A shot with no picture yet keeps its place, empty. */
export function sheetPages<T>(cards: readonly T[], perPage: SheetSize = DEFAULT_SHEET_SIZE): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < cards.length; i += perPage) pages.push(cards.slice(i, i + perPage));
  return pages;
}

/** The step's one-line state: "3 of 8 drawn", "8 frames · Live action". */
export function storyboardLine(project: Project): string {
  return storyboard(project).meta || storyboard(project).summary;
}
