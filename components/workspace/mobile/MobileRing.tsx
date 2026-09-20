"use client";
import { ATOMIK_RING } from "@/components/AtomikMark";
import { PULSE_LAP_S, PULSE_STEP_S, RING_VIEWBOX } from "@/lib/ring";

/**
 * The Atomik ring — the only loader anywhere on the phone (05-mobile, and
 * the brief's non-negotiables): no spinners, no skeletons, never rotated,
 * never recoloured per dot.
 *
 * The eight dots are `ATOMIK_RING`, which components/AtomikMark.tsx re-exports
 * from lib/ring.ts `RING_DOTS`, on lib/ring's own `RING_VIEWBOX`; the beat is
 * `PULSE_LAP_S` (1.6s) with `PULSE_STEP_S` (0.2s) between one dot and the
 * next. Nothing is transcribed and nothing is drawn here — the geometry and
 * the timing both come from the modules that own them, so this file only
 * decides how big the ring is and whether it is breathing.
 *
 * Sizes, from the spec: 36px in wells, 22px on cards, 14–16px in buttons.
 */
export const RING = { well: 36, card: 22, button: 14, sheet: 16 } as const;

export function MobileRing({
  size = RING.card,
  beating = false,
  color,
  label = "",
}: {
  size?: number;
  /** Running, waiting or rendering: the ring breathes. Otherwise it is a mark. */
  beating?: boolean;
  color?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox={RING_VIEWBOX}
      width={size}
      height={size}
      className="pxm-ring"
      style={{ fill: color ?? "currentColor" }}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      data-beating={beating ? "" : undefined}
    >
      {ATOMIK_RING.map(([cx, cy, r], i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r}
          style={beating ? { animationDuration: `${PULSE_LAP_S}s`, animationDelay: `${(i * PULSE_STEP_S).toFixed(1)}s` } : undefined}
        />
      ))}
    </svg>
  );
}
