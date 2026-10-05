"use client";
import type { ComponentType } from "react";
import { useWorkspace } from "@/lib/workspace/state";
import type { BoardAgentView } from "@/lib/board/types";
import type { BoardCtx } from "../cards/types";

/*
 * Stream 7's docked Atomik panel on the board (340 px open, a 56 px rail collapsed) and the board's Atomik seam.
 * A stub seeded by stream 3 (lead decision 26): the collapsed rail of frame a, opening today's Atomik sheet, and a
 * seam with no Start yet. Owned by stream 7 from its first PR, which replaces this file.
 */
export type BoardStartInput = { words: string; aspect: string; seconds: number | null; attachments: string[] };
export type BoardAgentSeam = {
  /** What "Start" costs (Atomik's thinking), from the server's estimate; null while the board has no Atomik. */
  startPrice: { credits: number | null; state: "loading" | "ready" | "unavailable" } | null;
  /** Starts Atomik on this board (a person pressed Start at the price shown); null while the board has no Atomik. Resolves to a refusal, or null. */
  start: ((input: BoardStartInput) => Promise<string | null>) | null;
  run: BoardAgentView | null;
};
const NONE: BoardAgentSeam = { startPrice: null, start: null, run: null };
export function useBoardAgent(): BoardAgentSeam { return NONE; }

export type BoardAgentDockProps = { ctx: BoardCtx; open: boolean; onOpenChange: (open: boolean) => void };
/** Whether the dock has an open panel yet: the board reserves 340 px only when it does. */
export const DOCK_PANEL = false;

export const BoardAgentDock: ComponentType<BoardAgentDockProps> = function BoardAgentDock() {
  const { dispatch } = useWorkspace();
  return (
    <aside className="bd-dock" data-open="false" aria-label="Atomik">
      <button type="button" className="bd-dock-rail" onClick={() => dispatch({ type: "patch", patch: { agentOpen: true } })}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" /></svg>
        <span>Atomik</span>
      </button>
    </aside>
  );
};
