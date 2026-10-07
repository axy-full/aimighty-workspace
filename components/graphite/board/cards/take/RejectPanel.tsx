"use client";
import { useEffect, useRef, useState } from "react";
import { REJECT_CHIPS, REJECT_REASON_MAX, rejectReasonOf, rejectReasonProblem } from "./take-model";

/*
 * Reject with a reason (design/particl-graphite "Gaps B frames", takes, `state=reject`): the reasons as chips, a free
 * line, and "Reject · spends nothing". A reject is the review trail's "changes" mark plus the reason as a note on the
 * take (use-judge); nothing is paid and nothing is erased, which is why the button says so. Only a person rejects:
 * this panel has no automatic path.
 */
export function RejectPanel({ busy, onReject, onCancel }: { busy: boolean; onReject: (reason: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, []);
  const reason = rejectReasonOf(picked, free);
  const toggle = (chip: string) => { setHint(null); setPicked((now) => (now.includes(chip) ? now.filter((c) => c !== chip) : [...now, chip])); };
  const submit = () => {
    const problem = rejectReasonProblem(reason);
    if (problem) { setHint(problem); return; }
    onReject(reason);
  };
  return (
    <form className="gx-take-ask nodrag nopan" aria-label="Why reject it" data-testid="take-reject-panel"
      onSubmit={(e) => { e.preventDefault(); submit(); }} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <div className="gx-take-ask-head"><span className="gx-take-ask-label">Why</span><span className="gx-take-ask-said" data-testid="take-reject-said">{picked.length ? REJECT_CHIPS.filter((c) => picked.includes(c)).join(", ") : ""}</span></div>
      <div className="gx-take-ask-chips" role="group" aria-label="Reasons">
        {REJECT_CHIPS.map((chip, i) => (
          <button key={chip} ref={i === 0 ? first : undefined} type="button" className="gx-take-btn gx-take-ask-chip nodrag nopan" aria-pressed={picked.includes(chip)}
            onClick={() => toggle(chip)} data-testid="take-reject-chip">{picked.includes(chip) ? "✓ " : ""}{chip}</button>
        ))}
      </div>
      <input className="gx-take-input" value={free} maxLength={REJECT_REASON_MAX} onChange={(e) => { setFree(e.target.value); setHint(null); }} placeholder="Or say it in a line" aria-label="Reason for rejecting, in your words"
        aria-invalid={hint ? true : undefined} data-hint={hint ? "" : undefined} data-testid="take-reason" />
      {hint ? <span className="gx-take-hint" role="alert" data-testid="take-reason-hint">{hint}</span> : null}
      <div className="gx-take-ask-go">
        <button type="submit" className="gx-take-btn gx-take-btn--go nodrag nopan" disabled={busy} data-testid="take-reject-confirm">Reject · spends nothing</button>
        <button type="button" className="gx-take-btn nodrag nopan" onClick={onCancel} data-testid="take-reject-cancel">Cancel</button>
      </div>
    </form>
  );
}
