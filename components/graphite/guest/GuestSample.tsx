"use client";

/**
 * The sample production, read-only, for a guest (Guest Home frame 2 / P2; README § 3.7). Stream 12 builds the real
 * sample; until it exists this draws the frame's layout — the slim line, the brief's title, and each region in board
 * order — with empty slots and no media, figures or names: nothing is faked. Every action reads "Sign up to make
 * this" and opens the sheet; nothing else is pressable.
 */
const REGIONS: { id: string; title: string; slots: number; wide?: boolean }[] = [
  { id: "looks", title: "Looks", slots: 4 },
  { id: "storyboard", title: "Storyboard", slots: 3 },
  { id: "shots", title: "Shots", slots: 3 },
  { id: "cast", title: "Cast, environment and elements", slots: 3 },
  { id: "cut", title: "Cut and deliver", slots: 1, wide: true },
];

export function GuestSample({ title, onSignup }: { title: string; onSignup: () => void }) {
  return (
    <div className="gx-gs gx-scroll" data-testid="guest-sample">
      <p className="gx-gs-line">A sample production. <button type="button" className="gx-gs-link" onClick={onSignup} data-testid="guest-sample-signup">Sign up</button> to make your own.</p>
      <div className="gx-gs-col">
        <section className="gx-gs-brief" aria-labelledby="gx-gs-title">
          <p className="gx-hm-eyebrow">Brief</p>
          <h1 className="gx-gs-title" id="gx-gs-title" data-testid="guest-sample-title">{title}</h1>
          <p className="gx-gs-wait">The looks, storyboard, plan, shots and cut appear here once the sample is made.</p>
        </section>
        {REGIONS.map((r) => (
          <section key={r.id} className="gx-gs-group" aria-label={r.title} data-region={r.id}>
            <h2 className="gx-gs-group-h">{r.title}</h2>
            <div className="gx-gs-slots" data-wide={r.wide ? "" : undefined}>
              {Array.from({ length: r.slots }, (_, i) => <span key={i} className="gx-gs-slot" aria-hidden="true" />)}
            </div>
            {r.id === "storyboard" ? (
              <div className="gx-gs-plan">
                <span className="gx-gs-plan-h">The plan</span>
                <button type="button" className="gx-gs-gated" onClick={onSignup} data-testid="guest-sample-make">Sign up to make this</button>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
