"use client";
import { useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { Price } from "@/components/graphite/Price";
import { SeedanceEditHost } from "@/components/graphite/tools/SeedanceEditHost";
import { useVerifications } from "@/components/workspace/rig/use-verifications";
import { SAY, referenceRole } from "@/lib/shell/assets";
import { exact, upTo } from "@/lib/shell/price-words";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { isVerifyCard } from "@/lib/workbench/verify";
import type { BoardCtx } from "../cards/types";
import {
  REJECT_REASON_MAX, hhmm, inFlight, judgeable, rejectReasonProblem, shotHistory, type ShotTakes, type ShotVersion,
} from "../cards/take/take-model";
import { useJudge } from "../cards/take/use-judge";
import { useTakeNotes } from "../cards/take/use-take-notes";
import { advancedRows, downloadHref, editQuoteBody, paidCredits } from "./inspector-model";

/*
 * Frame k: the Inspector on a take. Preview, the engine line and what it was charged, the prompt with Copy, its
 * versions, the actions every result carries (Approve, Reject, Change with words, Use as reference, Download),
 * its history, and Advanced folded. "Select & edit a region" is left out: no engine here edits a region of a
 * clip (DECISIONS 9, 20).
 *
 * Change with words runs the existing priced paths, its price on its own button before anything is sent: a
 * clip opens Seedance Edit on this take (DECISIONS 17), a still opens Make with the take as its reference.
 */

export function TakeBody({ row, ctx }: { row: ShotTakes; ctx: BoardCtx }) {
  const shell = useShell();
  const judge = useJudge(ctx.scope, ctx.project.id, ctx.toast);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const v: ShotVersion | null = row.versions.find((x) => x.genId === pickedId) ?? row.shown;
  const checked = ctx.project.nodes.some(isVerifyCard);
  const { list } = useVerifications(ctx.scope, checked ? ctx.project.id : null);
  const notes = useTakeNotes(ctx.scope, row.versions.map((x) => x.genId));
  const history = useMemo(() => shotHistory(row.versions, { verifications: list, notes }), [row.versions, list, notes]);
  /* Change with words on a clip: its price from the same free quote Seedance Edit's panel asks, read while the take is open. */
  const editBody = v ? editQuoteBody(v, ctx.project.productionProjectId) : null;
  const editQuote = useStageQuotes(ctx.scope, editBody && !ctx.offline && judgeable(v!) ? { edit: { body: editBody } } : {}).quotes.edit;
  const editPrice = upTo(editQuote?.credits);
  if (!v) return <p className="gx-insp-quiet" data-testid="insp-no-take">No take yet.</p>;

  if (editing && v.media === "video") {
    return (
      <div className="gx-insp-edit" data-testid="insp-change">
        <button type="button" className="gx-insp-link" onClick={() => setEditing(false)} data-testid="insp-change-back">‹ Back to the take</button>
        <SeedanceEditHost scope={ctx.scope} project={ctx.project} onBack={() => setEditing(false)} initialSource={v.id} />
      </div>
    );
  }

  const open = judgeable(v) && !ctx.offline;
  const paid = paidCredits(v);
  const role = referenceRole(v.media === "image" || v.media === "video" ? v.media : null);
  const pick = (x: ShotVersion) => { setPickedId(x.genId); setRejecting(false); setReason(""); setHint(null); };
  const reject = () => {
    const problem = rejectReasonProblem(reason);
    if (problem) { setHint(problem); return; }
    setPickedId(v.genId);
    void judge.reject(row, v, reason).then((ok) => { if (ok) { setRejecting(false); setReason(""); } });
  };
  const change = () => {
    if (v.media === "video") { setEditing(true); return; }
    shell.openMake({ prompt: "", type: "image", note: `Change with words · ${row.title} · ${v.label}`, references: [{ origin: "generation", id: v.genId, kind: "image" }] });
  };
  const useAsReference = () => {
    if (!role) return;
    sendReference({ id: v.id, name: v.entry.take.name });
    ctx.openMake(v.media === "video" ? "video" : "image");
    ctx.toast(SAY.referenced(v.entry.take.name, role));
  };
  const copy = () => { void navigator.clipboard?.writeText(v.prompt).then(() => ctx.toast("Prompt copied"), () => ctx.toast("The prompt could not be copied.")); };

  return (
    <div className="gx-insp-take" data-testid="insp-take">
      <div className="gx-insp-preview">
        {v.url && (v.media === "image" || v.media === "video") && !inFlight(v) ? <LazyMedia url={v.url} kind={v.media} alt="" name={row.title} preview={false} /> : <span className="gx-insp-face" aria-hidden="true" />}
      </div>
      <div>
        <div className="gx-insp-title">{`Shot ${row.index} · ${row.name} · ${v.label}`}</div>
        <div className="gx-insp-meta" data-testid="insp-engine">
          {v.engine}{paid != null ? <> · <Price value={exact(paid)} testId="insp-paid" /> paid</> : null}
        </div>
      </div>

      {v.prompt.trim() ? (
        <section>
          <div className="gx-insp-eyebrow-row"><span className="gx-insp-eyebrow">Prompt</span><button type="button" className="gx-insp-link" onClick={copy} data-testid="insp-copy">Copy</button></div>
          <p className="gx-insp-prompt">{v.prompt}</p>
        </section>
      ) : null}

      {row.versions.length > 1 ? (
        <section>
          <span className="gx-insp-eyebrow">Versions</span>
          <div className="gx-insp-versions" role="group" aria-label="Versions">
            {row.versions.map((x) => (
              <button key={x.genId} type="button" className="gx-insp-version" aria-pressed={x.genId === v.genId} onClick={() => pick(x)} data-testid="insp-version">
                {x.label}{x.status === "approved" ? " · approved" : ""}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="gx-insp-actions">
        <button type="button" className="gx-insp-act gx-insp-act--approve" disabled={!open || v.status === "approved" || Boolean(judge.busy)}
          onClick={() => { setPickedId(v.genId); void judge.approve(row, v); }} title={ctx.offline ? "Needs a connection" : undefined} data-testid="insp-approve">
          {v.status === "approved" ? "Approved" : "Approve"}
        </button>
        {rejecting ? (
          <form className="gx-insp-reason" onSubmit={(e) => { e.preventDefault(); reject(); }}>
            <input autoFocus className="gx-insp-input" value={reason} maxLength={REJECT_REASON_MAX} placeholder="Why reject it?" aria-label="Reason for rejecting"
              aria-invalid={hint ? true : undefined} onChange={(e) => { setReason(e.target.value); setHint(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRejecting(false); setHint(null); } }} data-testid="insp-reason" />
            <button type="submit" className="gx-insp-act gx-insp-act--danger" disabled={Boolean(judge.busy)} data-testid="insp-reject-confirm">Reject</button>
            {hint ? <span className="gx-insp-hint" role="alert" data-testid="insp-reason-hint">{hint}</span> : null}
          </form>
        ) : (
          <button type="button" className="gx-insp-act" disabled={!open || v.status === "changes" || Boolean(judge.busy)} onClick={() => setRejecting(true)}
            title={ctx.offline ? "Needs a connection" : undefined} data-testid="insp-reject">{v.status === "changes" ? "Rejected" : "Reject"}</button>
        )}
        {judgeable(v) && v.entry.asset.origin === "generation" ? (
          <button type="button" className="gx-insp-act" disabled={ctx.offline} onClick={change} title={ctx.offline ? "Needs a connection" : undefined} data-testid="insp-change-words">Change with words{editPrice ? <> · <Price value={editPrice} testId="insp-change-price" /></> : null}</button>
        ) : null}
        {role && judgeable(v) ? <button type="button" className="gx-insp-act" onClick={useAsReference} data-testid="insp-use-ref">Use as reference</button> : null}
        {judgeable(v) ? <a className="gx-insp-act" href={downloadHref(v.genId)} download data-testid="insp-download">Download</a> : null}
      </div>

      {history.length ? (
        <section>
          <span className="gx-insp-eyebrow">History</span>
          <ol className="gx-insp-history">
            {history.map((h) => (
              <li key={h.key}><span>{h.text}</span><time dateTime={new Date(h.at).toISOString()}>{hhmm(h.at)}</time></li>
            ))}
          </ol>
        </section>
      ) : null}

      <section>
        <button type="button" className="gx-insp-fold" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} data-testid="insp-advanced">
          <span className="gx-insp-eyebrow">Advanced</span><span>{advanced ? "Hide" : "Show"}</span>
        </button>
        {advanced ? (
          <dl className="gx-insp-rows">
            {advancedRows(v).map((r) => <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}
          </dl>
        ) : null}
      </section>
    </div>
  );
}
