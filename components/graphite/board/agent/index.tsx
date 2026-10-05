"use client";
import { useCallback, useEffect, type ComponentType } from "react";
import type { BoardAgentView, RegionId } from "@/lib/board/types";
import { BOARD_GO_EVENT, askAtomik, openAtomikPanel, type BoardGoDetail } from "@/lib/shell/atomik-panel";
import { useProvideBoardSeam } from "../BoardContext";
import type { BoardCtx } from "../cards/types";

/*
 * Stream 7's docked Atomik panel on the board (340 px open, a 56 px rail collapsed) and the board's Atomik seam.
 * Until stream 7's PR 3 (the docked panel itself), the collapsed rail of frame a opens Atomik's panel over the board,
 * and the dock carries out ⌘K's and Atomik's "go to <place>" on this board.
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

/** How long a landing waits for the board to lay itself out before it glides to the region a link named. */
const LANDING_MS = 400;

export const BoardAgentDock: ComponentType<BoardAgentDockProps> = function BoardAgentDock({ ctx }) {
  const { glide } = ctx;
  /* "go to <place>" from ⌘K or Atomik's panel, while this board is on screen. */
  useEffect(() => {
    const go = (event: Event) => {
      const region = (event as CustomEvent<BoardGoDetail>).detail?.region;
      if (region) glide(region as RegionId);
    };
    window.addEventListener(BOARD_GO_EVENT, go);
    return () => window.removeEventListener(BOARD_GO_EVENT, go);
  }, [glide]);
  /* …and from another view: the board opens with `region=`, glides there once, and the address forgets it. */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const region = q.get("region");
    if (!region) return;
    const timer = setTimeout(() => {
      glide(region as RegionId);
      q.delete("region");
      const text = q.toString();
      window.history.replaceState(window.history.state, "", window.location.pathname + (text ? `?${text}` : "") + window.location.hash);
    }, LANDING_MS);
    return () => clearTimeout(timer);
  }, [glide]);
  /* A card's "Ask Atomik" hands its words over, never sent. */
  const handOver = useCallback((words?: string) => askAtomik(words ?? ""), []);
  useProvideBoardSeam("atomik", handOver);
  return (
    <aside className="bd-dock" data-open="false" aria-label="Atomik">
      <button type="button" className="bd-dock-rail" onClick={() => openAtomikPanel("1")} data-testid="board-dock-rail">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" /></svg>
        <span>Atomik</span>
      </button>
    </aside>
  );
};
