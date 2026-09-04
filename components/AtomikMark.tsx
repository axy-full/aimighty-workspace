"use client";

/**
 * The atomik mark, from the brand sheet.
 *
 * Six dots on a flatter, shorter arc than particl's seven, radii 3 → 16 on
 * the 200 grid. The relationship is the whole idea and it is legible at a
 * glance once you know: particl accelerates, atomik has already arrived —
 * one fewer step, and much heavier terminal mass.
 *
 * atomik is a SUB-BRAND, not a second brand. The type and the colour system
 * are particl's unchanged; only the mark differs. That is why the wordmark
 * below borrows .wordmark-* wholesale rather than defining its own — the
 * dotless ı with a ring tittle is the same construction at the same
 * measurements, and two copies of it would drift apart the first time one
 * was adjusted.
 *
 * Never rotate the mark, recolour a dot on its own, or add strokes.
 */

/** cx, cy, r on the 200 × 200 grid, verbatim from the brand sheet. */
export const ATOMIK_TRAIL: [number, number, number][] = [
  [50, 116, 3], [68, 103, 5], [89, 96, 7],
  [111, 97, 9.5], [132, 106, 12.5], [150, 123, 16],
];

/* The dots' own box (x 47→166, y 87.5→139) plus about three units of air,
   which is how particl's mark is cropped too. Keeping the same treatment is
   what makes the two read as the same size at the same `size`. */
const VIEW = "44 84 126 59";
const RATIO = 126 / 59;

/** The mark alone. `size` is its HEIGHT; it is about 2.1× as wide. */
export function AtomikMark({ size = 20, className = "" }: {
  size?: number; className?: string;
}) {
  return (
    <svg width={Math.round(size * RATIO)} height={size} viewBox={VIEW}
      fill="currentColor" className={className} aria-hidden="true">
      {ATOMIK_TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}

/**
 * "atomık" in Outfit 600, with the ring tittle over the dotless ı.
 *
 * `size` is the font size in px. `by` adds the BY PARTICL tag beneath —
 * the parent's name, in the same Kode Mono treatment particl uses for
 * STUDIO, because a sub-brand that never says whose it is stops being one.
 */
export function AtomikWordmark({ size = 24, by = false, className = "" }: {
  size?: number; by?: boolean; className?: string;
}) {
  return (
    <span className={`wordmark ${className}`} style={{ fontSize: size }}
      aria-label={by ? "atomik by particl" : "atomik"}>
      <span className="wordmark-word" aria-hidden="true">
        atom<span className="wordmark-i">ı<span className="wordmark-ring" /></span>k
      </span>
      {by && <span className="wordmark-studio" aria-hidden="true">by particl</span>}
    </span>
  );
}

/**
 * The horizontal lockup: mark, one mark-height of air, the wordmark.
 * `size` is the wordmark's font size; the mark stands half as tall, as it
 * does in particl's lockup.
 */
export default function AtomikLockup({ size = 26, by = false, className = "" }: {
  size?: number; by?: boolean; className?: string;
}) {
  const mark = Math.round(size * 0.5);
  return (
    <span className={`inline-flex items-center ${className}`}
      style={{ gap: mark }}>
      <AtomikMark size={mark} />
      <AtomikWordmark size={size} by={by} />
    </span>
  );
}

/**
 * The stacked lockup: the mark over the wordmark, centred.
 * For the places a wide lockup cannot go — an empty state, a splash.
 */
export function AtomikStacked({ size = 56, className = "" }: {
  size?: number; className?: string;
}) {
  return (
    <span className={`inline-flex flex-col items-center ${className}`}
      style={{ gap: Math.round(size * 0.28) }}>
      <AtomikMark size={Math.round(size * 0.62)} />
      <AtomikWordmark size={size} by />
    </span>
  );
}
