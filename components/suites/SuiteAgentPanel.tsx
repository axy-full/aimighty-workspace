'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDraftEditor } from '@/lib/workspace/use-draft-editor';
import { PromptAttach, attachedAsset, keptNote, resolveAttached, type Attached } from '@/components/PromptAttach';
import Link from 'next/link';
import { ArrowUpRight, Sparkles, RefreshCw } from 'lucide-react';
import { useSession } from '@/lib/session';
import { suiteHref, type SuiteId } from '@/lib/suites';
import { AGENT_DRAFT_EVENT, agentDraftKey, shownAgentDraft, type AgentDraft, type AgentDraftEdit } from '@/lib/shell/agent-draft';
import { SUITE_AGENT_COPY } from '@/lib/workbench/suite-agent-plan';
import type { Plan, Project } from '@/lib/workbench/studio';
import type { AtomikJob } from '@/lib/workbench/atomik-server';
import { AtomikRunDialog } from '@/components/workbench/AtomikRunDialog';
import type { ThinkingModel } from '@/components/atomik/ModelPicker';
import { MEMORY_KIND_LABEL, MEMORY_LIMITS, MONEY_REFUSAL, TEXT_KINDS, guessKind, mentionsMoney, parseMemoryCommand, type MemoryKind } from '@/lib/atomikMemoryText';
import { useMemoryApi, type ForgetFind, type MemoryApi } from '@/lib/shell/use-memory';
import styles from './suite-agent.module.css';
import { saveMessage } from '@/lib/workbench/save-then-continue';

type AgentState = { configured: boolean; models: ThinkingModel[]; jobs: AtomikJob[] };
const subscribeDraft = (listener: () => void) => {
  window.addEventListener('storage', listener); window.addEventListener(AGENT_DRAFT_EVENT, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(AGENT_DRAFT_EVENT, listener); };
};
const emptySnapshot = () => null;

/** Workbench owns its authenticated scope without a SessionProvider. Keep its
 * drafts and responses bound to that captured identity, just like Studio saves.
 * A request handed in from ⌘K (lib/shell/agent-draft.ts) replaces an earlier
 * edit in an open box instead of being typed over by it. */
function useAgentDraft(scope: string | null | undefined, suite: SuiteId, projectId: string) {
  const key = agentDraftKey(scope, suite, projectId);
  const read = useCallback(() => { try { return key ? localStorage.getItem(key) : null; } catch { return null; } }, [key]);
  const stored = useSyncExternalStore(subscribeDraft, read, emptySnapshot);
  const [edit, setEdit] = useState<AgentDraftEdit | null>(null);
  const value = shownAgentDraft(key, stored, edit);
  return { value, set(next: AgentDraft) {
    const text = JSON.stringify(next);
    setEdit({ key, value: next, seen: [stored, text] });
    if (key) try { localStorage.setItem(key, text); window.dispatchEvent(new Event(AGENT_DRAFT_EVENT)); } catch { /* The current editor still works without draft storage. */ }
  } };
}

function useAgentState(scope: string | null | undefined, projectId: string, active: boolean) {
  const key = JSON.stringify([scope, projectId, active]);
  const [state, setState] = useState<{ key: string; data?: AgentState; error?: string } | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!active || !scope) return;
    const own = ++sequence.current;
    try {
      const response = await fetch(`/api/workbench/atomik?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store', headers: { 'X-Workbench-Scope': scope } });
      const value = await response.json();
      if (!response.ok) throw new Error(saveMessage(value.error || 'Agent proposals could not be loaded.'));
      if (sequence.current === own) setState({ key, data: value });
    } catch (error) { if (sequence.current === own) setState(previous => ({ key, data: previous?.key === key ? previous.data : undefined, error: error instanceof Error ? error.message : 'Agent proposals could not be loaded.' })); }
  }, [active, scope, projectId, key]);
  useEffect(() => {
    void refresh();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    const timer = active ? setInterval(onVisible, 10000) : null;
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      // Invalidate all polls, including a manual refresh newer than this effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, refresh]);
  return { data: state?.key === key ? state.data : undefined, error: state?.key === key ? state.error : undefined, refresh };
}

/**
 * Atomik memory from the Agent (lib/atomikMemory): "Forget …" typed in the
 * request box finds the kept entries it is about and a person confirms which
 * to archive; "Remember …", "Remember this" on a proposal, and Remember on
 * one of Atomik's assumptions keep a line once a person confirms it. None of
 * it spends: no quote, no model call.
 */
type MemoryCard =
  | { kind: 'forget'; phase: 'finding' | 'ready' | 'working'; subject: string; find: ForgetFind | null; picked: string[]; error: string | null }
  | { kind: 'remember'; phase: 'ready' | 'working'; text: string; memoryKind: MemoryKind; where: 'project' | 'workspace'; source: 'person' | 'atomik'; origin: string | null; fromRequest: boolean; error: string | null };

const memoryFailure = (error: unknown, fallback: string) => (error instanceof Error && error.message && error.message !== 'Failed to fetch' ? error.message : fallback);

function AgentMemoryCard({ card, setCard, api, projectId, onDone }: {
  card: MemoryCard; setCard: (next: MemoryCard | null) => void; api: MemoryApi; projectId: string | null; onDone: (said: string, fromRequest: boolean) => void;
}) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => { box.current?.scrollIntoView?.({ block: 'nearest' }); }, [card.kind]);
  if (card.kind === 'forget') {
    const find = card.find;
    const run = async () => {
      setCard({ ...card, phase: 'working', error: null });
      try {
        const n = await api.forget(card.picked);
        onDone(`Forgot ${n} ${n === 1 ? 'entry' : 'entries'}. A copy of each stays in the workspace archive.`, true);
      } catch (error) { setCard({ ...card, phase: 'ready', error: memoryFailure(error, 'Those entries could not be forgotten. Try again.') }); }
    };
    const retry = async () => {
      setCard({ ...card, phase: 'finding', error: null });
      try { const found = await api.find(`forget ${card.subject}`, projectId); setCard({ ...card, phase: 'ready', find: found, picked: found.matches.filter(m => m.selected).map(m => m.id), error: null }); }
      catch (error) { setCard({ ...card, phase: 'ready', find: null, error: memoryFailure(error, 'Memory could not be read.') }); }
    };
    return <section ref={box} className={styles.memoryCard} aria-label="Forget from memory" data-testid="agent-forget">
      <strong>Forget “{card.subject}”</strong>
      {card.phase === 'finding' ? <p role="status">Looking through memory…</p>
        : !find ? null
        : find.matches.length ? <>
          <p>Choose what Atomik should forget. A copy of each stays in the workspace archive.</p>
          <div className={styles.memoryPicks}>{find.matches.map(match => <label key={match.id} className={styles.memoryPick} data-testid="agent-forget-match">
            <input type="checkbox" checked={card.picked.includes(match.id)} disabled={card.phase === 'working'} onChange={event => setCard({ ...card, picked: event.target.checked ? [...card.picked, match.id] : card.picked.filter(id => id !== match.id) })} />
            <span><em>{MEMORY_KIND_LABEL[match.kind]}{match.scope === 'project' ? ' · this project' : ''}</em>{match.assetLabel ? ` ${match.assetLabel}` : ''}{match.text ? ` ${match.text}` : ''}</span>
          </label>)}</div>
        </> : <p data-testid="agent-forget-none">Nothing in memory matches “{find.subject}”.</p>}
      {card.error ? <p className={styles.error} role="alert" data-testid="agent-memory-error">{card.error}</p> : null}
      <div className={styles.memoryActions}>
        {card.error && !find ? <button type="button" className={styles.secondary} onClick={() => void retry()}>Try again</button> : null}
        {find?.matches.length ? <button type="button" className={styles.primary} disabled={!card.picked.length || card.phase === 'working'} onClick={() => void run()} data-testid="agent-forget-confirm">{card.phase === 'working' ? 'Forgetting…' : `Forget ${card.picked.length || ''}`.trim()}</button> : null}
        <button type="button" className={styles.secondary} disabled={card.phase === 'working'} onClick={() => setCard(null)} data-testid="agent-memory-cancel">{find && !find.matches.length ? 'Close' : 'Cancel'}</button>
      </div>
    </section>;
  }
  const money = mentionsMoney(card.text);
  const where = projectId ? card.where : 'workspace';
  const save = async () => {
    setCard({ ...card, phase: 'working', error: null });
    try {
      await api.add({ kind: card.memoryKind, text: card.text, projectId: where === 'project' ? projectId : null, source: card.source, origin: card.origin });
      onDone('Atomik will remember that.', card.fromRequest);
    } catch (error) { setCard({ ...card, phase: 'ready', error: memoryFailure(error, 'That could not be saved. Try again.') }); }
  };
  return <section ref={box} className={styles.memoryCard} aria-label="Remember" data-testid="agent-remember">
    <strong>{card.source === 'atomik' ? 'Keep what Atomik assumed' : 'Remember'}</strong>
    <div className={styles.memoryChips} role="group" aria-label="What it is">{TEXT_KINDS.map(kind => <button key={kind} type="button" className={styles.memoryChip} aria-pressed={card.memoryKind === kind} onClick={() => setCard({ ...card, memoryKind: kind })} data-testid={`agent-remember-kind-${kind}`}>{MEMORY_KIND_LABEL[kind]}</button>)}</div>
    <label className={styles.label}>What Atomik should remember<textarea rows={3} maxLength={MEMORY_LIMITS.text} value={card.text} disabled={card.phase === 'working'} onChange={event => setCard({ ...card, text: event.target.value, error: null })} data-testid="agent-remember-text" /></label>
    <div className={styles.memoryChips} role="group" aria-label="Where it applies">
      <button type="button" className={styles.memoryChip} aria-pressed={where === 'project'} disabled={!projectId} onClick={() => setCard({ ...card, where: 'project' })} data-testid="agent-remember-project">This project</button>
      <button type="button" className={styles.memoryChip} aria-pressed={where === 'workspace'} onClick={() => setCard({ ...card, where: 'workspace' })} data-testid="agent-remember-workspace">Whole workspace</button>
    </div>
    {money ? <p className={styles.error} role="alert">{MONEY_REFUSAL}</p> : null}
    {card.error ? <p className={styles.error} role="alert" data-testid="agent-memory-error">{card.error}</p> : null}
    <div className={styles.memoryActions}>
      <button type="button" className={styles.primary} disabled={money || card.text.trim().length < 2 || card.phase === 'working'} onClick={() => void save()} data-testid="agent-remember-save">{card.phase === 'working' ? 'Saving…' : 'Remember'}</button>
      <button type="button" className={styles.secondary} disabled={card.phase === 'working'} onClick={() => setCard(null)} data-testid="agent-memory-cancel">Cancel</button>
    </div>
  </section>;
}

export function SuiteAgentPanel({ suite, project, scope, enabled = true, onSave, onApply, onQueued }: {
  suite: SuiteId; project: Project; scope?: string; enabled?: boolean;
  onSave?: () => Promise<boolean>; onApply?: (plan: Plan) => void; onQueued?: () => void;
}) {
  const session = useSession();
  const requestScope = scope ?? session.requestScope;
  const [open, setOpen] = useState(false);
  const draft = useAgentDraft(requestScope, suite, project.id);
  const active = enabled && !!requestScope && !!project.productionProjectId;
  const state = useAgentState(requestScope, project.id, active);
  const copy = SUITE_AGENT_COPY[suite];
  const models = state.data?.models.filter(model => /^(anthropic|openai)\//.test(model.id)) ?? [];
  const configured = !!state.data?.configured && models.length > 0;
  /* The request box takes media: pictures and text files are filed on the project and selected as references (the agent reads them). */
  const editor = useDraftEditor(requestScope ?? '', project.id);
  const current = editor.project ?? project;
  const attach = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(requestScope ?? '', attached);
    const fit = media.filter(m => m.kind === 'image' || (m.kind === 'file' && m.mime.startsWith('text/')));
    const made = fit.map(m => current.assets.find(a => a.id === m.id || a.generationId === m.id || a.uploadId === m.id) ?? attachedAsset(m, 'Reference', 'Attached for Atomik'));
    if (made.length) {
      editor.change(old => ({ ...old, assets: [...old.assets, ...made.filter(a => !old.assets.some(x => x.id === a.id))] }));
      await editor.ensureSaved();
      draft.set({ ...draft.value, refs: [...new Set([...draft.value.refs, ...made.map(a => a.id)])].slice(0, 12) });
    }
    return [made.length ? `${made.map(a => a.name).join(', ')} ${made.length === 1 ? 'is' : 'are'} selected as project references.` : '', keptNote([...unreadable, ...media.filter(m => !fit.includes(m)).map(m => m.name)], 'the agent reads pictures and text files here; select a video under Project references once its frames are prepared.') ?? ''].filter(Boolean).join(' ') || null;
  };
  const assets = [...current.assets, ...(current.sharedAssets ?? [])].filter((asset, index, all) =>
    ['image', 'video', 'document'].includes(asset.kind) && all.findIndex(item => item.id === asset.id) === index);
  const selected = draft.value.refs.filter(id => assets.some(asset => asset.id === id));
  const jobs = state.data?.jobs.filter(job => job.suite === suite || job.plan?.suiteAgent?.suite === suite || (!job.plan && job.request.startsWith(`[${suite}]`))) ?? [];
  const live = state.data?.jobs.some(job => ['queued', 'running'].includes(job.status)) ?? false;
  /* Memory is kept against the production, which the whole team shares. */
  const memoryProject = project.productionProjectId ?? null;
  const memory = useMemoryApi(requestScope);
  const [memoryCard, setMemoryCard] = useState<MemoryCard | null>(null);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const command = parseMemoryCommand(draft.value.request);
  const openCommand = async () => {
    if (!command) return;
    setMemoryNote(null);
    if (command.verb === 'remember') {
      setMemoryCard({ kind: 'remember', phase: 'ready', text: command.subject, memoryKind: guessKind(command.subject), where: memoryProject ? 'project' : 'workspace', source: 'person', origin: null, fromRequest: true, error: null });
      return;
    }
    const opened: MemoryCard = { kind: 'forget', phase: 'finding', subject: command.subject, find: null, picked: [], error: null };
    setMemoryCard(opened);
    try {
      const found = await memory.find(draft.value.request, memoryProject);
      setMemoryCard(current => current?.kind === 'forget' && current.subject === opened.subject ? { ...opened, phase: 'ready', find: found, picked: found.matches.filter(m => m.selected).map(m => m.id) } : current);
    } catch (error) {
      setMemoryCard(current => current?.kind === 'forget' && current.subject === opened.subject ? { ...opened, phase: 'ready', error: memoryFailure(error, 'Memory could not be read.') } : current);
    }
  };
  const rememberLine = (text: string, source: 'person' | 'atomik', origin: string) => {
    setMemoryNote(null);
    const words = text.slice(0, MEMORY_LIMITS.text);
    setMemoryCard({ kind: 'remember', phase: 'ready', text: words, memoryKind: guessKind(words), where: memoryProject ? 'project' : 'workspace', source, origin, fromRequest: false, error: null });
  };
  const memoryDone = (said: string, fromRequest: boolean) => {
    setMemoryCard(null);
    setMemoryNote(said);
    if (fromRequest) draft.set({ ...draft.value, request: '' });
  };
  return <section className={styles.panel} aria-label={copy.title}>
    <header className={styles.heading}><div><span className={styles.eyebrow}><Sparkles size={14} /> {suite === 'moleculr' ? 'Atomik / Brand strategy' : suite === 'particl' ? 'Atomik / Production' : 'Atomik Agent'}</span><h2>{copy.title}</h2><p>Inspect context, develop the direction, then prepare editable production nodes.</p></div><button className={styles.iconButton} aria-label="Refresh agent proposals" onClick={() => void state.refresh()} disabled={!active}><RefreshCw size={16} /></button></header>
    <label className={styles.label}>Creative request<PromptAttach scope={requestScope ?? ""} projectId={project.id} onAttach={attach} testId="atomik-attach"><textarea rows={3} maxLength={11000} placeholder={copy.placeholder} value={draft.value.request} disabled={!active || live} onChange={event => draft.set({ ...draft.value, request: event.target.value })} /></PromptAttach></label>
    {!!assets.length && <details className={styles.references}><summary>Project references <span>{selected.length} selected</span></summary><div>{assets.map(asset => <label key={asset.id}><input type="checkbox" disabled={!active || live} checked={selected.includes(asset.id)} onChange={event => draft.set({ ...draft.value, refs: event.target.checked ? [...selected, asset.id].slice(0, 12) : selected.filter(id => id !== asset.id) })} /><span>{asset.name}</span><small>{asset.kind}</small></label>)}</div><p>Up to six visual samples: each video uses three. Only selected references are sent to the agent.</p></details>}
    <footer className={styles.footer}><span>Thinking model and effort selected with the quote</span>{command && active ? <button type="button" className={`${styles.secondary} ${styles.memoryCommand}`} disabled={memoryCard?.phase === 'working'} onClick={() => void openCommand()} data-testid="agent-memory-command">{command.verb === 'forget' ? 'Forget from memory…' : 'Remember this…'}</button> : null}<button className={styles.primary} disabled={!active || !configured || live || draft.value.request.trim().length < 3} onClick={() => setOpen(true)}>{live ? 'Agent working…' : 'Review agent quote'} <ArrowUpRight size={15} /></button></footer>
    {memoryNote ? <p className={styles.memoryNote} role="status" data-testid="agent-memory-note">{memoryNote}</p> : null}
    {memoryCard && active ? <AgentMemoryCard card={memoryCard} setCard={setMemoryCard} api={memory} projectId={memoryProject} onDone={memoryDone} /> : null}
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {active && state.data && !configured && <p className={styles.error}>Connect a priced thinking model in Workspace → Engines.</p>}
    {!!jobs.length && <div className={styles.results}>{jobs.slice(0, 5).map(job => {
      const plan = job.plan, proposal = plan?.suiteAgent;
      const applied = plan?.applied || project.plans.some(item => item.id === plan?.id && item.applied);
      return <article key={job.id} className={styles.result}>
        <div className={styles.resultHeader}><strong>{job.status === 'succeeded' ? 'Production proposal' : job.status === 'queued' || job.status === 'running' ? 'Inspecting and developing…' : 'Attempt needs review'}</strong><span>{job.credits != null ? `${job.credits} cr` : `${job.estimateCredits} cr reserved`}</span></div>
        {job.error && <p role="alert" className={styles.error}>{job.error}</p>}
        {plan && <><p className={styles.summary}>{plan.summary}</p>{active ? <button type="button" className={styles.memoryButton} onClick={() => rememberLine(plan.summary, 'person', job.id)} data-testid="agent-remember-summary">Remember this</button> : null}<ol className={styles.steps}>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          {proposal && <><div className={styles.actionGrid}>{proposal.actions.map((action, index) => <details key={index}><summary><span>{action.kind}</span><strong>{action.title}</strong></summary><p>{action.prompt}</p><small>{action.referenceIds.length} project reference{action.referenceIds.length === 1 ? '' : 's'}</small></details>)}</div>
            {!!proposal.assumptions.length && <details className={styles.assumptions}><summary>Assumptions to review</summary><ul>{proposal.assumptions.map((value, index) => <li key={index}><span>{value}</span>{active ? <button type="button" className={styles.memoryButton} onClick={() => rememberLine(value, 'atomik', job.id)} aria-label={`Remember: ${value}`} data-testid="agent-remember-assumption">Remember</button> : null}</li>)}</ul></details>}
            {!!proposal.hooks.length && <div className={styles.hooks}>{proposal.hooks.map(hook => <span key={hook}>{hook}</span>)}</div>}
            <footer className={styles.footer}><span>Adding nodes is free. Rendering has a separate quote.</span>{onApply ? <button className={styles.primary} disabled={!enabled || applied} onClick={() => onApply(plan)}>{applied ? 'Added to Rig' : `Add ${proposal.actions.length} actions to Rig`}</button> : <Link href={`${suiteHref('particl', project.id, 'canvas')}&atomik=open`} className={styles.primary}>Review in production <ArrowUpRight size={15} /></Link>}</footer>
          </>}
        </>}
      </article>;
    })}</div>}
    {open && active && requestScope && <AtomikRunDialog key={`${requestScope}:${project.id}`} scope={requestScope} project={project} models={models}
      target={{ suite, request: `[${suite}] ${draft.value.request}`, role: suite === 'moleculr' ? 'marketing' : 'director', model: 'auto', effort: 'auto', depth: 'Deep', refs: selected }}
      onSave={onSave ?? (async () => true)} onClose={() => setOpen(false)} onQueued={() => { setOpen(false); void state.refresh(); onQueued?.(); }} />}
  </section>;
}
