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
 * reads the next page by itself (library.more()), one page per scroll. It
 * waits for someone reading on — a row already in view when the list opens,
 * or still in view after a page lands (a filter showing few takes), reads
 * nothing more until the list is scrolled or Load more is pressed — so a
 * sparse filter never pages through a whole project on its own; and a failed
 * page is never read again by itself.
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
    /* Armed by a scroll of this list, or by the row leaving the view; spent by the read it starts. */
    let inView = false, armed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (timer || !inView || !armed) return;
      timer = setTimeout(() => {
        timer = null;
        if (!inView) return;
        armed = false;
        if (latest.current.ready) void latest.current.more();
      }, MORE_DWELL_MS);
    };
    /* Every entry, in order: a fast scroll can deliver "left the view" and "came back" in one batch. */
    const observer = new IntersectionObserver((hits) => {
      for (const hit of hits) {
        inView = hit.isIntersecting;
        if (!inView) { armed = true; if (timer) { clearTimeout(timer); timer = null; } }
      }
      settle();
    });
    /* A page can land and the list be scrolled to its new end within one frame: the row never seemed to
       leave. A scroll of the list this row ends (not of another panel) is someone reading on. */
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === document || (target instanceof Node && target.contains(row))) { armed = true; settle(); }
    };
    observer.observe(row);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => { observer.disconnect(); document.removeEventListener("scroll", onScroll, { capture: true }); if (timer) clearTimeout(timer); };
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
