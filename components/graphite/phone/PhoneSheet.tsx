"use client";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * A sheet that slides up over the phone's current screen with a scrim (README § 3.6: Change with words, the
 * Atomik sheet, Make's engine list). Esc and a press on the scrim close it; focus moves into it and back
 * out to what opened it. Flat Graphite: an opaque fill and a hairline, no blur.
 */
export function PhoneSheet({ title, onClose, children, testId, footer }: { title: string; onClose: () => void; children: ReactNode; testId?: string; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("textarea, input, button")?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); before?.focus?.({ preventScroll: true }); };
  }, [onClose]);
  return (
    <div className="ph-sheet-root" data-testid={testId}>
      <button type="button" className="ph-scrim" aria-label={`Close ${title}`} tabIndex={-1} onClick={onClose} data-testid="phone-scrim" />
      <div ref={panel} className="ph-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ph-sheet-head">
          <h2 className="ph-sheet-title">{title}</h2>
          <button type="button" className="ph-sheet-close" onClick={onClose} data-testid="phone-sheet-close">Close</button>
        </div>
        <div className="ph-sheet-body">{children}</div>
        {footer ? <div className="ph-sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
