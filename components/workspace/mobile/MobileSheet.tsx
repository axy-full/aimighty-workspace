"use client";
import { useEffect, type ReactNode } from "react";
import { MobileRing, RING } from "./MobileRing";

/**
 * The sheet chrome (05-mobile, "Sheets"). Every desktop right rail becomes
 * one of these, so the chrome is written once, exactly to the spec:
 *
 *   panel #0C0C0E · 24px top radius · 1px #2A2A2F top border · 36×4 grabber
 *   scrim rgba(5,6,8,.55), tap to close · 34px close · body scrolls
 *   26px bottom safe-area padding · max height 88% · dock behind the scrim
 *
 * Wave M-A wires one sheet through it (Search) so the primitive is proven;
 * Inspector, Atomik and Library arrive in M-C and change nothing here.
 */
export function MobileSheet({
  title,
  sub,
  dot,
  beating,
  onClose,
  children,
  testId = "mobile-sheet",
}: {
  title: string;
  sub?: string;
  /** The agent's colour, when this sheet carries the ring (Atomik, Search). */
  dot?: string;
  beating?: boolean;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  /* Esc closes: a phone can have a keyboard attached, and the sheet is modal. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pxm-sheet-host" data-testid={testId}>
      <button type="button" className="pxm-scrim" data-testid="mobile-sheet-scrim" aria-label="Close" onClick={onClose} />
      <div className="pxm-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pxm-grabber-row">
          <span className="pxm-grabber" aria-hidden="true" />
        </div>
        <div className="pxm-sheet-head">
          {dot ? <MobileRing size={RING.sheet} beating={beating} color={dot} /> : null}
          <span className="pxm-sheet-titles">
            <span className="pxm-sheet-title">{title}</span>
            {sub ? <span className="pxm-sheet-sub">{sub}</span> : null}
          </span>
          <button type="button" className="pxm-sheet-close" aria-label="Close" onClick={onClose}>
            <span className="pxm-sheet-close-inner" aria-hidden="true">×</span>
          </button>
        </div>
        <div className="pxm-sheet-body" data-testid="mobile-sheet-body">
          {children}
        </div>
      </div>
    </div>
  );
}
