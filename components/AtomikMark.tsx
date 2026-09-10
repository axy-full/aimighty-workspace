"use client";

import { RING_DOTS } from "@/lib/ring";

/**
 * The atomik mark, from the pipeline handoff.
 *
 * particl's trail, closed into a ring: eight dots on a 62-unit circle with
 * the head at the top, radii 2 → 16 running clockwise from the tail. The
 * earlier six-dot "compressed trail" is superseded — this is the shipped
 * mark, and it is the one the assets carry.
 *
 * Two rules the handoff is emphatic about. The wordmark sets the ring AS
 * the letter o — `at◯mık` — so the standalone ring must never be placed
 * beside the wordmark, or the o appears twice. The standalone ring appears
 * only as a badge next to an all-caps mono label (`ATOMIK`, `FROM ATOMIK`)
 * at 14–16px, and at 28px in Settings › Atomik connection.
 *
 * Same colour discipline as particl's mark: currentColor, no strokes, no
 * per-dot colour, never rotated.
 */

/** cx, cy, r on the 200 × 200 grid. One table: the ring that draws runs
    and the loader (`lib/ring.ts`) is the same eight dots as this mark. */
export const ATOMIK_RING = RING_DOTS;

/** The ring alone, as a badge. `size` is its height and width. */
export function AtomikMark({ size = 16, className = "" }: {
  size?: number; className?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="20 20 160 160" fill="currentColor"
      className={className} aria-hidden="true">
      {ATOMIK_RING.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}

/**
 * The atomik loader: the ring's own motion. Each dot breathes in turn
 * around the circle — opacity and scale, never rotation, which the mark's
 * rules forbid. Same CSS as particl's trail loader, on the ring.
 */
export function AtomikSpinner({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="20 20 160 160" fill="currentColor"
      className={`atomik-spin ${className}`} role="status" aria-label="Loading">
      {ATOMIK_RING.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </svg>
  );
}

/**
 * `at◯mık` — the wordmark recipe, verbatim.
 *
 * A baseline-aligned flex row in Outfit 500 at +0.005em: `at`, the ring
 * cropped to `20 22 160 145` at 0.61em tall and 0.67em wide, `m`, a dotless
 * ı carrying the ring tittle (0.17em circle, 0.035em border, 0.09em down),
 * `k`. `by` adds the BY PARTICL sub-line in Kode Mono at 10px, 0.3em
 * tracking, 0.6em to the right, muted.
 *
 * `size` is the font size in px.
 */
export function AtomikWordmark({ size = 17, by = false, className = "" }: {
  size?: number; by?: boolean; className?: string;
}) {
  return (
    <span className={`atomik-word ${className}`} style={{ fontSize: size }}
      aria-label={by ? "atomik by particl" : "atomik"}>
      <span aria-hidden="true">at</span>
      <svg viewBox="20 22 160 145" className="atomik-word-o" fill="currentColor" aria-hidden="true">
        {ATOMIK_RING.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
      </svg>
      <span aria-hidden="true">m</span>
      <span className="atomik-word-i" aria-hidden="true">ı<span className="atomik-word-ring" /></span>
      <span aria-hidden="true">k</span>
      {by && <span className="atomik-word-by" aria-hidden="true">by particl</span>}
    </span>
  );
}

/** The wordmark with its sub-line — what every atomik header carries. */
export default function AtomikLockup({ size = 17, className = "" }: {
  size?: number; className?: string;
}) {
  return <AtomikWordmark size={size} by className={className} />;
}

/** Ring over wordmark, centred — the empty-state lockup. */
export function AtomikStacked({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex flex-col items-center gap-2 ${className}`}>
      <AtomikMark size={Math.round(size * 1.1)} />
      <AtomikWordmark size={size} by />
    </span>
  );
}
