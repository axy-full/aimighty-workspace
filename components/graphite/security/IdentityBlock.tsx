"use client";
import { useState, type MouseEvent } from "react";
import { Price } from "@/components/graphite/Price";
import { exact } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import type { IdentityCardView } from "@/lib/security/identity-card";
import type { ConsentsState } from "@/lib/security/use-consents";
import { ConsentDialog } from "./ConsentDialog";
import "./security.css";

/*
 * Identity on the Cast card for a character (Gaps A: consent not recorded · the consent step · consent on file ·
 * training · ready · failed). What it says comes from the records (lib/security/identity-card.ts):
 *
 * - No live consent: "Record consent" opens the step a person completes; "Train Identity · N cr" is disabled until
 *   a record exists, with the reason.
 * - Consent on file: "Train Identity · N cr" opens the Inspector's build form, armed with the record, where the
 *   person picks the stills and presses the priced button (the existing paid path, POST /api/soul/identities).
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
  const [open, setOpen] = useState(false);
  const price = exact(trainingCredits);
  const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
  const reading = state.status === "loading" || state.status === "idle";
  const consentLine = state.status === "error" ? (state.error ?? "Consent records could not be read.") : reading ? "Reading…" : view.consent;

  const train = (label: string, testId: string, primary: boolean) => {
    /* Nothing spends here (the sample): no identity is trained, and no price is shown. */
    if (spendOff) return <button type="button" className="gsec-btn nodrag nopan" disabled title={spendOff} data-testid={testId}>{label}</button>;
    const off = !view.consentId || !price;
    return (
      <button type="button" className={`gsec-btn nodrag nopan${primary && !off ? " gsec-primary" : ""}`} disabled={off}
        title={!view.consentId ? "Needs a consent record first" : !price ? "Training has no price on this workspace" : undefined}
        onClick={stop(onTrain)} onDoubleClick={(e) => e.stopPropagation()} data-testid={testId} {...spendAttrsOf(price)}>
        {label}{price ? <> · <Price value={price} /></> : null}
      </button>
    );
  };

  return (
    <div className="gsec-id" data-stage={view.stage} data-testid="identity-block">
      <span className="gsec-id-label">Consent</span>
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
          {view.stage === "no-consent" ? (
            <>
              <button type="button" className={`gsec-btn nodrag nopan${open ? "" : " gsec-primary"}`} onClick={stop(() => setOpen(true))} onDoubleClick={(e) => e.stopPropagation()} data-testid="identity-record-consent">
                {open ? "Recording consent…" : "Record consent"}
              </button>
              {train("Train Identity", "identity-train", false)}
            </>
          ) : null}
          {view.stage === "recorded" ? train("Train Identity", "identity-train", true) : null}
          {view.stage === "failed" ? (view.consentId ? train("Retry", "identity-retry", true) : (
            <button type="button" className="gsec-btn gsec-primary nodrag nopan" onClick={stop(() => setOpen(true))} data-testid="identity-record-consent">Record consent</button>
          )) : null}
        </div>
      ) : null}
      {open ? (
        <ConsentDialog scope={scope} projectId={projectKey} subjectKey={subjectKey} subjectLabel={subjectLabel}
          onClose={() => setOpen(false)} onDone={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
