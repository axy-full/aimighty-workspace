'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDraftEditor } from '@/lib/workspace/use-draft-editor';
import { PromptAttach, attachedAsset, keptNote, resolveAttached, type Attached } from '@/components/PromptAttach';
import Link from 'next/link';
import { ArrowUpRight, Sparkles, RefreshCw } from 'lucide-react';
import { useSession } from '@/lib/session';
import { suiteHref, type SuiteId } from '@/lib/suites';
import { SUITE_AGENT_COPY } from '@/lib/workbench/suite-agent-plan';
import type { Plan, Project } from '@/lib/workbench/studio';
import type { AtomikJob } from '@/lib/workbench/atomik-server';
import { AtomikRunDialog } from '@/components/workbench/AtomikRunDialog';
import type { ThinkingModel } from '@/components/atomik/ModelPicker';
import styles from './suite-agent.module.css';

type AgentState = { configured: boolean; models: ThinkingModel[]; jobs: AtomikJob[] };
type AgentDraft = { request: string; refs: string[] };
const draftEvent = 'particl-suite-agent-draft';
const subscribeDraft = (listener: () => void) => {
  window.addEventListener('storage', listener); window.addEventListener(draftEvent, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(draftEvent, listener); };
};
const emptySnapshot = () => null;

const draftKey = (scope: string | null | undefined, suite: SuiteId, projectId: string) =>
  scope ? `aw_draft:suite-agent:${encodeURIComponent(scope)}:${suite}:${encodeURIComponent(projectId)}` : null;

/**
 * Hand a request to this suite's agent box from elsewhere (the Suites ⌘K
 * "Ask Atomik: …"): it lands in the same draft the box edits, keeping the
 * references already selected, and an open box shows it at once. Nothing is
 * sent — the person still reads it and presses Plan.
 */
export function prefillAgentRequest(scope: string | null | undefined, suite: SuiteId, projectId: string, request: string): boolean {
  const key = draftKey(scope, suite, projectId);
  const text = request.trim().slice(0, 11000);
  if (!key || !text) return false;
  try {
    let refs: string[] = [];
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (parsed && Array.isArray(parsed.refs)) refs = parsed.refs.filter((id: unknown): id is string => typeof id === 'string').slice(0, 12);
    localStorage.setItem(key, JSON.stringify({ request: text, refs }));
    window.dispatchEvent(new Event(draftEvent));
    return true;
  } catch { return false; }
}

/** Workbench owns its authenticated scope without a SessionProvider. Keep its
 * drafts and responses bound to that captured identity, just like Studio saves. */
function useAgentDraft(scope: string | null | undefined, suite: SuiteId, projectId: string) {
  const key = draftKey(scope, suite, projectId);
  const read = useCallback(() => { try { return key ? localStorage.getItem(key) : null; } catch { return null; } }, [key]);
  const stored = useSyncExternalStore(subscribeDraft, read, emptySnapshot);
  const [edit, setEdit] = useState<{ key: string | null; value: AgentDraft } | null>(null);
  let value: AgentDraft = { request: '', refs: [] };
  try {
    const parsed = JSON.parse(stored ?? 'null');
    if (parsed && typeof parsed.request === 'string' && Array.isArray(parsed.refs)) value = {
      request: parsed.request.slice(0, 11000), refs: parsed.refs.filter((id: unknown): id is string => typeof id === 'string').slice(0, 12),
    };
  } catch { /* An unreadable creative draft is not a paid recovery record. */ }
  if (edit?.key === key) value = edit.value;
  return { value, set(next: AgentDraft) {
    setEdit({ key, value: next });
    if (key) try { localStorage.setItem(key, JSON.stringify(next)); window.dispatchEvent(new Event(draftEvent)); } catch { /* The current editor still works without draft storage. */ }
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
      if (!response.ok) throw new Error(value.error || 'Agent proposals could not be loaded.');
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
  return <section className={styles.panel} aria-label={copy.title}>
    <header className={styles.heading}><div><span className={styles.eyebrow}><Sparkles size={14} /> {suite === 'moleculr' ? 'Atomik / Brand strategy' : suite === 'particl' ? 'Atomik / Production' : 'Atomik Super Agent'}</span><h2>{copy.title}</h2><p>Inspect context, develop the direction, then prepare editable production nodes.</p></div><button className={styles.iconButton} aria-label="Refresh agent proposals" onClick={() => void state.refresh()} disabled={!active}><RefreshCw size={16} /></button></header>
    <label className={styles.label}>Creative request<PromptAttach scope={requestScope ?? ""} projectId={project.id} onAttach={attach} testId="atomik-attach"><textarea rows={3} maxLength={11000} placeholder={copy.placeholder} value={draft.value.request} disabled={!active || live} onChange={event => draft.set({ ...draft.value, request: event.target.value })} /></PromptAttach></label>
    {!!assets.length && <details className={styles.references}><summary>Project references <span>{selected.length} selected</span></summary><div>{assets.map(asset => <label key={asset.id}><input type="checkbox" disabled={!active || live} checked={selected.includes(asset.id)} onChange={event => draft.set({ ...draft.value, refs: event.target.checked ? [...selected, asset.id].slice(0, 12) : selected.filter(id => id !== asset.id) })} /><span>{asset.name}</span><small>{asset.kind}</small></label>)}</div><p>Up to six visual samples: each video uses three. Only selected references are sent to the agent.</p></details>}
    <footer className={styles.footer}><span>Thinking model and effort selected with the quote</span><button className={styles.primary} disabled={!active || !configured || live || draft.value.request.trim().length < 3} onClick={() => setOpen(true)}>{live ? 'Agent working…' : 'Review agent quote'} <ArrowUpRight size={15} /></button></footer>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {active && state.data && !configured && <p className={styles.error}>Connect a priced thinking model in Workspace → Engines.</p>}
    {!!jobs.length && <div className={styles.results}>{jobs.slice(0, 5).map(job => {
      const plan = job.plan, proposal = plan?.suiteAgent;
      const applied = plan?.applied || project.plans.some(item => item.id === plan?.id && item.applied);
      return <article key={job.id} className={styles.result}>
        <div className={styles.resultHeader}><strong>{job.status === 'succeeded' ? 'Production proposal' : job.status === 'queued' || job.status === 'running' ? 'Inspecting and developing…' : 'Attempt needs review'}</strong><span>{job.credits != null ? `${job.credits} cr` : `${job.estimateCredits} cr reserved`}</span></div>
        {job.error && <p role="alert" className={styles.error}>{job.error}</p>}
        {plan && <><p className={styles.summary}>{plan.summary}</p><ol className={styles.steps}>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          {proposal && <><div className={styles.actionGrid}>{proposal.actions.map((action, index) => <details key={index}><summary><span>{action.kind}</span><strong>{action.title}</strong></summary><p>{action.prompt}</p><small>{action.referenceIds.length} project reference{action.referenceIds.length === 1 ? '' : 's'}</small></details>)}</div>
            {!!proposal.assumptions.length && <details className={styles.assumptions}><summary>Assumptions to review</summary><ul>{proposal.assumptions.map((value, index) => <li key={index}>{value}</li>)}</ul></details>}
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
