"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One film export as the Edit step shows it: start it for a board and a language (POST /api/exports/film, the `export_film` tool),
 * then follow it (GET /api/exports/{id}) until it is ready, failed or cancelled. Free: nothing here reads or shows a price but "free".
 * A request id is made once per click and kept for retries of the same click, so a repeated request returns the film it started.
 */
export type FilmFile = { url: string; filename: string; kind: string };
export type FilmState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "working"; line: string }
  | { phase: "ready"; files: FilmFile[] }
  | { phase: "failed"; error: string };

type JobBody = { status: string; queueLine: string | null; error: string | null; outputs: FilmFile[] };
const WORDS: Record<string, string> = { queued: "In queue", rendering: "Rendering…", saving: "Saving…" };
export const POLL_MS = 3000;

const say = (value: unknown, fallback: string) => (typeof (value as { error?: unknown })?.error === "string" ? (value as { error: string }).error : fallback);

export function useFilmExport(board: string, language: string): { state: FilmState; start: () => void; reset: () => void } {
  const [state, setState] = useState<FilmState>({ phase: "idle" });
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const set = (next: FilmState) => { if (alive.current) setState(next); };

  const follow = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/exports/${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { job?: JobBody };
      if (!response.ok || !body.job) return set({ phase: "failed", error: say(body, "The film's state could not be read. Nothing billed.") });
      const job = body.job;
      if (job.status === "ready") return set({ phase: "ready", files: job.outputs });
      if (job.status === "failed" || job.status === "cancelled") return set({ phase: "failed", error: job.error ?? "The film could not be made. Nothing billed." });
      set({ phase: "working", line: job.queueLine ?? WORDS[job.status] ?? "Working…" });
      timer.current = setTimeout(() => void follow(id), POLL_MS);
    } catch {
      set({ phase: "failed", error: "The connection dropped. Nothing billed. Try again." });
    }
  }, []);

  const requestId = useRef<string | null>(null);
  const start = useCallback(() => {
    if (!requestId.current) requestId.current = `film-${language}-${crypto.randomUUID()}`;
    set({ phase: "starting" });
    void (async () => {
      try {
        const response = await fetch("/api/exports/film", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ board, language, requestId: requestId.current }) });
        const body = (await response.json().catch(() => ({}))) as { job?: { id: string }; error?: string };
        if (response.status === 404 && !body.job && body.error === "Not found.") return set({ phase: "failed", error: "Film export isn't switched on for this workspace." });
        if (!response.ok || !body.job) return set({ phase: "failed", error: say(body, "The film could not be started. Nothing billed.") });
        requestId.current = null;
        set({ phase: "working", line: "In queue" });
        void follow(body.job.id);
      } catch {
        set({ phase: "failed", error: "The connection dropped. Nothing billed. Try again." });
      }
    })();
  }, [board, language, follow]);

  const reset = useCallback(() => { if (timer.current) clearTimeout(timer.current); requestId.current = null; set({ phase: "idle" }); }, []);
  return { state, start, reset };
}
