"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useV12PortalRoot } from "./overlay";
import { toastDuration, type ToastInput } from "./toast-time";

/**
 * Toasts (docs/redesign/inventory.md § 4.4): one pill at a time, bottom-centre everywhere (docs/redesign-plan.md,
 * decision 2), with a green dot. It lasts 2.6 s, or 5 s when it carries an action: "Undo", or "View" for a result that
 * is ready. A pointer over it or keyboard focus on it holds it. While an Undo shows, ⌘Z (Ctrl+Z) runs it, unless the
 * caret is in a text field, where ⌘Z is the field's own.
 */
export { TOAST_MS, TOAST_ACTION_MS, toastDuration, type ToastAction, type ToastInput } from "./toast-time";
type Shown = ToastInput & { key: number };

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/** Raises a toast. Outside a ToastProvider it does nothing. */
export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext) ?? noop;
}
const noop = () => {};

const editable = (node: EventTarget | null) => node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));

/** `bottom`: px above the bottom edge, so the toast clears the screen's bar (92 on a board, 196 over Make). */
export function ToastProvider({ children, bottom = 92 }: { children: ReactNode; bottom?: number }) {
  const [toast, setToast] = useState<Shown | null>(null);
  const [held, setHeld] = useState(false);
  const counter = useRef(0);
  const raise = useCallback((input: ToastInput) => { counter.current += 1; setToast({ ...input, key: counter.current }); setHeld(false); }, []);
  const dismiss = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!toast || held) return;
    const timer = setTimeout(dismiss, toastDuration(toast));
    return () => clearTimeout(timer);
  }, [toast, held, dismiss]);

  useEffect(() => {
    if (!toast?.action || toast.action.label !== "Undo") return;
    const run = toast.action.run;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.shiftKey || editable(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toast, dismiss]);

  const root = useV12PortalRoot();
  const value = useMemo(() => raise, [raise]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {root ? createPortal(<>
        {/* One live region for the provider's life: only its words change, so each toast is announced. */}
        <div className="v12-sr" role="status" aria-live="polite" data-testid="v12-toast-live">{toast?.text ?? ""}</div>
        {toast ? <div key={toast.key} className="v12-toast" data-testid="v12-toast" style={{ bottom }}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") setHeld(true); }} onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
          <span className="v12-toast-dot" aria-hidden />
          <span className="v12-toast-text">{toast.text}</span>
          {toast.action ? (
            <button type="button" className="v12-toast-action" data-testid="v12-toast-action" onClick={() => { const run = toast.action!.run; dismiss(); run(); }}>
              {toast.action.label}
            </button>
          ) : null}
        </div> : null}
      </>, root) : null}
    </ToastContext.Provider>
  );
}
