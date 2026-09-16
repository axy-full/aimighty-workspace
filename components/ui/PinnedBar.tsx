"use client";

import type { ReactNode } from "react";

/**
 * The pinned block (design/particl-v2-mobile/README.md — "One primary,
 * pinned"; boards M2–M7): below 768 the screen's single filled button lives
 * in a block at the bottom, above the dock — `--ground`, a .08 rule on top,
 * `10px 16px 6px`; the dock beneath carries the safe area, the way M4 (the
 * one board that draws the block and the dock together) composes it —
 * holding a 50px button at radius 14 (`0 16px`, 600 15, the cost
 * right-aligned in mono `--on-primary-cost`), with an optional 50px square
 * before it (M3's `+`). The block is a flex sibling under the page's
 * scroll container, so the last row is always reachable.
 *
 * The button outlines (.2 border, `--ink-body` text) while any sheet is
 * open or the action is blocked — `outlined` is the caller's to say.
 */
export default function PinnedBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-none gap-[8px] border-t border-border bg-ground px-[16px] pb-[6px] pt-[10px] md:hidden ${className}`} data-pinned="">
      {children}
    </div>
  );
}

/** The pinned primary itself: 50px, radius 14, `0 16px`, 600 15; the cost in mono; outlined while a sheet is open or the action is blocked. */
export function PinnedPrimary({ children, cost, outlined = false, disabled = false, busy = false, onClick, label }: {
  children: ReactNode; cost?: ReactNode; outlined?: boolean; disabled?: boolean; busy?: boolean; onClick?: () => void; label?: string;
}) {
  const off = outlined || disabled;
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy} aria-label={label} data-render=""
      className={`flex h-[50px] flex-1 items-center justify-between rounded-mobile px-[16px] text-[15px] font-semibold leading-none ${
        off ? "border border-[rgba(245,246,248,.2)] bg-transparent text-ink-body" : "bg-action text-on-action hover:bg-action-hover"}`}>
      <span className="truncate">{children}</span>
      {cost !== undefined && <span className={`ui-mono ui-mono-cost !text-[12px] ${off ? "text-ink-muted" : "text-on-primary-cost"}`}>{cost}</span>}
    </button>
  );
}

/** A 50px square beside the primary (M3's `+`). */
export function PinnedSquare({ children, onClick, label }: { children: ReactNode; onClick?: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label}
      className="flex h-[50px] w-[50px] flex-none items-center justify-center rounded-mobile border border-[rgba(245,246,248,.16)] text-[20px] font-medium leading-none text-ink">
      {children}
    </button>
  );
}
