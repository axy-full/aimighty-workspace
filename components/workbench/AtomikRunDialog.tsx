'use client';

import { useEffect, useRef, useState } from 'react';
import type { Project } from '@/lib/workbench/studio';
import { CREW } from '@/lib/workbench/crew';
import {
  AtomikPendingConflict, atomikPendingInput, persistPendingAtomik, readPendingAtomik,
  resolvePendingAtomik, withPendingAtomikLock, type PendingAtomikRequest, type AtomikRecoveryJob,
} from '@/lib/workbench/atomik-pending-request';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { studioRequest } from './GenerationDialog';

export type AtomikRunTarget = { request: string; role?: string; model: string; depth: string; refs: string[] };
type Quote = { estimateCredits: number; model: string; key: string };

export function AtomikRunDialog({ target, project, scope, models = [], onClose, onSave, onQueued }: {
  target: AtomikRunTarget;
  project: Project;
  /** Authenticated workspace + user identity; never a guest/default scope. */
  scope: string;
  models?: { id: string; name: string }[];
  onClose: () => void;
  onSave: () => Promise<boolean>;
  onQueued: (id: string) => void;
}) {
  const [request, setRequest] = useState(target.request);
  const [model, setModel] = useState(target.model || 'auto');
  const [depth, setDepth] = useState(['Quick', 'Considered', 'Deep'].includes(target.depth) ? target.depth : 'Quick');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [role, setRole] = useState(target.role);
  const [refs, setRefs] = useState(target.refs);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingAtomikRequest | null>(null);
  const [terminal, setTerminal] = useState(false);
  const callbacks = useRef({ onSave, onClose, onQueued });
  useEffect(() => { callbacks.current = { onSave, onClose, onQueued }; }, [onSave, onClose, onQueued]);
  const member = CREW.find(c => c.id === role);
  const quoteKey = JSON.stringify({ projectId: project.id, request, role, model, depth, refs, requestId });
  const shownQuote = quote?.key === quoteKey ? quote : null;

  useEffect(() => {
    let active = true;
    // Load the write-ahead record before enabling quotes or any new paid action.
    Promise.resolve().then(() => readPendingAtomik(window.localStorage, scope, project.id)).then(async saved => {
      if (!active) return;
      if (!saved) { setLoaded(true); return; }
      const input = atomikPendingInput(saved);
      setPending(saved); setRequest(input.request); setRequestId(saved.requestId); setModel(input.model);
      setDepth(input.depth); setRole(input.role); setRefs(input.refs);
      try {
        const state = await studioRequest<{ jobs: AtomikRecoveryJob[] }>('/api/workbench/atomik?' + new URLSearchParams({ projectId: project.id, requestId: saved.requestId }));
        if (!active) return;
        const job = state.jobs.find(item => item.requestId === saved.requestId);
        if (job) {
          resolvePendingAtomik(window.localStorage, scope, project.id, saved, { job });
          if (job.status === 'failed' || job.status === 'uncertain') {
            setTerminal(true); setError(job.error || 'This request ended without a usable proposal. Review its saved status in Activity.');
          } else { callbacks.current.onQueued(job.id); callbacks.current.onClose(); }
        } else setError('The earlier request is still unconfirmed. Recover it with the same request ID and quoted price.');
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'The earlier request could not be checked. Its recovery record is preserved.'); }
      finally { if (active) setLoaded(true); }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'The recovery record could not be read.'); });
    return () => { active = false; };
  }, [scope, project.id]);

  useEffect(() => {
    if (!loaded || pending || request.trim().length < 3) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        if (!(await callbacks.current.onSave())) throw new Error('Save this production before requesting an estimate.');
        if (controller.signal.aborted) return;
        const value = await studioRequest<Omit<Quote, 'key'>>('/api/workbench/atomik', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ ...JSON.parse(quoteKey), quoteOnly: true }),
        });
        if (!controller.signal.aborted) { setQuote({ ...value, key: quoteKey }); setError(''); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'The estimate could not be loaded.');
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [quoteKey, loaded, pending, request]);

  function restore(record: PendingAtomikRequest) {
    const input = atomikPendingInput(record);
    setPending(record); setRequest(input.request); setRequestId(record.requestId); setModel(input.model);
    setDepth(input.depth); setRole(input.role); setRefs(input.refs);
  }
  function accept(record: PendingAtomikRequest, job: AtomikRecoveryJob) {
    if (job.requestId !== record.requestId) throw new Error('The server returned another request. The original recovery record is preserved.');
    resolvePendingAtomik(window.localStorage, scope, project.id, record, { job });
    if (job.status === 'failed' || job.status === 'uncertain') {
      setTerminal(true);
      setError(job.error || 'This attempt ended without a usable proposal. Its status is saved in Activity.');
      return;
    }
    onQueued(job.id); onClose();
  }
  async function lookup(record: PendingAtomikRequest) {
    const state = await studioRequest<{ jobs: AtomikRecoveryJob[] }>('/api/workbench/atomik?' + new URLSearchParams({ projectId: project.id, requestId: record.requestId }));
    return state.jobs.find(job => job.requestId === record.requestId);
  }

  async function submit() {
    if (busy || terminal || !loaded || (!shownQuote && !pending)) return;
    setBusy(true); setError('');
    try {
      if (!pending && !(await onSave())) throw new Error('Save your latest work before starting Atomik.');
      await withPendingAtomikLock(scope, project.id, async () => {
        const body = pending?.body ?? JSON.stringify({ ...JSON.parse(quoteKey), model: shownQuote!.model, maxCredits: shownQuote!.estimateCredits });
        // This synchronous durable write must succeed BEFORE the paid POST.
        const record = persistPendingAtomik(window.localStorage, scope, project.id, body);
        restore(record);
        if (pending) {
          const known = await lookup(record);
          if (known) { accept(record, known); return; }
        }
        try {
          const result = await studioRequest<{ job: AtomikRecoveryJob }>('/api/workbench/atomik', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: record.body,
          });
          accept(record, result.job);
        } catch (e) {
          let confirmedNoJob = false;
          try {
            const known = await lookup(record);
            if (known) { accept(record, known); return; }
            confirmedNoJob = true;
          } catch { /* Access failures, missing rows and lost responses preserve the same identity. */ }
          const status = e && typeof e === 'object' && 'status' in e ? Number(e.status) : 0;
          if (resolvePendingAtomik(window.localStorage, scope, project.id, record, { rejectedStatus: status, confirmedNoJob })) {
            setTerminal(true);
          }
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof AtomikPendingConflict) restore(e.pending);
      setError(e instanceof Error ? e.message : 'The request could not be confirmed. Recover the same request.');
    } finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="ps ps-dialog" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>{member ? 'Run ' + member.name : 'Plan with Genie'}</DialogTitle>
        <DialogDescription>{project.name} · {refs.length} selected reference{refs.length === 1 ? '' : 's'}</DialogDescription>
      </DialogHeader>
      <div className="dialog-fields">
        {pending && <p className="small-copy">Recovering the previously submitted request. Its original model, instructions and price are preserved.</p>}
        <label className="field-label">Request
          <textarea aria-label="Atomik request" value={request} onChange={event => setRequest(event.target.value)} disabled={busy || !!pending || !loaded} maxLength={12000} />
        </label>
        <div className="generation-options">
          <label>Model
            <select aria-label="Atomik request model" value={model} disabled={busy || !!pending || !loaded} onChange={event => setModel(event.target.value)}>
              <option value="auto">Auto · economy</option>
              {models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              {model !== 'auto' && !models.some(option => option.id === model) && <option value={model}>{model}</option>}
            </select>
          </label>
          <label>Depth
            <select aria-label="Atomik request depth" value={depth} disabled={busy || !!pending || !loaded} onChange={event => setDepth(event.target.value)}>
              {['Quick', 'Considered', 'Deep'].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <p className="muted small-copy">Includes the saved brief, script, selected descriptions and supported uploaded text. This planning request does not generate media.</p>
        {shownQuote && !pending && <p className="small-copy">{models.find(option => option.id === shownQuote.model)?.name || shownQuote.model} · up to {shownQuote.estimateCredits} cr reserved</p>}
        {pending && <p className="small-copy">Original estimate: up to {atomikPendingInput(pending).maxCredits} cr.</p>}
        {error && <p className="save-problem" role="alert">{error}</p>}
        {pending && error && !terminal && <p className="muted small-copy">Recovery uses the saved request ID, including after closing this dialog or reloading.</p>}
        {terminal ? <Button className="btn" onClick={onClose}>Close and review Activity</Button> :
          <Button className="btn primary" disabled={busy || !loaded || (!shownQuote && !pending) || request.trim().length < 3} onClick={() => void submit()}>
            {busy ? 'Submitting…' : !loaded ? error ? 'Recovery unavailable' : 'Checking earlier requests…' : pending ? 'Recover this request' : shownQuote ? `Run · ${shownQuote.estimateCredits} cr estimated` : error ? 'Estimate unavailable' : 'Loading estimate…'}
          </Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
