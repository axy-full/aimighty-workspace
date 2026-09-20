'use client';
import { useState } from 'react';
import type { Project } from '@/lib/workbench/studio';
import { astraNativeSchema, isAstraBlendAsset, validateAstraNativeBindings } from '@/lib/astra-blender/native';
import { astraAssetKind } from '@/lib/astra-blender/proposal';
import styles from './astra-integration.module.css';

export function AstraNativeSourcePanel({ project, enabled, onChange, onSave }: { project: Project; enabled: boolean; onChange: (patch: Partial<Project>) => void; onSave: () => Promise<boolean> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <SourceEditor key={JSON.stringify(project.astraNative ?? null)} project={project} enabled={enabled} onChange={onChange} onSave={onSave} error={error} busy={busy} setError={setError} setBusy={setBusy} />;
}
function SourceEditor({ project, enabled, onChange, onSave, error, busy, setError, setBusy }: { project: Project; enabled: boolean; onChange: (patch: Partial<Project>) => void; onSave: () => Promise<boolean>; error: string; busy: boolean; setError: (value: string) => void; setBusy: (value: boolean) => void }) {
  const source = project.astraNative;
  const [program, setProgram] = useState(source?.program ?? 'import bpy\n\n# Edit the current scene here. The worker saves and renders afterward.\n');
  const [name, setName] = useState(source?.name ?? 'Native 3D scene');
  const [base, setBase] = useState(source?.baseBlendAssetId ?? '');
  const [assetIds, setAssetIds] = useState(source?.assetIds ?? []);
  const assets = [...project.assets, ...(project.sharedAssets ?? [])].filter((asset, index, all) => all.findIndex(item => item.id === asset.id) === index);
  async function save() {
    setBusy(true); setError('');
    try {
      const next = astraNativeSchema.parse({ schemaVersion: 1, name, program, assetIds, ...(base ? { baseBlendAssetId: base } : {}) });
      validateAstraNativeBindings(next, assets);
      onChange({ astraNative: next });
      if (!(await onSave())) throw new Error('The native source is on screen but has not saved yet. Keep this project open.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([program], { type: 'text/x-python' }));
    const link = document.createElement('a'); link.href = url; link.download = 'astra-scene.py'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className={styles.panel} aria-label="Native 3D source"><h3>Native 3D source</h3><p>Keep procedural geometry, rigs, material nodes and animation editable in Blender. The native worker runs the saved source; the visual viewport remains a separate scene preview.</p>
    <label>Source name<input aria-label="Native source name" value={name} maxLength={160} disabled={!enabled || busy} onChange={event => setName(event.target.value)} /></label>
    <label>Starting scene<select aria-label="Native starting scene" value={base} disabled={!enabled || busy} onChange={event => setBase(event.target.value)}><option value="">Current visual scene</option>{assets.filter(isAstraBlendAsset).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
    <p className={styles.notice}>A .blend starting scene preserves its native geometry, node graphs, rigs and animation. Uploaded files must be saved without compression. Embedded auto-run scripts are disabled.</p>
    <details open={!!source}><summary>Review or edit Python</summary><textarea className={styles.sourceEditor} aria-label="Native 3D Python" spellCheck={false} maxLength={180000} value={program} onChange={event => setProgram(event.target.value)} disabled={!enabled || busy} /><p className={styles.notice}>Use bpy, mathutils and ASSETS[asset_id]. The worker saves the .blend, renders one preview and exports GLB after your code. External downloads and package installation are unavailable.</p></details>
    <details><summary>Native input assets · {assetIds.length}/64</summary><div className={styles.referenceList}>{assets.filter(asset => astraAssetKind(asset)).map(asset => <label key={asset.id}><input type="checkbox" checked={assetIds.includes(asset.id)} disabled={!enabled || busy || !assetIds.includes(asset.id) && assetIds.length >= 64} onChange={event => setAssetIds(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} />{asset.name}</label>)}</div></details>
    <div className={styles.modeSwitch}><button className={`${styles.button} ${styles.primary}`} disabled={!enabled || busy || !program.trim() || !name.trim()} onClick={() => void save()}>{busy ? 'Saving source…' : 'Save native source'}</button><button className={styles.button} onClick={download}>Download Python</button></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
