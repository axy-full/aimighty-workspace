import type { ReactNode } from "react";
import Mono from "./Mono";

/**
 * The striped well (design/particl-v2/README.md §2). In the handoff every
 * striped rectangle stands in for a REAL frame — the boards draw an empty
 * shot as a transparent well with one mono line (`MediaCard`'s
 * `emptyLabel`) and a take on its way as the 36px loader. So this is the
 * stand-in for media that is not wired yet, for building against, and no
 * route ships it: the README's rule is "wire real media".
 */
export function Placeholder({ label, ratio = "16/9", className = "" }: { label?: ReactNode; ratio?: string; className?: string }) {
  return (
    <div className={`ui-placeholder relative overflow-hidden ${className}`} style={{ aspectRatio: ratio }}>
      {label && <span className="absolute inset-0 flex items-center justify-center"><Mono>{label}</Mono></span>}
    </div>
  );
}

/** The audio well (board 7b): ground, with the waveform gradient 22px tall across its middle, 10px in from each side. */
export function Waveform({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`absolute inset-0 bg-ground ${className}`}>
      <span className="ui-waveform absolute left-[10px] right-[10px] top-1/2 h-[22px] -translate-y-1/2" />
    </span>
  );
}
