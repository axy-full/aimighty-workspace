"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useMoney } from "@/lib/price";
import Loader, { LOADER_SIZES } from "@/components/atomik/Loader";

/**
 * The two buttons (design/particl-v2/README.md §3), in the three places the
 * boards put them, each at the board's own numbers:
 *
 *   header  a page header (7a, 7b): 38px pills. Primary ink-filled, Outfit
 *           600 13px, `0 16px`; secondary 1px `--border-mid`, 500 13px,
 *           `0 14px`.
 *   card      the one card in the compact rail (10a): primary 44px, radius
 *             10, 600 13.5px, `0 12px`; the secondary pair beneath 36px,
 *             radius 9, 500 12.5px, centred.
 *   rail      the expanded rail's pinned footer (10a): primary 46px, radius
 *             12, 600 14px, `0 14px`, label left and cost right;
 *             secondaries as the card's.
 *   composer  Make's composer (8a, 11a): primary 48px, radius 12, 600 14px,
 *             `0 16px`.
 *   sheet     the mobile sheet (9c): primary 54px, radius 14, 600 16px,
 *             `0 18px`; secondaries 46px, radius 12, 500 14px.
 *   auth      the auth card (12i): primary 46px, radius 10, 600 14px,
 *             `0 16px`, full width; secondary the same height and radius,
 *             500 14px, centred, full width.
 *
 * Every secondary's edge is `--border-mid`, because §3 names the token
 * ("transparent, 1px --border-mid"); the boards draw the rectangular ones
 * at .16, which is the prototype's hand, not the spec's. Where the spec is
 * silent the board's number is used; where it names a token, the token.
 *
 * Primary: ink fill, ground text, the cost right-aligned in mono
 * `--on-primary-cost`. ONE per screen — it is the thing that spends, so it
 * is the thing the eye lands on. When a rail opens, the page's primary
 * drops to `outlined` so the rail's own primary is the one.
 *
 * `cost` is a number in the workspace's own unit — credits, or dollars for
 * a workspace still billed at cost — and it comes from the engine; the
 * button formats it through `useMoney` like every other price, and never
 * knows it. A button with no cost shows nothing where
 * the price would be, not "0 cr" (unless the caller says `0`, which is a
 * fact worth stating: `Download 2 masters · 0 CR`).
 *
 * `busy` (board 11a): the ring appears at 14px where the label's left edge
 * was, 10px before the label, and the label goes to its present tense. The
 * ring keeps the loader's 300ms rule — a press that resolves faster never
 * shows it — while its box is reserved from the first frame.
 * The button keeps its width and its price: both rows are laid out in one
 * cell and the one not in use is hidden, so the width is the wider of the
 * two from the first frame. A present-tense label with the ring beside it
 * is meant to fit inside the idle label, and does when the caller gives one.
 *
 * Pixels, not rem, throughout: the root is 15px, so a rem height lands
 * 6% short of the board's.
 */
type Props = {
  variant?: "primary" | "secondary";
  placement?: "header" | "card" | "rail" | "composer" | "sheet" | "auth";
  /** A primary while a rail is open: the fill goes, the border stays. */
  outlined?: boolean;
  /** A secondary in `--ink-body` — the board dims the lesser of a pair (`Stop`). */
  muted?: boolean;
  cost?: number;
  /** After the cost, in the same mono: `· 0:05`. It widens the button when
      it appears, so a caller that shows a timer should show `· 0:00` from
      the first frame. */
  costSuffix?: ReactNode;
  busy?: boolean;
  /** The label while busy; present tense. Defaults to the label itself. */
  busyLabel?: ReactNode;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"button">, "children">;

const SHAPE = {
  header: {
    primary: "h-[38px] rounded-pill px-[16px] text-[13px] font-semibold gap-[10px]",
    secondary: "h-[38px] rounded-pill px-[14px] text-[13px] font-medium border border-border-mid gap-[10px]",
  },
  card: {
    primary: "h-[44px] rounded-tile px-[12px] text-[13.5px] font-semibold gap-[10px]",
    secondary: "h-[36px] rounded-[9px] px-[12px] text-[12.5px] font-medium border border-border-mid justify-center gap-[10px]",
  },
  rail: {
    primary: "min-h-[46px] rounded-card px-[14px] text-[14px] font-semibold gap-[10px]",
    secondary: "h-[36px] rounded-[9px] px-[12px] text-[12.5px] font-medium border border-border-mid justify-center gap-[10px]",
  },
  composer: {
    primary: "h-[48px] rounded-card px-[16px] text-[14px] font-semibold gap-[10px]",
    secondary: "h-[44px] rounded-tile px-[14px] text-[13.5px] font-medium border border-border-mid gap-[10px]",
  },
  sheet: {
    primary: "h-[54px] rounded-mobile px-[18px] text-[16px] font-semibold gap-[10px]",
    secondary: "h-[46px] rounded-card px-[14px] text-[14px] font-medium border border-border-mid justify-center gap-[10px]",
  },
  auth: {
    primary: "h-[46px] rounded-tile px-[16px] text-[14px] font-semibold gap-[12px] w-full",
    secondary: "h-[46px] rounded-tile px-[14px] text-[14px] font-medium border border-border-mid w-full justify-center gap-[10px]",
  },
} as const;

export default function Button({
  variant = "secondary", placement = "header", outlined = false, muted = false, cost, costSuffix,
  busy = false, busyLabel, children, className = "", disabled, type = "button", ...rest
}: Props) {
  const { price } = useMoney();
  const filled = variant === "primary" && !outlined;
  const paint = filled
    ? "bg-ink text-ground"
    : variant === "primary"
      ? "border border-border-mid text-ink hover:border-border-hover"
      : `${muted ? "text-ink-body" : "text-ink"} hover:border-border-hover`;
  return (
    <button type={type} disabled={disabled || busy} aria-busy={busy || undefined}
      className={`inline-flex items-center whitespace-nowrap leading-none disabled:cursor-not-allowed ${
        busy ? "" : "disabled:opacity-60"} ${variant === "primary" ? "justify-between" : ""} ${
        SHAPE[placement][variant]} ${paint} ${className}`}
      {...rest}>
      <span className="grid">
        <span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`} aria-hidden={busy || undefined}>
          {children}
        </span>
        {/* Laid out from the first frame when the caller gave a present-tense
            label, so the width is reserved; otherwise only while busy. */}
        {(busy || busyLabel !== undefined) && (
          <span className={`col-start-1 row-start-1 inline-flex items-center gap-[10px] ${busy ? "" : "invisible"}`}
            aria-hidden={!busy || undefined}>
            <Loader size={LOADER_SIZES.button} on={filled ? "primary" : "dark"} />
            {busyLabel ?? children}
          </span>
        )}
      </span>
      {cost !== undefined && (
        <span className={`ui-mono ui-mono-cost ${filled ? "text-on-primary-cost" : "text-ink-muted"}`}>
          {price(cost)}{costSuffix}
        </span>
      )}
    </button>
  );
}
