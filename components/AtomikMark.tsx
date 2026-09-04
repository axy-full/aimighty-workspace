"use client";

/**
 * The Atomik mark.
 *
 * Particl's mark is a trail of particles, growing as it goes. Atomik's is
 * what those particles are part of: a nucleus with two crossed orbits. The
 * relationship is the point — the same physics, one level up, which is
 * exactly what the section is to the rest of the app.
 *
 * Drawn rather than lettered so it survives at 17px in a menu row, and in
 * `currentColor` so it takes the colour of whatever it sits in, dark mode
 * included, without a second asset.
 */

export function AtomikMark({ size = 20, className = "" }: {
  size?: number; className?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.5">
        {/* Two orbits, crossed. Rotated rather than mirrored so the crossing
            points sit off-axis and the mark never reads as a flat X. */}
        <ellipse cx="12" cy="12" rx="10.2" ry="4.4" transform="rotate(-28 12 12)" />
        <ellipse cx="12" cy="12" rx="10.2" ry="4.4" transform="rotate(28 12 12)" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

/** Mark plus name, for the places Particl uses its lockup. */
export function AtomikLockup({ size = 19, className = "" }: {
  size?: number; className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} aria-label="Atomik">
      <AtomikMark size={Math.round(size * 1.05)} />
      <span className="atomik-word" style={{ fontSize: size }} aria-hidden="true">Atomik</span>
    </span>
  );
}

export default AtomikMark;
