"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { displayModelName } from "@/lib/models";
import { downloadHref } from "@/lib/format";
import { exact } from "@/lib/shell/price-words";
import { dayLabel, type ResultTile } from "@/lib/v12/make";
import { knownQuote } from "@/lib/v12/quote";
import { useOverlay, useV12PortalRoot } from "@/components/v12/ui/overlay";
import { useFocusReturn } from "@/components/v12/ui/Popover";
import { takesSeed } from "@/lib/workspace/composer";
import { Price } from "@/components/v12/ui/Price";

/** Why "Reuse seed" can't be pressed here: this engine takes no seed (today only Seedance does). */
export const SEED_LATER = "This engine doesn't repeat a seed. Variations puts these words and settings in the composer.";

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Make's viewer (docs/redesign/inventory.md § 5.12): one finished take large, its words and settings beside it. ‹ › and
 * ←/→ step through the results; Esc closes it first of anything open (the overlay stack's "viewer" layer). Its words load
 * the prompt and settings into the composer; "Use as reference" adds the take to the composer; Download is free.
 * What a take cost is the ledger's figure for it.
 */
export function Viewer({ tiles, index, onIndex, onClose, onReuse, onReuseSeed, onReference, paysInDollars }: {
  tiles: readonly ResultTile[];
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  onReuse: (tile: ResultTile) => void;
  /** Loads the take into the composer with its seed, to repeat it. */
  onReuseSeed: (tile: ResultTile, seed: number) => void;
  onReference: (tile: ResultTile) => void;
  paysInDollars: boolean;
}) {
  const open = index !== null && Boolean(tiles[index]);
  const panel = useRef<HTMLDivElement>(null);
  useOverlay("viewer", open, onClose, { refs: [panel], outside: false });
  useFocusReturn(open, panel);
  const portal = useV12PortalRoot();
  const [now] = useState(() => Date.now());
  const n = tiles.length;
  useEffect(() => {
    if (!open || index === null) return;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
      if (e.key === "ArrowRight") { e.preventDefault(); onIndex((index + 1) % n); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); onIndex((index - 1 + n) % n); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, index, n, onIndex]);
  if (!open || !portal || index === null) return null;
  const tile = tiles[index];
  const g = tile.source;
  const p = (g.params ?? {}) as Record<string, unknown>;
  const seed = typeof p.seed === "number" ? p.seed : null;
  const meta = [displayModelName(g.model), typeof p.resolution === "string" ? p.resolution : null, typeof p.ratio === "string" ? p.ratio : null,
    seed != null ? `seed ${seed}` : null, clock(g.createdAt)].filter(Boolean).join(" · ");
  const cost = !paysInDollars && typeof g.creditsBilled === "number" ? knownQuote(exact(g.creditsBilled)) : null;
  return createPortal(
    <div className="v12-scrim v12-mk-viewer-scrim" data-scrim="viewer" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="v12-make-viewer">
      <div ref={panel} role="dialog" aria-modal="true" aria-label={`${tile.type}: ${tile.prompt}`} tabIndex={-1} className="v12-mk-viewer">
        <div className="v12-mk-viewer-media">
          {tile.kind === "image" && tile.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- Particl's own media route, shown whole
            <img src={tile.url} alt="" data-testid="v12-make-viewer-media" />
          ) : tile.url ? (
            <video src={tile.url} controls playsInline preload="metadata" data-testid="v12-make-viewer-media" />
          ) : null}
          {n > 1 ? (
            <>
              <button type="button" className="v12-mk-viewer-step" data-side="prev" onClick={() => onIndex((index - 1 + n) % n)} title="Previous take · ←" aria-label="Previous take" data-testid="v12-make-viewer-prev">‹</button>
              <button type="button" className="v12-mk-viewer-step" data-side="next" onClick={() => onIndex((index + 1) % n)} title="Next take · →" aria-label="Next take" data-testid="v12-make-viewer-next">›</button>
            </>
          ) : null}
          <span className="v12-mk-viewer-count" data-testid="v12-make-viewer-count">{index + 1} / {n}</span>
        </div>
        <div className="v12-mk-viewer-side">
          <div className="v12-mk-viewer-top">
            <span className="v12-mk-quiet">{tile.type}</span>
            <button type="button" className="v12-mk-viewer-x" onClick={onClose} title="Close · Esc" aria-label="Close" data-testid="v12-make-viewer-close">×</button>
          </div>
          <button type="button" className="v12-mk-viewer-prompt" onClick={() => onReuse(tile)} disabled={Boolean(tile.reuseBlock)}
            title={tile.reuseBlock ?? "Load this prompt and its settings into the composer"} data-testid="v12-make-viewer-prompt">{tile.prompt}</button>
          <div className="v12-mk-viewer-meta">
            <span data-testid="v12-make-viewer-meta">{meta}</span>
            {cost ? <span className="v12-mk-mono" data-testid="v12-make-viewer-cost"><Price quote={cost} /> for this take</span> : null}
            <span>{dayLabel(g.createdAt, now)} · {clock(g.createdAt)}</span>
            {seed != null ? (
              <span className="v12-mk-viewer-seed" data-testid="v12-make-viewer-seed">
                <span className="v12-mk-mono">Seed {seed}</span>
                {/* A clip's seed goes out with the next make (lib/workbench/generation-request.ts `seed`); an engine that takes none has the button off (takesSeed). */}
                <button type="button" className="v12-mk-link" disabled={!takesSeed(tile.model) || Boolean(tile.reuseBlock)} onClick={() => onReuseSeed(tile, seed)}
                  title={!takesSeed(tile.model) ? SEED_LATER : tile.reuseBlock ?? "Reuse this seed in the composer"} data-testid="v12-make-viewer-reuse-seed">Reuse seed</button>
              </span>
            ) : null}
          </div>
          <div className="v12-mk-viewer-actions">
            <button type="button" className="v12-mk-action" onClick={() => onReuse(tile)} disabled={Boolean(tile.reuseBlock)} title={tile.reuseBlock ?? "Its words and settings go into the composer; Make shows the price"} data-testid="v12-make-viewer-reuse">
              <span>Variations</span><span className="v12-mk-quiet">priced in the composer</span>
            </button>
            {tile.kind !== "audio" ? (
              <button type="button" className="v12-mk-action" onClick={() => onReference(tile)} title="Add this take to the composer's references" data-testid="v12-make-viewer-reference">
                <span>Use as reference</span><span className="v12-mk-quiet">free</span>
              </button>
            ) : null}
            {tile.url ? (
              <a className="v12-mk-action" href={downloadHref(tile.url)} download title="The full-resolution original of this take" data-testid="v12-make-viewer-download">
                <span>Download</span><span className="v12-mk-quiet">free</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    portal,
  );
}
