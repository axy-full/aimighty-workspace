"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { TrayJob } from "@/lib/jobsTray";
import { downloadHref } from "@/lib/format";
import { byDay, justify, resultsCount, type ResultTile } from "@/lib/v12/make";
import { renderState } from "@/lib/v12/renderState";
import type { TypicalTimesReply } from "@/lib/v12/typicalTimes";
import { renderTakeOf } from "./use-results";

/** The width the grid has to fill, read as it changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.floor(el.clientWidth));
    read();
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    watch?.observe(el);
    return () => watch?.disconnect();
  }, []);
  return [ref, width];
}

/** The time now, every second while something renders (for "0:21 so far"), else frozen. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

const ACTIVE = new Set(["held", "queued", "running"]);

/**
 * Make's results (docs/redesign/inventory.md § 5.12 b): "Results · newest first", the count, then the takes in justified
 * rows that keep each take's true shape, under day dividers. Hover a finished take: select, download (free), and its
 * words, which load the prompt and its settings into the composer. A take in flight shows its render state (C1); one
 * that did not finish says whether anything was billed and offers Retry, which loads it into the composer to price again.
 */
/** A take still in flight is at least this wide for its height: its words (the stage, the time, the money) are on one line and must fit. */
const IN_FLIGHT_ASPECT = 1.5;

export function Results({ tiles, status, typical, trayPrices, paysInDollars, selected, onSelect, onOpen, onReuse }: {
  tiles: readonly ResultTile[];
  status: "loading" | "ready" | "error";
  typical: TypicalTimesReply | null;
  trayPrices: ReadonlyMap<string, TrayJob["price"]>;
  paysInDollars: boolean;
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (tile: ResultTile) => void;
  onReuse: (tile: ResultTile) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const now = useNow(tiles.some((t) => ACTIVE.has(t.source.status)));
  const groups = byDay(tiles, now);
  return (
    <section className="v12-mk-results" aria-labelledby="v12-mk-results-title" data-testid="v12-make-results">
      <div className="v12-mk-results-head">
        <span className="v12-mk-results-name"><h2 id="v12-mk-results-title">Results</h2><span className="v12-mk-quiet">newest first</span></span>
        <span className="v12-mk-count" data-testid="v12-make-count">{selected.size ? `${selected.size} selected · ` : ""}{resultsCount(tiles.length)}</span>
      </div>
      <div ref={box} className="v12-mk-grid">
        {!tiles.length ? (
          <p className="v12-mk-empty" data-testid="v12-make-empty">
            {status === "loading" ? "Reading your results…" : status === "error" ? "Your results could not be read. They show here when they load." : "What you make shows here. Describe it below and press Make."}
          </p>
        ) : width > 0 ? groups.map((group) => (
          <div key={group.label} className="v12-mk-day">
            <div className="v12-mk-divider" data-testid="v12-make-day"><span>{group.label}</span><span className="v12-mk-rule" /></div>
            {justify(group.items, (t) => (t.source.status === "succeeded" ? t.aspect : Math.max(t.aspect, IN_FLIGHT_ASPECT)), width).map((row, r) => (
              <div key={r} className="v12-mk-row" style={{ height: row.height }}>
                {row.items.map(({ item, width: w }) => (
                  <Tile key={item.id} tile={item} width={w} now={now} typical={typical} trayPrice={trayPrices.get(item.id)} paysInDollars={paysInDollars}
                    selected={selected.has(item.id)} onSelect={() => onSelect(item.id)} onOpen={() => onOpen(item)} onReuse={() => onReuse(item)} />
                ))}
              </div>
            ))}
          </div>
        )) : null}
      </div>
    </section>
  );
}

function Tile({ tile, width, now, typical, trayPrice, paysInDollars, selected, onSelect, onOpen, onReuse }: {
  tile: ResultTile; width: number; now: number; typical: TypicalTimesReply | null; trayPrice: TrayJob["price"] | undefined; paysInDollars: boolean;
  selected: boolean; onSelect: () => void; onOpen: () => void; onReuse: () => void;
}) {
  const g = tile.source;
  const done = g.status === "succeeded" && tile.url;
  const state = done ? null : renderState(renderTakeOf(g, trayPrice, paysInDollars), now, typical);
  const style = { flex: `0 0 ${width}px` } as CSSProperties;
  return (
    <div className="v12-mk-tile" style={style} data-kind={tile.kind} data-state={state?.stage ?? "ready"} data-selected={selected ? "" : undefined}
      data-testid="v12-make-tile" data-take={tile.id}>
      {done ? (
        <>
          {tile.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- Particl's own media route, already sized
            <img className="v12-mk-media" src={tile.url!} alt="" loading="lazy" draggable={false} />
          ) : tile.kind === "video" ? (
            <video className="v12-mk-media" src={tile.url!} muted playsInline preload="metadata" aria-hidden="true" />
          ) : (
            <span className="v12-mk-audio" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M2 8v0M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 8v0" /></svg>
            </span>
          )}
          <button type="button" className="v12-mk-open" onClick={onOpen} aria-label={`Open: ${tile.prompt}`} data-testid="v12-make-tile-open" />
          {tile.kind === "video" ? <span className="v12-mk-play" aria-hidden="true">▶</span> : null}
          <button type="button" className="v12-mk-check" onClick={onSelect} aria-pressed={selected} title="Select — Add this result to a selection." aria-label="Select" data-testid="v12-make-tile-select">
            {selected ? "✓" : ""}
          </button>
          <a className="v12-mk-download" href={downloadHref(tile.url!)} download title="Download — The full-resolution original of this take. Free." aria-label="Download, free" data-testid="v12-make-tile-download">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v9M4.5 7.5L8 11l3.5-3.5M3 13h10" /></svg>
          </a>
          <button type="button" className="v12-mk-caption" onClick={onReuse} disabled={Boolean(tile.reuseBlock)}
            title={tile.reuseBlock ?? "Load this prompt and its settings into the composer"} data-testid="v12-make-tile-caption">{tile.prompt}</button>
        </>
      ) : state ? (
        <div className="v12-mk-render" data-testid="v12-make-tile-render" data-stage={state.stage}>
          <span className="v12-mk-render-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="v12-mk-render-text">
            <span className="v12-mk-render-stage" data-tone={state.tone}><span className="v12-mk-dot" aria-hidden="true" />{state.label}</span>
            {state.tile ? <span className="v12-mk-render-line" title={state.line?.title ?? state.tile} data-testid="v12-make-tile-line">{state.tile}</span> : null}
            {state.bar ? <span className="v12-mk-bar" data-hold={state.bar.hold ? "" : undefined}><span style={{ width: `${Math.round(state.bar.pct * 100)}%` }} /></span> : null}
            {state.failed && !tile.reuseBlock ? <button type="button" className="v12-mk-retry" onClick={onReuse} title="Load it into the composer; Make shows its price" data-testid="v12-make-tile-retry">{state.retry?.label ?? "Retry"}</button> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
