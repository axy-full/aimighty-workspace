"use client";
import type { ProjectLibrary } from "@/lib/workspace/library";

/**
 * The end of a project's asset list (the Library panel, Takes): a failed
 * read says so with Try again, and while the library's cursors say there is
 * more, Load more reads the next page — so an older take is never out of reach.
 * A re-read that failed with cards on screen says they were not refreshed and
 * offers Try again; a Load more that failed is tried again by Load more.
 */
export function LibraryMore({ library, testId = "library-more" }: { library: ProjectLibrary; testId?: string }) {
  const { state } = library;
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
    <div className="gx-lib-more" data-testid={testId}>
      {state.error ? <span className="gx-gen-error" role="alert">{state.stale ? `Not refreshed · ${state.error}` : state.error}</span> : null}
      {state.error && state.stale ? <button type="button" className="gx-hbtn" onClick={() => void library.refresh()} data-testid={`${testId}-retry`}>Try again</button> : null}
      {library.hasMore ? (
        <button type="button" className="gx-hbtn" disabled={state.moreBusy} onClick={() => void library.more()} data-testid={`${testId}-button`}>
          {state.moreBusy ? "Loading…" : `Load more · ${shown.toLocaleString("en-US")} shown`}
        </button>
      ) : null}
    </div>
  );
}
