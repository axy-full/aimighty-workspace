'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Upload, UserRound } from 'lucide-react';
import type { Asset, Project } from '@/lib/workbench/studio';
import { mediaReferenceIdentity } from '@/lib/workbench/media-reference-input';
import { soulReferenceAssets, type SoulIdentity, type SoulIdentityState } from '@/lib/workbench/soul-identity';
import { usePaidAction } from '@/lib/usePaidAction';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { studioRequest } from './GenerationDialog';
import styles from './soul-identity-panel.module.css';

const endpoint = '/api/soul/identities';
const statusLabels: Record<SoulIdentity['status'], string> = {
  submitting: 'Submitting', training: 'Training', ready: 'Ready', failed: 'Failed', uncertain: 'Needs review',
};
const activeStatus = (identity: SoulIdentity) => identity.status === 'submitting' || identity.status === 'training';

export function SoulIdentityPanel({ project, subjectType, assetId, scope, enabled, onSave, onUpload, onAttach, onClose, onSettings }: {
  project: Project; subjectType: 'character' | 'element'; assetId?: string; scope: string; enabled: boolean;
  onSave: () => Promise<boolean>; onUpload: (files: File[]) => Promise<Asset[]>;
  onAttach: (identity: SoulIdentity, assetId?: string) => Promise<void>;
  onClose: () => void; onSettings: () => void;
}) {
  const paid = usePaidAction(`soul-identity:${project.id}`, enabled, { signedIn: enabled, requestScope: scope });
  const target = project.assets.find(asset => asset.id === assetId);
  const [state, setState] = useState<SoulIdentityState | null>(null);
  const [name, setName] = useState(target?.name.slice(0, 100) ?? '');
  const [description, setDescription] = useState(target?.description.slice(0, 1000) ?? '');
  const [selected, setSelected] = useState<string[]>(target && soulReferenceAssets([target]).length ? [target.id] : []);
  const [consent, setConsent] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true), epoch = useRef(0), reading = useRef(false), acting = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const callbacks = useRef({ onSave, onUpload, onAttach, onClose });
  useEffect(() => { callbacks.current = { onSave, onUpload, onAttach, onClose }; }, [onSave, onUpload, onAttach, onClose]);
  const assets = soulReferenceAssets([...project.assets, ...(project.sharedAssets ?? [])]);
  const references = assets.filter(asset => selected.includes(asset.id)).map(asset => mediaReferenceIdentity(asset)!);
  const terms = state?.terms;
  const credits = terms?.trainingCredits;
  const dollars = terms?.trainingCostUsd;
  const price = typeof credits === 'number' ? `${credits.toLocaleString()} credits` : typeof dollars === 'number' ? `$${dollars.toFixed(2)}` : null;
  const polling = !!state?.identities.some(activeStatus);
  const disabled = !!busy || !!paid.pending || !!paid.error || !enabled;
  const recovered = paid.pending ? JSON.parse(paid.pending.body) as Record<string, unknown> : null;

  const refresh = useCallback(async () => {
    if (!enabled || reading.current || acting.current) return;
    reading.current = true;
    const started = epoch.current;
    setRefreshing(true);
    try {
      if (!(await callbacks.current.onSave())) throw new Error('Save this project before loading its Soul IDs.');
      if (!alive.current || started !== epoch.current) return;
      const value = await studioRequest<SoulIdentityState>(`${endpoint}?${new URLSearchParams({ projectId: project.id })}`, { headers: { 'X-Workbench-Scope': scope }, cache: 'no-store' });
      if (alive.current && started === epoch.current) { setState(value); setError(''); }
    } catch (cause) {
      if (alive.current && started === epoch.current) setError(cause instanceof Error ? cause.message : 'Soul IDs could not be loaded.');
    } finally {
      reading.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, [enabled, project.id, scope, setState, setError, setRefreshing]);

  useEffect(() => {
    const requestEpoch = epoch;
    alive.current = true;
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => { clearTimeout(timer); alive.current = false; requestEpoch.current++; };
  }, [refresh]);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  async function submit() {
    if (acting.current || !enabled || paid.error) return;
    acting.current = true; epoch.current++; setBusy('training'); setError('');
    try {
      let body: Record<string, unknown>;
      if (paid.pending) {
        body = JSON.parse(paid.pending.body);
        if (paid.pending.url !== endpoint || body.projectId !== project.id) throw new Error('Return to the original project to recover this training request.');
      } else {
        if (!state?.configured || !terms || !price || !consent || !name.trim() || references.length < terms.minPhotos || references.length > terms.maxPhotos) throw new Error('Add the required portraits, name and consent before training.');
        if (!(await callbacks.current.onSave())) throw new Error('Save this project before training a Soul ID.');
        if (!alive.current) return;
        body = { projectId: project.id, name: name.trim(), description: description.trim(), subjectType, references, consent: true,
          ...(typeof credits === 'number' ? { maxCredits: credits } : { maxUsd: dollars }) };
      }
      const { data } = await paid.run<{ identity: SoulIdentity }>(endpoint, body);
      if (!alive.current) return;
      epoch.current++;
      setState(previous => previous ? { ...previous, identities: [data.identity, ...previous.identities.filter(identity => identity.id !== data.identity.id)] } : previous);
      setCreating(false); setConsent(false); setName(''); setDescription(''); setSelected([]);
      if (data.identity.status === 'uncertain' || data.identity.status === 'failed') setError(data.identity.error || 'Training needs review. Its saved status is shown below.');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'The response could not be confirmed. Recover the saved training request.');
    } finally {
      acting.current = false; epoch.current++;
      if (alive.current) { setBusy(''); void refresh(); }
    }
  }

  async function upload(files: File[]) {
    if (acting.current || disabled || !files.length) return;
    acting.current = true; setBusy('upload'); setError('');
    try {
      if (files.some(file => !file.type.startsWith('image/'))) throw new Error('Choose image files for Soul ID portraits.');
      const uploaded = await callbacks.current.onUpload(files);
      if (alive.current) setSelected(previous => [...new Set([...previous, ...uploaded.map(asset => asset.id)])].slice(0, terms?.maxPhotos ?? 40));
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The portraits could not be uploaded.'); }
    finally { acting.current = false; if (alive.current) setBusy(''); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function attach(identity: SoulIdentity) {
    if (acting.current || identity.status !== 'ready' || target?.locked) return;
    acting.current = true; setBusy(identity.id); setError('');
    try { await callbacks.current.onAttach(identity, assetId); if (alive.current) callbacks.current.onClose(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'This Soul ID could not be attached.'); }
    finally { acting.current = false; if (alive.current) setBusy(''); }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className={`ps ps-dialog ${styles.panel}`} overlayClassName="z-[100]" style={{ zIndex: 101 }}>
      <DialogHeader>
        <DialogTitle>Soul ID</DialogTitle>
        <DialogDescription>Keep one real or fictional character’s face consistent across shots. Props, products and worlds stay as ordinary image references.</DialogDescription>
      </DialogHeader>
      <div className={styles.body}>
        {!enabled && <div className={styles.notice}>Sign in and open a saved project to create or use a Soul ID.</div>}
        {enabled && !state && !error && <p role="status">Loading workspace identities…</p>}
        {state && !state.configured && <div className={styles.notice}><strong>Connect Higgsfield to train a Soul ID</strong><p>Training is not configured for this workspace. An owner or admin can connect the provider in workspace settings.</p><button type="button" onClick={onSettings}>Workspace settings</button></div>}
        {target && <p className={styles.help}>Attach to <strong>{target.name}</strong>. Its cover will use the identity’s original portrait.{target.locked ? ' Unlock this asset before changing its Soul ID.' : ''}</p>}
        {(error || paid.error) && <div role="alert" className={`${styles.notice} ${styles.error}`}>{paid.error || error}</div>}
        {paid.pending && <div className={styles.notice}><strong>Recover saved training request</strong><p>{typeof recovered?.name === 'string' ? recovered.name : 'Saved identity'} · {Array.isArray(recovered?.references) ? recovered.references.length : 0} portraits{typeof recovered?.maxCredits === 'number' ? ` · ${recovered.maxCredits.toLocaleString()} credits` : typeof recovered?.maxUsd === 'number' ? ` · $${recovered.maxUsd.toFixed(2)}` : ''}</p><p>The original portraits, price and consent are saved. Recovery checks the same request; it does not start another training attempt.</p><button type="button" disabled={!!busy || !!paid.error || !enabled} onClick={() => void submit()}>{busy === 'training' ? <Loader2 size={14} className="spin"/> : <RefreshCw size={14}/>}Recover training request</button></div>}
        <div className={styles.heading}><div><h3>Available identities</h3><span>For this project and workspace.</span></div><button type="button" aria-label="Refresh Soul IDs" disabled={refreshing || !!busy || !enabled} onClick={() => void refresh()}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/></button></div>
        <p className={styles.help}>{state?.generationAvailable === false ? 'Trained-character rendering is not enabled yet. You can prepare and train identities now. ' : ''}Soul character rendering uses a prompt and one Soul ID, without additional image or video references.</p>
        <div className={styles.identities} aria-label="Workspace Soul IDs">
          {state?.identities.length === 0 && <p className={styles.help}>No Soul IDs yet. Train a character from your project portraits below.</p>}
          {state?.identities.map(identity => <article key={identity.id} className={styles.identity} aria-label={`Soul ID: ${identity.name}`}>
            {identity.previewUrl ? <img src={identity.previewUrl} alt="" loading="lazy"/> : <div className={styles.placeholder}><UserRound size={20}/></div>}
            <div><strong>{identity.name}</strong><small role="status">{statusLabels[identity.status]}{identity.creditsBilled != null ? ` · ${identity.creditsBilled.toLocaleString()} credits` : ''}</small>{identity.error && <p>{identity.error}</p>}{identity.status === 'uncertain' && <p>No new attempt will be submitted automatically. Contact workspace support to reconcile this request.</p>}</div>
            {identity.status === 'ready' && <button type="button" disabled={!!busy || !enabled || !!target?.locked || target?.soulIdentityId === identity.id} onClick={() => void attach(identity)}>{busy === identity.id ? 'Saving…' : target?.soulIdentityId === identity.id ? 'Attached' : `Use in ${subjectType === 'character' ? 'Characters' : 'Elements'}`}</button>}
          </article>)}
        </div>
        <section className={styles.create} aria-label="Create Soul ID">
          <div className={styles.heading}><h3>Create a Soul ID</h3>{state?.identities.length ? <button type="button" disabled={!!busy} aria-expanded={creating} onClick={() => setCreating(value => !value)}>{creating ? 'Hide form' : 'New identity'}</button> : null}</div>
          {(creating || !state?.identities.length) && !paid.pending && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
            <fieldset className={styles.formFields} disabled={disabled || !state?.configured}>
              <label className={styles.field}>Identity name<input aria-label="Soul ID name" value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="e.g. Mira — principal character" required/></label>
              <label className={styles.field}>Continuity notes<textarea aria-label="Soul ID continuity notes" value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} placeholder="Describe the character and the portrait set."/></label>
              <div className={styles.refHeading}><div><h3>Portrait references</h3><span>{references.length} selected{terms ? ` · ${terms.minPhotos}–${terms.maxPhotos} images` : ''}</span></div><button type="button" onClick={() => fileInput.current?.click()}><Upload size={14}/>{busy === 'upload' ? 'Uploading…' : 'Upload portraits'}</button><input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Upload Soul ID portraits" onChange={event => void upload(Array.from(event.target.files ?? []))}/></div>
              <p className={styles.help}>Use clear images of the same person: varied angles, expressions and lighting. Only uploaded images and saved generated stills can be used.</p>
              <div className={styles.references} role="group" aria-label="Soul ID portrait references">
                {assets.map(asset => <label key={asset.id} className={styles.reference}><input type="checkbox" aria-label={`Use portrait ${asset.name}`} checked={selected.includes(asset.id)} disabled={!selected.includes(asset.id) && references.length >= (terms?.maxPhotos ?? 40)} onChange={event => setSelected(previous => event.target.checked ? [...previous, asset.id] : previous.filter(id => id !== asset.id))}/><img src={asset.url} alt="" loading="lazy"/><span>{asset.name}</span></label>)}
              </div>
              {!assets.length && <p className={styles.help}>Upload portraits to add them to this project and select them for training.</p>}
              <p className={styles.help}>Accepted training requests are billed even if training later fails.</p>
              <label className={styles.consent}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>I have the rights and consent to use these images and this likeness for AI training. They depict one person or fictional character.</span></label>
            </fieldset>
            <div className={styles.footer}><small>Training is a paid request. Its status stays in your workspace after you close this panel.</small><Button type="submit" className="btn primary" disabled={disabled || !state?.configured || !terms || !price || !consent || !name.trim() || references.length < (terms?.minPhotos ?? 1) || references.length > (terms?.maxPhotos ?? 40)}>{busy === 'training' ? <Loader2 size={14} className="spin"/> : null}Train Soul ID{price ? ` · ${price}` : ''}</Button></div>
          </form>}
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}
