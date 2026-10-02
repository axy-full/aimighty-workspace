"use client";

import { useId, useState } from "react";
import { unkeptReason, type SkillView } from "@/lib/atomikSkillsText";
import { useAtomik } from "./AtomikProvider";
import { creditsFigure } from "@/lib/creditTerms";
import { EffortPicker, ModelPicker, effortLabel, thinkingModelName } from "./ModelPicker";
import { ComposerSkillDialogs, SaveSkillButton, SkillHints, sayAboutChat, skillOptionId, useComposerSkills, useSkillNotice } from "./skills/ComposerSkills";

/** Planning always presents the exact model, effort and credit ceiling before Send.
 *  A skill's `/command` opens its run form instead of a planning turn: the run plans for nothing, and each of its
 *  steps is priced and approved like any other (components/atomik/skills). While a command is still being typed,
 *  the skills it matches are listed; the arrow keys move the highlight and Enter opens the highlighted one. */
export function ChatComposer({ inputHeight = 48 }: { inputHeight?: 44 | 46 | 48 }) {
  const a = useAtomik();
  const recovering = a.recoveryText !== null;
  const locked = a.busy || recovering;
  const selected = a.models.find(model => model.id === a.model);
  const skills = useComposerSkills(recovering ? "" : a.draftText);
  const [running, setRunning] = useState<{ skill: SkillView; values: Record<string, string> } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /* What a skill just did for this chat ("Saved as /x…", "Planned…"): kept outside this composer, which a fold redraws. */
  const said = useSkillNotice(a.chat?.id ?? null);
  const listId = useId();
  /* The highlighted match: the first (the command itself, when it is one) until the arrows move it, again on every keystroke. */
  const [highlight, setHighlight] = useState<{ text: string; index: number }>({ text: "", index: 0 });
  const matches = recovering ? [] : skills.matches;
  const at = highlight.text === a.draftText ? Math.min(highlight.index, Math.max(0, matches.length - 1)) : 0;
  const command = recovering ? null : matches.length ? { skill: matches[at], values: {} } : skills.exact;
  /* A command typed before the skills are read is not sent as a planning turn: it waits for the list. */
  const waiting = !recovering && !command && a.draftText.startsWith("/") && (skills.loading || skills.reading);
  /* Only a plan with a step a skill can keep (lib/atomikSkillsText.ts › unkeptReason) offers to be saved as one. */
  const savable = Boolean(a.chat) && !recovering && a.plan.some(step => !unkeptReason(step));
  const openSkill = (skill: SkillView, values: Record<string, string> = {}) => { setRunning({ skill, values }); sayAboutChat(null, null); a.setDraftText(""); };
  return <>
  <form className="flex min-w-0 flex-1 flex-col gap-2" onSubmit={event => { event.preventDefault(); if (waiting) return; if (command) { openSkill(command.skill, command.values); return; } sayAboutChat(null, null); void a.send(a.draftText); }}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ModelPicker value={a.model} models={a.models} onPick={a.setThinkingModel} disabled={locked} compact label="Chat thinking model" />
      <EffortPicker value={a.effort} model={selected} onPick={a.setReasoningEffort} disabled={locked} compact label="Chat reasoning effort" />
      {savable && a.chat && <SaveSkillButton disabled={locked} onOpen={() => { setSaving(a.chat!.id); sayAboutChat(null, null); }} />}
    </div>
    {a.modelNote && !recovering && <p role="note" data-testid="atomik-model-note" className="text-[11px] leading-relaxed text-ink-muted">{a.modelNote}</p>}
    {said && <p role="status" data-testid="atomik-skill-said" className="text-[12px] leading-relaxed text-ink-body [overflow-wrap:anywhere]">{said}</p>}
    <SkillHints text={recovering ? "" : a.draftText} skills={skills.skills} loading={skills.loading || skills.reading} onPick={(skill) => openSkill(skill)} disabled={locked} listId={listId} active={at}
      failed={skills.failed} onRetry={skills.retry} />
    <input value={a.draftText} onChange={event => a.setDraftText(event.target.value)} placeholder="Ask Atomik…" aria-label="Ask Atomik" disabled={locked}
      aria-autocomplete="list" aria-controls={matches.length ? listId : undefined} aria-activedescendant={matches.length ? skillOptionId(listId, at) : undefined}
      onKeyDown={event => {
        if (!matches.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
        event.preventDefault();
        setHighlight({ text: a.draftText, index: (at + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length });
      }}
      style={{height:inputHeight}} className="w-full min-w-0 rounded-card border border-border-mid bg-card px-3 text-[16px] text-ink placeholder:text-ink-muted" />
    {command && <p data-testid="atomik-skill-command" className="text-[12px] leading-relaxed text-ink-body [overflow-wrap:anywhere]">/{command.skill.slug} plans its steps for nothing; each is then priced and waits for your Continue.</p>}
    {a.quote && !recovering && !command && <p className="text-[11px] leading-relaxed text-ink-muted">{thinkingModelName(a.quote.model, a.models)} · {effortLabel(a.quote.effort, a.models.find(model => model.id === a.quote?.model))} · up to {creditsFigure(a.quote.estimateCredits)} cr</p>}
    {a.quoteError && !recovering && !command && <p role="alert" className="text-[12px] text-ink-body">{a.quoteError}</p>}
    {recovering && <p className="text-[11px] leading-relaxed text-ink-muted">Recover the original request with its saved model, effort and price.</p>}
    <button type="submit" disabled={a.busy || waiting || !a.draftText.trim() || (!recovering && !a.quote && !command)}
      className="flex min-h-11 w-full items-center justify-center rounded-ctl border border-border-mid bg-action hover:bg-action-hover px-3 text-[13px] font-medium text-on-action [overflow-wrap:anywhere] disabled:opacity-50">
      {a.busy ? "Sending…" : recovering ? "Recover saved request" : command ? `Run /${command.skill.slug}` : waiting ? "Reading skills…" : a.quote ? `Send · ${creditsFigure(a.quote.estimateCredits)} cr estimated` : a.quoting ? "Estimating…" : a.quoteError ? "Estimate unavailable" : "Send"}
    </button>
  </form>
  <ComposerSkillDialogs api={skills.api} running={running} saving={saving} chat={a.chat ? { id: a.chat.id, projectId: a.chat.projectId } : null}
    onClose={() => { setRunning(null); setSaving(null); }} />
  </>;
}
