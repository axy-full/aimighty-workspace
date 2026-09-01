"use client";

/**
 * The opening.
 *
 * Eight particles arrive from outside the frame and settle onto the ring, the
 * accent one last, and the wordmark resolves under them. Then the veil lifts
 * and the page is already there behind it — no spinner, no gate.
 *
 * It plays every time this page is opened, and it is the ONLY page it plays
 * on. The first version tried to run once per session, which was both a bug
 * (writing the flag during render made the next render read it back and
 * unmount the veil before a single frame drew) and the wrong instinct: a
 * front door should open when you walk up to it. The team's own way in is
 * /login and "/", neither of which has an animation to sit through.
 *
 * It is pure CSS on eight circles, so it costs nothing and cannot jank; and
 * under prefers-reduced-motion the veil simply lifts.
 */

/** Final ring positions — the same geometry as the mark. */
const RING: [number, number, number][] = [
  [16.0, 5.5, 1.05], [23.42, 8.58, 1.35], [26.5, 16.0, 1.65], [23.42, 23.42, 1.95],
  [16.0, 26.5, 2.25], [8.58, 23.42, 2.55], [5.5, 16.0, 2.85],
];
const ACCENT: [number, number, number] = [8.58, 8.58, 3.15];

/** Where each one flies in from — far enough out to start off-frame. */
const FROM: [number, number][] = [
  [14, -26], [30, -14], [34, 8], [18, 30], [-6, 34], [-28, 20], [-34, -4], [-18, -30],
];

const dot = (i: number) => ({
  ["--dx" as string]: `${FROM[i][0]}px`,
  ["--dy" as string]: `${FROM[i][1]}px`,
  animationDelay: `${i * 55}ms`,
});

export default function ParticlIntro() {
  return (
    <div className="intro-veil pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-desk">
      <div className="flex flex-col items-center gap-5">
        <svg width={96} height={96} viewBox="0 0 32 32" fill="none" aria-hidden="true">
          {RING.map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="var(--color-bone)"
              className="intro-dot" style={dot(i)} />
          ))}
          <circle cx={ACCENT[0]} cy={ACCENT[1]} r={ACCENT[2]} fill="var(--color-blue)"
            className="intro-dot" style={{ ...dot(7), animationDelay: "470ms" }} />
        </svg>
        <p className="intro-word text-[34px] font-semibold text-black"
           style={{ animationDelay: "620ms" }}>
          Particl
        </p>
      </div>
    </div>
  );
}
