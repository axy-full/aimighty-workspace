'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Eye, EyeOff, ImagePlus, Lock, Plus, Trash2, Type, Unlock } from 'lucide-react';
import { createPoster, posterDimensions, posterPng, posterSourceIds, renderPoster, type PosterDocument, type PosterLayer } from '@/lib/workbench/moleculr-poster';
import { EMPTY_MOLECULR } from '@/lib/workbench/moleculr';
import { safeName, uid, type Project } from '@/lib/workbench/studio';
import styles from './poster-designer.module.css';

export function PosterDesigner({ project, scope, enabled, onChange, onSaveAsset }: {
  project: Project; scope: string; enabled: boolean; onChange: (poster: PosterDocument) => void;
  onSaveAsset: (file: File, sourceIds: string[], document: PosterDocument) => Promise<void>;
}) {
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const poster = brief.poster;
  const [selectedId, setSelectedId] = useState('');
  const [imageId, setImageId] = useState('');
  const [edge, setEdge] = useState(2160);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewError, setPreviewError] = useState('');
  const preview = useRef<HTMLCanvasElement>(null);
  const active = useRef(true);
  const saving = useRef(false);
  const selected = poster?.layers.find(layer => layer.id === selectedId) ?? poster?.layers.at(-1);
  const images = project.assets.filter(asset => asset.kind === 'image');
  const drag = useRef<{ pointer: number; id: string; clientX: number; clientY: number; x: number; y: number; width: number; height: number } | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!poster) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void renderPoster(poster, project.assets, 900, scope, abort.signal).then(canvas => {
        if (abort.signal.aborted || !preview.current) return;
        preview.current.width = canvas.width; preview.current.height = canvas.height;
        preview.current.getContext('2d')?.drawImage(canvas, 0, 0);
        setPreviewError('');
      }).catch(reason => { if (!abort.signal.aborted) setPreviewError(reason instanceof Error ? reason.message : 'Preview unavailable.'); });
    }, 80);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [poster, project.assets, scope]);
  const update = (fields: Partial<PosterDocument>) => { if (poster && enabled && !busy) onChange({ ...poster, ...fields }); };
  const edit = (layer: PosterLayer) => update({ layers: poster!.layers.map(item => item.id === layer.id && !item.locked ? layer : item) });
  function add(kind: PosterLayer['kind']) {
    if (!poster || !enabled || busy || poster.layers.length >= 40) return;
    const common = { id: uid('layer'), name: kind === 'text' ? 'New text' : kind === 'image' ? 'Product image' : 'Shape', x: 8, y: 40, width: 84, height: 40, opacity: 1, visible: true, locked: false };
    let layer: PosterLayer;
    if (kind === 'image') {
      const asset = images.find(item => item.id === imageId) ?? images[0]; if (!asset) return;
      layer = { ...common, kind, name: asset.name.slice(0, 120), assetId: asset.id, fit: 'contain' };
    } else if (kind === 'text') layer = { ...common, kind, text: 'Your message', color: '#FFFFFF', size: 6, weight: 'bold', font: brief.brandKit?.font ?? 'system', align: 'left' };
    else layer = { ...common, kind, color: brief.brandKit?.colors[1] ?? '#5CC8B4', radius: 0 };
    update({ layers: [...poster.layers, layer] }); setSelectedId(layer.id);
  }
  function move(delta: number) {
    if (!poster || !selected || selected.locked) return;
    const next = [...poster.layers]; const index = next.findIndex(item => item.id === selected.id); const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]]; update({ layers: next });
  }
  async function exportPoster(save: boolean) {
    if (!poster || !enabled || saving.current) return;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const canvas = await renderPoster(poster, project.assets, edge, scope);
      const png = await posterPng(canvas);
      if (!active.current) return;
      const file = new File([png], `${safeName(poster.name)}-${canvas.width}x${canvas.height}.png`, { type: 'image/png' });
      if (save) await onSaveAsset(file, posterSourceIds(poster), poster);
      else {
        const url = URL.createObjectURL(png); const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      if (active.current) setNotice(save ? 'Poster saved in the project library. Its layers remain editable.' : 'Full-size PNG exported. Original reference files remain unchanged.');
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : 'Poster export failed.'); }
    finally { saving.current = false; if (active.current) setBusy(false); }
  }
  if (!poster) return <section className={`suite-panel ${styles.empty}`}><Type size={32}/><h2>Build the final design.</h2><p>Add typography, product images, logos and shapes as separate layers. Export a full-size PNG and retain every editable layer with the project.</p><button className="suite-primary" disabled={!enabled} onClick={() => onChange(createPoster(brief.brandKit?.tagline || brief.productName || project.name, () => uid('poster'), brief.brandKit?.colors[0] ?? '#141414'))}><Plus size={16}/>Create a poster</button></section>;
  const dimensions = posterDimensions(poster.aspect, edge);
  return <section className={`suite-panel ${styles.designer}`} aria-label="Poster designer">
    <header className="suite-section-heading"><div><h2>Poster designer</h2><p>Arrange layers, then save a separate finished take. Images always use their stored originals.</p></div><span className="suite-badge">{poster.layers.length} / 40 layers</span></header>
    <fieldset className={styles.toolbar} disabled={!enabled || busy}>
      <label>Design name<input value={poster.name} maxLength={160} onChange={event => update({ name: event.target.value })}/></label>
      <label>Canvas format<select aria-label="Canvas format" value={poster.aspect} onChange={event => update({ aspect: event.target.value as PosterDocument['aspect'] })}>{['1:1','4:5','9:16','16:9'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Background<input type="color" value={poster.background} onChange={event => update({ background: event.target.value })}/></label>
      <label>Export size<select aria-label="Export size" value={edge} onChange={event => setEdge(Number(event.target.value))}>{[1080,2160,3840].map(value => <option key={value} value={value}>{value}px long edge</option>)}</select></label>
    </fieldset>
    <div className={styles.layout}>
      <div className={styles.stage}><div className={styles.canvas} style={{ aspectRatio: poster.aspect.replace(':',' / '), width: `min(100%, ${posterDimensions(poster.aspect, 620).width}px)` }}>
        <canvas ref={preview} aria-label="Poster preview"/>
        <div className={styles.hitArea}>{poster.layers.filter(layer => layer.visible).map(layer => <button type="button" key={layer.id} aria-label={`Select layer ${layer.name}`} aria-pressed={selected?.id === layer.id} disabled={!enabled || busy} className={styles.layerHit} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%` }} onClick={() => setSelectedId(layer.id)} onPointerDown={event => {
          setSelectedId(layer.id); if (layer.locked) return;
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
          drag.current = { pointer: event.pointerId, id: layer.id, clientX: event.clientX, clientY: event.clientY, x: layer.x, y: layer.y, width: bounds.width, height: bounds.height }; event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const start = drag.current; if (!start || start.pointer !== event.pointerId || start.id !== layer.id) return;
          edit({ ...layer, x: Math.max(0, Math.min(100 - layer.width, start.x + (event.clientX - start.clientX) / start.width * 100)), y: Math.max(0, Math.min(100 - layer.height, start.y + (event.clientY - start.clientY) / start.height * 100)) });
        }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}/>)}</div>
      </div><p>{dimensions.width} × {dimensions.height} PNG · Preview is scaled</p>{previewError && <p role="alert" className="suite-alert">{previewError}</p>}</div>
      <div className={styles.controls}>
        <div className={styles.add}><button className="suite-button" disabled={!enabled || busy || poster.layers.length >= 40} onClick={() => add('text')}><Type size={14}/>Text</button><button className="suite-button" disabled={!enabled || busy || poster.layers.length >= 40} onClick={() => add('shape')}><Plus size={14}/>Shape</button></div>
        <label>Image from library<select aria-label="Image from library" value={imageId || images[0]?.id || ''} onChange={event => setImageId(event.target.value)}><option value="" disabled>Select an image</option>{images.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        <button className="suite-button" disabled={!enabled || busy || !images.length || poster.layers.length >= 40} onClick={() => add('image')}><ImagePlus size={14}/>Add image layer</button>
        <div className={styles.layers} aria-label="Design layers">{poster.layers.slice().reverse().map(layer => <div key={layer.id} data-selected={selected?.id === layer.id}><button onClick={() => setSelectedId(layer.id)}>{layer.name}</button><button disabled={!enabled || busy || layer.locked} aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`} onClick={() => edit({ ...layer, visible: !layer.visible })}>{layer.visible ? <Eye size={14}/> : <EyeOff size={14}/>}</button><button disabled={!enabled || busy} aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`} onClick={() => update({ layers: poster.layers.map(item => item.id === layer.id ? { ...item, locked: !item.locked } : item) })}>{layer.locked ? <Lock size={14}/> : <Unlock size={14}/>}</button></div>)}</div>
        {selected && <fieldset disabled={!enabled || busy || selected.locked} className={styles.inspector}>
          <label>Layer name<input value={selected.name} maxLength={120} onChange={event => edit({ ...selected, name: event.target.value })}/></label>
          {selected.kind === 'text' && <><label>Text<textarea aria-label="Layer text" value={selected.text} rows={3} maxLength={2000} onChange={event => edit({ ...selected, text: event.target.value })}/></label><div className={styles.pair}><label>Font<select aria-label="Font" value={selected.font} onChange={event => edit({ ...selected, font: event.target.value as 'system' | 'editorial' | 'geometric' })}><option value="system">System</option><option value="editorial">Editorial serif</option><option value="geometric">Geometric sans</option></select></label><label>Weight<select aria-label="Weight" value={selected.weight} onChange={event => edit({ ...selected, weight: event.target.value as 'regular' | 'bold' })}><option value="regular">Regular</option><option value="bold">Bold</option></select></label></div><div className={styles.pair}><label>Type size (%)<input type="number" min={1} max={25} step={0.5} value={selected.size} onChange={event => edit({ ...selected, size: Math.max(1, Math.min(25, Number(event.target.value))) })}/></label><label>Alignment<select aria-label="Alignment" value={selected.align} onChange={event => edit({ ...selected, align: event.target.value as 'left' | 'center' | 'right' })}><option>left</option><option>center</option><option>right</option></select></label></div></>}
          {selected.kind === 'image' && <><label>Source image<select aria-label="Source image" value={selected.assetId} onChange={event => edit({ ...selected, assetId: event.target.value })}>{images.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>Image fit<select aria-label="Image fit" value={selected.fit} onChange={event => edit({ ...selected, fit: event.target.value as 'contain' | 'cover' })}><option value="contain">Contain entire image</option><option value="cover">Fill and crop</option></select></label></>}
          {(selected.kind === 'text' || selected.kind === 'shape') && <label>Layer color<input type="color" value={selected.color} onChange={event => edit({ ...selected, color: event.target.value })}/></label>}
          {selected.kind === 'shape' && <label>Corner radius (%)<input type="number" min={0} max={50} value={selected.radius} onChange={event => edit({ ...selected, radius: Math.max(0, Math.min(50, Number(event.target.value))) })}/></label>}
          <div className={styles.pair}>{(['x','y','width','height'] as const).map(key => <label key={key}>{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key} (%)<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} max={100} step={0.5} value={selected[key]} onChange={event => edit({ ...selected, [key]: Math.max(key === 'x' || key === 'y' ? 0 : 1, Math.min(100, Number(event.target.value))) })}/></label>)}</div>
          <label>Opacity<input type="range" min={0} max={1} step={0.01} value={selected.opacity} onChange={event => edit({ ...selected, opacity: Number(event.target.value) })}/></label>
          <div className={styles.add}><button type="button" className="suite-button" onClick={() => move(1)} aria-label="Bring layer forward"><ArrowUp size={14}/></button><button type="button" className="suite-button" onClick={() => move(-1)} aria-label="Send layer backward"><ArrowDown size={14}/></button><button type="button" className="suite-button" onClick={() => update({ layers: poster.layers.filter(layer => layer.id !== selected.id) })}><Trash2 size={14}/>Delete layer</button></div>
        </fieldset>}
      </div>
    </div>
    {error && <p className="suite-alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <footer className="suite-panel-footer"><span>Layers saved with this project · {posterSourceIds(poster).length} original references</span><div className={styles.add}><button className="suite-button" disabled={!enabled || busy || !!previewError} onClick={() => void exportPoster(false)}><Download size={15}/>Export PNG</button><button className="suite-primary" disabled={!enabled || busy || !!previewError} onClick={() => void exportPoster(true)}>{busy ? 'Rendering…' : 'Save poster to library'}</button></div></footer>
  </section>;
}
