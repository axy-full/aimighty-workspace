'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, Plan } from '@/lib/workbench/studio';
import { ASTRA_BLENDER_MODEL, createAstraScene } from '@/lib/astra-blender/scene';
import { astraSceneDigest, validateAstraBindings } from '@/lib/astra-blender/proposal';
import { astraNativeDigest } from '@/lib/astra-blender/native';
import type { AtomikJob } from '@/lib/workbench/atomik-server';
import type { ThinkingModel } from '@/components/atomik/ModelPicker';
import { AtomikRunDialog, type AtomikRunTarget } from '@/components/workbench/AtomikRunDialog';
import { readPendingAtomik, atomikPendingInput } from '@/lib/workbench/atomik-pending-request';
import { studioRequest } from '@/components/workbench/GenerationDialog';
import styles from './astra-integration.module.css';

type State = { models: ThinkingModel[]; jobs: AtomikJob[] };
export function AstraAgentPanel({ project, scope, enabled, onSave, onApply }: { project: Project; scope: string; enabled: boolean; onSave: () => Promise<boolean>; onApply: (plan: Plan) => Promise<void> }) {
  const [request, setRequest] = useState('');
  const [mode, setMode] = useState<'scene' | 'native'>('scene');
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<AtomikRunTarget | null>(null);
  const [target, setTarget] = useState<AtomikRunTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const active = enabled && !!project.productionProjectId;
  const refresh = useCallback(async () => {
    if (!active) return;
    const own = ++sequence.current;
    try {
      const pending = readPendingAtomik(localStorage, scope, project.id);
      const input = pending ? atomikPendingInput(pending) : null;
      setRecovery(input?.astraBlender ? input : null);
      const value = await studioRequest<State>('/api/workbench/atomik?' + new URLSearchParams({ projectId: project.id }), { headers: { 'X-Workbench-Scope': scope } });
      if (own === sequence.current) { setState(value); setError(''); }
    } catch (e) { if (own === sequence.current) setError((e as Error).message); }
  }, [active, project.id, scope]);
  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    return () => {
      // Invalidate manual refreshes too; this is a request sequence, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      clearTimeout(initial); clearInterval(timer);
    };
  }, [refresh]);
  const model = state?.models.find(item => item.id === ASTRA_BLENDER_MODEL);
  const jobs = state?.jobs.filter(job => job.astraBlender || job.plan?.astraBlender || job.plan?.astraNative) ?? [];
  const running = jobs.some(job => ['queued', 'running'].includes(job.status));
  async function review() {
    setBusy(true); setError('');
    try {
      if (!(await onSave())) throw new Error('Save this project before asking Astra to edit it.');
      const scene = project.astraBlender ?? createAstraScene('product');
      validateAstraBindings(scene, [...project.assets, ...(project.sharedAssets ?? [])]);
      setTarget({ astraBlender: { sceneDigest: await astraSceneDigest(scene), ...(mode === 'native' ? { mode, nativeDigest: await astraNativeDigest(project.astraNative) } : {}), ...(referenceIds.length ? { referenceIds } : {}) }, request, model: ASTRA_BLENDER_MODEL, effort: 'medium', depth: 'Deep', refs: [] });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-label="Astra scene assistant">
    <h3>Build with Astra</h3>
    <div className={styles.modeSwitch} role="group" aria-label="Astra workflow"><button className={styles.button} aria-pressed={mode === 'scene'} onClick={() => setMode('scene')}>Visual scene</button><button className={styles.button} aria-pressed={mode === 'native'} onClick={() => setMode('native')}>Native 3D</button></div>
    <p>{mode === 'native' ? 'Use 3D runtime Python for detailed modeling, geometry nodes, materials, rigging, animation, camera tours, compositing and simulation setups. Review the source, then render it in Output.' : 'Describe geometry, lighting, materials or movement. Astra uses your scene and up to 64 recent project assets. Review the proposal before applying it.'}</p>
    {mode === 'native' && <details><summary>Start a 3D runtime workflow</summary><div className={styles.modeSwitch}>{[
      ['Modeling', 'Refine this scene with production mesh modeling, modifiers and clean named objects.'],
      ['Geometry nodes', 'Create a reusable procedural geometry-node setup with exposed controls for this scene.'],
      ['Materials & UV', 'Develop physically based material nodes and appropriate UVs for the selected scene objects.'],
      ['Rigging', 'Create an editable armature and control rig for the supplied character. Preserve the mesh and materials.'],
      ['Animation', 'Animate this scene with editable keyframes and smooth timing. Preserve the current composition.'],
      ['Camera tour', 'Create a cinematic camera tour through this scene with editable camera animation and considered lighting.'],
      ['Compositing', 'Create a restrained filmic compositor setup with controllable exposure and color treatment.'],
      ['Simulation', 'Set up a bounded native physics simulation appropriate to this scene, retaining editable controls and explaining bake limits.'],
    ].map(([label, text]) => <button key={label} className={styles.button} onClick={() => setRequest(text)}>{label}</button>)}</div></details>}
    <textarea aria-label="Astra scene request" placeholder="Create a brushed-metal product on a warm stone plinth. Use a large soft key and a slow turntable…" maxLength={11000} value={request} onChange={event => setRequest(event.target.value)} disabled={!enabled || busy} />
    <details><summary>Visual references · {referenceIds.length}/4</summary><p>Attach project images or a previous native render for Astra to inspect and refine.</p><div className={styles.referenceList}>{[...project.assets, ...(project.sharedAssets ?? [])].filter((asset, index, all) => asset.kind === 'image' && all.findIndex(item => item.id === asset.id) === index).map(asset => <label key={asset.id}><input type="checkbox" checked={referenceIds.includes(asset.id)} disabled={!referenceIds.includes(asset.id) && referenceIds.length >= 4} onChange={event => setReferenceIds(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} />{asset.name}</label>)}</div></details>
    <button className={`${styles.button} ${styles.primary}`} disabled={!!recovery || !active || !model || running || busy || request.trim().length < 3} onClick={() => void review()}>{running ? 'Astra is working…' : busy ? 'Preparing scene…' : 'Review Astra quote'}</button>
    {recovery && <button className={styles.button} disabled={!enabled || busy} onClick={() => setTarget(recovery)}>Recover saved Astra request</button>}
    <p className={styles.notice}>Astra · choose effort with the quote. Scene proposals and 3D runtime rendering are separate actions.</p>
    {state && !model && <p className={styles.error}>Astra is not available for this workspace. Check model access and the language account in Workspace → Engines.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {jobs.slice(0, 8).map(job => {
      const plan = job.plan, proposal = plan?.astraBlender, native = plan?.astraNative;
      const applied = project.plans.some(item => item.id === job.id && item.applied);
      return <article key={job.id} className={styles.result}><strong>{job.status === 'succeeded' ? native ? 'Native 3D proposal' : 'Scene proposal' : job.status}</strong><small>{job.credits ?? job.estimateCredits} cr{job.credits == null ? ' reserved' : ''} · {job.effort || 'default effort'}</small>
        {job.error && <p role="alert" className={styles.error}>{job.error}</p>}
        {plan && proposal && <><p>{plan.summary}</p><ol>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          <details><summary>{proposal.scene.objects.length} objects · {proposal.scene.lights.length} lights · review scene</summary><div className={styles.diff}>{proposal.scene.objects.map(object => <div key={object.id}>{object.name} · {object.type} · {object.position.join(', ')} m</div>)}</div></details>
          <button className={styles.button} disabled={!enabled || busy || applied} onClick={async () => { setBusy(true); try { await onApply(plan); setError(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{applied ? 'Applied to scene' : 'Apply scene proposal'}</button>
        </>}
        {plan && native && <><p>{plan.summary}</p><ol>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol><details><summary>Review 3D runtime Python · {native.source.name}</summary><pre className={styles.sourceCode}>{native.source.program}</pre><p>{native.source.assetIds.length} asset inputs · {native.source.baseBlendAssetId ? 'Continues from a saved .blend' : 'Starts from the visual scene'}</p></details><button className={styles.button} disabled={!enabled || busy || applied} onClick={async () => { setBusy(true); try { await onApply(plan); setError(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{applied ? 'Applied to native source' : 'Apply native proposal'}</button></>}
      </article>;
    })}
    {target && enabled && <AtomikRunDialog project={project} scope={scope} models={model ? [model] : []} target={target} onSave={onSave} onClose={() => { setTarget(null); void refresh(); }} onQueued={() => { setTarget(null); void refresh(); }} />}
  </section>;
}
