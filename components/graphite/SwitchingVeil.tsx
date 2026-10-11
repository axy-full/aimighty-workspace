"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { pressedControl, switchState, useSwitchState } from "@/lib/shell/switch-workspace";

/**
 * While a workspace switch runs (lib/shell/switch-workspace.ts), the page takes no edits: every save goes to the
 * workspace being left, and one that reached the server after the switch would be refused and lost. A veil over the
 * whole screen takes the pointer, the shell goes inert (nothing in it can be focused or typed into), and the board's
 * keyboard shortcuts, pastes and drops wait. If the switch does not happen, it all comes back as it was, focus included.
 */
export function SwitchingVeil() {
  const { phase } = useSwitchState();
  const on = phase !== "idle";
  useEffect(() => {
    if (!on) return;
    const shell = document.querySelector<HTMLElement>(".gx");
    shell?.setAttribute("inert", "");
    if (document.activeElement instanceof HTMLElement && shell?.contains(document.activeElement)) document.activeElement.blur();
    const hold = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const kinds = ["keydown", "keypress", "paste", "drop", "dragover"] as const;
    for (const kind of kinds) window.addEventListener(kind, hold, true);
    return () => {
      shell?.removeAttribute("inert");
      for (const kind of kinds) window.removeEventListener(kind, hold, true);
      /* It did not happen: focus back on the control that was pressed (the menu item, the row, the link's button). */
      const back = pressedControl();
      if (switchState().phase === "idle" && back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [on]);
  if (!on) return null;
  return createPortal(
    <div className="gx-switching" role="status" aria-live="polite" data-testid="switching-veil">
      <span className="gx-switching-note">Switching…</span>
    </div>,
    document.body,
  );
}
