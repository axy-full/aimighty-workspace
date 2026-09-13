"use client";

/**
 * The opening.
 *
 * The trail arrives the way the mark describes it: each particle comes in
 * along the arc from a little further back, small, and settles at its place
 * — the gaps between arrivals shrinking, because the trail accelerates.
 * Then the wordmark resolves under it, the veil lifts, and the page is
 * already there behind it. No spinner, no gate.
 *
 * It plays every time this page is opened, and it is the ONLY page it plays
 * on: a front door should open when you walk up to it. Pure CSS on seven
 * circles, so it costs nothing and cannot jank; under prefers-reduced-motion
 * the veil simply lifts.
 */
import { TRAIL, ParticlWordmark } from "./ParticlMark";

/* The arc's centre and radius, recovered from the dots themselves. Each
   particle starts 34° further back along the same arc — never off it, and
   never rotated: the mark keeps its geometry, the motion is only travel. */
const CX = 100, CY = 142, R = 62;
const BACK = (34 * Math.PI) / 180;
const start = (cx: number, cy: number): [number, number] => {
  const a = Math.atan2(cy - CY, cx - CX) - BACK;
  return [CX + R * Math.cos(a) - cx, CY + R * Math.sin(a) - cy];
};
/* Arrivals bunch up: 0, 150, 270, 365, 435, 480, 505 ms. */
const DELAYS = [0, 150, 270, 365, 435, 480, 505];

export default function ParticlIntro() {
  return (
    <div className="intro-veil pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-ground">
      <div className="flex flex-col items-center gap-7 text-ink">
        <svg width={168} height={72} viewBox="34 72 132 56" fill="currentColor" aria-hidden="true">
          {TRAIL.map(([cx, cy, r], i) => {
            const [dx, dy] = start(cx, cy);
            return (
              <circle key={i} cx={cx} cy={cy} r={r} className="intro-dot"
                style={{ ["--dx" as string]: `${dx.toFixed(1)}px`, ["--dy" as string]: `${dy.toFixed(1)}px`,
                         animationDelay: `${DELAYS[i]}ms` }} />
            );
          })}
        </svg>
        <div className="intro-word" style={{ animationDelay: "680ms" }}>
          <ParticlWordmark size={40} studio />
        </div>
      </div>
    </div>
  );
}
