"use client";

import type { Ref } from "react";
import { useAtomik } from "./AtomikProvider";
import { EffortPicker, ModelPicker, effortLabel, thinkingModelName } from "./ModelPicker";
import { useApi } from "@/lib/useApi";
import { parseSlashCommand, type ConnectedRecipe } from "@/lib/higgsfield-consumer/workflows";

/** `/` in the composer: the connected account's recipes (A5 + A6). */
function RecipeHints({ text, pick, disabled }: { text: string; pick: (value: string) => void; disabled: boolean }) {
  const typing = /^\/[a-z0-9-]*$/.test(text);
  const slash = parseSlashCommand(text);
  const { data } = useApi<{ recipes: ConnectedRecipe[] }>(text.startsWith("/") ? "/api/atomik/recipes" : null);
  const recipes = data?.recipes ?? [];
  if (!text.startsWith("/") || !recipes.length) return null;
  if (typing) {
    const query = text.trim().slice(1);
    const matches = recipes.filter((r) => r.name.startsWith(query) || r.name.includes(query)).slice(0, 6);
    if (!matches.length) return <p className="text-[11px] leading-relaxed text-ink-muted">No recipe starts with {text.trim()}.</p>;
    return <div role="listbox" aria-label="Recipes" className="flex min-w-0 flex-col gap-1 overflow-y-auto" style={{ maxHeight: "clamp(34px, calc(100dvh - 330px), 172px)" }}>
      {matches.map((r) => <button key={r.name} type="button" role="option" aria-selected={false} disabled={disabled} onClick={() => pick(`/${r.name} `)} title={r.description}
        className="flex h-8 min-w-0 flex-none items-center gap-2 rounded-ctl border border-border-mid px-2 text-left">
        <span className="flex-none text-[12.5px] font-medium text-ink">/{r.name}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-muted">{r.description}</span>
      </button>)}
    </div>;
  }
  const recipe = slash && recipes.find((r) => r.name === slash.name);
  return recipe
    ? <p className="text-[11px] leading-relaxed text-ink-muted">Recipe /{recipe.name} from the connected account · every paid step is priced for your approval.</p>
    : null;
}

/** Planning always presents the exact model, effort and credit ceiling before Send. */
export function ChatComposer({ inputHeight = 48, inputRef }: { inputHeight?: 44 | 46 | 48; inputRef?: Ref<HTMLInputElement> }) {
  const a = useAtomik();
  const recovering = a.recoveryText !== null;
  const locked = a.busy || recovering;
  const selected = a.models.find(model => model.id === a.model);
  return <form className="flex min-w-0 flex-1 flex-col gap-2" onSubmit={event => { event.preventDefault(); void a.send(a.draftText); }}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ModelPicker value={a.model} models={a.models} onPick={a.setThinkingModel} disabled={locked} compact label="Chat thinking model" />
      <EffortPicker value={a.effort} model={selected} onPick={a.setReasoningEffort} disabled={locked} compact label="Chat reasoning effort" />
    </div>
    <RecipeHints text={a.draftText} pick={a.setDraftText} disabled={locked} />
    <input ref={inputRef} value={a.draftText} onChange={event => a.setDraftText(event.target.value)} placeholder="Ask Atomik… or / for recipes" aria-label="Ask Atomik" disabled={locked}
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
