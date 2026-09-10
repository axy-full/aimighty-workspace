/**
 * particl's mark and wordmark (design/particl-v2/README.md §3; board 4a):
 * the 7-dot trail on a `30 68 140 64` viewBox at 30×14, then `partıcl` —
 * Outfit 600 16px, −0.03em, dotless ı — 8px apart. On a phone (9c): 26×12,
 * 15px, 7px apart. The dots are the handoff's, verbatim.
 */
export const TRAIL: ReadonlyArray<readonly [number, number, number]> = [
  [38.7, 120.8, 1.8], [50.9, 100.5, 2.8], [69.8, 86.3, 4], [92.7, 80.1, 5.5],
  [116.2, 83, 7.2], [136.9, 94.5, 9.2], [151.7, 112.9, 12],
];

export function Mark({ width = 30, height = 14, className = "" }: { width?: number; height?: number; className?: string }) {
  return (
    <svg viewBox="30 68 140 64" width={width} height={height} fill="var(--ink)" aria-hidden="true" className={className}>
      {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}

export function Wordmark({ size = 16 }: { size?: 16 | 15 }) {
  return <span className="font-semibold leading-none tracking-[-0.03em] text-ink" style={{ fontSize: size }}>partıcl</span>;
}

/** Mark + wordmark, at the desktop or the phone's size. */
export function Lockup({ mobile = false }: { mobile?: boolean }) {
  return (
    <span className={`flex items-center ${mobile ? "gap-[7px]" : "gap-[8px]"}`}>
      <Mark width={mobile ? 26 : 30} height={mobile ? 12 : 14} />
      <Wordmark size={mobile ? 15 : 16} />
    </span>
  );
}
