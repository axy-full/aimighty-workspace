"use client";

import { useState } from "react";
import type { SkillView } from "@/lib/atomikSkillsText";
import { useAtomik } from "./AtomikProvider";
import { EffortPicker, ModelPicker, effortLabel, thinkingModelName } from "./ModelPicker";
import { ComposerSkillDialogs, SaveSkillButton, SkillHints, useComposerSkills } from "./skills/ComposerSkills";

/** Planning always presents the exact model, effort and credit ceiling before Send.
 *  A skill's `/command` opens its run form instead of a planning turn: the run plans for nothing, and each of its
 *  steps is priced and approved like any other (components/atomik/skills). */
export function ChatComposer({ inputHeight = 48 }: { inputHeight?: 44 | 46 | 48 }) {
  const a = useAtomik();
  const recovering = a.recoveryText !== null;
  const locked = a.busy || recovering;
  const selected = a.models.find(model => model.id === a.model);
  const skills = useComposerSkills(recovering ? "" : a.draftText);
  const [running, setRunning] = useState<SkillView | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const command = recovering ? null : skills.exact;
  const savable = Boolean(a.chat) && !recovering && a.plan.some(step => !a.isReadOnly(step));
  const openSkill = (skill: SkillView) => { setRunning(skill); setSaid(null); a.setDraftText(""); };
  return <>
  <form className="flex min-w-0 flex-1 flex-col gap-2" onSubmit={event => { event.preventDefault(); if (command) { openSkill(command); return; } void a.send(a.draftText); }}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ModelPicker value={a.model} models={a.models} onPick={a.setThinkingModel} disabled={locked} compact label="Chat thinking model" />
      <EffortPicker value={a.effort} model={selected} onPick={a.setReasoningEffort} disabled={locked} compact label="Chat reasoning effort" />
      {savable && a.chat && <SaveSkillButton disabled={locked} onOpen={() => { setSaving(a.chat!.id); setSaid(null); }} />}
    </div>
    {a.modelNote && !recovering && <p role="note" data-testid="atomik-model-note" className="text-[11px] leading-relaxed text-ink-muted">{a.modelNote}</p>}
    {said && <p role="status" data-testid="atomik-skill-said" className="text-[12px] leading-relaxed text-ink-body">{said}</p>}
    <SkillHints text={recovering ? "" : a.draftText} skills={skills.skills} loading={skills.loading || skills.reading} onPick={openSkill} disabled={locked} />
    <input value={a.draftText} onChange={event => a.setDraftText(event.target.value)} placeholder="Ask Atomik…" aria-label="Ask Atomik" disabled={locked}
      style={{height:inputHeight}} className="w-full min-w-0 rounded-card border border-border-mid bg-card px-3 text-[16px] text-ink placeholder:text-ink-muted" />
    {command && <p data-testid="atomik-skill-command" className="text-[12px] leading-relaxed text-ink-body">/{command.slug} plans its steps for nothing; each is then priced and waits for your Continue.</p>}
    {a.quote && !recovering && !command && <p className="text-[11px] leading-relaxed text-ink-muted">{thinkingModelName(a.quote.model, a.models)} · {effortLabel(a.quote.effort, a.models.find(model => model.id === a.quote?.model))} · up to {a.quote.estimateCredits} cr</p>}
    {a.quoteError && !recovering && !command && <p role="alert" className="text-[12px] text-ink-body">{a.quoteError}</p>}
    {recovering && <p className="text-[11px] leading-relaxed text-ink-muted">Recover the original request with its saved model, effort and price.</p>}
    <button type="submit" disabled={a.busy || !a.draftText.trim() || (!recovering && !a.quote && !command)}
      className="flex min-h-11 w-full items-center justify-center rounded-ctl border border-border-mid bg-action hover:bg-action-hover px-3 text-[13px] font-medium text-on-action disabled:opacity-50">
      {a.busy ? "Sending…" : recovering ? "Recover saved request" : command ? `Run /${command.slug}` : a.quote ? `Send · ${a.quote.estimateCredits} cr estimated` : a.quoting ? "Estimating…" : a.quoteError ? "Estimate unavailable" : "Send"}
    </button>
  </form>
  <ComposerSkillDialogs api={skills.api} running={running} saving={saving} chat={a.chat ? { id: a.chat.id, projectId: a.chat.projectId } : null}
    onClose={() => { setRunning(null); setSaving(null); }} onSaved={setSaid} />
  </>;
}
