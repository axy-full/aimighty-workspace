"use client";

import { useEffect, useState } from "react";
import { fmtCredits } from "@/lib/price";
import {
  headline, REASSURANCE, splitLine, primaryLabel, footnote,
} from "@/lib/impactChoice";
import type { Impact, ChoiceKey } from "@/lib/impact";

/**
 * What changing a shared element costs, asked before it changes
 * (brief 3, surface 1b).
 *
 * The design's fifth rule is that nothing re-renders silently, and this sheet
 * is what that rule looks like: an edit to something other shots are using
 * stops here, shows what it reaches and what each way forward costs, and does
 * nothing until a person picks one.
 *
 * The reassurance at the top is the working part, not politeness. A producer
 * who has just changed a look on a production with six approved takes wants
 * one question answered before any other, and it is not what it costs — it is
 * whether anything has already happened. It has not.
 *
 * The swap is refused server-side without a choice, so this sheet is the only
 * way through rather than the polite way through.
 */
export default function ImpactSheet({ impact, kindWord, versionLabel, onClose, onApplied }: {
  impact: Impact;
  /** "look", "wardrobe", "plate" — what was changed, in the studio's word. */
  kindWord: string;
  /** What the shots stay on if nothing is re-rendered: "v3". */
  versionLabel: string;
  onClose: () => void;
  onApplied: (choice: ChoiceKey) => void;
}) {
  const [choice, setChoice] = useState<ChoiceKey>(impact.defaultKey);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  /* Escape closes it, like every other sheet in the app. Nothing is applied on
     the way out: leaving is not one of the three answers. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const picked = impact.choices.find((c) => c.key === choice) ?? impact.choices[0];
  const total = impact.shots.length;

  async function apply() {
    if (busy || !picked.verdict.allow) return;
    setBusy(true);
    setTrouble(null);
    try {
      const res = await fetch(`/api/rig/attributes/${encodeURIComponent(impact.attributeId)}/current`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /* No scope travels with the choice, because a swap has none: moving
           current_id moves every production at once, so the route asks and
           acts workspace-wide. Guessing a scope from the first row of the
           result was how an empty panel came to un-approve another
           production's takes. */
        body: JSON.stringify({ versionId: impact.versionId, choice }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setTrouble(String(json.error ?? "That didn't go through.")); return; }
      onApplied(choice);
    } finally { setBusy(false); }
  }

  return (
    <div className="imp-scrim" onClick={() => !busy && onClose()}>
      <div className="imp-sheet" role="dialog" aria-modal="true" aria-label="What happens to the takes that already exist"
           onClick={(e) => e.stopPropagation()}>
        <div className="imp-grab"><span /></div>

        <div className="imp-body">
          <div className="imp-head">
            <span className="imp-eyebrow">IMPACT · {kindWord.toUpperCase()}</span>
            <h2 className="imp-title">{headline(kindWord, total)}</h2>
            <p className="imp-said">{REASSURANCE}</p>
          </div>

          <section className="imp-summary">
            <div className="imp-summary-top">
              <span className="imp-used">Used by {total} shot{total === 1 ? "" : "s"}</span>
              <span className="imp-split">{splitLine(impact.approved, impact.draft)}</span>
            </div>
            {total ? (
              <div className="imp-bar">
                {impact.approved ? <i className="is-approved" style={{ flex: impact.approved }} /> : null}
                {impact.draft ? <i style={{ flex: impact.draft }} /> : null}
              </div>
            ) : null}
            {total ? (
              <div className="imp-pills">
                {impact.shots.map((s) => (
                  <span key={s.shotId} className="imp-pill">
                    <i className={s.approved ? "is-approved" : ""} />
                    {s.code || "—"}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <div className="imp-choices" role="radiogroup" aria-label="What happens to existing takes">
            {impact.choices.map((c) => (
              <button
                key={c.key} type="button" role="radio" aria-checked={choice === c.key}
                className={`imp-choice${choice === c.key ? " is-on" : ""}`}
                onClick={() => setChoice(c.key)}
              >
                <span className="imp-choice-top">
                  <span className="imp-mark" />
                  <span className="imp-choice-label">{c.label}</span>
                  <span className="imp-choice-cost">{fmtCredits(c.quote.totalCredits)}</span>
                </span>
                <span className="imp-choice-note">{c.consequence}</span>
                {!c.verdict.allow ? <span className="imp-choice-stop">{c.verdict.line}</span> : null}
              </button>
            ))}
          </div>

        </div>

        {/* Pinned, not scrolled. Phase 0 settled this for the composer sheet:
            a primary action a person has to scroll to find is one they can
            miss, and this one is the whole point of the sheet. */}
        <div className="imp-foot">
            {trouble ? <p className="imp-trouble">{trouble}</p> : null}
            <button className="imp-primary" onClick={apply} disabled={busy || !picked.verdict.allow}>
              <span>{primaryLabel(picked.key, picked.label)}</span>
              <span className="imp-primary-cost">{fmtCredits(picked.quote.totalCredits)}</span>
            </button>
            <span className="imp-footnote">
              {footnote(picked.key, {
                credits: picked.quote.totalCredits,
                approved: impact.approved, draft: impact.draft, version: versionLabel,
              })}
            </span>
        </div>
      </div>
    </div>
  );
}
