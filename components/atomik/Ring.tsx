import { ringDots, RING_VIEWBOX, type RingInput, type Paint } from "@/lib/ring";

/**
 * The Atomik ring, rendered from data (design/particl-v2/README.md §3).
 *
 * One component draws the mark, a run and Atomik's own state: pass `steps`
 * (a run, head first — each dot is one paid step) or `mode` (idle,
 * listening, planning, done). What each state looks like is decided in
 * `lib/ring.ts`; this file only turns that decision into circles.
 *
 * Paint is by token, never by literal: ink, accent and ground are the §2
 * variables themselves (not the Tailwind aliases, which the older paper
 * routes still override), so the ring is ink on ground wherever it is. Planning is the only motion in the product, and it is the
 * loader's motion — the same keyframes, the same lap.
 */

/** Where the ring goes and how big it is there. */
export const RING_SIZES = {
  headerButton: 14, railHeader: 18, messageHeader: 20, compact: 36, checkpoint: 64, sheet: 88,
} as const;

const PAINT: Record<Paint | "none", string> = {
  ink: "var(--ink)", accent: "var(--accent)", ground: "var(--ground)", none: "none",
};

type Props = RingInput & {
  size?: number;
  className?: string;
  /** What a screen reader hears. Empty hides the ring from it (it is decoration beside a label). */
  label?: string;
};

export default function Ring({ size = RING_SIZES.compact, className, label = "", ...input }: Props) {
  const dots = ringDots(input);
  return (
    <svg viewBox={RING_VIEWBOX} width={size} height={size} className={className}
      style={{ display: "block", flex: "none" }}
      role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r}
          fill={PAINT[d.fill]} stroke={PAINT[d.stroke]} strokeWidth={d.strokeWidth || undefined}
          strokeOpacity={d.strokeOpacity === 1 ? undefined : d.strokeOpacity}
          opacity={d.opacity === 1 ? undefined : d.opacity}
          className={d.pulseDelay === null ? undefined : "atomik-pulse"}
          style={d.pulseDelay === null ? undefined : { animationDelay: `${d.pulseDelay}s` }} />
      ))}
    </svg>
  );
}
