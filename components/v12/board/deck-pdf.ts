"use client";
import { useCallback, useRef, useState } from "react";

/**
 * One deck PDF as the Edit step offers it: POST /api/pdf (the `make_deck_pdf` tool, kind "film") for this board and a cover. The PDF
 * is printed while the request waits (a few seconds) and comes back as a link. Free: nothing here reads or shows a price but "free".
 */
export type DeckCover = "treatment" | "pitch";
export type DeckState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "ready"; url: string; filename: string; pages: number }
  | { phase: "failed"; error: string };

export function useDeckPdf(board: string, cover: DeckCover): { state: DeckState; start: () => void; reset: () => void } {
  const [state, setState] = useState<DeckState>({ phase: "idle" });
  const alive = useRef(true);
  const start = useCallback(() => {
    alive.current = true;
    setState({ phase: "working" });
    void (async () => {
      const set = (next: DeckState) => { if (alive.current) setState(next); };
      try {
        const response = await fetch("/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "film", board, cover }) });
        const body = (await response.json().catch(() => ({}))) as { deck?: { url: string; filename: string; pages: number }; error?: string };
        if (response.status === 404 && !body.deck && body.error === "Not found.") return set({ phase: "failed", error: "Deck PDFs aren't switched on for this workspace." });
        if (!response.ok || !body.deck) return set({ phase: "failed", error: typeof body.error === "string" ? body.error : "The deck could not be made. Nothing billed." });
        set({ phase: "ready", url: body.deck.url, filename: body.deck.filename, pages: body.deck.pages });
      } catch {
        set({ phase: "failed", error: "The connection dropped. Nothing billed. Try again." });
      }
    })();
  }, [board, cover]);
  const reset = useCallback(() => { alive.current = false; setState({ phase: "idle" }); }, []);
  return { state, start, reset };
}
