"use client";
import { useEffect, useRef, useState } from "react";
import type { ProjectLibrary } from "@/lib/workspace/library";

/** How long the end of a list stays in view before the next page is read by itself: a press on Load more lands first. */
export const MORE_DWELL_MS = 200;

/**
 * The end of a project's asset list (the Library panel, Takes): a failed
 * read says so with Try again, and while the library's cursors say there is
 * more, Load more reads the next page — so an older take is never out of reach.
 * A re-read that failed with cards on screen says they were not refreshed and
 * offers Try again; a Load more that failed is tried again by Load more.
 *
 * With `auto`, the row is also the list's sentinel: scrolled into view, it
 * reads the next page by itself (library.more()). Only a scroll brings it in —
 * a row already in view when the list opens, or still in view after a page
 * lands (a filter showing few of them), waits for Load more, so a sparse
 * filter never pages through a whole project on its own; and a failed page is
 * never read again by itself.
 */
export function LibraryMore({ library, testId = "library-more", auto = false, countWord = "shown" }: {
  library: ProjectLibrary; testId?: string;
  /** Read the next page when the row scrolls into view (Takes, the Library panel). */
  auto?: boolean;
  /** "Load more · 60 shown"; a filtered grid counts what is loaded instead. */
  countWord?: "shown" | "loaded";
}) {
  const { state } = library;
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const ready = auto && state.status === "ready" && library.hasMore && !state.error && !state.moreBusy;
  const latest = useRef({ ready, more: library.more });
  useEffect(() => { latest.current = { ready, more: library.more }; });
  useEffect(() => {
    if (!auto || !row || typeof IntersectionObserver === "undefined") return;
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(([hit]) => {
      if (!hit?.isIntersecting) {
        armed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        return;
      }
      if (!armed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        armed = false;
        if (latest.current.ready) void latest.current.more();
      }, MORE_DWELL_MS);
    });
    observer.observe(row);
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [auto, row]);

  if (state.status === "error") {
    return (
      <div className="gx-lib-more" role="alert" data-testid={`${testId}-error`}>
        <span className="gx-gen-error">{state.error ?? "The project library could not be loaded."}</span>
        <button type="button" className="gx-hbtn" onClick={() => void library.refresh()}>Try again</button>
      </div>
    );
  }
  if (state.status !== "ready" || (!library.hasMore && !state.error)) return null;
  const shown = state.uploads.length + state.generations.length;
  return (
    <div className="gx-lib-more" data-testid={testId} ref={setRow} data-sentinel={auto || undefined}>
      {state.error ? <span className="gx-gen-error" role="alert">{state.stale ? `Not refreshed · ${state.error}` : state.error}</span> : null}
      {state.error && state.stale ? <button type="button" className="gx-hbtn" onClick={() => void library.refresh()} data-testid={`${testId}-retry`}>Try again</button> : null}
      {library.hasMore ? (
        <button type="button" className="gx-hbtn" disabled={state.moreBusy} onClick={() => void library.more()} data-testid={`${testId}-button`}>
          {state.moreBusy ? "Loading…" : `Load more · ${shown.toLocaleString("en-US")} ${countWord}`}
        </button>
      ) : null}
    </div>
  );
}
