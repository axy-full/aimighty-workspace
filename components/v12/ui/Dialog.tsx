"use client";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";
import { useOverlay, useV12PortalRoot } from "./overlay";
import type { OverlayLayer } from "./overlay-stack";
import { useFocusReturn } from "./Popover";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal on the overlay stack: a centred dialog, or a sheet from the bottom edge (phone). Esc, × and a click on the
 * scrim close it (its typed text is the caller's state, so it stays). Focus moves in, stays in while it is open, and
 * goes back to where it was.
 *
 * `layer` places it in the Esc order (docs/redesign/inventory.md § 4.1): "viewer" for the Make viewer, "join" for the
 * join sheet, "menu" (the default) for the other sheets and dialogs. `scrim` picks the prototype's darkness for each.
 */
export function Dialog({ open, onClose, label, title, children, footer, variant = "dialog", layer = "menu", scrim = "default", width, closeTip = "Close" }: {
  open: boolean;
  onClose: () => void;
  /** Accessible name when there is no visible title. */
  label: string;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "dialog" | "sheet";
  layer?: OverlayLayer;
  scrim?: "default" | "join" | "viewer";
  width?: number;
  /** The × tooltip's line ("Close · Esc — your text stays in the bar", for the join sheet). */
  closeTip?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(layer, open, onClose, { refs: [panel], outside: false });
  useFocusReturn(open, panel);
  useEffect(() => {
    if (!open || !panel.current) return;
    /* What was asked for, else the first field or button in the body, else the × in the head. */
    const p = panel.current;
    (p.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? p.querySelector<HTMLElement>(`.v12-dialog-body :is(${FOCUSABLE})`) ?? p.querySelector<HTMLElement>(FOCUSABLE) ?? p).focus({ preventScroll: true });
  }, [open]);

  /* Tab stays inside. */
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panel.current) return;
    const all = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!all.length) { event.preventDefault(); return; }
    const first = all[0];
    const last = all[all.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const portal = useV12PortalRoot();
  const root = open ? portal : null;
  if (!root) return null;
  return createPortal(
    <div className="v12-scrim" data-scrim={scrim} data-variant={variant} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title ? undefined : label} aria-labelledby={title ? titleId : undefined}
        tabIndex={-1} className="v12-dialog" data-variant={variant} style={width ? { width } : undefined} onKeyDown={trap}>
        <div className="v12-dialog-head">
          {title ? <h2 id={titleId} className="v12-dialog-title">{title}</h2> : <span />}
          <IconButton tooltip={{ name: closeTip, shortcut: "Esc" }} label="Close" size="sm" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </IconButton>
        </div>
        <div className="v12-dialog-body">{children}</div>
        {footer ? <div className="v12-dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    root,
  );
}

/** The bottom sheet: a Dialog from the bottom edge, radius 16 on top. */
export function Sheet(props: Omit<Parameters<typeof Dialog>[0], "variant">) {
  return <Dialog {...props} variant="sheet" />;
}
