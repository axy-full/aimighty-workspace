"use client";

import { useAtomik } from "./AtomikProvider";
import { EffortPicker, ModelPicker, effortLabel, thinkingModelName } from "./ModelPicker";

/** Planning always presents the exact model, effort and credit ceiling before Send. */
export function ChatComposer({ inputHeight = 48 }: { inputHeight?: 44 | 46 | 48 }) {
  const a = useAtomik();
  const recovering = a.recoveryText !== null;
  const locked = a.busy || recovering;
  const selected = a.models.find(model => model.id === a.model);
  return <form className="flex min-w-0 flex-1 flex-col gap-2" onSubmit={event => { event.preventDefault(); void a.send(a.draftText); }}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ModelPicker value={a.model} models={a.models} onPick={a.setThinkingModel} disabled={locked} compact label="Chat thinking model" />
      <EffortPicker value={a.effort} model={selected} onPick={a.setReasoningEffort} disabled={locked} compact label="Chat reasoning effort" />
    </div>
    <input value={a.draftText} onChange={event => a.setDraftText(event.target.value)} placeholder="Ask Atomik…" aria-label="Ask Atomik" disabled={locked}
      style={{height:inputHeight}} className="w-full min-w-0 rounded-card border border-border-mid bg-card px-3 text-[16px] text-ink placeholder:text-ink-muted" />
    {a.quote && !recovering && <p className="text-[11px] leading-relaxed text-ink-muted">{thinkingModelName(a.quote.model, a.models)} · {effortLabel(a.quote.effort, a.models.find(model => model.id === a.quote?.model))} · up to {a.quote.estimateCredits} cr</p>}
    {a.quoteError && !recovering && <p role="alert" className="text-[12px] text-ink-body">{a.quoteError}</p>}
    {recovering && <p className="text-[11px] leading-relaxed text-ink-muted">Recover the original request with its saved model, effort and price.</p>}
    <button type="submit" disabled={a.busy || !a.draftText.trim() || (!recovering && !a.quote)}
      className="flex min-h-11 w-full items-center justify-center rounded-ctl border border-border-mid bg-action hover:bg-action-hover px-3 text-[13px] font-medium text-on-action disabled:opacity-50">
      {a.busy ? "Sending…" : recovering ? "Recover saved request" : a.quote ? `Send · ${a.quote.estimateCredits} cr estimated` : a.quoting ? "Estimating…" : a.quoteError ? "Estimate unavailable" : "Send"}
    </button>
  </form>;
}
