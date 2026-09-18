'use client';
import { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import type { Project, Plan, Asset } from '@/lib/workbench/studio';
import { astraAssetKind } from '@/lib/astra-blender/proposal';
import { originalAssetDownload } from '@/lib/workbench/original-asset';
import { uploadFile } from '@/lib/uploadClient';
import { validateAstraGlb } from '@/lib/astra-blender/glb';
import { AstraBlenderWorkspace } from './AstraBlenderWorkspace';
import { AstraNativeSourcePanel } from './AstraNativeSourcePanel';
import { AstraAgentPanel } from './AstraAgentPanel';
import { AstraExportPanel } from './AstraExportPanel';
import { AstraRenderPanel } from './AstraRenderPanel';
import styles from './astra-integration.module.css';

export function AstraStudio({ project, scope, enabled, onChange, onSave, onApply, onAsset, onRefreshProject }: { project: Project; scope: string; enabled: boolean; onChange: (patch: Partial<Project>) => void; onSave: () => Promise<boolean>; onApply: (plan: Plan) => Promise<void>; onAsset: (asset: Asset) => void; onRefreshProject: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const previews = useMemo(() => Object.fromEntries([...project.assets, ...(project.sharedAssets ?? [])].flatMap(asset => {
    const kind = astraAssetKind(asset), original = originalAssetDownload(asset);
    return kind && original ? [[asset.id, { url: original.url, kind, name: asset.name }]] : [];
  })), [project.assets, project.sharedAssets]);
  async function upload(file: File) {
    setBusy(true); setError('');
    try {
      if (project.assets.length >= 500) throw new Error('This project has reached its asset limit.');
      if (file.size > (/\.blend$/i.test(file.name) ? 50 : 32) * 1024 * 1024) throw new Error('Use an image or GLB below 32 MB, or an uncompressed .blend below 50 MB.');
      if (/\.glb$/i.test(file.name)) validateAstraGlb(new Uint8Array(await file.arrayBuffer()));
      else if (!/\.blend$/i.test(file.name) && !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose an uncompressed .blend, embedded GLB, PNG, JPEG or WebP image.');
      const result = await uploadFile(file, 'reference', undefined, { scope });
      const asset: Asset = { id: 'astra-' + result.id, uploadId: result.id, name: result.filename, url: result.url, mime: result.mime, kind: result.kind === 'image' ? 'image' : 'document', category: 'Astra blender', description: 'Original asset uploaded for a 3D scene.', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] };
      // Uploads remain in the shared library even if the project was changed or
      // its save fails; the parent guards this patch against a switched project.
      onAsset(asset);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="stage-scroll"><div className={styles.toolbar}><p>3D scene building · project assets · GPT-6 Astra</p><label className={styles.button}><Upload size={14}/>{busy ? 'Uploading…' : 'Upload image, GLB or .blend'}<input aria-label="Upload Astra asset" type="file" accept=".blend,.glb,image/png,image/jpeg,image/webp" disabled={!enabled || busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label></div>{error && <p className={styles.error} role="alert">{error}</p>}
    <AstraBlenderWorkspace project={project} onChange={onChange} assetPreviews={previews}
      assistant={<><AstraAgentPanel key={scope + project.id} project={project} scope={scope} enabled={enabled} onSave={onSave} onApply={onApply} /><AstraNativeSourcePanel project={project} enabled={enabled} onChange={onChange} onSave={onSave} /></>}
      exportPanel={<><AstraRenderPanel key={`render-${scope}-${project.id}`} project={project} scope={scope} enabled={enabled} onSave={onSave} onRefreshProject={onRefreshProject} /><AstraExportPanel key={scope + project.id} project={project} scope={scope} enabled={enabled} onSave={onSave} /></>} />
  </div>;
}
