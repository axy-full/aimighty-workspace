"use client";
import type { ReactNode } from "react";
import "./library-tile.css";

export type AttachThumb = {
  key: string;
  name: string;
  /** The tile's picture: components/graphite/LibraryTile TileMedia or LocalTileMedia. */
  picture: ReactNode;
  testId?: string;
};

/**
 * The files a prompt box holds, under the box: one small Library tile each (components/graphite/library-tile.css),
 * in a row that wraps. Pressing a tile removes that file from what the box sends; its name says so ("Remove name").
 */
export function AttachThumbs({ items, onRemove, disabled = false, testId = "attach-thumbs" }: {
  items: readonly AttachThumb[];
  onRemove: (key: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  if (!items.length) return null;
  return (
    <ul className="gx-at" aria-label="Attached files" data-testid={testId}>
      {items.map((item) => (
        <li key={item.key} data-testid={item.testId}>
          <button type="button" className="bd-tile gx-at-tile" aria-label={`Remove ${item.name}`} title={item.name} disabled={disabled}
            onClick={() => onRemove(item.key)} data-testid="attach-thumb">
            {item.picture}
            <span className="bd-tile-name" aria-hidden="true">{item.name}</span>
            <span className="gx-at-x" aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
