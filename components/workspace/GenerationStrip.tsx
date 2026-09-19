"use client";
import { useWorkspace } from "@/lib/workspace/state";

/** Shown only while `state.gen` holds a real job; its phase comes from the job status. */
export function GenerationStrip() {
  const { state } = useWorkspace();
  const gen = state.gen;
  if (!gen) return null;
  const pct = Math.max(0, Math.min(100, gen.pct));
  const label = gen.label ?? (pct >= 100 ? "Complete" : pct < 20 ? "Queued" : "Rendering");
  const tone = gen.tone ?? (pct >= 100 ? "green" : "blue");
  return (
    <div className="pxw-gen" role="status" aria-label={`${label} ${gen.name}`}>
      <span className="pxw-dot" style={{ background: `var(--pxw-${tone})` }} aria-hidden="true" />
      <span className="pxw-gen-label">{label}</span>
      <span className="pxw-gen-track" aria-hidden="true">
        <span className="pxw-gen-bar" style={{ width: `${pct}%`, background: `var(--pxw-${tone})` }} />
      </span>
      <span className="pxw-gen-meta">{gen.meta}</span>
    </div>
  );
}
