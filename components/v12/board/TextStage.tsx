"use client";
import { useMemo, useState, type CSSProperties } from "react";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { Dialog, Segment } from "@/components/v12/ui";
import { Price } from "@/components/v12/ui/Price";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { creditRate } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { priceDisplay, type Quote } from "@/lib/v12/quote";
import { fmtLedgerUsd } from "@/lib/usageLedgerTerms";
import { useQuote } from "@/lib/v12/useQuote";
import { TEXT_REASONS, SCRIPT_TABS, beatLines, breakdownLines, briefCard, fingerprint, scriptCard, withMark, withoutMark, type ScriptTab, type TextCard, type TextStepId } from "@/lib/v12/board/text-steps";
import { quoteBody, runBody, translateFromResponse, translateProblem, TRANSLATE_ENDPOINT } from "@/lib/v12/translate-script";
import { useScreenScale } from "./use-screen-scale";
import { StepCard } from "./StepCard";
import "./stage-pages.css";
import "./card-scale.css";
import "./text-stage.css";

/**
 * Brief and Script, the Film board's text steps (design/particl-prototype-25; demo plan PR 11): one text card each, drawn with the v25 card
 * (StepCard), over the draft's own words. A click or Enter opens the card: the Brief's words to edit, or the Script's three tabs (Script,
 * Beats, Breakdown) and its Hindi version. ✓ and ✕ are kept in the draft (`boardMarks`, lib/v12/board/text-steps.ts); an edit makes a mark stale.
 *
 * The Hindi script is a priced tool (lib/v12/translate-script.ts): the button states the server's quote and is a person's press. Atomik can
 * be asked for any of it from the same screen. Nothing here spends except that one press.
 */
type Props = { ctx: BoardCtx; step: TextStepId };

/** When a verdict was given (kept beside it; read by nothing yet). */
const clock = () => Date.now();

/** The control's spend marker: the quote's own figure once it has one, else unpriced (and disabled). */
function spendAttrsOfQuote(quote: Quote, words: (quote: Quote) => string) {
  if (quote.state === "ready") {
    const price = quote.price;
    return price.unit === "cr" ? spendAttrsOf(price.value) : { "data-spend": "priced" as const, "data-spend-price": words(quote) };
  }
  return { "data-spend": "unpriced" as const };
}

export function TextStage({ ctx, step }: Props) {
  const project = ctx.project;
  const canEdit = !ctx.offline && !ctx.readOnly;
  const scale = useScreenScale(true);
  const [open, setOpen] = useState<TextStepId | null>(null);
  /* The Hindi card opens the Script on its Hindi view. */
  const [inHindi, setInHindi] = useState(false);
  const show = (id: TextStepId, hindi = false) => { setInHindi(hindi); setOpen(id); };
  const brief = briefCard(project);
  const script = scriptCard(project);
  const [hindi, setHindi] = useState<{ fp: string; text: string } | null>(null);
  const hindiNow = hindi && hindi.fp === fingerprint(script.text) ? hindi : null;

  const write = (change: (p: typeof project) => typeof project) => {
    const refused = ctx.rig.apply(change);
    if (refused) ctx.toast(refused);
  };
  const judge = (card: TextCard, verdict: "approved" | "rejected", reason?: string) => {
    write((p) => ({ ...p, boardMarks: withMark(p.boardMarks, card.id, card.text, verdict, clock(), reason) }));
  };
  const toggleApprove = (card: TextCard) => {
    if (card.status === "approved") write((p) => ({ ...p, boardMarks: withoutMark(p.boardMarks, card.id) }));
    else judge(card, "approved");
  };

  const draw = (card: TextCard) => (
    <StepCard key={card.id} id={card.id} title={card.title} status={card.status} version={card.version} reason={card.reason}
      text={card.excerpt} tile={{ letter: (project.name || "P").trim().charAt(0).toUpperCase() || "P" }} chips={card.chips} reasons={TEXT_REASONS[card.id]}
      onSelect={(event) => { if (!(event.target as HTMLElement).closest(".v12-card-marks, .v12-card-reasons")) show(card.id); }} onOpen={() => show(card.id)} onChip={() => show(card.id)}
      onApprove={canEdit ? () => toggleApprove(card) : undefined} onReject={canEdit ? (reason) => judge(card, "rejected", reason) : undefined} />
  );

  return (
    <div className="v12-sp v12-ts" data-testid="v12-text-stage" data-step={step}>
      <div className="v12-ts-grid v12-scaled" style={{ "--k": scale } as CSSProperties}>
        {step === "brief" ? draw(brief) : (
          <>
            {draw(script)}
            <StepCard id="hindi" title="Hindi script" status={hindiNow ? "ready" : "none"} own={hindiNow ? "Hindi · from the script" : "Not made yet"}
              text={hindiNow ? hindiNow.text.slice(0, 280) : ""} tile={{ letter: "ह" }} onSelect={() => show("script", true)} onOpen={() => show("script", true)} />
          </>
        )}
      </div>
      <div className="v12-ts-acts">
        <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik(step === "brief" ? "Write the brief for this film: " : "Write the script from the brief: ")} data-testid="v12-text-ask">Ask Atomik</button>
      </div>
      {open === "brief" ? <BriefPreview ctx={ctx} card={brief} canEdit={canEdit} onClose={() => setOpen(null)} write={write} /> : null}
      {open === "script" ? <ScriptPreview ctx={ctx} card={script} startInHindi={inHindi} canEdit={canEdit} hindi={hindiNow?.text ?? null} onHindi={(text) => setHindi({ fp: fingerprint(script.text), text })} onClose={() => setOpen(null)} write={write} /> : null}
    </div>
  );
}

export const BriefStage = ({ ctx }: { ctx: BoardCtx }) => <TextStage ctx={ctx} step="brief" />;
export const ScriptStage = ({ ctx }: { ctx: BoardCtx }) => <TextStage ctx={ctx} step="script" />;

type Write = (change: (p: BoardCtx["project"]) => BoardCtx["project"]) => void;

/** The words, edited in place and kept when the field is left or the preview closes. New words from outside (a different `key`) start it again. */
function Words({ value, label, rows, readOnly, onCommit, testId, lang }: { value: string; label: string; rows: number; readOnly: boolean; onCommit: (text: string) => void; testId: string; lang?: string }) {
  const [text, setText] = useState(value);
  return (
    <label className="v12-ts-field"><span className="v12-sp-eyebrow">{label}</span>
      <textarea className="v12-ts-text" rows={rows} value={text} lang={lang} readOnly={readOnly} onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== value) onCommit(text); }} data-testid={testId} />
    </label>
  );
}

function BriefPreview({ ctx, card, canEdit, onClose, write }: { ctx: BoardCtx; card: TextCard; canEdit: boolean; onClose: () => void; write: Write }) {
  return (
    <Dialog open onClose={onClose} label="Brief" title="Brief" width={640} testId="v12-brief-preview">
      <div className="v12-ts-pane">
        {card.chips.length ? <p className="v12-sp-why" data-testid="v12-brief-spec">{card.chips.map((c) => c.label).join(" · ")}</p> : null}
        <Words key={card.text} value={card.text} label="The brief" rows={10} readOnly={!canEdit} testId="v12-brief-words" onCommit={(text) => write((p) => ({ ...p, brief: text.slice(0, 30_000) }))} />
        <div className="v12-sp-acts"><button type="button" className="v12-sp-btn" onClick={() => { onClose(); ctx.askAtomik("Rewrite the brief: "); }} data-testid="v12-brief-ask">Ask Atomik</button></div>
      </div>
    </Dialog>
  );
}

type Lang = "en" | "hi";

function ScriptPreview({ ctx, card, startInHindi, canEdit, hindi, onHindi, onClose, write }: { ctx: BoardCtx; card: TextCard; startInHindi: boolean; canEdit: boolean; hindi: string | null; onHindi: (text: string) => void; onClose: () => void; write: Write }) {
  const [tab, setTab] = useState<ScriptTab>("Script");
  const [lang, setLang] = useState<Lang>(startInHindi ? "hi" : "en");
  const beats = useMemo(() => beatLines(ctx.project), [ctx.project]);
  const breakdown = useMemo(() => breakdownLines(ctx.project), [ctx.project]);
  return (
    <Dialog open onClose={onClose} label="Script" title="Script" width={720} testId="v12-script-preview">
      <div className="v12-ts-pane">
        <div className="v12-ts-tabs">
          <Segment<ScriptTab> label="Script view" value={tab} onChange={setTab} options={SCRIPT_TABS.map((t) => ({ id: t, label: t }))} />
          {tab === "Script" ? <Segment<Lang> label="Language" value={lang} onChange={setLang} options={[{ id: "en", label: "English" }, { id: "hi", label: "हिन्दी" }]} /> : null}
        </div>
        {tab === "Script" && lang === "en" ? (
          <Words key={card.text} value={card.text} label="The script" rows={14} readOnly={!canEdit} testId="v12-script-words" onCommit={(text) => write((p) => ({ ...p, script: text }))} />
        ) : null}
        {tab === "Script" && lang === "hi" ? <HindiScript ctx={ctx} text={card.text} hindi={hindi} onHindi={onHindi} canEdit={canEdit} /> : null}
        {tab === "Beats" ? <Lines lines={beats} empty="No beats yet. They come from the script's breakdown." ctx={ctx} testId="v12-script-beats" /> : null}
        {tab === "Breakdown" ? <Lines lines={breakdown} empty="No breakdown yet. Atomik reads the characters, places and props from the script." ctx={ctx} testId="v12-script-breakdown" /> : null}
      </div>
    </Dialog>
  );
}

function Lines({ lines, empty, ctx, testId }: { lines: string[]; empty: string; ctx: BoardCtx; testId: string }) {
  return lines.length ? (
    <ul className="v12-ts-lines" data-testid={testId}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
  ) : (
    <div data-testid={testId}>
      <p className="v12-sp-why">{empty}</p>
      <div className="v12-sp-acts"><button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("Break the script down into scenes, beats and shots: ")}>Ask Atomik</button></div>
    </div>
  );
}

/** The Hindi script: the translate tool's quote on the button, a person's press to run it, the result read-only. */
function HindiScript({ ctx, text, hindi, onHindi, canEdit }: { ctx: BoardCtx; text: string; hindi: string | null; onHindi: (text: string) => void; canEdit: boolean }) {
  const { rates } = useSession();
  const fetcher = useScopedFetch(ctx.scope);
  const problem = translateProblem(text);
  const quote = useQuote(problem ? null : { route: "translate", body: quoteBody({ text }) });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const words = (q: Quote) => priceDisplay(q, undefined, { creditUsd: creditRate(rates.creditUsd), dollars: fmtLedgerUsd })?.text ?? "";
  const approved = approvedFigure(quote);

  const run = async () => {
    if (busy || quote.state !== "ready" || approved === null) return;
    setBusy(true);
    setFailed(null);
    try {
      const reply = await fetcher(TRANSLATE_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(runBody({ text }, approved)) });
      const out = translateFromResponse(reply.ok, await reply.json().catch(() => null));
      if (out.ok) onHindi(out.text); else setFailed(out.error);
    } catch {
      setFailed("The Hindi script could not be made. Nothing billed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v12-ts-hindi" data-testid="v12-hindi-script">
      {hindi ? <Words key={hindi} value={hindi} label="Hindi script" rows={14} readOnly lang="hi" testId="v12-hindi-words" onCommit={() => {}} /> : null}
      {problem ? <p className="v12-sp-why" data-testid="v12-hindi-problem">{problem}</p> : null}
      {failed ? <p className="v12-sp-why v12-sp-problem" role="alert" data-testid="v12-hindi-failed">{failed}</p> : null}
      <div className="v12-sp-acts">
        <button type="button" className="v12-sp-btn v12-sp-primary" onClick={() => void run()} disabled={!canEdit || Boolean(problem) || busy || quote.state !== "ready" || approved === null}
          aria-busy={busy || undefined} data-testid="v12-hindi-make" {...spendAttrsOfQuote(quote, words)}>
          {busy ? "Making…" : failed ? "Retry" : hindi ? "Make it again" : "Make the Hindi script"}{problem ? null : <> · <Price quote={quote} /></>}
        </button>
        <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("Make the Hindi script from the script: ")} data-testid="v12-hindi-ask">Ask Atomik</button>
      </div>
    </div>
  );
}

/** What the person approves: the quote's own figure in the unit it is shown in (credits, or the house workspace's dollars), never worked out here. */
function approvedFigure(quote: Quote): number | null {
  if (quote.state !== "ready") return null;
  const price = quote.price;
  if (price.unit === "usd") return Number.isFinite(price.usd) ? price.usd : null;
  return price.value.kind === "free" ? 0 : Number.isFinite(price.value.credits) ? price.value.credits : null;
}
