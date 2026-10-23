"use client";
import { useState, type MouseEvent } from "react";
import { Price } from "@/components/graphite/Price";
import { exact } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import type { IdentityCardView } from "@/lib/security/identity-card";
import { consentLive } from "@/lib/security/consent-words";
import { useConsents, type ConsentsState } from "@/lib/security/use-consents";
import { ConsentDialog } from "./ConsentDialog";
import "./security.css";

/*
 * Identity on the Cast card for a character (Gaps A: not ticked · ticked · training · ready · failed). What it says
 * comes from the records (lib/security/identity-card.ts). A tick, not a gate (owner, 23 Oct 2026):
 *
 * - The tick, unticked until a person ticks it: ticking records who and when at once; unticking withdraws it (marked,
 *   never erased). Details opens the optional fields for the lawyer's NOC. Nothing waits on any of it.
 * - "Train Identity · N cr" opens the Inspector's build form, ticked or not, where the person picks the stills and
 *   presses the priced button (the existing paid path, POST /api/soul/identities); a live tick is cited.
 * - Training: an indeterminate bar; the trainer reports no progress, so no percentage or time is invented.
 * - Failed: what the ledger says was billed ("Nothing billed" only when it shows nothing), the trainer's reason, and
 *   "Retry · N cr" back to the same form.
 * The price is the server's (`terms.trainingCredits`, the rate card's identity training). Nothing here spends.
 */
export function IdentityBlock({ scope, projectKey, subjectKey, subjectLabel, view, consents, trainingCredits, canAct, spendOff, onTrain }: {
  scope: string; projectKey: string; subjectKey: string; subjectLabel: string;
  /** The card's identity and consent, worked out once by the card (lib/security/identity-card.ts). */
  view: IdentityCardView;
  consents: ConsentsState;
  trainingCredits: number | null;
  /** A signed-in person on a board that can be written to. */
  canAct: boolean;
  /** Why nothing spends here (the sample workspace): training is shown disabled, with this reason and no price. */
  spendOff?: string | null;
  /** Opens the build form (the Inspector), armed with the live consent. */
  onTrain: () => void;
}) {
  const state = consents;
  const price = exact(trainingCredits);
  const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
  const reading = state.status === "loading" || state.status === "idle";
  const consentLine = state.status === "error" ? (state.error ?? "Consent records could not be read.") : reading ? "Reading…" : view.consent;

  const train = (label: string, testId: string, primary: boolean) => {
    /* Nothing spends here (the sample): no identity is trained, and no price is shown. */
    if (spendOff) return <button type="button" className="gsec-btn nodrag nopan" disabled title={spendOff} data-testid={testId}>{label}</button>;
    const off = !price;
    return (
      <button type="button" className={`gsec-btn nodrag nopan${primary && !off ? " gsec-primary" : ""}`} disabled={off}
        title={!price ? "Training has no price on this workspace" : undefined}
        onClick={stop(onTrain)} onDoubleClick={(e) => e.stopPropagation()} data-testid={testId} {...spendAttrsOf(price)}>
        {label}{price ? <> · <Price value={price} /></> : null}
      </button>
    );
  };

  return (
    <div className="gsec-id" data-stage={view.stage} data-testid="identity-block">
      {/* The tick takes the label's place while there is something to train, so the card keeps its rows. */}
      {canAct && (view.stage === "no-consent" || view.stage === "recorded" || view.stage === "failed") ? (
        <div className="gsec-id-head">
          <ConsentTick scope={scope} projectKey={projectKey} subjectKey={subjectKey} subjectLabel={subjectLabel} liveId={view.consentId} ready={state.status === "ready"} />
        </div>
      ) : <span className="gsec-id-label">Consent</span>}
      <span className="gsec-id-line" data-testid="identity-consent">{consentLine}</span>
      {view.stage === "training" ? <span className="gsec-bar" role="progressbar" aria-label="Training" aria-valuetext="Training; the trainer reports no progress" data-testid="identity-progress" /> : null}
      {view.stage === "failed" ? (
        <span data-testid="identity-failed">
          <span className="gsec-id-billed" data-testid="identity-billed">{view.billed}</span>
          {view.why ? <> · {view.why}</> : null}
        </span>
      ) : null}
      {canAct ? (
        <div className="gsec-id-acts">
          {view.stage === "no-consent" || view.stage === "recorded" ? train("Train Identity", "identity-train", true) : null}
          {view.stage === "failed" ? train("Retry", "identity-retry", true) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The consent tick (owner, 23 Oct 2026: a tick, not a gate), on the Cast card and in its Inspector: one plain line,
 * the box and Details as a link. Unticked until a person ticks it; ticking records who ticked and when, at once
 * (everything saves itself); unticking withdraws it, marked and never erased. Details opens the optional fields. Only
 * a person ticks: the route refuses tokens and agents.
 */
export function ConsentTick({ scope, projectKey, subjectKey, subjectLabel, liveId, ready }: {
  scope: string; projectKey: string; subjectKey: string; subjectLabel: string;
  /** The live tick, when there is one. */
  liveId: string | null;
  /** The records have been read, so the box shows what is on file. */
  ready: boolean;
}) {
  const { state, record, withdraw } = useConsents(scope, projectKey);
  /* The box shows the press at once while it saves; it settles on what the records say. */
  const [pending, setPending] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ticked = liveId != null;
  const busy = pending != null;
  const flip = async () => {
    if (busy || !ready) return;
    setPending(!ticked); setProblem(null);
    /* Unticking withdraws every live tick of this cast member (there is one; older data may hold more), so the box
       always ends unticked. */
    const lives = state.consents.filter((r) => r.subjectKey === subjectKey && consentLive(r)).map((r) => r.id);
    let failed: string | null = null;
    if (ticked) { for (const id of lives.length ? lives : [liveId]) failed = (await withdraw(id)) ?? failed; }
    else failed = (await record({ projectId: projectKey, subjectKey, subjectLabel })).error;
    setPending(null);
    if (failed) setProblem(failed);
  };
  const shown = pending ?? ticked;
  const halt = (e: MouseEvent) => e.stopPropagation();
  return (
    <>
      <label className="gsec-tick nodrag nopan" onClick={halt} onDoubleClick={halt} data-testid="consent-tick">
        <input type="checkbox" checked={shown} aria-busy={busy || undefined} disabled={!ready} onChange={() => void flip()} data-testid="consent-tick-box" />
        <span className="gsec-check" aria-hidden="true">{shown ? "✓" : ""}</span>
        <span>Consent given</span>
      </label>
      <button type="button" className="gsec-tick-link nodrag nopan" onClick={(e) => { e.stopPropagation(); setOpen(true); }} onDoubleClick={halt} data-testid="consent-details">Details</button>
      {problem ? <span className="gsec-problem" role="alert" data-testid="consent-tick-problem">{problem}</span> : null}
      {open ? (
        <ConsentDialog scope={scope} projectId={projectKey} subjectKey={subjectKey} subjectLabel={subjectLabel}
          onClose={() => setOpen(false)} onDone={() => setOpen(false)} />
      ) : null}
    </>
  );
}
