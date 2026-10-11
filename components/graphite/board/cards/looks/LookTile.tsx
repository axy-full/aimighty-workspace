"use client";
import LazyMedia from "@/components/LazyMedia";
import { ratioOf } from "../storyboard/FrameTile";
import "./looks.css";

/**
 * One look (design/particl-graphite/README.md § 3.1 c): the still in the project's aspect, a tick to pick it
 * (free), and the look's name over its engine line. While it renders it says so; a still that did not render says
 * what the provider did. Selection and dragging are the board's.
 */
export function LookTile({ name, meta, genId, aspect, rendering, picked, problem, readOnly, onPick, testId = "board-look" }: {
  name: string; meta: string; genId: string | null; aspect: string; rendering: boolean; picked: boolean;
  problem: string | null; readOnly: string | null; onPick: () => void; testId?: string;
}) {
  return (
    <article className="gx-look" data-picked={picked || undefined} data-testid={testId} aria-label={name}>
      <div className="gx-look-media" style={{ aspectRatio: ratioOf(aspect) }}>
        {genId ? <LazyMedia url={`/api/media/${encodeURIComponent(genId)}`} kind="image" alt={name} preview={false} />
          : <span className="gx-look-empty">{rendering ? "Drawing…" : problem ?? "Not made yet"}</span>}
        {rendering ? <span className="gx-frame-bar" data-indeterminate="" role="progressbar" aria-label={`${name} is being drawn`}><span /></span> : null}
      </div>
      {genId ? (
        <button type="button" className="gx-look-tick nodrag" aria-pressed={picked} disabled={Boolean(readOnly)}
          title={readOnly ?? (picked ? "Picked" : "Pick this look")} aria-label={picked ? `${name} · picked` : `Pick ${name}`} onClick={onPick}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
        </button>
      ) : null}
      <div className="gx-look-body">
        <div className="gx-look-name">{name}</div>
        <div className="gx-look-meta">{meta}</div>
      </div>
    </article>
  );
}
