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

/**
 * The loader. The same eight particles, pulsing in sequence around the ring —
 * so a wait looks like the brand thinking rather than a generic spinner
 * bolted on. Pure CSS; respects reduced motion.
 */
export function ParticlSpinner({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
      className={`particl-spin ${className}`} role="status" aria-label="Loading">
      {[...PARTICLES, ACCENT].map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r}
          fill={i === 7 ? "var(--color-blue)" : "currentColor"}
          style={{ animationDelay: `${i * 110}ms` }} />
      ))}
    </svg>
  );
}

/**
 * A wait that's worth a sentence. Centred, quiet, branded — replaces the
 * four different "Reading the…" strings that used to stand in for a loader.
 */
export function Waiting({ label = "Loading" }: { label?: string }) {
  return (
    <div className="screen grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-dim">
        <ParticlSpinner size={30} />
        <p className="text-[14px]">{label}</p>
      </div>
    </div>
  );
}

/**
 * An empty state that looks designed rather than absent: the mark at rest,
 * a title, one line, and optionally one thing to do about it.
 */
export function Empty({ title, line, action, compact = false }: {
  title: string; line?: string; action?: React.ReactNode; compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "py-6" : "py-10"}`}>
      <ParticlMark size={compact ? 22 : 30} className="text-mute/70" />
      <p className={`mt-3 font-medium text-dim ${compact ? "text-[14px]" : "text-[15px]"}`}>{title}</p>
      {line && <p className="mt-1 max-w-[40ch] text-[13px] leading-relaxed text-mute">{line}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
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
