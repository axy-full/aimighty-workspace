"use client";
import { useWorkspace } from "@/lib/workspace/state";
import { MobileRing } from "./MobileRing";

/**
 * The phone's generation strip (05-mobile's shell, above the composer card).
 *
 * It reads `state.gen`, which is what the composer publishes from the REAL job
 * it is polling — the same field the desktop's GenerationStrip reads, written
 * by the same `useComposer`. The label is the job's own phase. No engine
 * reports a percentage (`gen.pct` only marks the stage reached), so none is
 * shown: while the job is out the bar is an indeterminate "working" mark, and
 * once it ends it fills in the outcome's tone.
 */
export function MobileGenerationStrip() {
  const { state } = useWorkspace();
  const gen = state.gen;
  if (!gen) return null;
  const tone = gen.tone ?? "blue";
  const done = gen.pct >= 100;
  const colour = tone === "green" ? "var(--pxw-green)" : tone === "red" ? "var(--pxw-red)" : "var(--pxw-blue)";
  return (
    <div className="pxm-gen" data-testid="mobile-gen" data-tone={tone} role="status">
      <MobileRing size={18} beating={tone === "blue"} color={colour} />
      <span className="pxm-gen-label">{gen.label ?? gen.name}</span>
      <span className="pxm-gen-bar" aria-hidden="true">
        <span className="pxm-gen-fill" data-running={done ? undefined : ""} style={{ background: colour }} />
      </span>
      {gen.meta ? <span className="pxm-gen-meta" data-functional-label="">{gen.meta}</span> : null}
    </div>
  );
}
