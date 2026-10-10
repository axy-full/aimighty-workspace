"use client";
import type { ComponentProps, ReactNode } from "react";
import { OverlayProvider } from "./ui/overlay";
import { ToastProvider } from "./ui/Toast";
import { V12Header } from "./shell/Header";
import "./v12.css";

/**
 * The new interface's frame (docs/redesign-plan.md › "One shell, two frames"), mounted by components/graphite/
 * SuitesShell.tsx when the workspace's switch is on (lib/newInterface.ts) and the window is desktop-sized (not
 * lib/shell/use-compact.ts; a phone keeps PhoneApp). SuitesShell loads it lazily, so customers never download it or
 * anything it draws.
 *
 * It is the .v12 root (every rule in components/v12/v12.css sits under it), the 56 px header (components/v12/shell/
 * Header.tsx), and the body, with the overlay stack (Esc order, outside click) and the toasts under it. Until each screen
 * is rebuilt the body holds today's screen, so the app stays whole.
 */
export function V12Shell({ header, children }: { header: ComponentProps<typeof V12Header>; children: ReactNode }) {
  return (
    <OverlayProvider>
      <ToastProvider>
        <div className="v12 v12-frame" data-testid="v12-root">
          <div className="v12-head" data-testid="v12-head"><V12Header {...header} /></div>
          <div className="v12-body" data-testid="v12-body">{children}</div>
        </div>
      </ToastProvider>
    </OverlayProvider>
  );
}
