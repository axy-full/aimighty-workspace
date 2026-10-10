"use client";
import type { CSSProperties, MouseEvent } from "react";
import { wallLayout, type WallTile } from "@/lib/v12/home";

/**
 * The wall (docs/redesign/inventory.md § 5.9 · 2): this workspace's newest finished stills and clips on a 6-column
 * mosaic. A tile's label names what it is and what it is called. Hovering shows "Make one like this" and Remix this;
 * clicking picks it (a "Picked" pill, the others fade, the bar opens its sheet). Remix opens Make with the take's own
 * recipe, where Make shows its price. A new workspace sees one quiet line instead of sample work.
 */
export function Wall({ tiles, status, row, picked, onPick, onRemix, onMenu }: {
  tiles: readonly WallTile[];
  status: "loading" | "ready" | "error";
  /** Grid row height, px. */
  row: number;
  picked: string | null;
  onPick: (tile: WallTile) => void;
  onRemix: (tile: WallTile) => void;
  /** A right-click on a tile (components/v12/menus/WallMenu.tsx). */
  onMenu?: (event: MouseEvent, tile: WallTile) => void;
}) {
  const cells = wallLayout(tiles.length);
  const style = { "--v12-wall-row": `${row}px` } as CSSProperties;
  if (!tiles.length) {
    return (
      <div className="v12-hm-wall v12-hm-wall-empty" style={style} data-testid="v12-home-wall" data-state={status}>
        <p className="v12-hm-wall-note" data-testid="v12-home-wall-empty">
          {status === "loading" ? "Reading your work…" : status === "error" ? "Your work could not be read. It shows here when it loads." : "What you make shows here. Describe a film, ad or idea below to start."}
        </p>
      </div>
    );
  }
  return (
    <div className="v12-hm-wall" style={style} data-testid="v12-home-wall" data-picked={picked ? "" : undefined}>
      {tiles.map((tile, i) => {
        const on = picked === tile.id;
        return (
          <div key={tile.id} className="v12-hm-tile" style={{ gridColumn: cells[i].col, gridRow: cells[i].row }} data-picked={on ? "" : undefined}
            data-faded={picked && !on ? "" : undefined} data-testid="v12-home-tile" data-tile={tile.id} onContextMenu={onMenu ? (e) => onMenu(e, tile) : undefined}>
            {tile.media === "video"
              ? <video className="v12-hm-tile-media" src={tile.url} muted playsInline preload="metadata" aria-hidden="true" />
              // eslint-disable-next-line @next/next/no-img-element -- Particl's own media route (/api/media), already sized
              : <img className="v12-hm-tile-media" src={tile.url} alt="" loading="lazy" />}
            <button type="button" className="v12-hm-tile-pick" onClick={() => onPick(tile)} aria-pressed={on}
              aria-label={`${on ? "Picked" : "Pick"}: ${tile.title}`} title={`${tile.title} · ${tile.type} — Make one like this`} data-testid="v12-home-tile-pick" />
            <span className="v12-hm-tile-label" aria-hidden="true">
              <span className="v12-hm-tile-type">{tile.type}</span>
              <span className="v12-hm-tile-title">{tile.title}</span>
            </span>
            <span className="v12-hm-tile-hover">
              <span className="v12-hm-tile-like" aria-hidden="true">Make one like this</span>
              <button type="button" className="v12-hm-tile-remix" onClick={() => onRemix(tile)} disabled={Boolean(tile.remixBlock)}
                title={tile.remixBlock ?? "Remix this — Open it in Make with its words and settings; Make shows the price."} data-testid="v12-home-tile-remix">Remix this</button>
            </span>
            {on ? <span className="v12-hm-tile-picked" data-testid="v12-home-tile-picked">Picked</span> : null}
          </div>
        );
      })}
    </div>
  );
}
