'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Camera, ChevronRight, Copy, Diamond, Download, Eye, EyeOff, Focus, Grid3X3, Layers, Lightbulb, LockKeyhole, Move3D, Pause, Play, Plus, Redo2, Rotate3D, RotateCcw, Scaling, SkipBack, Sparkles, Trash2, Undo2, UnlockKeyhole } from 'lucide-react';
import type { Project } from '@/lib/workbench/studio';
import { astraSceneSchema, ASTRA_SCENE_LIMITS, createAstraScene, sampleAstraObjectTransform, type AstraScene, type AstraObject, type AstraLight, type AstraTemplate, type AstraVector3 } from '@/lib/astra-blender/scene';
import type { AstraAssetPreviews, AstraTransform, AstraTransformMode, AstraViewportActions } from './types';
import styles from './astra-blender.module.css';

const Viewport = dynamic(() => import('./AstraViewport'), { ssr: false, loading: () => <div className={styles.loading}>Opening 3D workspace…</div> });
const EMPTY_PREVIEWS: AstraAssetPreviews = {};
const PRIMITIVES = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'text'] as const;
const TEMPLATE_NAMES: Record<AstraTemplate, string> = { product: 'Product study', interior: 'Interior study', abstract: 'Orbital study', empty: 'Empty scene' };
type WorkspaceProject = Project & { astraBlender?: AstraScene };
export type AstraBlenderWorkspaceProps = {
  project: WorkspaceProject;
  onChange: (patch: Partial<Project> & { astraBlender?: AstraScene }) => void;
  assetPreviews?: AstraAssetPreviews;
  assistant?: ReactNode;
  exportPanel?: ReactNode;
};

function freshId(prefix: string) { return `${prefix}-${crypto.randomUUID().slice(0, 8)}`; }
function round(value: number) { return Number(value.toFixed(3)); }
function downloadScene(scene: AstraScene) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${scene.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'scene'}.astra.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function NumberField({ label, value, onChange, min, max, step = .1 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label className={styles.numberField}><span>{label}</span><input key={value} aria-label={label} type="number" inputMode="decimal" defaultValue={round(value)} min={min} max={max} step={step} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} onBlur={(event) => {
    const input = event.currentTarget;
    const next = input.valueAsNumber;
    if (input.value !== '' && Number.isFinite(next) && next >= (min ?? -Infinity) && next <= (max ?? Infinity)) { if (next !== value) onChange(next); }
    else input.value = String(round(value));
  }} /></label>;
}

function VectorFields({ label, value, onChange, min = -1000, max = 1000, step = .1 }: { label: string; value: AstraVector3; onChange: (value: AstraVector3) => void; min?: number; max?: number; step?: number }) {
  return <fieldset className={styles.vector}><legend>{label}</legend><div>{['X', 'Y', 'Z'].map((axis, index) => <NumberField key={axis} label={`${label} ${axis}`} value={value[index]} min={min} max={max} step={step} onChange={(next) => { const updated = [...value] as AstraVector3; updated[index] = next; onChange(updated); }} />)}</div></fieldset>;
}

export function AstraBlenderWorkspace(props: AstraBlenderWorkspaceProps) {
  return <Workspace key={props.project.id} {...props} />;
}

function Workspace({ project, onChange, assetPreviews = EMPTY_PREVIEWS, assistant, exportPanel }: AstraBlenderWorkspaceProps) {
  const parsed = useMemo(() => astraSceneSchema.safeParse(project.astraBlender), [project.astraBlender]);
  const initial = useMemo(() => createAstraScene('product'), []);
  const scene = parsed.success ? parsed.data : initial;
  const [selectedId, setSelectedId] = useState<string | null>(scene.objects[0]?.id ?? null);
  const [mode, setMode] = useState<AstraTransformMode>('translate');
  const [grid, setGrid] = useState(true);
  const [frame, setFrame] = useState(scene.timeline.start);
  const [playing, setPlaying] = useState(false);
  const [panel, setPanel] = useState<'properties' | 'astra' | 'output'>('properties');
  const [mobileTab, setMobileTab] = useState('scene');
  const [history, setHistory] = useState<{ undo: AstraScene[]; redo: AstraScene[]; scene: AstraScene; signature: string; pending: string | null }>(() => ({ undo: [], redo: [], scene, signature: JSON.stringify(scene), pending: null }));
  const [error, setError] = useState('');
  const actions = useRef<AstraViewportActions | null>(null);
  const [viewportReady, setViewportReady] = useState(false);
  const selected = scene.objects.find((object) => object.id === selectedId);
  const light = scene.lights.find((item) => item.id === selectedId);
  const currentFrame = Math.max(scene.timeline.start, Math.min(frame, scene.timeline.end));
  const sampled = selected ? sampleAstraObjectTransform(selected, currentFrame) : null;
  const totalKeys = scene.objects.reduce((count, object) => count + object.keyframes.length, 0);
  const keyAtFrame = selected?.keyframes.some((key) => key.frame === currentFrame) ?? false;
  const signature = JSON.stringify(scene);
  // Record externally applied assistant proposals as well as editor changes.
  // A signature distinguishes our own controlled update from an external one.
  if (history.signature !== signature) {
    setHistory(history.pending === signature
      ? { ...history, scene, signature, pending: null }
      : { undo: [...history.undo.slice(-39), history.scene], redo: [], scene, signature, pending: null });
  }
  const { undo, redo } = history;

  const commit = useCallback((next: AstraScene) => {
    const result = astraSceneSchema.safeParse(next);
    if (!result.success) { setError(result.error.issues[0]?.message || 'This scene change is not supported.'); return; }
    if (JSON.stringify(result.data) === JSON.stringify(scene)) return;
    setHistory((previous) => ({ ...previous, undo: [...previous.undo.slice(-39), scene], redo: [], pending: JSON.stringify(result.data) }));
    setError('');
    onChange({ astraBlender: result.data });
  }, [onChange, scene]);
  const undoScene = useCallback(() => {
    const previous = undo.at(-1);
    if (!previous) return;
    setHistory((history) => ({ ...history, redo: [...history.redo, scene], undo: history.undo.slice(0, -1), pending: JSON.stringify(previous) }));
    setPlaying(false);
    onChange({ astraBlender: previous });
  }, [onChange, scene, undo]);
  const redoScene = useCallback(() => {
    const next = redo.at(-1);
    if (!next) return;
    setHistory((history) => ({ ...history, undo: [...history.undo, scene], redo: history.redo.slice(0, -1), pending: JSON.stringify(next) }));
    setPlaying(false);
    onChange({ astraBlender: next });
  }, [onChange, redo, scene]);
  const changeObject = (id: string, patch: Partial<AstraObject>) => commit({ ...scene, objects: scene.objects.map((object) => object.id === id ? { ...object, ...patch } : object) });
  const changeLight = (patch: Partial<AstraLight>) => commit({ ...scene, lights: scene.lights.map((item) => item.id === selectedId ? { ...item, ...patch } : item) });
  const changeTransform = useCallback((id: string, transform: AstraTransform) => {
    const object = scene.objects.find((item) => item.id === id);
    if (!object || object.locked) return;
    const keyframes = object.keyframes.length ? [...object.keyframes.filter((key) => key.frame !== currentFrame), { frame: currentFrame, ...transform }].sort((a, b) => a.frame - b.frame) : [];
    commit({ ...scene, objects: scene.objects.map((item) => item.id === id ? { ...item, ...transform, keyframes } : item) });
  }, [commit, currentFrame, scene]);
  const ready = useCallback((value: AstraViewportActions | null) => { actions.current = value; setViewportReady(!!value); }, []);
  const select = useCallback((id: string | null) => { setSelectedId(id); setPanel('properties'); }, []);

  useEffect(() => {
    if (!playing) return;
    const started = performance.now();
    const from = currentFrame;
    const length = scene.timeline.end - scene.timeline.start + 1;
    let timer = 0;
    const tick = (now: number) => {
      const elapsed = Math.floor((now - started) / 1000 * scene.timeline.fps);
      setFrame(scene.timeline.start + (from - scene.timeline.start + elapsed) % length);
      timer = requestAnimationFrame(tick);
    };
    timer = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(timer);
    // Playback owns its starting frame until paused; scrubbing explicitly pauses it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scene.timeline.start, scene.timeline.end, scene.timeline.fps]);

  const add = (type: AstraObject['type'], assetId?: string) => {
    if (scene.objects.length >= ASTRA_SCENE_LIMITS.objects) return;
    const object: AstraObject = {
      id: freshId(type), name: assetId ? assetPreviews[assetId]?.name || type : type[0].toUpperCase() + type.slice(1), type,
      position: [0, 0, type === 'plane' || type === 'image' ? 0 : .5], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false,
      material: { color: '#b9c5d8', metalness: 0, roughness: .4 }, keyframes: [],
      ...(assetId ? { assetId } : {}), ...(type === 'text' ? { text: 'Astra' } : {}),
    };
    commit({ ...scene, objects: [...scene.objects, object] });
    select(object.id);
  };
  const addLight = () => {
    if (scene.lights.length >= ASTRA_SCENE_LIMITS.lights) return;
    const item: AstraLight = { id: freshId('light'), name: 'Point light', type: 'point', position: [2, -2, 3], rotation: [0, 0, 0], color: '#ffffff', power: 400, size: .25 };
    commit({ ...scene, lights: [...scene.lights, item] });
    select(item.id);
  };
  const duplicate = () => {
    if (!selected || selected.locked || scene.objects.length >= ASTRA_SCENE_LIMITS.objects) return;
    const copy = structuredClone(selected);
    copy.id = freshId(selected.type);
    copy.name = `${selected.name.slice(0, 94)} copy`;
    copy.position[0] += .5;
    copy.keyframes.forEach((key) => { key.position[0] += .5; });
    commit({ ...scene, objects: [...scene.objects, copy] });
    select(copy.id);
  };
  const deleteSelected = () => {
    if (selected?.locked) return;
    commit({ ...scene, objects: scene.objects.filter((object) => object.id !== selectedId), lights: scene.lights.filter((item) => item.id !== selectedId) });
    select(null);
  };
  const keyframe = () => {
    if (!selected || selected.locked || !sampled) return;
    changeObject(selected.id, { keyframes: [...selected.keyframes.filter((key) => key.frame !== currentFrame), { frame: currentFrame, ...sampled }].sort((a, b) => a.frame - b.frame) });
  };
  const template = (value: AstraTemplate) => {
    const next = createAstraScene(value);
    setPlaying(false);
    setFrame(next.timeline.start);
    commit(next);
    select(next.objects[0]?.id ?? null);
  };

  return <section className={styles.workspace} aria-label="Astra blender" data-mobile-tab={mobileTab} onKeyDown={(event) => {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redoScene(); else undoScene(); }
  }}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.brandIcon}><Box size={19} /></span><div><h1>Astra blender</h1><p>{project.name} <ChevronRight size={10} /> 3D workspace</p></div></div>
      <div className={styles.headerActions}>
        <label className={styles.templatePicker}><Layers size={14} /><select aria-label="Scene template" value="" onChange={(event) => template(event.target.value as AstraTemplate)}><option value="" disabled>Templates</option>{Object.entries(TEMPLATE_NAMES).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
        <button className={styles.iconButton} aria-label="Undo scene change" disabled={!undo.length} onClick={undoScene}><Undo2 size={15} /></button>
        <button className={styles.iconButton} aria-label="Redo scene change" disabled={!redo.length} onClick={redoScene}><Redo2 size={15} /></button>
        <button onClick={() => { setPanel('astra'); setMobileTab('astra'); }} className={styles.assistantButton}><Sparkles size={14} />GPT-6 Astra</button>
      </div>
    </header>
    <nav className={styles.mobileTabs} aria-label="3D workspace panels">{[['scene', 'Scene'], ['objects', 'Objects'], ['properties', 'Properties'], ['astra', 'Astra'], ['output', 'Output']].map(([value, label]) => <button key={value} aria-pressed={mobileTab === value} onClick={() => { setMobileTab(value); if (['properties', 'astra', 'output'].includes(value)) setPanel(value as typeof panel); }}>{label}</button>)}</nav>
    {(error || project.astraBlender && !parsed.success) && <div className={styles.error} role="alert">{error || 'This saved scene could not be validated. A starter scene is shown. Editing it will replace the unsupported scene.'}</div>}
    <div className={styles.layout}>
      <aside className={styles.outliner} aria-label="Scene objects">
        <div className={styles.panelHeading}><h2>Scene collection</h2><span>{scene.objects.length}</span></div>
        <div className={styles.addRow}><label className={styles.addSelect}><Plus size={14} /><select aria-label="Add object" value="" disabled={scene.objects.length >= ASTRA_SCENE_LIMITS.objects} onChange={(event) => { const value = event.target.value; if (value.startsWith('asset:')) { const assetId = value.slice(6); add(assetPreviews[assetId].kind, assetId); } else add(value as AstraObject['type']); }}><option value="" disabled>Add object</option><optgroup label="Primitives">{PRIMITIVES.map((type) => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</optgroup>{Object.keys(assetPreviews).length > 0 && <optgroup label="Project assets">{Object.entries(assetPreviews).map(([id, asset]) => <option key={id} value={`asset:${id}`}>{asset.name || id} · {asset.kind === 'model' ? 'GLB' : 'Image'}</option>)}</optgroup>}</select></label></div>
        <div className={styles.objectList}>
          {scene.objects.length === 0 && <p className={styles.emptyHint}>Start with a primitive, a project asset, or a scene template.</p>}
          {scene.objects.map((object) => <div className={styles.objectRow} data-selected={selectedId === object.id} key={object.id}>
            <button className={styles.objectName} aria-pressed={selectedId === object.id} onClick={() => select(object.id)}><Box size={13} /><span>{object.name}</span>{object.keyframes.length > 0 && <Diamond size={9} />}</button>
            <button className={styles.rowIcon} aria-label={`${object.visible ? 'Hide' : 'Show'} ${object.name}`} onClick={() => changeObject(object.id, { visible: !object.visible })}>{object.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
            <button className={styles.rowIcon} aria-label={`${object.locked ? 'Unlock' : 'Lock'} ${object.name}`} onClick={() => changeObject(object.id, { locked: !object.locked })}>{object.locked ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}</button>
          </div>)}
        </div>
        <div className={styles.subheading}><span>Lighting & camera</span><button className={styles.rowIcon} aria-label="Add light" disabled={scene.lights.length >= ASTRA_SCENE_LIMITS.lights} onClick={addLight}><Plus size={13} /></button></div>
        {scene.lights.map((item) => <button className={styles.sceneItem} aria-pressed={selectedId === item.id} key={item.id} onClick={() => select(item.id)}><Lightbulb size={13} /><span>{item.name}</span><small>{item.type}</small></button>)}
        <button className={styles.sceneItem} aria-pressed={selectedId === 'camera'} onClick={() => select('camera')}><Camera size={13} /><span>Scene camera</span><small>{scene.camera.focalLength} mm</small></button>
        <div className={styles.outlinerFooter}><span>Saved with your project</span><span>{totalKeys} keyframe{totalKeys === 1 ? '' : 's'} · {scene.timeline.fps} fps</span></div>
      </aside>

      <main className={styles.stage}>
        <div className={styles.viewportToolbar}><div className={styles.segment}>
          {([{ id: 'translate', label: 'Move', Icon: Move3D }, { id: 'rotate', label: 'Rotate', Icon: Rotate3D }, { id: 'scale', label: 'Scale', Icon: Scaling }] as const).map(({ id, label, Icon }) => <button key={id} aria-label={label} aria-pressed={mode === id} onClick={() => setMode(id)}><Icon size={14} /><span>{label}</span></button>)}
        </div><div className={styles.viewportTools}>
          <button className={styles.iconButton} aria-label="Toggle grid" aria-pressed={grid} onClick={() => setGrid(!grid)}><Grid3X3 size={14} /></button>
          <button className={styles.iconButton} aria-label="Frame selection" disabled={!viewportReady} onClick={() => actions.current?.frameSelection()}><Focus size={15} /></button>
          <button className={styles.iconButton} aria-label="Restore scene camera" disabled={!viewportReady} onClick={() => actions.current?.resetView()}><RotateCcw size={14} /></button>
        </div></div>
        <div className={styles.viewport}><Viewport scene={scene} frame={currentFrame} selectedId={selected?.id ?? null} mode={mode} grid={grid} playing={playing} assetPreviews={assetPreviews} onSelect={select} onTransform={changeTransform} onReady={ready} /></div>
        <div className={styles.timeline} aria-label="Animation timeline">
          <div className={styles.timelineTop}><div className={styles.playback}><button className={styles.iconButton} aria-label="First frame" onClick={() => { setPlaying(false); setFrame(scene.timeline.start); }}><SkipBack size={14} /></button><button className={styles.iconButton} aria-label={playing ? 'Pause animation' : 'Play animation'} aria-pressed={playing} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={14} /> : <Play size={14} />}</button><label>Frame <input aria-label="Current frame" type="number" min={scene.timeline.start} max={scene.timeline.end} value={currentFrame} onChange={(event) => { setPlaying(false); const next = event.target.valueAsNumber; if (Number.isFinite(next)) setFrame(Math.max(scene.timeline.start, Math.min(scene.timeline.end, Math.round(next)))); }} /></label><span className={styles.fps}>{scene.timeline.fps} fps</span></div>
          <button className={styles.keyButton} disabled={!selected || selected.locked || playing || (!keyAtFrame && (selected.keyframes.length >= ASTRA_SCENE_LIMITS.keyframesPerObject || totalKeys >= ASTRA_SCENE_LIMITS.keyframes))} onClick={keyframe}><Diamond size={12} fill={keyAtFrame ? 'currentColor' : 'none'} /><span>{keyAtFrame ? 'Update keyframe' : 'Add keyframe'}</span></button></div>
          <div className={styles.scrubber}><input type="range" aria-label="Timeline frame" min={scene.timeline.start} max={scene.timeline.end} step={1} value={currentFrame} onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} /><div className={styles.keyMarkers}>{selected?.keyframes.map((key) => <button key={key.frame} aria-label={`Go to keyframe ${key.frame}`} title={`Frame ${key.frame}`} style={{ left: `${(key.frame - scene.timeline.start) / Math.max(scene.timeline.end - scene.timeline.start, 1) * 100}%` }} onClick={() => { setPlaying(false); setFrame(key.frame); }}><Diamond size={9} fill="currentColor" /></button>)}</div></div>
          <div className={styles.timelineLabels}><span>{scene.timeline.start}</span><span>{selected ? selected.name : scene.name} {selected?.keyframes.length ? '· Linear interpolation' : '· Select an object to animate'}</span><span>{scene.timeline.end}</span></div>
        </div>
      </main>

      <aside className={styles.inspector}>
        <nav className={styles.inspectorTabs} aria-label="Inspector panels">{[['properties', 'Properties'], ['astra', 'Astra'], ['output', 'Output']].map(([value, label]) => <button key={value} aria-pressed={panel === value} onClick={() => setPanel(value as typeof panel)}>{value === 'astra' && <Sparkles size={12} />}{label}</button>)}</nav>
        <div className={styles.inspectorBody}>
          {panel === 'astra' ? assistant ?? <div className={styles.emptyPanel}><Sparkles size={22} /><h2>GPT-6 Astra</h2><p>Describe your scene to the project assistant. Review its proposal before applying changes.</p></div> : panel === 'output' ? <>
            <div className={styles.propertyHeading}><h2>Output</h2><p>Export a scene or capture your current view.</p></div>
            <div className={styles.exportActions}><button onClick={() => downloadScene(scene)}><Download size={14} />Download scene JSON</button><button disabled={!viewportReady} onClick={() => actions.current?.downloadPng()}><Camera size={14} />Save viewport PNG</button></div>
            <p className={styles.hint}>Viewport captures use the interactive preview. Blender renders use the saved scene camera and output settings.</p>
            <div className={styles.propertySection}><h3>Blender output settings</h3><div className={styles.twoColumns}><NumberField label="Width" value={scene.render.width} min={64} max={2048} step={1} onChange={(width) => commit({ ...scene, render: { ...scene.render, width: Math.round(width) } })} /><NumberField label="Height" value={scene.render.height} min={64} max={2048} step={1} onChange={(height) => commit({ ...scene, render: { ...scene.render, height: Math.round(height) } })} /></div><NumberField label="Samples" value={scene.render.samples} min={1} max={128} step={1} onChange={(samples) => commit({ ...scene, render: { ...scene.render, samples: Math.round(samples) } })} /><label className={styles.checkbox}><input type="checkbox" checked={scene.render.transparent} onChange={(event) => commit({ ...scene, render: { ...scene.render, transparent: event.target.checked } })} />Transparent background</label></div>
            {exportPanel}
          </> : <>
            <div className={styles.propertyHeading}><h2>{selected ? 'Object properties' : light ? 'Light properties' : selectedId === 'camera' ? 'Scene camera' : 'Scene properties'}</h2><p>{selected ? `${selected.type} · ${selected.locked ? 'Locked' : 'Editable'}` : light ? `${light.type} light` : 'Meters · Z up'}</p></div>
            {selected && sampled ? <>
              <label className={styles.field}>Name<input key={`${selected.id}-${selected.name}`} defaultValue={selected.name} maxLength={100} disabled={selected.locked} onBlur={(event) => { const name = event.target.value.trim(); if (name) changeObject(selected.id, { name }); else event.target.value = selected.name; }} /></label>
              <div className={styles.objectActions}><button onClick={duplicate} disabled={selected.locked || scene.objects.length >= ASTRA_SCENE_LIMITS.objects}><Copy size={13} />Duplicate</button><button onClick={deleteSelected} disabled={selected.locked}><Trash2 size={13} />Delete</button></div>
              {selected.locked && <p className={styles.hint}>Unlock this object in the scene collection to edit it.</p>}
              <fieldset className={styles.propertiesFieldset} disabled={selected.locked || playing}>
                <div className={styles.propertySection}><h3>Transform</h3><VectorFields label="Position" value={sampled.position} onChange={(position) => changeTransform(selected.id, { ...sampled, position })} /><VectorFields label="Rotation" value={sampled.rotation} min={-3600} max={3600} step={1} onChange={(rotation) => changeTransform(selected.id, { ...sampled, rotation })} /><VectorFields label="Scale" value={sampled.scale} min={.001} max={100} onChange={(scale) => changeTransform(selected.id, { ...sampled, scale })} />{selected.keyframes.length > 0 && <p className={styles.hint}>Animated transform edits add or update a keyframe at frame {currentFrame}.</p>}</div>
                {selected.type === 'text' && <div className={styles.propertySection}><label className={styles.field}>Text<input key={`${selected.id}-${selected.text}`} defaultValue={selected.text} maxLength={160} onBlur={(event) => { if (event.target.value.trim()) changeObject(selected.id, { text: event.target.value }); }} /></label><p className={styles.hint}>Text uses a flat browser preview. Blender exports generate native text geometry.</p></div>}
                {(selected.type === 'image' || selected.type === 'model') && <div className={styles.propertySection}><label className={styles.field}>Project asset<select value={selected.assetId || ''} onChange={(event) => changeObject(selected.id, { assetId: event.target.value })}>{!assetPreviews[selected.assetId || ''] && <option value={selected.assetId || ''}>Asset unavailable</option>}{Object.entries(assetPreviews).filter(([, asset]) => asset.kind === selected.type).map(([id, asset]) => <option key={id} value={id}>{asset.name || id}</option>)}</select></label><p className={styles.hint}>{selected.type === 'model' ? 'Self-contained GLB models keep their original materials.' : 'Set the X and Y scale to match the image aspect ratio.'}</p></div>}
                {selected.type !== 'model' && selected.type !== 'image' && <div className={styles.propertySection}><h3>Material</h3><label className={styles.colorField}><span>Base color</span><input type="color" aria-label="Material color" value={selected.material.color} onChange={(event) => changeObject(selected.id, { material: { ...selected.material, color: event.target.value } })} /><code>{selected.material.color.toUpperCase()}</code></label><NumberField label="Metalness" value={selected.material.metalness} min={0} max={1} step={.05} onChange={(metalness) => changeObject(selected.id, { material: { ...selected.material, metalness } })} /><NumberField label="Roughness" value={selected.material.roughness} min={0} max={1} step={.05} onChange={(roughness) => changeObject(selected.id, { material: { ...selected.material, roughness } })} /></div>}
                <div className={styles.propertySection}><h3>Animation <span>{selected.keyframes.length} / {ASTRA_SCENE_LIMITS.keyframesPerObject}</span></h3><p className={styles.hint}>Set the current frame, position your object, then add a keyframe.</p>{selected.keyframes.map((key) => <div className={styles.keyListRow} key={key.frame}><button onClick={() => { setPlaying(false); setFrame(key.frame); }}><Diamond size={10} />Frame {key.frame}</button><button aria-label={`Delete keyframe ${key.frame}`} onClick={() => changeObject(selected.id, { keyframes: selected.keyframes.filter((item) => item.frame !== key.frame) })}><Trash2 size={12} /></button></div>)}</div>
              </fieldset>
            </> : light ? <>
              <label className={styles.field}>Name<input key={`${light.id}-${light.name}`} defaultValue={light.name} maxLength={100} onBlur={(event) => { if (event.target.value.trim()) changeLight({ name: event.target.value.trim() }); }} /></label>
              <label className={styles.field}>Light type<select value={light.type} onChange={(event) => changeLight({ type: event.target.value as AstraLight['type'], power: event.target.value === 'sun' ? Math.min(light.power, 20) : light.power })}><option value="area">Area</option><option value="point">Point</option><option value="sun">Sun</option></select></label>
              <VectorFields label="Position" value={light.position} onChange={(position) => changeLight({ position })} /><VectorFields label="Rotation" value={light.rotation} min={-3600} max={3600} step={1} onChange={(rotation) => changeLight({ rotation })} />
              <label className={styles.colorField}><span>Light color</span><input type="color" aria-label="Light color" value={light.color} onChange={(event) => changeLight({ color: event.target.value })} /><code>{light.color.toUpperCase()}</code></label>
              <NumberField label={light.type === 'sun' ? 'Strength' : 'Power (W)'} value={light.power} min={0} max={light.type === 'sun' ? 20 : 10000} step={light.type === 'sun' ? .1 : 10} onChange={(power) => changeLight({ power })} />{light.type !== 'sun' && <NumberField label={light.type === 'area' ? 'Size (m)' : 'Radius (m)'} value={light.size} min={.01} max={100} onChange={(size) => changeLight({ size })} />}<button className={styles.secondaryButton} onClick={deleteSelected}><Trash2 size={13} />Delete light</button>
            </> : selectedId === 'camera' ? <>
              <VectorFields label="Camera position" value={scene.camera.position} onChange={(position) => commit({ ...scene, camera: { ...scene.camera, position } })} /><VectorFields label="Look at" value={scene.camera.target} onChange={(target) => commit({ ...scene, camera: { ...scene.camera, target } })} /><NumberField label="Focal length (mm)" value={scene.camera.focalLength} min={12} max={200} step={1} onChange={(focalLength) => commit({ ...scene, camera: { ...scene.camera, focalLength } })} /><button className={styles.secondaryButton} disabled={!viewportReady} onClick={() => { const camera = actions.current?.getCamera(); if (camera) commit({ ...scene, camera }); }}><Camera size={14} />Use current view as camera</button><button className={styles.secondaryButton} disabled={!viewportReady} onClick={() => actions.current?.resetView()}><RotateCcw size={14} />Go to scene camera</button>
            </> : <p className={styles.emptyHint}>Select an object in the viewport or scene collection to edit its transform and material.</p>}
            <details className={styles.sceneSettings} open={!selected && !light && selectedId !== 'camera'}><summary>Scene settings</summary><div className={styles.propertySection}><label className={styles.field}>Scene name<input key={scene.name} defaultValue={scene.name} maxLength={100} onBlur={(event) => { if (event.target.value.trim()) commit({ ...scene, name: event.target.value.trim() }); }} /></label><label className={styles.colorField}><span>World color</span><input type="color" aria-label="World color" value={scene.world.color} onChange={(event) => commit({ ...scene, world: { ...scene.world, color: event.target.value } })} /></label><NumberField label="World strength" value={scene.world.strength} min={0} max={5} step={.1} onChange={(strength) => commit({ ...scene, world: { ...scene.world, strength } })} /><div className={styles.twoColumns}><NumberField label="Start frame" value={scene.timeline.start} min={1} max={scene.timeline.end} step={1} onChange={(start) => commit({ ...scene, timeline: { ...scene.timeline, start: Math.round(start) } })} /><NumberField label="End frame" value={scene.timeline.end} min={scene.timeline.start} max={7200} step={1} onChange={(end) => commit({ ...scene, timeline: { ...scene.timeline, end: Math.round(end) } })} /></div><NumberField label="Frames per second" value={scene.timeline.fps} min={1} max={60} step={1} onChange={(fps) => commit({ ...scene, timeline: { ...scene.timeline, fps: Math.round(fps) } })} /></div></details>
          </>}
        </div>
      </aside>
    </div>
  </section>;
}

export default AstraBlenderWorkspace;
