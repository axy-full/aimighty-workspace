"use client";

/**
 * Single-series magnitude bar: one hue, length carries the value.
 * No categorical palette, so rank never repaints anything.
 * Uses --lift (5.58:1 on panel) rather than brand red (3.05:1, marginal).
 */
export default function Bar({ value, max, title }: { value: number; max: number; title?: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1.5 : 0) : 0;
  return (
    <div className="h-[5px] w-full bg-panel3" title={title}>
      <div className="h-full bg-lift transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}
