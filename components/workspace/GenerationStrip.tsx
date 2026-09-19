"use client";
import { useWorkspace } from "@/lib/workspace/state";

/** Shown only while `state.gen` holds a real job; driven by job status later. */
export function GenerationStrip() {
  const { state } = useWorkspace();
  const gen = state.gen;
  if (!gen) return null;
  const pct = Math.max(0, Math.min(100, gen.pct));
  const label = pct >= 100 ? "Complete" : pct < 20 ? "Queued" : "Rendering";
  return (
    <div className="pxw-gen" role="status" aria-label={`${label} ${gen.name}`}>
      <span className="pxw-dot" style={{ background: pct >= 100 ? "var(--pxw-green)" : "var(--pxw-blue)" }} aria-hidden="true" />
      <span className="pxw-gen-label">{label}</span>
      <span className="pxw-gen-track" aria-hidden="true">
        <span className="pxw-gen-bar" style={{ width: `${pct}%` }} />
      </span>
      <span className="pxw-gen-meta">{gen.meta}</span>
    </div>
  );
}
