'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentAttachments } from '@/components/graphite/production/use-agent-attachments';
import { PromptAttach } from '@/components/PromptAttach';
import { ArrowRight, Download, RefreshCw, Sparkles } from 'lucide-react';
import { ModelPicker, EffortPicker, thinkingModelName, effortLabel, type ThinkingModel } from '@/components/atomik/ModelPicker';
import type { Project } from '@/lib/workbench/studio';
import { sourceCanonical, type DevelopmentJob, type DevelopmentKind, type DevelopmentQuote, type DevelopmentRequest, type DevelopmentState } from '@/lib/workbench/development-types';
import { clearDevelopment, developmentInput, developmentSourceHash, readDevelopment, recordDevelopment, withDevelopmentLock, type PendingDevelopment } from '@/lib/workbench/development-client';
import { studioRequest } from './GenerationDialog';
import styles from './development-panel.module.css';

type ApplyChoice = { idea: number } | { scenes: string[] };
const endpoint = '/api/workbench/development';
const statusLabel = { queued: 'Queued', running: 'Developing', succeeded: 'Complete', failed: 'Needs attention', uncertain: 'Unconfirmed' };
const stageLabel = { draft: 'Drafting', critique: 'Reviewing', refine: 'Refining', complete: 'Complete' };
const kindLabel = (kind: DevelopmentKind) => kind === 'idea' ? 'Idea development' : kind === 'adfilm' ? 'Ad-film breakdown' : 'Screenplay breakdown';
export function DevelopmentPanel({ project, kind, scope, enabled, models: connectedModels, onSave, onApply, change }: {
  project: Project; kind: DevelopmentKind; scope: string; enabled: boolean; models: ThinkingModel[];
  onSave: () => Promise<boolean>; onApply: (job: DevelopmentJob, choice: ApplyChoice) => Promise<void>;
  /** When given, the instructions box takes pictures and text files the agent sees (owner, 25 September). */
  change?: (fn: (p: Project) => Project) => void;
}) {
  const [provider, setProvider] = useState('anthropic');
  const [pickedModel, setPickedModel] = useState('');
  const [effort, setEffort] = useState('auto');
  const [instructions, setInstructions] = useState('');
  const attach = useAgentAttachments({ scope, project, change: change ?? (() => {}), save: onSave });
  const [state, setState] = useState<DevelopmentState | null>(null);
  const [resultPages, setResultPages] = useState<Record<string, DevelopmentJob>>({});
  const [quote, setQuote] = useState<{ value: DevelopmentQuote; input: DevelopmentRequest } | null>(null);
  const [pending, setPending] = useState<PendingDevelopment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [identity, setIdentity] = useState({ canonical: '', hash: '' });
  const callbacks = useRef({ onSave, onApply });
  const active = useRef(true), pollBusy = useRef(false), requestEpoch = useRef(0);
  const canonical = useMemo(() => sourceCanonical(project, kind), [project, kind]);
  const currentCanonical = useRef(canonical);
  useEffect(() => { callbacks.current = { onSave, onApply }; currentCanonical.current = canonical; }, [onSave, onApply, canonical]);
  const headers = { 'Content-Type': 'application/json', 'X-Workbench-Scope': scope };
  const models = (state?.models ?? connectedModels).filter(model => model.id.startsWith(provider + '/'));
  const model = models.find(value => value.id === pickedModel)?.id ?? [...models].sort((a, b) => ((b as ThinkingModel).released ?? 0) - ((a as ThinkingModel).released ?? 0))[0]?.id ?? '';
  const selectedModel = models.find(value => value.id === model);
  const sourceHash = identity.canonical === canonical ? identity.hash : '';
  const shownQuote = quote && quote.value.sourceHash === sourceHash && quote.input.kind === kind && quote.input.model === model && quote.input.effort === effort && quote.input.instructions === instructions && JSON.stringify(quote.input.attachmentAssetIds ?? []) === JSON.stringify(attach.ids) ? quote : null;
  const runs = state?.jobs.filter(job => job.kind === kind).map(job => resultPages[job.id] ?? job) ?? [];
  const running = state?.jobs.some(job => job.status === 'queued' || job.status === 'running');
  const completeSource = kind === 'idea' ? !!project.brief.trim() : !!project.script?.trim();

  useEffect(() => {
    let alive = true;
    void developmentSourceHash(project, kind).then(hash => { if (alive) setIdentity({ canonical, hash }); }).catch(() => { if (alive) setError('This browser cannot verify the source. Use a secure browser connection.'); });
    return () => { alive = false; };
    // Identity is deliberately driven by canonical source, not canvas or UI changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical, kind]);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const requestHeaders = { 'X-Workbench-Scope': scope };
    async function refresh() {
      if (!enabled || pollBusy.current) return;
      pollBusy.current = true;
      try {
        const epoch = requestEpoch.current;
        let record: PendingDevelopment | null = null;
        let storageFailure = '';
        try { record = readDevelopment(window.localStorage, scope, project.id); }
        catch (cause) { storageFailure = cause instanceof Error ? cause.message : 'Recovery storage is unavailable. Saved runs can still be reviewed.'; }
        const query = new URLSearchParams({ projectId: project.id });
        if (record) query.set('requestId', developmentInput(record).requestId);
        const next = await studioRequest<DevelopmentState>(`${endpoint}?${query}`, { headers: requestHeaders });
        if (cancelled || epoch !== requestEpoch.current) return;
        if (!storageFailure && readDevelopment(window.localStorage, scope, project.id)?.body !== record?.body) return;
        setState(next); setLoaded(!storageFailure); setPending(record);
        if (storageFailure) setError(storageFailure + ' Saved runs are shown below; new paid requests remain paused.');
        const accepted = record && next.jobs.find(job => job.requestId === developmentInput(record).requestId);
        if (record && accepted) {
          clearDevelopment(window.localStorage, record, accepted.requestId); setPending(null);
        }
        const queued = next.jobs.find(job => job.status === 'queued');
        if (queued) {
          await studioRequest(endpoint, { method: 'POST', headers: { ...requestHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ resume: true, projectId: project.id, jobId: queued.id }) });
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Development history could not be loaded.');
      } finally { pollBusy.current = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => { cancelled = true; active.current = false; clearInterval(timer); };
  }, [enabled, project.id, scope]);

  async function review() {
    if (busy || !sourceHash || !model || !completeSource || pending || running) return;
    setBusy('Estimating…'); setError(''); setQuote(null);
    try {
      const snapshot = canonical;
      if (!(await callbacks.current.onSave())) throw new Error('Save this project before requesting a development estimate.');
      if (currentCanonical.current !== snapshot) throw new Error('The source changed while saving. Review the estimate again.');
      const input: DevelopmentRequest = { projectId: project.id, requestId: crypto.randomUUID(), kind, model, effort, instructions, ...attach.input };
      const value = await studioRequest<DevelopmentQuote>(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...input, quoteOnly: true }) });
      if (!active.current) return;
      if (currentCanonical.current !== snapshot || value.sourceHash !== sourceHash) throw new Error('The saved source changed. Review its latest version and request a fresh estimate.');
      setQuote({ value, input });
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'The estimate could not be loaded.'); }
    finally { if (active.current) setBusy(''); }
  }
  async function lookup(record: PendingDevelopment) {
    const query = new URLSearchParams({ projectId: project.id, requestId: developmentInput(record).requestId });
    return studioRequest<DevelopmentState>(`${endpoint}?${query}`, { headers });
  }
  function accept(record: PendingDevelopment, job: DevelopmentJob) {
    if (job.requestId !== developmentInput(record).requestId) throw new Error('The server returned another request. The original recovery record is preserved.');
    clearDevelopment(window.localStorage, record, job.requestId);
    if (!active.current) return;
    setPending(null); setQuote(null);
    setState(old => ({ configured: old?.configured ?? true, models: old?.models ?? [], jobs: [job, ...(old?.jobs ?? []).filter(value => value.id !== job.id)] }));
    if (job.error) setError(job.error);
  }
  async function submit() {
    if (busy || !loaded || (!pending && !shownQuote)) return;
    requestEpoch.current++;
    setBusy(pending ? 'Recovering…' : 'Starting…'); setError('');
    try {
      await withDevelopmentLock(scope, project.id, async () => {
        const record = pending ?? recordDevelopment(window.localStorage, scope, project.id, JSON.stringify({ ...shownQuote!.input, sourceHash: shownQuote!.value.sourceHash, maxCredits: shownQuote!.value.estimateCredits, ...(shownQuote!.value.estimateUsd == null ? {} : { maxUsd: shownQuote!.value.estimateUsd }) }));
        if (active.current) setPending(record);
        if (pending) {
          const next = await lookup(record), known = next.jobs.find(job => job.requestId === developmentInput(record).requestId);
          if (known) { accept(record, known); return; }
        }
        try {
          const next = await studioRequest<{ job: DevelopmentJob }>(endpoint, { method: 'POST', headers, body: record.body });
          accept(record, next.job);
        } catch (cause) {
          let absent = false;
          try {
            const next = await lookup(record), known = next.jobs.find(job => job.requestId === developmentInput(record).requestId);
            if (known) { accept(record, known); return; }
            absent = true;
          } catch { /* Retain exact request on ambiguous errors. */ }
          const status = Number((cause as { status?: number })?.status);
          if (absent && [400, 402, 409, 422].includes(status)) {
            clearDevelopment(window.localStorage, record, developmentInput(record).requestId);
            if (active.current) { setPending(null); setQuote(null); }
          }
          throw cause;
        }
      });
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'The request is unconfirmed. Recover the same request before starting another.'); }
    finally { requestEpoch.current++; if (active.current) setBusy(''); }
  }
  async function apply(job: DevelopmentJob, choice: ApplyChoice) {
    setBusy('Adding result…'); setError('');
    try { await callbacks.current.onApply(job, choice); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'The result could not be applied.'); }
    finally { if (active.current) setBusy(''); }
  }
  async function resultPage(job: DevelopmentJob, offset: number) {
    const query = new URLSearchParams({ projectId: project.id, jobId: job.id, offset: String(offset) });
    const next = await studioRequest<{ job: DevelopmentJob }>(`${endpoint}?${query}`, { headers });
    if (next.job.id !== job.id || next.job.projectId !== project.id || next.job.sourceHash !== job.sourceHash || next.job.resultPage?.offset !== offset || !next.job.result) throw new Error('The returned source section does not match this saved result.');
    return next.job;
  }
  async function showPage(job: DevelopmentJob, offset: number) {
    setBusy('Loading source section…'); setError('');
    try { const next = await resultPage(job, offset); if (active.current) setResultPages(old => ({ ...old, [job.id]: next })); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'This source section could not be loaded.'); }
    finally { if (active.current) setBusy(''); }
  }
  async function download(job: DevelopmentJob) {
    setBusy('Preparing complete breakdown…'); setError('');
    try {
      const results = [];
      for (let offset = 0; offset < (job.resultPage?.totalChunks ?? 1); offset++) {
        const part = job.resultPage ? await resultPage(job, offset) : job;
        if (!part.result) throw new Error('A source section is missing. No partial download was created.');
        results.push(part.result);
        if (!active.current) return;
      }
      const result = { summary: results.map(part => part.summary).join('\n\n'), recommendation: results.map(part => part.recommendation).join('\n\n'), ideas: results.flatMap(part => part.ideas), scenes: results.flatMap(part => part.scenes), critique: [...new Set(results.flatMap(part => part.critique))], assumptions: [...new Set(results.flatMap(part => part.assumptions))] };
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...job, result, resultPage: undefined }, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${job.kind}-${job.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'The complete breakdown could not be downloaded.'); }
    finally { if (active.current) setBusy(''); }
  }
  return <section className={styles.panel} aria-label={kindLabel(kind)}>
    <div className={styles.heading}><span className={styles.icon}><Sparkles size={17}/></span><div><h3>{kind === 'idea' ? 'Develop with an agent' : 'Agentic script breakdown'}</h3><p>{kind === 'idea' ? 'Explore creative routes, challenge them, then refine the strongest direction.' : 'Read the full source, draft the breakdown, critique it, then refine beats and coverage.'}</p></div></div>
    <div className={styles.providers} role="group" aria-label={`${kindLabel(kind)} provider`}>
      <button type="button" aria-pressed={provider === 'anthropic'} disabled={!!busy || !!pending} onClick={() => { setProvider('anthropic'); setPickedModel(''); setEffort('auto'); }}>Claude <small>Thinking models</small></button>
      <button type="button" aria-pressed={provider === 'openai'} disabled={!!busy || !!pending} onClick={() => { setProvider('openai'); setPickedModel(''); setEffort('auto'); }}>GPT <small>Thinking models</small></button>
    </div>
    <div className={styles.controls}>
      <div><label>Model</label><ModelPicker label={`${kindLabel(kind)} model`} value={model} models={models} allowAuto={false} disabled={!enabled || !models.length || !!busy || !!pending} onPick={value => { setPickedModel(value); setEffort('auto'); }} /></div>
      <div><label>Reasoning effort</label><EffortPicker label={`${kindLabel(kind)} effort`} model={selectedModel} value={effort} disabled={!enabled || !!busy || !!pending} onPick={setEffort}/></div>
    </div>
    <label className={styles.instructions}>Creative instructions <span>Optional</span>{change ? <PromptAttach scope={scope} projectId={project.id} onAttach={attach.onAttach} label="Attach for the agent" testId="development-attach"><textarea aria-label={`${kindLabel(kind)} instructions`} value={instructions} maxLength={4000} disabled={!!busy || !!pending} onChange={event => setInstructions(event.target.value)} placeholder={kind === 'idea' ? 'Tone, constraints, ideas to explore, or what to avoid…' : 'Coverage priorities, tone, duration, production constraints…'}/>{attach.chips}</PromptAttach> : <textarea aria-label={`${kindLabel(kind)} instructions`} value={instructions} maxLength={4000} disabled={!!busy || !!pending} onChange={event => setInstructions(event.target.value)} placeholder={kind === 'idea' ? 'Tone, constraints, ideas to explore, or what to avoid…' : 'Coverage priorities, tone, duration, production constraints…'}/>}</label>
    {!enabled && <p className={styles.hint}>Sign in and save a project to use your assistant.</p>}
    {enabled && !completeSource && <p className={styles.hint}>{kind === 'idea' ? 'Add a creative brief to begin.' : 'Upload or write a script to begin.'}</p>}
    {enabled && loaded && !models.length && <p className={styles.hint}>No connected models for this provider. Check workspace connections.</p>}
    {pending ? <div className={styles.quote}><p>An earlier {kindLabel(developmentInput(pending).kind).toLowerCase()} request is unconfirmed. Recovery uses {thinkingModelName(developmentInput(pending).model, connectedModels)} · {effortLabel(developmentInput(pending).effort, connectedModels.find(value => value.id === developmentInput(pending).model))} · up to {developmentInput(pending).maxCredits} credits. Its original source and price are preserved.</p><button type="button" className={styles.primary} disabled={!!busy} onClick={() => void submit()}><RefreshCw size={14}/>{busy || 'Recover development request'}</button></div> : shownQuote ? <div className={styles.quote}><p><strong>{shownQuote.value.chunks} source {shownQuote.value.chunks === 1 ? 'section' : 'sections'} · {shownQuote.value.calls} agent steps</strong><br/>{shownQuote.value.sourceCharacters.toLocaleString()} source characters · {thinkingModelName(model, models)}<br/>Up to {shownQuote.value.estimateCredits} credits{shownQuote.value.estimateUsd != null ? ` · $${shownQuote.value.estimateUsd.toFixed(4)} provider ceiling` : ''}</p><button type="button" className={styles.primary} disabled={!loaded || !!busy || !!running} onClick={() => void submit()}><Sparkles size={14}/>{busy || `Start ${kind === 'idea' ? 'idea development' : 'script breakdown'}`}</button></div> : <button type="button" className={styles.primary} disabled={!enabled || !loaded || !!busy || !!pending || !!running || !completeSource || !sourceHash || !model} onClick={() => void review()}><Sparkles size={14}/>{busy || (running ? 'Development in progress' : 'Review development estimate')}</button>}
    <p className={styles.hint}>Results are saved to this project. Adding a proposal to the canvas or creative direction is your choice.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!!runs.length && <div className={styles.runs}><h4>Saved development runs</h4>{runs.map((job, index) => {
      const stale = !!sourceHash && job.sourceHash !== sourceHash;
      const unapplied = job.result?.scenes.filter(scene => !project.developmentApplications?.includes(`${job.id}:scene:${scene.id}`)) ?? [];
      return <details key={job.id} open={index === 0} className={styles.run}>
        <summary><strong>{thinkingModelName(job.model, connectedModels)}</strong><span>{statusLabel[job.status]} · {new Date(job.createdAt).toLocaleString()}</span></summary>
        {(job.status === 'queued' || job.status === 'running') && <div role="status"><p>{stageLabel[job.currentStage]} · {job.completedSteps} of {job.totalSteps} agent steps · {job.completedChunks} of {job.totalChunks} source sections</p><progress value={job.completedSteps} max={job.totalSteps}/><p className={styles.hint}>You can leave this section; progress and completed steps are saved.</p></div>}
        {job.error && <p role="alert" className={styles.error}>{job.error}</p>}
        {job.result && <>
          {job.resultPage && job.resultPage.totalChunks > 1 && <div className={styles.actions} aria-label="Breakdown source pages"><button type="button" disabled={!!busy || job.resultPage.offset === 0} onClick={() => void showPage(job, job.resultPage!.offset - 1)}>Previous source section</button><span>Source section {job.resultPage.offset + 1} of {job.resultPage.totalChunks}</span><button type="button" disabled={!!busy || !job.resultPage.hasMore} onClick={() => void showPage(job, job.resultPage!.offset + 1)}>Next source section</button></div>}
          <p>{job.result.summary}</p><p>{job.result.recommendation}</p>
          {stale && <p className={styles.notice}>The source or creative brief has changed since this run. The saved result remains available; run development again before applying it.</p>}
          {job.result.ideas.map((idea, ideaIndex) => <article key={ideaIndex} className={styles.scene}><h4>{idea.title}</h4><p>{idea.logline}</p><p>{idea.treatment}</p><h5>Visual direction</h5><p>{idea.visualDirection}</p><h5>Creative review</h5><p>{idea.critique}</p><button type="button" disabled={!!busy || stale || !sourceHash || project.developmentApplications?.includes(`${job.id}:idea:${ideaIndex}`)} onClick={() => void apply(job, { idea: ideaIndex })}>Add to creative direction <ArrowRight size={14}/></button></article>)}
          {!!job.result.scenes.length && <><div className={styles.actions}><strong>{job.result.scenes.length} {job.result.scenes.length === 1 ? 'scene / sequence' : 'scenes / sequences'}</strong><button type="button" disabled={!!busy || stale || !sourceHash || !unapplied.length || project.nodes.length + unapplied.length > 250} onClick={() => void apply(job, { scenes: unapplied.map(scene => scene.id) })}>Add {unapplied.length} scene {unapplied.length === 1 ? 'node' : 'nodes'}</button></div>{job.result.scenes.map(scene => <details key={scene.id} className={styles.scene}><summary>{scene.heading}</summary><p>{scene.summary}</p><h5>Beats</h5><ol>{scene.beats.map((beat, i) => <li key={i}>{beat}</li>)}</ol><h5>Proposed coverage</h5><ol>{scene.shots.map((shot, i) => <li key={i}><strong>{shot.description}</strong><p>{shot.framing} · {shot.movement}</p><p>Lighting: {shot.lighting}<br/>Sound: {shot.sound}</p></li>)}</ol><p>Characters: {scene.characters.join(', ') || '—'}<br/>Props: {scene.props.join(', ') || '—'}<br/>Locations: {scene.locations.join(', ') || '—'}</p><ul>{scene.productionNotes.map((note, i) => <li key={i}>{note}</li>)}</ul><button type="button" disabled={!!busy || stale || !sourceHash || project.nodes.length >= 250 || !unapplied.some(value => value.id === scene.id)} onClick={() => void apply(job, { scenes: [scene.id] })}>Add scene to canvas <ArrowRight size={14}/></button></details>)}</>}
          {!!job.result.critique.length && <details><summary>Review notes</summary><ul>{job.result.critique.map((note, i) => <li key={i}>{note}</li>)}</ul></details>}
          {!!job.result.assumptions.length && <details><summary>Assumptions to check</summary><ul>{job.result.assumptions.map((note, i) => <li key={i}>{note}</li>)}</ul></details>}
          <button type="button" disabled={!!busy} onClick={() => void download(job)}><Download size={14}/>Download complete breakdown</button>
        </>}
      </details>;
    })}</div>}
  </section>;
}
