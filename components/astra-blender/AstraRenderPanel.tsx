'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, RefreshCw, Server, Square } from 'lucide-react';
import type { Project } from '@/lib/workbench/studio';
import { createAstraScene } from '@/lib/astra-blender/scene';
import { astraSceneDigest, serializeAstraScene } from '@/lib/astra-blender/proposal';
import { astraNativeDigest, serializeAstraNative, type AstraNativeSource } from '@/lib/astra-blender/native';
import type { AstraRenderSource as Source, AstraRenderRuntime as Runtime, AstraRenderArtifact as Artifact, AstraRenderJob as RenderJob, AstraRenderQuote as RenderQuote } from '@/lib/astra-blender/render-contract';
import { studioRequest, StudioRequestError } from '@/components/workbench/GenerationDialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/workbench/ui/dialog';
import { clearPendingAstraRender, persistPendingAstraRender, readPendingAstraRender, withAstraRenderLock, type PendingAstraRender } from './astra-render-recovery';
import styles from './astra-render.module.css';

const ENDPOINT = '/api/workbench/astra-blender/render';
type NativeProject = Project & { astraNative?: AstraNativeSource };
type RenderState = { runtime: Runtime; jobs: RenderJob[] };
type ReviewedQuote = { quote: RenderQuote; requestId: string; source: Source; sourceKey: string; name: string; runtime: Runtime };
const ACTIVE = new Set<RenderJob['status']>(['queued', 'starting', 'running', 'saving']);
const STATUS: Record<RenderJob['status'], string> = { queued: 'Queued', starting: 'Starting the 3D runtime', running: 'Rendering', saving: 'Saving outputs', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Needs reconciliation' };

function sourceIdentity(project: NativeProject, source: Source) {
  const scene = serializeAstraScene(project.astraBlender ?? createAstraScene('product'));
  return source === 'native' ? JSON.stringify([scene, serializeAstraNative(project.astraNative)]) : scene;
}
function safeArtifact(artifact: Artifact) { return /^\/api\/uploads\/[A-Za-z0-9_-]+(?:\?download=1)?$/.test(artifact.url) ? artifact.url : null; }
function artifactName(kind: Artifact['kind']) { return kind === 'preview' ? 'PNG' : kind === 'blend' ? '.blend' : 'GLB'; }
function dateLabel(value: number | string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Saved run';
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The native render request could not be completed.'; }
function verifyHistory(value: RenderState) {
  if (!value || !Array.isArray(value.jobs) || !value.runtime || typeof value.runtime.configured !== 'boolean') throw new Error('The native render status could not be read. Refresh render history.');
  return value;
}

export function AstraRenderPanel({ project, scope, enabled, onSave, onRefreshProject }: {
  project: NativeProject;
  scope: string;
  enabled: boolean;
  onSave: () => Promise<boolean>;
  onRefreshProject?: () => Promise<void>;
}) {
  const [source, setSource] = useState<Source>(project.astraNative ? 'native' : 'scene');
  const [state, setState] = useState<RenderState | null>(null);
  const [pending, setPending] = useState<PendingAstraRender | null>(null);
  const [quote, setQuote] = useState<ReviewedQuote | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  /* A failed history poll is its own message: the next good poll clears it, without touching an action's error. */
  const [pollError, setPollError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const latest = useRef({ project, onSave, onRefreshProject });
  useEffect(() => { latest.current = { project, onSave, onRefreshProject }; }, [project, onSave, onRefreshProject]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = enabled && !!project.productionProjectId;
  const headers = useCallback(() => ({ 'X-Workbench-Scope': scope, 'Content-Type': 'application/json' }), [scope]);

  const refresh = useCallback(async () => {
    if (!active) return;
    const own = ++sequence.current;
    let saved: PendingAstraRender | null = null;
    try { saved = readPendingAstraRender(localStorage, scope, project.id); if (mounted.current) { setStorageError(''); setPending(saved); } }
    catch (problem) { if (mounted.current) setStorageError(message(problem)); }
    try {
      const result = verifyHistory(await studioRequest<RenderState>(`${ENDPOINT}?${new URLSearchParams({ projectId: project.id })}`, { headers: headers() }));
      if (!mounted.current || own !== sequence.current) return;
      if (saved && result.jobs.some((job) => job.requestId === saved!.requestId)) {
        clearPendingAstraRender(localStorage, scope, project.id, saved);
        saved = null;
      }
      setState(result);
      setPending(saved);
      setPollError('');
    } catch (problem) { if (mounted.current && own === sequence.current) setPollError(message(problem)); }
  }, [active, scope, project.id, headers]);

  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, quote.quote.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);

  const lookup = async (record: PendingAstraRender) => {
    const result = verifyHistory(await studioRequest<RenderState>(`${ENDPOINT}?${new URLSearchParams({ projectId: record.projectId, requestId: record.requestId })}`, { headers: headers() }));
    return result.jobs.find((job) => job.requestId === record.requestId);
  };
  const accept = (record: PendingAstraRender, job: RenderJob) => {
    const input = JSON.parse(record.body);
    if (job.requestId !== record.requestId || job.projectId !== record.projectId || job.source !== input.source || job.sourceDigest !== input.sourceDigest) throw new Error('The server returned another render. The original recovery record is preserved.');
    clearPendingAstraRender(localStorage, scope, project.id, record);
    if (mounted.current) { setPending(null); setQuote(null); setError(''); setState((previous) => previous ? { ...previous, jobs: [job, ...previous.jobs.filter((item) => item.id !== job.id)] } : previous); }
  };
  async function review() {
    if (submitting.current || busy) return;
    setBusy(true); setError('');
    try {
      const saved = readPendingAstraRender(localStorage, scope, project.id);
      if (saved) { setPending(saved); throw new Error('Recover the previous render request before requesting another quote.'); }
      if (source === 'native' && !project.astraNative) throw new Error('Review and apply a native 3D proposal before rendering native code.');
      const sourceKey = sourceIdentity(project, source);
      if (!(await latest.current.onSave())) throw new Error('Save this project before reviewing a native render quote.');
      if (!mounted.current) return;
      if (sourceKey !== sourceIdentity(latest.current.project, source)) throw new Error('The source changed while saving. Review a quote for the latest source.');
      const sourceDigest = source === 'native' ? await astraNativeDigest(project.astraNative) : await astraSceneDigest(project.astraBlender ?? createAstraScene('product'));
      const requestId = crypto.randomUUID();
      const result = await studioRequest<{ quote: RenderQuote; runtime: Runtime }>(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ projectId: project.id, requestId, source, sourceDigest, quoteOnly: true }) });
      if (!mounted.current) return;
      if (!result.runtime.configured || result.quote.sourceDigest !== sourceDigest || !Number.isFinite(result.quote.estimateCredits) || result.quote.estimateCredits < 0 || !/^[a-f0-9]{64}$/.test(result.quote.quoteDigest) || !Number.isFinite(result.quote.expiresAt)) throw new Error('The render quote could not be verified. Refresh and review another quote.');
      setExpired(false);
      setQuote({ ...result, requestId, source, sourceKey, name: source === 'native' ? project.astraNative!.name : (project.astraBlender ?? createAstraScene('product')).name });
    } catch (problem) { if (mounted.current) setError(message(problem)); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function submit(recovery?: PendingAstraRender) {
    if (submitting.current || busy || !recovery && !quote) return;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      await withAstraRenderLock(scope, project.id, async () => {
        if (!mounted.current) return;
        if (!recovery && quote) {
          if (quote.quote.expiresAt <= Date.now()) throw new Error('The render quote expired. Review a new quote.');
          if (quote.sourceKey !== sourceIdentity(latest.current.project, quote.source)) throw new Error('The source changed after this quote. Review a new quote before rendering.');
          if (!(await latest.current.onSave())) throw new Error('Save the quoted source before starting the render.');
          if (quote.sourceKey !== sourceIdentity(latest.current.project, quote.source)) throw new Error('The source changed while saving. Review a new quote before rendering.');
        }
        const body = recovery?.body ?? JSON.stringify({ projectId: project.id, requestId: quote!.requestId, source: quote!.source, sourceDigest: quote!.quote.sourceDigest, quoteOnly: false, quoteDigest: quote!.quote.quoteDigest, maxCredits: quote!.quote.estimateCredits });
        const record = persistPendingAstraRender(localStorage, scope, project.id, body);
        if (mounted.current) setPending(record);
        if (recovery) { const known = await lookup(record); if (known) { accept(record, known); return; } }
        try {
          const result = await studioRequest<{ job: RenderJob }>(ENDPOINT, { method: 'POST', headers: headers(), body: record.body });
          accept(record, result.job);
        } catch (problem) {
          let missing = false;
          try { const known = await lookup(record); if (known) { accept(record, known); return; } missing = true; }
          catch { /* An uncertain lookup keeps the durable request unchanged. */ }
          if (missing && problem instanceof StudioRequestError && [400, 402, 409, 422, 503].includes(problem.status)) {
            clearPendingAstraRender(localStorage, scope, project.id, record);
            if (mounted.current) { setPending(null); setQuote(null); }
          }
          throw problem;
        }
      });
    } catch (problem) { if (mounted.current) setError(message(problem)); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); void refresh(); }
  }

  async function cancel(job: RenderJob) {
    if (cancelId) return;
    setCancelId(job.id); setError('');
    try {
      const result = await studioRequest<{ job: RenderJob }>(ENDPOINT, { method: 'PATCH', headers: headers(), body: JSON.stringify({ projectId: project.id, jobId: job.id, action: 'cancel' }) });
      if (mounted.current) setState((previous) => previous ? { ...previous, jobs: previous.jobs.map((item) => item.id === job.id ? result.job : item) } : previous);
    } catch (problem) { if (mounted.current) setError(`Cancellation could not be confirmed. ${message(problem)}`); }
    finally { if (mounted.current) setCancelId(null); void refresh(); }
  }
  const staleQuote = quote ? sourceIdentity(project, quote.source) !== quote.sourceKey : false;
  const activeJobs = state?.jobs.some((job) => ACTIVE.has(job.status));
  const uncertainJobs = state?.jobs.some((job) => job.status === 'uncertain');
  const sourceName = source === 'native' ? project.astraNative?.name : (project.astraBlender ?? createAstraScene('product')).name;
  const registeredMissing = state?.jobs.some((job) => job.assetsRegistered && job.artifacts.some((artifact) => !project.assets.some((asset) => asset.id === artifact.assetId)));

  return <section className={styles.panel} aria-label="Native 3D renders">
    <div className={styles.heading}><h3>Render in the 3D runtime</h3><Server size={16} /></div>
    <p>Run the saved source in native 3D. Keep the finished image and editable scene in your project library, with GLB when compatible.</p>
    <div className={styles.status} data-ready={state?.runtime.configured === true}><i />{state ? state.runtime.configured ? `3D runtime ${state.runtime.blenderVersion} · Ready` : 'Runtime setup required' : active ? 'Checking 3D runtime…' : 'Sign in to render this project'}</div>
    {state && !state.runtime.configured && <div className={styles.notice} role="status"><strong>Native rendering is unavailable</strong><p>{state.runtime.reason || 'A workspace administrator needs to connect the 3D runtime.'}</p><p>You can keep editing and download the portable 3D package.</p></div>}
    <label className={styles.source}>Render source<select aria-label="Native render source" value={source} disabled={busy || !!pending} onChange={(event) => { setSource(event.target.value as Source); setQuote(null); }}><option value="scene">3D workspace scene</option><option value="native" disabled={!project.astraNative}>Native 3D program{project.astraNative ? '' : ' · Apply a proposal first'}</option></select></label>
    <p>{source === 'native' ? `${sourceName || 'Native program'} runs in the 3D runtime. Its geometry is shown in the finished render, not in the browser scene editor.` : `${sourceName} uses the saved scene camera and output settings.`}</p>
    <button className={`${styles.button} ${styles.primary}`} disabled={!active || !state?.runtime.configured || busy || !!pending || !!storageError || !!activeJobs || !!uncertainJobs || source === 'native' && !project.astraNative} onClick={() => void review()}>{busy ? 'Preparing render…' : activeJobs ? 'Render in progress' : uncertainJobs ? 'Awaiting render reconciliation' : 'Review render quote'}</button>
    {pending && <div className={styles.notice}><strong>One render request needs confirmation</strong><p>Recovery checks the original request before resubmitting its same identity and price.</p><button className={styles.button} disabled={!active || busy} onClick={() => void submit(pending)}>Recover saved render request</button></div>}
    {(error || storageError || pollError) && <div className={styles.error} role="alert">{storageError || error || pollError}</div>}
    <div className={styles.historyHeading}><h4>Render history</h4><button className={styles.refresh} aria-label="Refresh native render history" disabled={!active || refreshing} onClick={async () => { setRefreshing(true); try { await refresh(); } finally { if (mounted.current) setRefreshing(false); } }}><RefreshCw size={13} /></button></div>
    {!state?.jobs.length && <p>No saved renders for this project yet.</p>}
    {registeredMissing && onRefreshProject && <button className={styles.button} disabled={refreshing} onClick={async () => { setRefreshing(true); try { await latest.current.onRefreshProject?.(); setError(''); } catch (problem) { setError(message(problem)); } finally { if (mounted.current) setRefreshing(false); } }}>Load saved outputs into project</button>}
    <div className={styles.jobs}>{state?.jobs.map((job) => {
      const preview = job.artifacts.find((artifact) => artifact.kind === 'preview');
      const previewUrl = preview ? safeArtifact(preview) : null;
      return <article className={styles.job} key={job.id} aria-label={`Native render ${job.id}`}>
        <div className={styles.jobTitle}><strong>{job.source === 'native' ? 'Native 3D program' : '3D workspace scene'}</strong><span data-status={job.status}>{STATUS[job.status]}</span></div>
        <div className={styles.meta}><span>{dateLabel(job.createdAt)}</span><span>{job.billedCredits === null ? `${job.estimateCredits} cr reserved` : `${job.billedCredits} cr charged`}</span></div>
        {ACTIVE.has(job.status) && <div className={styles.progress} role="status"><span>{job.status === 'queued' ? 'Waiting for the native worker' : job.status === 'starting' ? 'Preparing the saved source and assets' : job.status === 'saving' ? 'Registering finished files in your library' : 'The 3D runtime is processing the scene'}</span><progress aria-label="Native render in progress" /></div>}
        {job.error && <p className={styles.error} role="alert">{job.error}</p>}
        {job.status === 'uncertain' && <p>This attempt needs reconciliation. Refresh its saved status; recovery does not start another render.</p>}
        {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" aria-label="Open rendered preview">
          {/* Original authenticated output is served directly without an image proxy. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.preview} src={previewUrl} alt="Native 3D rendered preview" />
        </a>}
        {job.artifacts.length > 0 && <div className={styles.artifacts}>{job.artifacts.map((artifact) => {
          const url = safeArtifact(artifact);
          return url ? <a key={artifact.kind} href={`${url.split('?')[0]}?download=1`} aria-label={`Download rendered ${artifactName(artifact.kind)}`}><Download size={12} />{artifactName(artifact.kind)}</a> : null;
        })}</div>}
        {job.assetsRegistered && <div className={styles.library}><Check size={12} /><span>Outputs saved in your project library.</span></div>}
        {job.status === 'succeeded' && !job.artifacts.some((artifact) => artifact.kind === 'glb') && <p>GLB is unavailable for this run. Use the .blend file to retain native 3D features.</p>}
        {ACTIVE.has(job.status) && <div className={styles.jobActions}><button className={styles.button} disabled={!!cancelId || !enabled} onClick={() => void cancel(job)}><Square size={11} />{cancelId === job.id ? 'Stopping…' : 'Cancel render'}</button></div>}
        <details className={styles.details}><summary>Run details</summary><code>Request: {job.requestId}</code><code>Source: {job.sourceDigest.slice(0, 16)}…</code></details>
      </article>;
    })}</div>
    {quote && <Dialog open onOpenChange={(open) => { if (!open && !busy) setQuote(null); }}><DialogContent className="ps ps-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle>Run native 3D render</DialogTitle><DialogDescription>{project.name} · {quote.name}</DialogDescription></DialogHeader><div className={styles.quote}>
      <p>This starts a native 3D job for the saved {quote.source === 'native' ? 'Python program' : '3D scene'}. The job and its outputs remain in render history after you close this page.</p>
      <dl className={styles.quoteFacts}><dt>Render source</dt><dd>{quote.source === 'native' ? 'Native program' : '3D workspace'}</dd><dt>3D runtime</dt><dd>{quote.runtime.blenderVersion}</dd><dt>Runtime limit</dt><dd>{Math.ceil(quote.runtime.timeoutMs / 1000)} seconds</dd><dt>Outputs</dt><dd>PNG · .blend<br />GLB when compatible</dd><dt>Credit ceiling</dt><dd>{quote.quote.estimateCredits} cr</dd></dl>
      <p>{quote.quote.billingNote}</p>
      {(expired || staleQuote) && <div className={styles.error} role="alert">{staleQuote ? 'The source changed after this quote. Close this dialog and review a new quote.' : 'This quote expired. Close this dialog and review a new quote.'}</div>}
      {error && <div className={styles.error} role="alert">{error}</div>}
      <button className={`${styles.button} ${styles.primary}`} disabled={busy || expired || staleQuote || !!pending} onClick={() => void submit()}>{busy ? 'Starting native render…' : `Start render · up to ${quote.quote.estimateCredits} cr`}</button>
    </div></DialogContent></Dialog>}
  </section>;
}
