"use client";
import { useState, type ReactNode } from "react";
import LazyMedia from "@/components/LazyMedia";
import { dragAttrs } from "@/lib/drop";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { entryFace, entryKind, type EntryFace, type LibraryEntry, type LibraryView } from "@/lib/workspace/library";
import { takeChip, takeReasonLine, type ChipTone } from "@/lib/workspace/takes";

/**
 * One card contract for every grid of takes — Gen › Results, Library › Assets
 * and Studio › Takes. The picture area says what the take is doing (media,
 * rendering, held, failed, or a finished take whose copy has not landed),
 * a chip names its status, and the line under the name says why a take
 * failed or waits. While the library is read, aspect-true skeletons hold the
 * grid; a failed read is a banner with Try again, never an empty grid.
 */

type Variant = "grid" | "library" | "take";
const KIND_BADGE = { image: "IMAGE", video: "VIDEO", audio: "AUDIO", file: "FILE" } as const;

function Chip({ label, tone }: { label: string; tone: ChipTone }) {
  return <span className="gx-tile-chip" data-tone={tone} data-testid="take-chip" title={label}><span className="gx-tile-chip-dot" aria-hidden="true" />{label}</span>;
}

function Face({ face, entry, onFail }: { face: EntryFace; entry: LibraryEntry; onFail: () => void }) {
  if (face === "media" && entry.url && (entry.media === "image" || entry.media === "video"))
    return <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} className="gx-lazy" onFail={onFail} />;
  const glyph = face === "live" ? <span className="gx-tile-spin" /> : face === "held" ? "❚❚" : face === "failed" ? "!" : face === "audio" ? "♪" : face === "unavailable" ? "" : "▤";
  return <span className="gx-tile-face" data-face={face}><span className="gx-tile-glyph" aria-hidden="true">{glyph}</span></span>;
}

function Refresh({ onRefresh, name }: { onRefresh: () => Promise<unknown> | void; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="gx-tile-refresh" disabled={busy} aria-label={`Refresh the preview of ${name}`} data-testid="take-refresh"
      onClick={async (event) => { event.stopPropagation(); setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}>
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  );
}

export function TakeTile({ entry, variant, selected = false, checked = false, cut = false, fresh = false, action, onOpen, onRefresh, dragEffect = "copy" }: {
  entry: LibraryEntry;
  variant: Variant;
  selected?: boolean;
  /** The Takes grid is a radio group: the take open in the editor below. */
  checked?: boolean;
  cut?: boolean;
  fresh?: boolean;
  /** The Library's `+` (use as reference), beside the name. */
  action?: ReactNode;
  onOpen: () => void;
  /** Re-read the library: a finished take whose stored copy was not there yet. */
  onRefresh: () => Promise<unknown> | void;
  dragEffect?: DataTransfer["effectAllowed"];
}) {
  const { take } = entry;
  /* The URL whose bytes would not load; Refresh clears it and mounts the media afresh. */
  const [broken, setBroken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const base = entryFace(entry);
  const face: EntryFace = base === "media" && broken != null && broken === entry.url ? "unavailable" : base;
  const compact = variant === "library";
  const chip = takeChip(take, compact);
  /* A finished take whose copy is missing says so under its name; Refresh sits on the picture. */
  const reason = face === "unavailable" ? "Preview unavailable" : takeReasonLine(take, compact);
  const kind = entryKind(entry);
  const refresh = async () => { setBroken(null); setAttempt((n) => n + 1); await onRefresh(); };
  const fail = () => setBroken(entry.url);
  const inner = (
    <>
      <Face key={attempt} face={face} entry={entry} onFail={fail} />
      {/* The kind, except where Refresh has the picture to itself. */}
      {face !== "unavailable" && (variant !== "grid" || kind === "audio" || kind === "file") ? <span className="gx-badge">{KIND_BADGE[kind]}</span> : null}
      {fresh ? <span className="gx-badge gx-badge--new">NEW</span> : null}
      {chip ? <Chip {...chip} /> : null}
    </>
  );
  const tone = face === "unavailable" ? "idle" : chip?.tone ?? "idle";
  const why = reason ? <span className="gx-tile-reason" data-tone={tone} title={face === "unavailable" ? "The stored copy did not load. Refresh reads the library again." : take.detail ?? reason} data-testid="take-reason">{reason}</span> : null;
  const refreshButton = face === "unavailable" ? <span className="gx-tile-over"><Refresh onRefresh={refresh} name={take.name} /></span> : null;
  const attrs = { "data-status": take.status, "data-face": face, "data-variant": variant, "data-testid": "take-tile" };

  if (variant === "take") {
    return (
      <div className="pd-take-cell gx-tile" {...attrs}>
        <button type="button" role="radio" aria-checked={checked} className="pd-take" onClick={onOpen} data-testid="edit-take" data-media={entry.media ?? "file"}
          {...previewAttrs(entryPreview(entry))} {...dragAttrs(take.id, { name: take.name, kind: entry.media ?? "file" })}>
          <span className="gx-tile-media pd-take-media">{inner}</span>
          <span className="pd-take-name">{take.name}</span>
          {why}
        </button>
        {refreshButton}
      </div>
    );
  }
  return (
    <div className="gx-asset gx-tile" {...attrs} data-selected={selected} data-cut={cut || undefined} data-asset={take.id}>
      <div className="gx-tile-media">
        <button type="button" className="gx-asset-thumb" title={take.name} draggable data-ctx={`asset:${take.id}`} {...previewAttrs(entryPreview(entry))}
          onDragStart={(e) => { e.dataTransfer.setData("text/plain", take.id); e.dataTransfer.effectAllowed = dragEffect; }}
          onClick={onOpen}>
          {inner}
        </button>
        {refreshButton}
      </div>
      {variant === "library" ? (
        <div className="gx-asset-row">
          <span className="gx-asset-name">{take.name}</span>
          {action}
        </div>
      ) : (
        <>
          <span className="gx-asset-name">{take.name}</span>
          <span className="gx-asset-meta">{take.meta}</span>
        </>
      )}
      {why}
    </div>
  );
}

/** Aspect-true placeholders for the first read: the grid keeps its shape, nothing jumps when the cards land. */
export function TakeSkeletons({ count, variant }: { count: number; variant: Variant }) {
  return (
    <>
      <span className="sr-only" role="status">Loading takes…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={variant === "take" ? "pd-take gx-skel" : "gx-asset gx-skel"} aria-hidden="true" data-testid="take-skeleton">
          <span className={`gx-skel-thumb${variant === "take" ? " pd-take-media" : ""}`} />
          <span className="gx-skel-line" />
          {variant === "grid" ? <span className="gx-skel-line gx-skel-line--short" /> : null}
        </div>
      ))}
    </>
  );
}

/** A read that failed says so, with the one action that helps. */
export function LoadBanner({ banner, onRetry, testId, compact = false }: { banner: NonNullable<LibraryView["banner"]>; onRetry: () => Promise<unknown> | void; testId: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="gx-banner" data-tone={banner.tone} data-compact={compact || undefined} role={banner.tone === "error" ? "alert" : "status"} data-testid={testId}>
      <span className="gx-banner-dot" aria-hidden="true" />
      <span className="gx-banner-text">{banner.tone === "stale" ? `Not refreshed · ${banner.message}` : banner.message}</span>
      <button type="button" className="gx-hbtn" disabled={busy} data-testid={`${testId}-retry`}
        onClick={async () => { setBusy(true); try { await onRetry(); } finally { setBusy(false); } }}>
        {busy ? "Trying…" : "Try again"}
      </button>
    </div>
  );
}
