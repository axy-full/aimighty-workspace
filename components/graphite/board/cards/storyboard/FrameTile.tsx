"use client";
import type { ReactNode } from "react";
import LazyMedia from "@/components/LazyMedia";
import "./storyboard.css";

/**
 * One picture on the board with its name and its line (design/particl-graphite/README.md § 3.1 d, f): a
 * storyboard frame, and — through `badge`, `progress` and `play` — the take that later replaces it in
 * place (stream 5's Shots group can draw its tiles with this, so a frame becomes a take where it stood).
 *
 * The picture's box takes the project's aspect. Without a picture it says what is happening instead.
 * Selection, dragging and opening are the board's (its card wrapper), not this tile's.
 */
export function FrameTile({
  name, line, genId, aspect, rendering = false, empty = "No frame yet", badge, progress, play = false, testId, children,
}: {
  name: string;
  line: string;
  /** The picture: a generation id, shown from /api/media. */
  genId: string | null;
  /** The project's aspect, "16:9". */
  aspect: string;
  /** A picture is on its way: an indeterminate bar (no engine reports a percentage). */
  rendering?: boolean;
  /** What the box says with no picture and nothing on its way. */
  empty?: string;
  badge?: { text: string; tone: "accent" | "dark" } | null;
  /** A known fraction (0–1) for a bar that has one; otherwise `rendering` draws the indeterminate one. */
  progress?: number | null;
  play?: boolean;
  testId?: string;
  /** What sits under the name and line: a card action. */
  children?: ReactNode;
}) {
  const ratio = ratioOf(aspect);
  return (
    <article className="gx-frame" data-testid={testId} data-rendering={rendering || undefined} aria-label={name}>
      <div className="gx-frame-media" style={{ aspectRatio: ratio }}>
        {genId ? (
          <LazyMedia url={`/api/media/${encodeURIComponent(genId)}`} kind="image" alt={name} className="gx-frame-img" preview={false} />
        ) : (
          <span className="gx-frame-empty">{rendering ? "Drawing…" : empty}</span>
        )}
        {badge ? <span className="gx-frame-badge" data-tone={badge.tone}>{badge.text}</span> : null}
        {play ? <span className="gx-frame-play" aria-hidden="true">▶</span> : null}
        {typeof progress === "number" && Number.isFinite(progress) ? (
          <span className="gx-frame-bar" role="progressbar" aria-label={`${name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}>
            <span style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%` }} />
          </span>
        ) : rendering ? (
          <span className="gx-frame-bar" data-indeterminate="" role="progressbar" aria-label={`${name} is being drawn`}><span /></span>
        ) : null}
      </div>
      <div className="gx-frame-body">
        <div className="gx-frame-name">{name}</div>
        <div className="gx-frame-line">{line}</div>
        {children}
      </div>
    </article>
  );
}

/** "16:9" → "16 / 9" for CSS; anything unreadable falls back to 16 / 9. */
export function ratioOf(aspect: string): string {
  const [w, h] = aspect.split(":").map(Number);
  return w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9";
}

/** The tile's height at a width: the picture's box plus the name and line under it (design: 8 + 20 + 35 + 10). */
export function frameTileHeight(width: number, aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  const media = w > 0 && h > 0 ? (width * h) / w : (width * 9) / 16;
  return Math.ceil(media + 2 + 73);
}
