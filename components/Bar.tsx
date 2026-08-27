"use client";

/**
 * Single-series magnitude bar: one hue, length carries the value.
 * The design's spend bar — 3px, rounded, accent red on a chip track.
 */
export default function Bar({ value, max, title }: { value: number; max: number; title?: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1.5 : 0) : 0;
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-[2px] bg-chip" title={title}>
      <div className="h-full rounded-[2px] bg-red transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}
