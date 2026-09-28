"use client";
import { useState, type ReactNode } from "react";
import LazyMedia from "@/components/LazyMedia";
import { dragAttrs } from "@/lib/drop";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { entryFace, entryKind, type EntryFace, type LibraryEntry, type LibraryView } from "@/lib/workspace/library";
import { takeChip, takeReasonLine, type ChipTone } from "@/lib/workspace/takes";
import { ReleaseTake } from "./ReleaseTake";

/**
 * One card contract for every grid of takes — Gen › Results, Library › Assets
 * and Studio › Takes. The picture area says what the take is doing (media,
 * rendering, held, failed, stopped, or a finished take whose copy has not
 * landed), a chip names its status, and the line under the name says why a
 * take failed or waits. While the library is read, aspect-true skeletons hold
 * the grid; a failed read is a banner with Try again, never an empty grid.
 *
 * A take held for credits carries Release at its exact price (ReleaseTake),
 * except on the 2-up Library tile, whose Inspector has it.
 *
 * The words come from lib/workspace/takes.ts (takeChip, takeReasonLine, the
 * Take's `stage`, `reason`, `detail`, `failedUnbilled`, `cancelled`) and the
 * states from lib/workspace/library.ts (entryFace, libraryView, tileAspect):
 * a new grid of takes renders TakeTile and reads those, never its own copy.
 */

type Variant = "grid" | "library" | "take";
const KIND_BADGE = { image: "IMAGE", video: "VIDEO", audio: "AUDIO", file: "FILE" } as const;

/* `need` is the tail of a held take's label (" · needs 12 cr"): on the chip where the tile has room for it whole,
   else said on its own line under the name (graphite.css) — a price is never cut. */
function Chip({ label, tone, need }: { label: string; tone: ChipTone; need?: string | null }) {
  const head = need && label.endsWith(need) ? label.slice(0, -need.length) : null;
  return (
    <span className="gx-tile-chip" data-tone={tone} data-testid="take-chip" title={label}>
      <span className="gx-tile-chip-dot" aria-hidden="true" />{head != null ? <>{head}<span className="gx-chip-need">{need}</span></> : label}
    </span>
  );
}

function Face({ face, entry, onFail }: { face: EntryFace; entry: LibraryEntry; onFail: () => void }) {
  if (face === "media" && entry.url && (entry.media === "image" || entry.media === "video"))
    return <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} className="gx-lazy" onFail={onFail} />;
  const glyph = face === "live" ? <span className="gx-tile-spin" /> : face === "held" ? <span className="gx-tile-pause" /> : face === "failed" ? "!" : face === "stopped" ? "–" : face === "audio" ? "♪" : face === "unavailable" ? "" : "▤";
  return <span className="gx-tile-face" data-face={face}><span className="gx-tile-glyph" aria-hidden="true">{glyph}</span></span>;
}

/* "Preview unavailable" is said under the name; this is its Refresh, named in full for a screen reader and on hover. */
function Refresh({ onRefresh, name }: { onRefresh: () => Promise<unknown> | void; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="gx-tile-refresh" disabled={busy} aria-busy={busy} aria-label={`Refresh the preview of ${name}`} title="Refresh" data-testid="take-refresh"
      onClick={async (event) => { event.stopPropagation(); setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}>
      <span aria-hidden="true">↻</span>
    </button>
  );
}

export function TakeTile({ entry, variant, label, selected = false, checked = false, cut = false, fresh = false, action, meta, testId, onOpen, onRefresh, dragEffect = "copy" }: {
  entry: LibraryEntry;
  variant: Variant;
  /** Its place in a batch strip ("take 2", components/graphite/TakeStrip.tsx), said in place of its name: the strip names the batch. */
  label?: string;
  selected?: boolean;
  /** The Takes grid is a radio group: the take open in the editor below. */
  checked?: boolean;
  cut?: boolean;
  fresh?: boolean;
  /** The Library's `+` (use as reference), beside the name. */
  action?: ReactNode;
  /** The line under a grid card's name, when its strip knows better than the take's own detail (a draft's watermark, components/graphite/DraftFinal.tsx). */
  meta?: ReactNode;
  /** The card's test id, when its strip names its takes its own way (a draft and its final). */
  testId?: string;
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
  /* A held take's need, whole: on the chip where there is room, else on its own line (the 2-up Library says it on the reason line). */
  const needs = take.status === "held" && !compact && take.needs != null ? take.needs.toLocaleString("en-US") : null;
  /* A finished take whose copy is missing says so under its name; Refresh sits in the picture's corner. */
  const reason = face === "unavailable" ? "Preview unavailable" : takeReasonLine(take, compact);
  const kind = entryKind(entry);
  /* Draft mode (lib/draftFinal.ts): a draft or its final says so, unless its strip's label already does ("draft · 480p"). */
  const pair = take.pair && !label ? (take.pair.role === "draft" ? "Draft" : "Final") : null;
  const refresh = async () => { setBroken(null); setAttempt((n) => n + 1); await onRefresh(); };
  const fail = () => setBroken(entry.url);
  const inner = (
    <>
      <Face key={attempt} face={face} entry={entry} onFail={fail} />
      {/* The kind, except where Refresh has the picture to itself; a draft or a final (always a video) is named as one. */}
      {face !== "unavailable" && (variant !== "grid" || kind === "audio" || kind === "file")
        ? <span className="gx-badge" {...(pair ? { "data-testid": "take-pair" } : {})}>{pair ? pair.toUpperCase() : KIND_BADGE[kind]}</span> : null}
      {/* NEW gives its corner to Refresh. */}
      {fresh && face !== "unavailable" ? <span className="gx-badge gx-badge--new">NEW</span> : null}
      {chip ? <Chip {...chip} need={needs ? ` · needs ${needs} cr` : null} /> : null}
    </>
  );
  const tone = face === "unavailable" ? "idle" : chip?.tone ?? "idle";
  const why = reason ? <span className="gx-tile-reason" data-tone={tone} title={face === "unavailable" ? "The stored copy did not load. Refresh reads the library again." : take.detail ?? reason} data-testid="take-reason">{reason}</span> : null;
  const refreshButton = face === "unavailable" ? <span className="gx-tile-over"><Refresh onRefresh={refresh} name={take.name} /></span> : null;
  const need = needs ? <span className="gx-tile-reason gx-tile-need" data-tone="waiting" data-testid="take-need">Needs {needs}{"\u00a0"}cr</span> : null;
  /* A take held for credits carries its way out: Release at the exact price (the 2-up Library tile leaves it to the Inspector). */
  const release = take.status === "held" && variant !== "library" ? <ReleaseTake entry={entry} onReleased={onRefresh} place="tile" /> : null;
  /* A screen reader hears the take and its state, not the badge text inside the picture. */
  const spoken = [label, take.name, pair, chip?.label ?? (face === "unavailable" ? "Preview unavailable" : null)].filter(Boolean).join(" · ");
  const shownName = label ?? take.name;
  /* In a strip the card is one of the strip's list of takes (TakeStrip), under #406's `gen-batch-take`. */
  const strip = Boolean(label) && variant === "grid";
  const attrs = {
    "data-status": take.status, "data-face": face, "data-variant": variant, "data-testid": testId ?? (strip ? "gen-batch-take" : "take-tile"),
    ...(take.pair ? { "data-pair": take.pair.role } : {}), ...(strip ? { role: "listitem" } : {}),
  };

  if (variant === "take") {
    return (
      <div className="pd-take-cell gx-tile" {...attrs}>
        <button type="button" role="radio" aria-checked={checked} aria-label={spoken} className="pd-take" onClick={onOpen} data-testid="edit-take" data-media={entry.media ?? "file"}
          {...previewAttrs(entryPreview(entry))} {...dragAttrs(take.id, { name: take.name, kind: entry.media ?? "file" })}>
          <span className="gx-tile-media pd-take-media">{inner}</span>
          <span className="pd-take-name">{shownName}</span>
          {why}
          {need}
        </button>
        {refreshButton}
        {release}
      </div>
    );
  }
  return (
    <div className={strip ? "gx-asset gx-tile gx-batch-take" : "gx-asset gx-tile"} {...attrs} data-selected={selected} data-cut={cut || undefined} data-asset={take.id}>
      <div className="gx-tile-media">
        <button type="button" className="gx-asset-thumb" title={take.name} aria-label={spoken} draggable data-ctx={`asset:${take.id}`} {...previewAttrs(entryPreview(entry))}
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
          <span className="gx-asset-name">{shownName}</span>
          <span className="gx-asset-meta">{meta ?? take.meta}</span>
        </>
      )}
      {why}
      {need}
      {release}
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
