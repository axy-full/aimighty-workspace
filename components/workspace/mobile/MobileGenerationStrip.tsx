"use client";
import { useWorkspace } from "@/lib/workspace/state";
import { MobileRing } from "./MobileRing";

/**
 * The phone's generation strip (05-mobile's shell, above the composer card).
 *
 * It reads `state.gen`, which is what the composer publishes from the REAL job
 * it is polling — the same field the desktop's GenerationStrip reads, written
 * by the same `useComposer`. Nothing here animates on its own: the bar's width
 * is the job's own percentage and the label is the job's own phase, so a
 * stalled job looks stalled.
 *
 * The ring beside it is the ring, beating, which is the only loader the phone
 * has; the 3px bar is determinate progress, not a loader.
 */
export function MobileGenerationStrip() {
  const { state } = useWorkspace();
  const gen = state.gen;
  if (!gen) return null;
  const tone = gen.tone ?? "blue";
  const colour = tone === "green" ? "var(--pxw-green)" : tone === "red" ? "var(--pxw-red)" : "var(--pxw-blue)";
  return (
    <div className="pxm-gen" data-testid="mobile-gen" data-tone={tone} role="status">
      <MobileRing size={18} beating={tone === "blue"} color={colour} />
      <span className="pxm-gen-label">{gen.label ?? gen.name}</span>
      <span className="pxm-gen-bar" aria-hidden="true">
        <span className="pxm-gen-fill" style={{ width: `${Math.max(0, Math.min(100, gen.pct))}%`, background: colour }} />
      </span>
      <span className="pxm-gen-pct" data-functional-label="">{Math.round(gen.pct)}%</span>
    </div>
  );
}
