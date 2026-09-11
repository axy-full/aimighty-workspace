"use client";

import { useEffect, type ReactNode } from "react";
import Mono from "./Mono";

/**
 * The phone's sheet (design/particl-v2-mobile/README.md; boards M3, M5,
 * M8, M9): every desktop right rail below 768. `#0F1116` (the rail's
 * colour), a .14 rule on top, radius 24 above, the 36×4 grabber at
 * `10px auto 0`, the scrim `rgba(5,6,8,.55)` that closes on a tap, a 48px
 * header (`0 16px`, 8 apart: a title at 600 14, a mono context line, the
 * sheet's own actions, the 34px ×), a body that scrolls (`4px 16px 12px`,
 * 12 apart), and a footer pinned at the bottom with the 26px safe area.
 * Sizes: compact = 58% of the screen, expanded = 92%, full = from 44px
 * down, auto = as tall as its content up to 92%. The page behind stops
 * scrolling while a sheet is open; Esc closes it.
 */
export type SheetSize = "compact" | "expanded" | "full" | "auto";

type Props = {
  open: boolean;
  onClose: () => void;
  label: string;
  size?: SheetSize;
  /** The header: a title (600 14), a mono context line, and the sheet's own actions (before the ×). */
  title?: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
  /** Pinned under the body: the one primary, or the ask field. */
  footer?: ReactNode;
  /** The footer's padding — `8px 16px 26px` for an ask field, `10px 16px 26px` for a pinned primary. */
  footerPad?: string;
  children: ReactNode;
  bodyClassName?: string;
};

const MAX: Record<SheetSize, string> = { compact: "58%", expanded: "92%", full: "calc(100% - 44px)", auto: "92%" };

export default function Sheet({ open, onClose, label, size = "auto", title, context, actions, footer, footerPad = "10px 16px 26px", children, bodyClassName = "" }: Props) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" data-sheet={size}>
      <button type="button" aria-label="Close" onClick={onClose} className="ui-sheet-scrim absolute inset-0" />
      <div role="dialog" aria-modal="true" aria-label={label}
        className={`ui-rail relative flex flex-col rounded-t-[24px] border-t border-border-mid text-ink ${size === "full" ? "h-[calc(100%-44px)]" : ""}`}
        style={{ maxHeight: MAX[size], paddingBottom: footer ? 0 : "calc(26px + env(safe-area-inset-bottom, 0px))" }}>
        <span className="mx-auto mt-[10px] block h-[4px] w-[36px] flex-none rounded-[2px] bg-[rgba(245,246,248,.25)]" aria-hidden="true" />
        {(title || context || actions) && (
          <div className="flex h-[48px] flex-none items-center gap-[8px] px-[16px]">
            {title && <span className="text-[14px] font-semibold leading-none text-ink">{title}</span>}
            {context && <Mono className="min-w-0 truncate">{context}</Mono>}
            <span className="ml-auto flex items-center gap-[8px]">
              {actions}
              <button type="button" onClick={onClose} aria-label="Close" className="tap44 flex h-[34px] w-[34px] items-center justify-center rounded-ctl border border-border-mid text-[15px] leading-none text-ink">×</button>
            </span>
          </div>
        )}
        <div className={`flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[16px] pb-[12px] pt-[4px] ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className="flex flex-none gap-[8px] border-t border-border" style={{ padding: footerPad, paddingBottom: `calc(${footerPad.split(" ").pop()} + env(safe-area-inset-bottom, 0px))` }}>{footer}</div>
        )}
      </div>
    </div>
  );
}
