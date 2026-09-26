"use client";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Shown only while `state.gen` holds a real job; its phase comes from the job
 * status. No engine reports progress, so the bar claims none: it runs as a
 * plain "working" mark until the job ends, then fills in the outcome's tone.
 */
export function GenerationStrip() {
  const { state } = useWorkspace();
  const gen = state.gen;
  if (!gen) return null;
  const done = gen.pct >= 100;
  const label = gen.label ?? (done ? "Complete" : "Rendering");
  const tone = gen.tone ?? (done ? "green" : "blue");
  return (
    <div className="pxw-gen" role="status" aria-label={`${label} ${gen.name}`}>
      <span className="pxw-dot" style={{ background: `var(--pxw-${tone})` }} aria-hidden="true" />
      <span className="pxw-gen-label">{label}</span>
      <span className="pxw-gen-track" aria-hidden="true">
        <span className="pxw-gen-bar" data-running={done ? undefined : ""} style={{ background: `var(--pxw-${tone})` }} />
      </span>
      <span className="pxw-gen-meta">{gen.meta}</span>
    </div>
  );
}
