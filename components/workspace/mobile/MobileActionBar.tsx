"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { runChip } from "@/lib/workspace/atomik-view";
import { agentDot } from "@/lib/workspace/next";
import { useWorkspace } from "@/lib/workspace/state";
import { MobileRing, RING } from "./MobileRing";

/** What the filled primary on this screen is, and what stops it. */
export type MobilePrimary = {
  label: string;
  /** The live cost, shown inline on the button ("18 cr"). Null when there is none. */
  cost: string | null;
  /** Why it cannot run. The button stays visible and says so. */
  blocked: string | null;
  run: () => void;
};

/**
 * The pinned action bar (05-mobile): 46px, one filled primary with its cost
 * inline, plus the Ask Atomik control. It sits above the dock as a flex
 * sibling of the scroller, never over it, so the last row of a scroll
 * container clears it at max scroll.
 *
 * The Atomik control is the touch equivalent of the desktop `Run with Atomik`
 * chip, and it obeys the same rule the two identically-labelled controls have
 * to share: while a gate waits it APPROVES the run through the engine's
 * `approve`, and never starts or restarts one.
 */
export function MobileActionBar({ primary }: { primary: MobilePrimary | null }) {
  const ws = useWorkspace();
  const { state } = ws;
  const atomik = useAtomik();
  const run = atomik.runFor(state.page);
  const chip = runChip(run);
  const waiting = run?.status === "waiting";
  const label = chip.tone === "idle" && chip.label === "Run with Atomik" ? "Ask Atomik" : chip.label;

  return (
    <div className="pxm-actions" data-testid="mobile-actions">
      <button
        type="button"
        className="pxm-ask"
        data-tone={chip.tone}
        data-testid="mobile-ask-atomik"
        onClick={() => {
          if (waiting) {
            /* Approve, never start: the gate is the product's promise. */
            void atomik.approve();
            return;
          }
          ws.setSheet("atomik");
          atomik.start(state.page);
        }}
      >
        <MobileRing
          size={RING.button}
          beating={chip.tone === "running"}
          color={chip.tone === "waiting" ? "var(--pxw-amber)" : chip.tone === "running" ? "var(--pxw-blue)" : agentDot(state)}
        />
        <span className="pxm-ask-label">{label}</span>
      </button>
      {primary ? (
        <button
          type="button"
          className="pxm-primary"
          data-testid="mobile-primary"
          aria-disabled={primary.blocked ? true : undefined}
          title={primary.blocked ?? undefined}
          onClick={() => (primary.blocked ? ws.toast(primary.blocked) : primary.run())}
        >
          <span className="pxm-primary-label">
            {primary.label}
            {primary.cost ? <span className="pxm-primary-cost">{primary.cost}</span> : null}
          </span>
        </button>
      ) : null}
    </div>
  );
}
