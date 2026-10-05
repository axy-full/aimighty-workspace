"use client";
import { useEffect, useRef, useState } from "react";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { posterDimensions, posterPng, posterSourceIds, renderPoster, type PosterDocument, type PosterLayer } from "@/lib/workbench/moleculr-poster";
import { safeName, uid } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { PicturePicker, Said, adoptEntry, briefOf, changeBrief, refreshLibrary, uploadToDraft, useLatest, useWork } from "../../business/own-kit";
import type { BoardCtx } from "../cards/types";
import { posterFor } from "./designer-model";
import { useRiggedEditor } from "./use-ads-editor";

/*
 * Frame 3 of the Ads board (README § 3.3, "Ads and Social frames" A3): the poster Designer, full screen over the board.
 * Layers · the canvas · the selected layer's panel; Close and Export PNG · free. It runs on today's poster model
 * (lib/workbench/moleculr-poster.ts, saved with the project in `brief.poster`): no engine is called, the export is
 * drawn on this device, and image layers always draw their stored originals. "New background · 3 cr" is left out
 * (decision 32); Save to the Library, hide, lock, export size and one poster per project are kept (gap G7).
 */
const ASPECTS: PosterDocument["aspect"][] = ["1:1", "4:5", "9:16", "16:9"];
const EDGES = [1080, 2160, 3840] as const;
const LAYERS_MAX = 40;
type Font = "system" | "editorial" | "geometric";
/* Sans only in the Suites; a layer already set to the editorial face keeps it until it is changed. */
const FONTS: [Font, string][] = [["system", "System"], ["geometric", "Geometric"]];
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);

export function Designer({ ctx, items, onClose }: { ctx: BoardCtx; items: readonly LibraryEntry[]; onClose: () => void }) {
  const { scope, rig } = ctx;
  const editor = useRiggedEditor(rig);
  const p = rig.project ?? ctx.project;
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
  /* Opens on the headline: the first type layer, else the last layer. */
  const selected = poster?.layers.find((l) => l.id === selectedId) ?? poster?.layers.find((l) => l.kind === "text") ?? poster?.layers.at(-1) ?? null;
  const kit = brief.brandKit;

  /* The poster the Designer opens on: the project's own, or a new one made now (a headline and a call to action, the brand's colour behind them). */
  const made = useRef(false);
  useEffect(() => {
    if (made.current || poster) return;
    made.current = true;
    rig.apply((project) => posterFor(project, uid).project);
  }, [poster, rig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || e.defaultPrevented || el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    const asset = await uploadToDraft(scope, editor, latest.current, file, "Campaign design", "Rendered poster · its layers stay editable in the Designer", posterSourceIds(doc));
    if (!(await editor.ensureSaved())) throw new Error("The poster is uploaded, but the project is not saved yet. Keep it open; it saves again.");
    refreshLibrary(scope, latest.current.id);
    return `${asset.name} is in this project’s Library. Its layers stay editable here.`;
  });

  if (!poster) return <div className="ab-designer" role="dialog" aria-label="Poster" data-testid="ads-designer"><p className="ab-designer-wait" role="status">Opening the poster…</p></div>;
  const size = posterDimensions(poster.aspect, edge);
  const stage = posterDimensions(poster.aspect, 620).width;
  const kitColors = kit?.colors ?? [];
  const fonts: [Font, string][] = selected?.kind === "text" && selected.font === "editorial" ? [...FONTS, ["editorial", "Editorial"]] : FONTS;
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
  return (
    <div className="ab-designer" role="dialog" aria-label="Poster designer" data-testid="ads-designer">
      <header className="ab-designer-head">
        <span className="ab-designer-title"><strong>Poster · {poster.aspect}</strong><span>{size.width} × {size.height}{kit?.name ? ` · ${kit.name}` : ""}</span></span>
        <span className="ab-designer-actions">
          <span className="ab-panel-save" role="status" data-testid="ads-designer-saved">{editor.saveState}</span>
          <button type="button" className="ab-btn" onClick={() => { void rig.save(); onClose(); }} data-testid="ads-designer-close">Close</button>
          <button type="button" className="ab-btn ab-btn--solid" disabled={Boolean(work.busy) || Boolean(previewError)} onClick={() => void exportPng(false)} data-testid="ads-designer-export">
            {work.busy === "export" ? "Rendering…" : <>Export PNG · <Price value={FREE} /></>}
          </button>
        </span>
      </header>
      <div className="ab-designer-main">
        <nav className="ab-layers" aria-label="Layers">
          <span className="ab-eyebrow">Layers</span>
          <ol className="ab-layer-list" data-testid="ads-designer-layers">
            {poster.layers.slice().reverse().map((layer) => (
              <li key={layer.id} className="ab-layer" data-selected={selected?.id === layer.id || undefined}>
                <button type="button" className="ab-layer-main" aria-pressed={selected?.id === layer.id} onClick={() => setSelectedId(layer.id)}>
                  <span>{layer.name || layer.kind}</span><span className="ab-mono">{layer.kind}</span>
                </button>
                <button type="button" className="ab-mini" aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`} disabled={layer.locked} onClick={() => edit({ ...layer, visible: !layer.visible })}>{layer.visible ? "Hide" : "Show"}</button>
                <button type="button" className="ab-mini" aria-label={`${layer.locked ? "Unlock" : "Lock"} ${layer.name}`} aria-pressed={layer.locked} onClick={() => setPoster((d) => ({ ...d, layers: d.layers.map((l) => (l.id === layer.id ? { ...l, locked: !l.locked } : l)) }))}>{layer.locked ? "Locked" : "Lock"}</button>
              </li>
            ))}
          </ol>
          <span className="ab-add">
            <button type="button" className="ab-btn" disabled={poster.layers.length >= LAYERS_MAX} onClick={addText} data-testid="ads-designer-add-text">+ Text</button>
            <button type="button" className="ab-btn" disabled={poster.layers.length >= LAYERS_MAX} onClick={() => setAdding(!adding)} aria-expanded={adding} data-testid="ads-designer-add-image">+ Image</button>
            <button type="button" className="ab-btn" disabled={poster.layers.length >= LAYERS_MAX} onClick={addShape} data-testid="ads-designer-add-shape">+ Shape</button>
          </span>
          {adding ? <PicturePicker items={items} label="Poster images" busy={work.busy === "upload"} onPick={takeImage} onUpload={(f) => void uploadImage(f)} testId="ads-designer-picker" /> : null}
          <span className="ab-eyebrow">Canvas</span>
          <span className="ab-chips" role="group" aria-label="Canvas">{ASPECTS.map((a) => <button key={a} type="button" className="ab-chip" aria-pressed={poster.aspect === a} onClick={() => setPoster((d) => ({ ...d, aspect: a }))}>{a}</button>)}</span>
          <span className="ab-eyebrow">Export size</span>
          <span className="ab-chips" role="group" aria-label="Export size">{EDGES.map((n) => <button key={n} type="button" className="ab-chip" aria-pressed={edge === n} onClick={() => setEdge(n)}>{n.toLocaleString("en-US")} px</button>)}</span>
          <button type="button" className="ab-btn" disabled={Boolean(work.busy) || Boolean(previewError)} onClick={() => void exportPng(true)} data-testid="ads-designer-save">{work.busy === "save" ? "Rendering…" : "Save to the Library"}</button>
          <Said error={work.error} notice={work.notice} testId="ads-designer" />
        </nav>
        <div className="ab-stage" data-testid="ads-designer-stage">
          <div className="ab-canvas" style={{ aspectRatio: poster.aspect.replace(":", " / "), width: `min(100%, ${stage}px)` }}>
            <canvas ref={preview} aria-label="Poster preview" />
            <div className="ab-hits">
              {poster.layers.filter((l) => l.visible).map((layer) => (
                <button type="button" key={layer.id} className="ab-hit" aria-label={`Select layer ${layer.name}`} aria-pressed={selected?.id === layer.id}
                  style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%` }}
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
          {previewError ? <p className="ab-note" data-tone="bad" role="alert">{previewError}</p> : null}
        </div>
        <aside className="ab-inspect" aria-label="Layer" data-testid="ads-designer-inspector">
          {selected ? (
            <fieldset className="ab-fields" disabled={selected.locked}>
              <label className="ab-field">
                <span className="ab-eyebrow">{selected.name || selected.kind}</span>
                {selected.kind === "text" ? (
                  <textarea className="ab-input nodrag" rows={3} aria-label={selected.name || "Text"} value={selected.text} maxLength={2000} onChange={(e) => edit({ ...selected, text: e.target.value })} data-testid="ads-designer-text" />
                ) : <input className="ab-input" aria-label="Layer name" value={selected.name} maxLength={120} onChange={(e) => edit({ ...selected, name: e.target.value })} />}
              </label>
              {selected.locked ? <p className="ab-note">This layer is locked. Unlock it in the layers to change it.</p> : null}
              {selected.kind === "text" ? (
                <div className="ab-prop"><span>Type</span>
                  <span className="ab-chips" role="group" aria-label="Type">
                    {fonts.map(([id, label]) => <button key={id} type="button" className="ab-chip" aria-pressed={selected.font === id} onClick={() => edit({ ...selected, font: id })}>{label}</button>)}
                    <button type="button" className="ab-chip" aria-pressed={selected.weight === "bold"} onClick={() => edit({ ...selected, weight: selected.weight === "bold" ? "regular" : "bold" })}>Bold</button>
                  </span>
                </div>
              ) : null}
              {selected.kind !== "image" ? (
                <div className="ab-prop"><span>Colour</span>
                  <span className="ab-colour">
                    <input type="color" aria-label="Layer colour" value={selected.color} onChange={(e) => edit({ ...selected, color: e.target.value })} />
                    <span className="ab-mono">{selected.color.toUpperCase()}{kitColors.some((c) => c.toLowerCase() === selected.color.toLowerCase()) ? " · from the brand kit" : ""}</span>
                  </span>
                  {kitColors.length ? <span className="ab-chips" role="group" aria-label="Brand colours">{kitColors.map((c) => <button key={c} type="button" className="ab-swatch" style={{ background: c }} aria-label={`Use ${c.toUpperCase()}`} aria-pressed={selected.color.toLowerCase() === c.toLowerCase()} onClick={() => edit({ ...selected, color: c })} />)}</span> : null}
                </div>
              ) : null}
              {selected.kind === "text" ? <div className="ab-prop"><span>Size</span><input className="ab-input ab-input--num" type="number" min={1} max={25} step={0.5} aria-label="Type size, percent of the width" value={selected.size} onChange={(e) => edit({ ...selected, size: clamp(Number(e.target.value), 1, 25) })} /></div> : null}
              {selected.kind === "image" ? (
                <div className="ab-prop"><span>Fit</span>
                  <span className="ab-chips" role="group" aria-label="Fit">{([["contain", "Whole image"], ["cover", "Fill and crop"]] as const).map(([id, label]) => <button key={id} type="button" className="ab-chip" aria-pressed={selected.fit === id} onClick={() => edit({ ...selected, fit: id })}>{label}</button>)}</span>
                </div>
              ) : null}
              {selected.kind === "shape" ? <div className="ab-prop"><span>Corners</span><input className="ab-input ab-input--num" type="number" min={0} max={50} aria-label="Corner radius, percent" value={selected.radius} onChange={(e) => edit({ ...selected, radius: clamp(Number(e.target.value), 0, 50) })} /></div> : null}
              <details className="ab-advanced">
                <summary>Advanced</summary>
                <span className="ab-pair">
                  {(["x", "y", "width", "height"] as const).map((key) => (
                    <label key={key} className="ab-field"><span>{key === "x" ? "Left %" : key === "y" ? "Top %" : key === "width" ? "Width %" : "Height %"}</span>
                      <input className="ab-input ab-input--num" type="number" min={key === "x" || key === "y" ? 0 : 1} max={100} step={0.5} value={Math.round(selected[key] * 10) / 10} onChange={(e) => edit({ ...selected, [key]: clamp(Number(e.target.value), key === "x" || key === "y" ? 0 : 1, 100) })} /></label>
                  ))}
                </span>
                <label className="ab-field"><span>Opacity · {Math.round(selected.opacity * 100)}%</span><input type="range" min={0} max={1} step={0.01} value={selected.opacity} onChange={(e) => edit({ ...selected, opacity: clamp(Number(e.target.value), 0, 1) })} /></label>
                <span className="ab-add">
                  <button type="button" className="ab-btn" onClick={() => move(1)}>Forward</button>
                  <button type="button" className="ab-btn" onClick={() => move(-1)}>Backward</button>
                  <button type="button" className="ab-btn" onClick={() => setPoster((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== selected.id) }))} data-testid="ads-designer-delete">Delete the layer</button>
                </span>
              </details>
            </fieldset>
          ) : <p className="ab-note">Add a layer to start.</p>}
        </aside>
      </div>
    </div>
  );
}
