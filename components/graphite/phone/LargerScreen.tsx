"use client";
import { LARGER_TITLES, type LargerPage } from "./phone-model";

/**
 * "Open this on a larger screen": what the phone says for a control-room page it has no screen for (Activity,
 * Memory, Skills) until after the demo. The handoff draws these three on desktop only (README § 3.4), so this is the
 * honest page: its title, one plain line, and a way Home. It is not a drawn frame and has no new function.
 */
export function LargerScreen({ page, onHome }: { page: LargerPage; onHome: () => void }) {
  return (
    <main className="ph-scroll" data-testid="mobile-scroll">
      <div className="ph-larger" data-testid="phone-larger" data-page={page}>
        <h2 className="ph-larger-title" data-testid="phone-larger-title">{LARGER_TITLES[page]}</h2>
        <p className="ph-larger-line" data-testid="phone-larger-line">Open this on a larger screen.</p>
        <button type="button" className="ph-btn ph-btn--primary" onClick={onHome} data-testid="phone-larger-home">Home</button>
      </div>
    </main>
  );
}
