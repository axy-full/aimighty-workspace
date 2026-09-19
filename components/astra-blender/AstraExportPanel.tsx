'use client';
import { useState } from 'react';
import { zip, strToU8 } from 'fflate';
import type { Project } from '@/lib/workbench/studio';
import { createAstraScene, type AstraScene } from '@/lib/astra-blender/scene';
import { astraSceneDigest } from '@/lib/astra-blender/proposal';
import { studioRequest } from '@/components/workbench/GenerationDialog';
import { downloadFile } from '@/lib/workbench/studio-export';
import styles from './astra-integration.module.css';

type Export = { scene: AstraScene; script: string; files: { assetId: string; filename: string; url: string }[] };
async function sourceBytes(url: string, remaining: number, scope: string) {
  if (!/^\/(?:api\/(?:uploads|media|workbench\/media)\/[A-Za-z0-9_-]+(?:\?download=1)?|campaign\/[A-Za-z0-9_.-]+)$/.test(url)) throw new Error('This asset has no supported original download.');
  const response = await fetch(url, { headers: { 'X-Workbench-Scope': scope }, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('An original asset could not be read. Nothing was exported.');
  const limit = Math.min(32 * 1024 * 1024, remaining);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('3D packages support 32 MB per asset and 100 MB in total.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new Error('3D packages support 32 MB per asset and 100 MB in total.'); chunks.push(next.value); }
  } catch (error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function AstraExportPanel({ project, scope, enabled, onSave }: { project: Project; scope: string; enabled: boolean; onSave: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function exportBlender() {
    setBusy(true); setError('');
    try {
      if (!(await onSave())) throw new Error('Save your scene before exporting.');
      const manifest = await studioRequest<Export>('/api/workbench/astra-blender/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Scope': scope }, body: JSON.stringify({ projectId: project.id, sceneDigest: await astraSceneDigest(project.astraBlender ?? createAstraScene('product')) }) });
      const files: Record<string, Uint8Array> = { 'scene.astra.json': strToU8(JSON.stringify(manifest.scene, null, 2)), 'render.py': strToU8(manifest.script) };
      let remaining = 100 * 1024 * 1024;
      for (const source of manifest.files) { const bytes = await sourceBytes(source.url, remaining, scope); files['assets/' + source.filename] = bytes; remaining -= bytes.length; }
      files['README.txt'] = strToU8(`ASTRA / ${manifest.scene.name}\n\nThis is a portable scene package, not an already rendered .blend file.\nInstall Blender 5 or newer from https://www.blender.org/download/\nUnzip this folder and run the following, replacing paths with absolute paths:\n\nblender --background --factory-startup --disable-autoexec --python /path/to/render.py -- /path/to/output\n\nOn macOS the 3D runtime executable is normally /Applications/3D runtime.app/Contents/MacOS/3D runtime.\nThe script creates scene.blend, preview.png and scene.glb. Open scene.blend in 3D runtime to continue editing or render the animation. Source media is preserved in assets/. The saved timeline and animation keys are included.\n\nThe browser viewport is a real-time preview. The native render uses Cycles/AgX, so lighting and text can differ. GLB export has material and light limitations; .blend is the native scene. No cloud render or paid model request is started by this export.\n`);
      const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => zip(files, { level: 1 }, (err, data) => err ? reject(err) : resolve(new Uint8Array(data))));
      downloadFile(new Blob([bytes], { type: 'application/zip' }), 'astra-scene.zip');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel}><h3>Continue locally</h3><p>Download the scene, original assets and a build script for the 3D runtime, version 5 or newer. Run it locally to create an editable .blend, a Cycles still and a GLB.</p><button className={`${styles.button} ${styles.primary}`} disabled={!enabled || busy} onClick={() => void exportBlender()}>{busy ? 'Collecting originals…' : 'Download 3D package'}</button><p className={styles.notice}>This package runs in your own 3D runtime installation. Native cloud rendering is available separately below when its runtime is connected. The viewport and PNG export run in your browser.</p>{error && <p role="alert" className={styles.error}>{error}</p>}</section>;
}
