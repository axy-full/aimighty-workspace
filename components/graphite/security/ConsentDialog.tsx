"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ConsentRecord } from "@/lib/security/consent-words";
import { ConsentForm } from "./ConsentForm";
import "./security.css";

/**
 * The consent step over the board (Gaps A, "?view=board&gap=identity&state=consent"): a dialog on a scrim, drawn on
 * the page rather than inside the canvas so the board's zoom never scales it. Escape or the scrim closes it; nothing
 * is kept until Record consent is pressed.
 */
const halt = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function ConsentDialog(props: {
  scope: string; projectId: string; subjectKey: string; subjectLabel: string;
  onDone: (consent: ConsentRecord) => void; onClose: () => void;
}) {
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    /* Portalled out of the canvas, but React still bubbles to the card: nothing here reaches the board's handlers. */
    <div className="gsec-layer nodrag nopan nowheel" data-testid="consent-dialog" onClick={halt} onPointerDown={halt} onMouseDown={halt} onDoubleClick={halt} onKeyDown={halt} onWheel={halt}>
      <div className="gsec-scrim" onClick={onClose} aria-hidden="true" />
      <div className="gsec-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <ConsentForm {...props} onCancel={onClose} layout="dialog" />
      </div>
    </div>,
    document.body,
  );
}
