"use client";
import { useEffect, useRef, useState } from "react";
import { createPoster, posterDimensions, posterPng, posterSourceIds, renderPoster, type PosterDocument, type PosterLayer } from "@/lib/workbench/moleculr-poster";
import { safeName, uid } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { CardHead, Field, PicturePicker, Said, SaveLine, adoptEntry, briefOf, changeBrief, refreshLibrary, uploadToDraft, useLatest, useWork, type OwnEditor } from "./own-kit";

const ASPECTS: PosterDocument["aspect"][] = ["1:1", "4:5", "9:16", "16:9"];
const EDGES = [1080, 2160, 3840] as const;
const LAYERS_MAX = 40;
type Font = "system" | "editorial" | "geometric";
/* Sans only in the Suites; a layer already set to the editorial face keeps it until it is changed. */
const FONTS: [Font, string][] = [["system", "System"], ["geometric", "Geometric"]];
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);

/**
 * Business › Design: the poster designer. Text, image and shape layers over
 * a background, each editable, movable, lockable and hideable, saved with the
 * project as layers; exported as a full-size PNG — downloaded, or saved to
 * this project's Library as a new original. Image layers always draw their
 * stored originals (lib/workbench/moleculr-poster.ts). Free: nothing here
 * calls an engine.
 */
export function DesignTool({ scope, editor, items }: { scope: string; editor: OwnEditor; items: LibraryEntry[] }) {
  const p = editor.project!;
  const latest = useLatest(p);
  const brief = briefOf(p);
  const poster = brief.poster;
  const work = useWork();
  const [selectedId, setSelectedId] = useState("");
  const [edge, setEdge] = useState<number>(2160);
  const [adding, setAdding] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ pointer: number; id: string; x0: number; y0: number; x: number; y: number; w: number; h: number } | null>(null);
  const selected = poster?.layers.find((l) => l.id === selectedId) ?? poster?.layers.at(-1) ?? null;

  useEffect(() => {
    if (!poster) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void renderPoster(poster, p.assets, 900, scope, abort.signal).then((canvas) => {
        if (abort.signal.aborted || !preview.current) return;
        preview.current.width = canvas.width; preview.current.height = canvas.height;
        preview.current.getContext("2d")?.drawImage(canvas, 0, 0);
        setPreviewError("");
      }).catch((reason) => { if (!abort.signal.aborted) setPreviewError(reason instanceof Error ? reason.message : "The preview could not be drawn."); });
    }, 80);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [poster, p.assets, scope]);

  const setPoster = (fn: (doc: PosterDocument) => PosterDocument) => changeBrief(editor, (b) => (b.poster ? { ...b, poster: fn(b.poster) } : b));
  const edit = (layer: PosterLayer) => setPoster((doc) => ({ ...doc, layers: doc.layers.map((l) => (l.id === layer.id && !l.locked ? layer : l)) }));
  const add = (layer: PosterLayer) => { setPoster((doc) => (doc.layers.length >= LAYERS_MAX ? doc : { ...doc, layers: [...doc.layers, layer] })); setSelectedId(layer.id); };
  const base = (name: string) => ({ id: uid("layer"), name, x: 8, y: 40, width: 84, height: 40, opacity: 1, visible: true, locked: false });
  const kit = brief.brandKit;
  const addText = () => add({ ...base("New text"), kind: "text", text: "Your message", color: "#FFFFFF", size: 6, weight: "bold", font: kit?.font === "geometric" ? "geometric" : "system", align: "left" });
  const addShape = () => add({ ...base("Shape"), kind: "shape", color: kit?.colors[1] ?? "#0A84FF", radius: 0 });
  const addImage = (assetId: string, name: string) => { add({ ...base(name.slice(0, 120) || "Image"), kind: "image", assetId, fit: "contain" }); setAdding(false); };
  const takeImage = (entry: LibraryEntry) => {
    const asset = adoptEntry(editor, latest.current, entry, "Campaign design");
    if (!asset) { work.setError("The project’s asset library is full."); return; }
    addImage(asset.id, asset.name);
  };
  const uploadImage = (file: File) => work.run("upload", async () => {
    if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
    const asset = await uploadToDraft(scope, editor, latest.current, file, "Campaign design", "Poster image");
    addImage(asset.id, asset.name);
    await editor.ensureSaved();
    refreshLibrary(scope, latest.current.id);
  });
  const move = (delta: number) => {
    if (!selected || selected.locked) return;
    setPoster((doc) => {
      const layers = [...doc.layers];
      const from = layers.findIndex((l) => l.id === selected.id), to = from + delta;
      if (from < 0 || to < 0 || to >= layers.length) return doc;
      [layers[from], layers[to]] = [layers[to], layers[from]];
      return { ...doc, layers };
    });
  };
  const exportPng = (save: boolean) => work.run(save ? "save" : "export", async () => {
    const doc = briefOf(latest.current).poster;
    if (!doc) return;
    const canvas = await renderPoster(doc, latest.current.assets, edge, scope);
    const png = await posterPng(canvas);
    const file = new File([png], `${safeName(doc.name)}-${canvas.width}x${canvas.height}.png`, { type: "image/png" });
    if (!save) {
      const url = URL.createObjectURL(png);
      const link = document.createElement("a");
      link.href = url; link.download = file.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return `${file.name} is downloaded. The originals it draws on are unchanged.`;
    }
    const sources = posterSourceIds(doc);
    const asset = await uploadToDraft(scope, editor, latest.current, file, "Campaign design", "Rendered poster · its layers stay editable in Business › Design", sources);
    if (!(await editor.ensureSaved())) throw new Error("The poster is uploaded, but the project is not saved yet. Keep it open; it saves again.");
    refreshLibrary(scope, latest.current.id);
    return `${asset.name} is in this project’s Library. Its layers stay editable here.`;
  });

  if (!poster) {
    return (
      <div className="bo gx-enter" data-testid="design-tool">
        <section className="gx-gen-card" aria-label="Poster designer" data-testid="design-empty">
          <CardHead label="Build the final design" />
          <p className="gx-hint">Type, product images, the logo and shapes as separate layers you can move and change. Export a full-size PNG; the layers stay with the project.</p>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-primary" onClick={() => changeBrief(editor, (b) => ({ ...b, poster: createPoster(b.brandKit?.tagline || b.productName || p.name, () => uid("poster"), b.brandKit?.colors[0] ?? "#141414") }))} data-testid="design-create">Create a poster</button>
          </div>
        </section>
      </div>
    );
  }
  const size = posterDimensions(poster.aspect, edge);
  const stageWidth = posterDimensions(poster.aspect, 620).width;
  const fonts: [Font, string][] = selected?.kind === "text" && selected.font === "editorial" ? [...FONTS, ["editorial", "Editorial"]] : FONTS;
  return (
    <div className="bo gx-enter" data-testid="design-tool">
      <section className="gx-gen-card" aria-label="Poster designer" data-testid="design-poster">
        <CardHead label={`Poster · ${poster.layers.length} of ${LAYERS_MAX} layers`}><span className="gx-hint">Free · saved with the project</span></CardHead>
        <div className="bo-toolbar">
          <Field label="Name"><input className="gx-field" value={poster.name} maxLength={160} onChange={(e) => { const name = e.target.value; setPoster((d) => ({ ...d, name })); }} data-testid="design-name" /></Field>
          <div className="bo-row">
            <span className="bo-field-label" data-functional-label="">Canvas</span>
            <div className="gx-chips" role="group" aria-label="Canvas" data-testid="design-aspect">{ASPECTS.map((a) => <button key={a} type="button" className="gx-chip" aria-pressed={poster.aspect === a} onClick={() => setPoster((d) => ({ ...d, aspect: a }))}>{a}</button>)}</div>
          </div>
          <div className="bo-row">
            <span className="bo-field-label" data-functional-label="">Background</span>
            <span className="bo-swatch"><input type="color" aria-label="Background colour" value={poster.background} onChange={(e) => { const background = e.target.value; setPoster((d) => ({ ...d, background })); }} /><span className="bo-mono">{poster.background.toUpperCase()}</span></span>
          </div>
        </div>
        <div className="bo-design">
          <div className="bo-stage">
            <div className="bo-canvas" style={{ aspectRatio: poster.aspect.replace(":", " / "), width: `min(100%, ${stageWidth}px)` }} data-testid="design-canvas">
              <canvas ref={preview} aria-label="Poster preview" />
              <div className="bo-hits">
                {poster.layers.filter((l) => l.visible).map((layer) => (
                  <button type="button" key={layer.id} className="bo-hit" aria-label={`Select layer ${layer.name}`} aria-pressed={selected?.id === layer.id} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%` }}
                    onClick={() => setSelectedId(layer.id)}
                    onPointerDown={(e) => {
                      setSelectedId(layer.id);
                      if (layer.locked) return;
                      const box = e.currentTarget.parentElement!.getBoundingClientRect();
                      drag.current = { pointer: e.pointerId, id: layer.id, x0: e.clientX, y0: e.clientY, x: layer.x, y: layer.y, w: box.width, h: box.height };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      const d = drag.current;
                      if (!d || d.pointer !== e.pointerId || d.id !== layer.id) return;
                      edit({ ...layer, x: clamp(d.x + ((e.clientX - d.x0) / d.w) * 100, 0, 100 - layer.width), y: clamp(d.y + ((e.clientY - d.y0) / d.h) * 100, 0, 100 - layer.height) });
                    }}
                    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
                ))}
              </div>
            </div>
            <p className="gx-hint bo-center">{size.width} × {size.height} PNG · the preview is scaled</p>
            {previewError ? <p className="gx-gen-error" role="alert">{previewError}</p> : null}
          </div>
          <div className="bo-controls">
            <div className="gx-gen-enhance">
              <button type="button" className="gx-hbtn" disabled={poster.layers.length >= LAYERS_MAX} onClick={addText} data-testid="design-add-text">+ Text</button>
              <button type="button" className="gx-hbtn" disabled={poster.layers.length >= LAYERS_MAX} onClick={addShape} data-testid="design-add-shape">+ Shape</button>
              <button type="button" className="gx-hbtn" aria-expanded={adding} disabled={poster.layers.length >= LAYERS_MAX} onClick={() => setAdding(!adding)} data-testid="design-add-image">+ Image</button>
            </div>
            {adding ? <PicturePicker items={items} label="Poster images" busy={work.busy === "upload"} onPick={takeImage} onUpload={(f) => void uploadImage(f)} testId="design-picker" /> : null}
            <ol className="bo-layers" aria-label="Layers" data-testid="design-layers">
              {poster.layers.slice().reverse().map((layer) => (
                <li key={layer.id} className="bo-layer" data-selected={selected?.id === layer.id || undefined}>
                  <button type="button" className="bo-layer-name" aria-pressed={selected?.id === layer.id} onClick={() => setSelectedId(layer.id)}>{layer.name || layer.kind}</button>
                  <button type="button" className="gx-hbtn" aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`} disabled={layer.locked} onClick={() => edit({ ...layer, visible: !layer.visible })}>{layer.visible ? "Hide" : "Show"}</button>
                  <button type="button" className="gx-hbtn" aria-label={`${layer.locked ? "Unlock" : "Lock"} ${layer.name}`} aria-pressed={layer.locked} onClick={() => setPoster((d) => ({ ...d, layers: d.layers.map((l) => (l.id === layer.id ? { ...l, locked: !l.locked } : l)) }))}>{layer.locked ? "Locked" : "Lock"}</button>
                </li>
              ))}
            </ol>
            {selected ? (
              <fieldset className="bo-inspector" disabled={selected.locked} data-testid="design-inspector">
                {selected.locked ? <p className="gx-hint" data-testid="design-locked">{selected.name || "This layer"} is locked. Unlock it in the layers to change it.</p> : null}
                <Field label="Layer name"><input className="gx-field" value={selected.name} maxLength={120} onChange={(e) => edit({ ...selected, name: e.target.value })} /></Field>
                {selected.kind === "text" ? (<>
                  <Field label="Text"><textarea className="gx-textarea bo-short" value={selected.text} maxLength={2000} onChange={(e) => edit({ ...selected, text: e.target.value })} data-testid="design-text" /></Field>
                  <div className="bo-row"><span className="bo-field-label" data-functional-label="">Type</span>
                    <div className="gx-chips" role="group" aria-label="Type">{fonts.map(([id, label]) => <button key={id} type="button" className="gx-chip" aria-pressed={selected.font === id} onClick={() => edit({ ...selected, font: id })}>{label}</button>)}
                      <button type="button" className="gx-chip" aria-pressed={selected.weight === "bold"} onClick={() => edit({ ...selected, weight: selected.weight === "bold" ? "regular" : "bold" })}>Bold</button></div>
                  </div>
                  <div className="bo-row"><span className="bo-field-label" data-functional-label="">Align</span>
                    <div className="gx-chips" role="group" aria-label="Align">{(["left", "center", "right"] as const).map((a) => <button key={a} type="button" className="gx-chip" aria-pressed={selected.align === a} onClick={() => edit({ ...selected, align: a })}>{a[0].toUpperCase() + a.slice(1)}</button>)}</div>
                  </div>
                  <Field label="Type size (% of the width)"><input className="gx-field" type="number" min={1} max={25} step={0.5} value={selected.size} onChange={(e) => edit({ ...selected, size: clamp(Number(e.target.value), 1, 25) })} /></Field>
                </>) : null}
                {selected.kind === "image" ? (
                  <div className="bo-row"><span className="bo-field-label" data-functional-label="">Fit</span>
                    <div className="gx-chips" role="group" aria-label="Fit">{([["contain", "Whole image"], ["cover", "Fill and crop"]] as const).map(([id, label]) => <button key={id} type="button" className="gx-chip" aria-pressed={selected.fit === id} onClick={() => edit({ ...selected, fit: id })}>{label}</button>)}</div>
                  </div>
                ) : null}
                {selected.kind !== "image" ? (
                  <div className="bo-row"><span className="bo-field-label" data-functional-label="">Colour</span>
                    <span className="bo-swatch"><input type="color" aria-label="Layer colour" value={selected.color} onChange={(e) => edit({ ...selected, color: e.target.value })} /><span className="bo-mono">{selected.color.toUpperCase()}</span></span>
                  </div>
                ) : null}
                {selected.kind === "shape" ? <Field label="Corner radius (%)"><input className="gx-field" type="number" min={0} max={50} value={selected.radius} onChange={(e) => edit({ ...selected, radius: clamp(Number(e.target.value), 0, 50) })} /></Field> : null}
                <div className="bo-pair">
                  {(["x", "y", "width", "height"] as const).map((key) => (
                    <Field key={key} label={key === "x" ? "Left (%)" : key === "y" ? "Top (%)" : key === "width" ? "Width (%)" : "Height (%)"}>
                      <input className="gx-field" type="number" min={key === "x" || key === "y" ? 0 : 1} max={100} step={0.5} value={Math.round(selected[key] * 10) / 10} onChange={(e) => edit({ ...selected, [key]: clamp(Number(e.target.value), key === "x" || key === "y" ? 0 : 1, 100) })} />
                    </Field>
                  ))}
                </div>
                <Field label={`Opacity · ${Math.round(selected.opacity * 100)}%`}><input className="bo-range" type="range" min={0} max={1} step={0.01} value={selected.opacity} onChange={(e) => edit({ ...selected, opacity: clamp(Number(e.target.value), 0, 1) })} /></Field>
                <div className="gx-gen-enhance">
                  <button type="button" className="gx-hbtn" onClick={() => move(1)}>Forward</button>
                  <button type="button" className="gx-hbtn" onClick={() => move(-1)}>Backward</button>
                  <button type="button" className="gx-hbtn gx-hbtn--danger" onClick={() => setPoster((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== selected.id) }))} data-testid="design-delete">Delete the layer</button>
                </div>
              </fieldset>
            ) : null}
          </div>
        </div>
        <div className="bo-row">
          <span className="bo-field-label" data-functional-label="">Export size</span>
          <div className="gx-chips" role="group" aria-label="Export size" data-testid="design-edge">{EDGES.map((n) => <button key={n} type="button" className="gx-chip" aria-pressed={edge === n} onClick={() => setEdge(n)}>{n.toLocaleString("en-US")} px</button>)}</div>
        </div>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" disabled={Boolean(work.busy) || Boolean(previewError)} onClick={() => void exportPng(false)} data-testid="design-export">{work.busy === "export" ? "Rendering…" : "Export PNG"}</button>
          <button type="button" className="gx-primary" disabled={Boolean(work.busy) || Boolean(previewError)} onClick={() => void exportPng(true)} data-testid="design-save">{work.busy === "save" ? "Rendering…" : "Save to the Library"}</button>
        </div>
        <Said error={work.error} notice={work.notice} testId="design" />
      </section>
      <SaveLine editor={editor} testId="design-save-state" />
    </div>
  );
}
