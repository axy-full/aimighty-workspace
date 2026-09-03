"use client";

/**
 * The work, as the room's main wall: every render in the project laid out
 * as a masonry that plays on approach. A render in flight takes its place
 * in the grid the moment it is submitted — a breathing card with the brand
 * thinking and the clock running — rather than a status word in a strip.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Gen } from "./GenCard";
import LazyMedia from "./LazyMedia";
import { Empty, ParticlSpinner } from "./ParticlMark";
import { shortLabel } from "@/lib/models";

export type FeedFilter = "all" | "video" | "image";

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

/** The tile's shape is the render's shape — a 9:16 stays a portrait. */
export function aspectOf(g: Gen): string {
  const r = String((g.params as { ratio?: string }).ratio ?? "");
  const m = r.match(/^(\d+):(\d+)$/);
  return m ? `${m[1]} / ${m[2]}` : "16 / 9";
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function Feed({
  gens, visible, activeId, onOpen, filter, setFilter, scopeName, className = "",
}: {
  /** Everything in scope — what the counts describe. */
  gens: Gen[];
  /** What the wall shows: the same list through the Clips/Stills filter,
   *  decided by the owner so the theatre walks exactly these. */
  visible: Gen[];
  activeId: string | null;
  onOpen: (id: string) => void;
  filter: FeedFilter;
  setFilter: (f: FeedFilter) => void;
  scopeName: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);

  // Columns follow the width: two on a phone, up to six on a wide desk.
  // Items are dealt round-robin so the newest sit on the top row, left to
  // right — the reading order a feed is expected to have.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      const min = w < 520 ? 156 : 208;
      setCols(Math.max(1, Math.min(6, Math.floor((w + 12) / (min + 12)))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One clock for every card in flight.
  const anyLive = gens.some((g) => g.status === "queued" || g.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const clips = gens.filter((g) => g.kind !== "image").length;
  const stills = gens.length - clips;
  const mixed = clips > 0 && stills > 0;
  const shown = visible;

  const columns: Gen[][] = Array.from({ length: cols }, () => []);
  shown.forEach((g, i) => columns[i % cols].push(g));
  const live = gens.filter((g) => g.status === "queued" || g.status === "running").length;

  return (
    <div ref={box} className={`feed ${className}`}>
      <div className="feed-head">
        <span className="feed-title">{scopeName}</span>
        {live > 0 && (
          <span className="feed-live"><span className="lamp lamp-live" />{live} rendering</span>
        )}
        {mixed && (
          <span className="feed-filter">
            {([["all", `All ${gens.length}`], ["video", `Clips ${clips}`], ["image", `Stills ${stills}`]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setFilter(k)} data-active={filter === k}>{label}</button>
            ))}
          </span>
        )}
        <span className="ml-auto" />
        <Link href="/all" className="feed-link">Library</Link>
      </div>

      {gens.length === 0 ? (
        <div className="feed-empty">
          <Empty
            title="Your first shot goes here"
            line="Describe it below. The cost sits on the button before you press it, and every render lands on this wall as it finishes."
          />
        </div>
      ) : shown.length === 0 ? (
        <div className="feed-empty"><Empty compact title="Nothing of this kind yet" /></div>
      ) : (
        <div className="masonry" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {columns.map((col, c) => (
            <div key={c} className="masonry-col">
              {col.map((g) => (
                <Tile key={g.id} gen={g} active={g.id === activeId} now={now} onOpen={() => onOpen(g.id)} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ gen, active, now, onOpen }: { gen: Gen; active: boolean; now: number; onOpen: () => void }) {
  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && Boolean(url);
  const live = gen.status === "queued" || gen.status === "running";
  const still = gen.kind === "image";
  const p = gen.params as { duration?: number; resolution?: string };
  const elapsed = Math.max(0, Math.floor((now - gen.createdAt) / 1000));

  return (
    <button
      type="button" onClick={onOpen} title={gen.title ? `${gen.title} — ${gen.prompt}` : gen.prompt}
      data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)}
      data-gen-title={gen.title ?? ""}
      className={`tile ${active ? "is-active" : ""} ${live ? "tile-live" : ""} ${gen.status === "failed" ? "tile-failed" : ""}`}
      style={{ aspectRatio: aspectOf(gen) }}
    >
      {done ? (
        <LazyMedia url={url!} kind={still ? "image" : "video"} hoverPlay alt={gen.prompt.slice(0, 120)} className="!absolute inset-0" />
      ) : live ? (
        <span className="tile-face">
          <ParticlSpinner size={26} className="text-dim" />
          <span className="tile-face-label">{gen.status === "queued" ? "Queued" : "Rendering"} · {mmss(elapsed)}</span>
          <span className="tile-face-sub">{shortLabel(gen.model)}{p.resolution ? ` · ${String(p.resolution).toUpperCase()}` : ""}</span>
        </span>
      ) : (
        <span className="tile-face">
          <span className="tile-face-label text-lift">{gen.status === "cancelled" ? "Cancelled" : "Failed"}</span>
          {gen.error && <span className="tile-face-error">{gen.error.slice(0, 160)}</span>}
        </span>
      )}

      {done && (
        <>
          <span className="tile-scrim" />
          <span className="tile-meta">
            <span className="truncate font-medium">
              {gen.title || (gen.shotCode ? `${gen.shotCode} v${gen.version ?? 1}` : clipId(gen.id))}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {still ? String(p.resolution ?? "").toUpperCase() : p.duration != null ? `${p.duration}s` : ""}
            </span>
          </span>
        </>
      )}
      {gen.reviewState === "approved" && <span className="tile-badge bg-ok" title="Approved">✓</span>}
      {gen.reviewState === "changes" && <span className="tile-badge bg-warn" title="Changes wanted">!</span>}
    </button>
  );
}
