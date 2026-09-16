"use client";

import { useEffect, useState, type ReactNode } from "react";
import { RING_DOTS, RING_VIEWBOX, PULSE_STEP_S } from "@/lib/ring";

/**
 * The loader is the ring (design/particl-v2/README.md §3, board 11a).
 *
 * It is the only loading indicator in the product: no spinner, no skeleton,
 * no shimmer. The same eight dots as `Ring`, each breathing in turn, head
 * first around to the tail — 1.6s a lap, 0.2s between dots. The dots never
 * move and never change size; only their opacity does.
 *
 * Four sizes, four places: 88 for a page (centred, with one mono line of
 * what is loading), 36 inside a well while a take arrives, 20 at the head
 * of an Atomik message while it plans (with the 3px bar beneath — the one
 * progress bar the product has), 14 inside a button while it works.
 *
 * Ink on dark; ground inside a filled primary. Never the accent — the
 * accent means done, and this is the opposite of done.
 *
 * A wait under 300ms shows nothing. The ring still takes its space from the
 * first frame, so a button that is about to show one does not change width
 * when it does.
 */

export const LOADER_SIZES = { page: 88, well: 36, message: 20, button: 14 } as const;
export type LoaderSize = (typeof LOADER_SIZES)[keyof typeof LOADER_SIZES];

/** Waits shorter than this are not shown. */
export const LOADER_AFTER_MS = 300;

type Props = {
  size?: LoaderSize;
  /** The surface under it: ink on dark, ground on a filled primary. */
  on?: "dark" | "primary";
  /** Milliseconds before the ring appears. 0 shows it at once. */
  after?: number;
  label?: string;
  className?: string;
};

export default function Loader({ size = LOADER_SIZES.well, on = "dark", after = LOADER_AFTER_MS, label = "Loading", className }: Props) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (after <= 0) return;
    const t = setTimeout(() => setWaited(true), after);
    return () => clearTimeout(t);
  }, [after]);
  const shown = after <= 0 || waited;
  const fill = on === "primary" ? "var(--graphite-on-primary)" : "var(--ink)";
  return (
    <svg viewBox={RING_VIEWBOX} width={size} height={size} className={className}
      role="status" aria-label={label} aria-busy="true"
      style={{ display: "block", flex: "none", visibility: shown ? "visible" : "hidden" }}>
      {RING_DOTS.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill={fill} className="atomik-pulse"
          style={{ animationDelay: `${i * PULSE_STEP_S}s` }} />
      ))}
    </svg>
  );
}

/** A page arriving (board 11a): the ring at 88, centred, 22px above one mono line of what is loading. */
export function PageLoader({ what, after }: { what: ReactNode; after?: number }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-[22px]">
      <Loader size={LOADER_SIZES.page} after={after} />
      <span className="ui-mono text-ink-muted">{what}</span>
    </div>
  );
}

/**
 * Atomik planning (board 11a): the ring at 20, 10px before a two-line
 * header — the title at Outfit 600 14px/1.1 over the mono state line, 3px
 * apart — and the 3px indeterminate bar 10px beneath. Nothing else in the
 * product is a progress bar.
 */
export function MessageLoader({ title, children, after }: { title: ReactNode; children: ReactNode; after?: number }) {
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-center gap-[10px]">
        <Loader size={LOADER_SIZES.message} after={after} />
        <span className="flex flex-col gap-[3px]">
          <span className="text-[14px] font-semibold leading-[1.1] text-ink">{title}</span>
          <span className="ui-mono text-ink-muted">{children}</span>
        </span>
      </div>
      <span className="atomik-bar" aria-hidden="true"><span /></span>
    </div>
  );
}
