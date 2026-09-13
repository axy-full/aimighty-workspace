"use client";

import type { ReactNode } from "react";

/**
 * The desk's block (SOW surfaces board 12h): `--card`, 1px `--border`,
 * radius 12, `18px 20px`; the head is one row, 12 apart, `padding-bottom
 * 10px` — the title at 600 18, the line at 400 13 `--ink-muted` beside
 * it, and whatever sits at the right (`margin-left:auto`). Below 768 the
 * head wraps and the line drops under the title.
 */
export function Card({ title, line, head, children, className = "", label, span = false }: {
  title: string; line?: ReactNode; head?: ReactNode; children?: ReactNode; className?: string; label?: string;
  /** Spans both columns of the desk's grid (Studios, the defaults line). */
  span?: boolean;
}) {
  return (
    <section aria-label={label ?? title} data-desk-card=""
      className={`flex min-w-0 flex-col rounded-card border border-border bg-card px-[20px] py-[18px] ${span ? "col-span-2 max-xl:col-span-1" : ""} ${className}`}>
      <span className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] pb-[10px]">
        <span className="text-[18px] font-semibold leading-none text-ink">{title}</span>
        {line && <span className="text-[13px] leading-[1.3] text-ink-muted max-md:basis-full">{line}</span>}
        {head && <span className="ml-auto flex items-center gap-[8px] max-md:ml-0 max-md:basis-full">{head}</span>}
      </span>
      {children}
    </section>
  );
}

/** A 48px row on the .07 rule at 400 14 — the grid is the caller's. */
export const ROW = "grid min-h-[48px] items-center border-t border-[rgba(245,246,248,.07)] text-[14px] leading-none text-ink";

/** The block's one-line empty state, in `--ink-body`, on the same rule as a row would be. */
export function Nothing({ children }: { children: ReactNode }) {
  return <span className="flex min-h-[48px] items-center border-t border-[rgba(245,246,248,.07)] text-[13px] leading-[1.4] text-ink-body">{children}</span>;
}

/** A text action in a row — `Skip`, `Withdraw` — in `--ink-body`, 44pt tall on a phone. */
export function TextAction({ children, onClick, disabled = false, className = "", label }: { children: ReactNode; onClick: () => void; disabled?: boolean; className?: string; label?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label}
      className={`tap44 text-[14px] font-normal leading-none text-ink-body disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}

/** A v2 field on the desk: 36px, radius 8, 1px `--border-mid`, 13.5px — 44px and 16px on a phone so iOS does not zoom. */
export const FIELD = "h-[36px] w-full min-w-0 rounded-ctl border border-border-mid bg-transparent px-[10px] text-[13.5px] leading-none text-ink placeholder:text-ink-muted max-md:h-[44px] max-md:text-[16px]";
export const FIELD_LABEL = "flex min-w-0 flex-col gap-[6px] text-[12.5px] leading-none text-ink-muted";
