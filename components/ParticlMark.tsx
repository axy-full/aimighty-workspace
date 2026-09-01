"use client";

/**
 * Particl Studio — temporary mark.
 *
 * Eight particles on a ring, graduating from a speck to a solid dot, with the
 * largest carrying the accent. Two readings, both wanted: a lens iris seen
 * head-on, and loose particles resolving into a form — which is the thing the
 * Studio is for, a shot going from scattered intent to something specified.
 *
 * The centre is deliberately empty so the mark stays legible at 16px, where a
 * filled middle turns the whole thing into a blob.
 *
 * TEMPORARY: this is a placeholder identity, not a commissioned one. It is
 * one component and one SVG file, so replacing it is a two-file job.
 */
const PARTICLES: [number, number, number][] = [
  [16.0, 5.5, 1.05], [23.42, 8.58, 1.35], [26.5, 16.0, 1.65], [23.42, 23.42, 1.95],
  [16.0, 26.5, 2.25], [8.58, 23.42, 2.55], [5.5, 16.0, 2.85],
];
/** The one that has arrived. */
const ACCENT: [number, number, number] = [8.58, 8.58, 3.15];

export function ParticlMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
      className={className} aria-hidden="true">
      {PARTICLES.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="currentColor"
          opacity={0.28 + i * 0.09} />
      ))}
      <circle cx={ACCENT[0]} cy={ACCENT[1]} r={ACCENT[2]} fill="var(--color-blue)" />
    </svg>
  );
}

/** Mark plus wordmark, for a screen header. */
export default function ParticlLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <ParticlMark size={30} className="text-black" />
      <span className="text-[26px] font-semibold leading-none tracking-[-0.035em] text-black">
        Particl<span className="ml-1.5 font-normal text-dim">Studio</span>
      </span>
    </span>
  );
}
