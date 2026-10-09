"use client";
import type { ReactNode } from "react";
import { OverlayProvider } from "./ui/overlay";
import { ToastProvider } from "./ui/Toast";
import "./v12.css";

/**
 * The new interface's frame (docs/redesign-plan.md › "One shell, two frames"), mounted by components/graphite/
 * SuitesShell.tsx when the workspace's switch is on (lib/newInterface.ts) and the window is desktop-sized (not
 * lib/shell/use-compact.ts; a phone keeps PhoneApp).
 *
 * It is the .v12 root (every rule in components/v12/v12.css sits under it), the 56 px header slot, and the body, with
 * the overlay stack (Esc order, outside click) and the toasts under it. Until A2 builds the new header the slot holds
 * today's graphite Header, and until each screen is rebuilt the body holds today's screen, so the app stays whole.
 */
export function V12Shell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <OverlayProvider>
      <ToastProvider>
        <div className="v12 v12-frame" data-testid="v12-root">
          <div className="v12-head" data-testid="v12-head">{header}</div>
          <div className="v12-body" data-testid="v12-body">{children}</div>
        </div>
      </ToastProvider>
    </OverlayProvider>
  );
}
