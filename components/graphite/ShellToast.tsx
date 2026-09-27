"use client";
import { useShell } from "@/lib/shell/state";
import { splitUndoHint } from "@/lib/shell/undo";

/**
 * The shell's toast. When it announces something the undo stack can take
 * back, it carries an Undo button — the phone's ⌘Z — and the "⌘Z to undo"
 * half is hidden where there is no keyboard to press it on.
 */
export function ShellToast({ text }: { text: string }) {
  const shell = useShell();
  if (!text) return null;
  const offer = shell.undoToast === text && shell.canUndo;
  const { lead, hint } = offer ? splitUndoHint(text) : { lead: text, hint: "" };
  return (
    <div className="gx-toast" role="status" data-testid="toast" data-undo={offer || undefined}>
      <span className="gx-toast-text">{lead}{hint ? <span className="gx-toast-kbd">{hint}</span> : null}</span>
      {offer ? <button type="button" className="gx-toast-undo" onClick={(e) => { e.stopPropagation(); void shell.undo(); }} data-testid="toast-undo">Undo</button> : null}
    </div>
  );
}
