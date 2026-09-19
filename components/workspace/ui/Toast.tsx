"use client";
import { useWorkspace } from "@/lib/workspace/state";

/** Bottom-centre at 54px, 2600ms, green dot. Genuine confirmations only. */
export function ToastHost() {
  const { state } = useWorkspace();
  if (!state.toast) return null;
  return (
    <div className="pxw-toast" role="status" aria-live="polite">
      <span className="pxw-dot" style={{ width: 7, height: 7, background: "var(--pxw-green)" }} />
      <span>{state.toast}</span>
    </div>
  );
}
