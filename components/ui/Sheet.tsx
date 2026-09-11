"use client";

import { useEffect, type ReactNode } from "react";

/**
 * The mobile sheet (design/particl-v2/README.md §3, §14; board 9c): a
 * `rgba(5,6,8,.55)` scrim; the sheet in `--card` with a 1px `--border-mid`
 * top edge, 24px radius on top, `0 20px 28px` of padding, and a 36×4
 * grabber at .2 with `10px 0 18px` around it. It rises from the bottom
 * and clears the home indicator (ground rule 7). Esc and the scrim close
 * it; the content decides everything else.
 */
type Props = {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
};

export default function Sheet({ open, onClose, label, children, className = "" }: Props) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="ui-sheet-scrim absolute inset-0" />
      <div role="dialog" aria-modal="true" aria-label={label}
        className={`relative flex max-h-[92vh] flex-col rounded-t-[24px] border-t border-border-mid bg-card px-[20px] text-ink ${className}`}
        style={{ paddingBottom: "calc(28px + env(safe-area-inset-bottom, 0px))" }}>
        <div className="flex flex-none justify-center pb-[18px] pt-[10px]" aria-hidden="true">
          <span className="block h-[4px] w-[36px] rounded-[2px] bg-[rgba(245,246,248,.2)]" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
