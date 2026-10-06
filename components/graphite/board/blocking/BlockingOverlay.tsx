"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Price } from "@/components/graphite/Price";
import type { AstraViewportActions } from "@/components/astra-blender/types";
import { astraSceneSchema, type AstraScene } from "@/lib/astra-blender/scene";
import {
  LENSES, ROLE_LABEL, addFigure, addProp, blockingOf, cameraView, moveAt, moveWords, roleOf, sceneFromShot, shotSource, withBlockingFrame, withCameraView, withLens,
  type Move, type MoveKind,
} from "@/lib/production/blocking";
import { FREE } from "@/lib/shell/price-words";
import { uploadFile } from "@/lib/uploadClient";
import type { Asset } from "@/lib/workbench/studio";
import { typingIn } from "../review/review-model";
import type { BoardCtx } from "../cards/types";
import { closeBlocking, openBlocking, useOpenBlocking } from "./blocking-store";
import "./blocking.css";

const Viewport = dynamic(() => import("@/components/astra-blender/AstraViewport"), { ssr: false, loading: () => <div className="gx-bko-loading">Opening the 3D view…</div> });

/*
 * 3D blocking (gap screens): a full-screen overlay over the board. Empty scene, building (viewport, objects, camera, lens, frame guide,
 * a slow push on a timeline), and saved to the shot: the frame becomes the shot's reference and the card shows it. It reuses the old
 * 3D tool's scene model and viewport (lib/astra-blender, components/astra-blender/AstraViewport.tsx), nothing else of it.
 * Opening, building and saving are free; nothing here sends anything paid. "Prop from a photo" has no price yet and is not wired.
 */

const EMPTY_PREVIEWS = {};
/** The viewport reports its lens as a float (84.99999999999999): a lens is read to a hundredth, so 85mm stays 85mm. */
const tidy = (camera: AstraScene["camera"]): AstraScene["camera"] => ({ ...camera, focalLength: Math.round(camera.focalLength * 100) / 100 });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const blank = (): AstraScene => astraSceneSchema.parse({
  schemaVersion: 1, name: "Shot blocking", objects: [], lights: [], camera: { position: [0, -6, 1.6], target: [0, 0, 1.3], focalLength: 35 },
  world: { color: "#14161a", strength: 0.6 }, timeline: { start: 1, end: 120, fps: 24 }, render: { width: 1280, height: 720, samples: 32, transparent: false },
});

function Num({ label, value, onCommit, min, max, step = 0.1 }: { label: string; value: number; onCommit: (n: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <input key={value} className="gx-bko-num" type="number" inputMode="decimal" aria-label={label} defaultValue={value} min={min} max={max} step={step}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={(e) => { const n = e.currentTarget.valueAsNumber; if (Number.isFinite(n) && n >= (min ?? -Infinity) && n <= (max ?? Infinity)) { if (n !== value) onCommit(n); } else e.currentTarget.value = String(value); }} />
  );
}

function Overlay({ ctx, nodeId }: { ctx: BoardCtx; nodeId: string }) {
  const project = ctx.project;
  const shots = ctx.rig.shots;
  const shot = shots.find((s) => s.id === nodeId) ?? null;
  const saved = blockingOf(project, nodeId);
  const seeded = useMemo(() => (saved ? { scene: saved.scene, move: saved.move } : { scene: blank(), move: { kind: "hold", meters: 0, seconds: shotSource(project, nodeId)?.shot.duration ?? 5 } as Move }),
    // The scene opens as it was saved (or empty) once per shot; later edits are this overlay's own until they are saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId]);
  const [scene, setScene] = useState<AstraScene>(seeded.scene);
  const [move, setMove] = useState<Move>(seeded.move);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const actions = useRef<AstraViewportActions | null>(null);
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const empty = scene.objects.length === 0;
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const view = cameraView(scene);
  const label = shot ? `Shot ${shot.index}` : "this shot";
  const source = shotSource(project, nodeId);
  const duration = move.seconds;

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !typingIn(e.target)) { e.preventDefault(); closeBlocking(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onReady = useCallback((a: AstraViewportActions | null) => { actions.current = a; setReady(Boolean(a)); }, []);
  const edit = (next: AstraScene) => { setPlaying(false); setScene(next); setProblem(null); };

  /* What the camera shows after a drag or a scroll in the viewport is the scene's camera, so the fields below always say where it stands. */
  const sync = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = () => {
    if (sync.current) clearTimeout(sync.current);
    sync.current = setTimeout(() => { const cam = actions.current?.getCamera(); if (cam) setScene((s) => ({ ...s, camera: tidy(cam) })); }, 250);
  };
  useEffect(() => () => { if (sync.current) clearTimeout(sync.current); }, []);

  /* The move: scrubbing or playing puts the camera along it; stopping puts the scene's own camera back. */
  useEffect(() => {
    if (!ready) return;
    actions.current?.setCamera(moveAt(scene, move, t));
    // The scene's camera is only read at the start of a move; t moves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, ready]);
  useEffect(() => {
    if (!playing) return;
    const from = performance.now() - t * duration * 1000;
    let raf = 0;
    const tick = (now: number) => {
      const next = Math.min(1, (now - from) / (duration * 1000));
      setT(next);
      if (next >= 1) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Playback owns its start; a scrub pauses it first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);

  const addFromShot = () => { const made = sceneFromShot(project, nodeId); setScene(made.scene); setMove(made.move); setT(0); setSelectedId(null); setProblem(null); };

  async function saveAsReference() {
    if (busy || blocked || !shot) return;
    const parsed = astraSceneSchema.safeParse({ ...scene, camera: tidy(actions.current?.getCamera() ?? scene.camera) });
    if (!parsed.success) { setProblem(parsed.error.issues[0]?.message ?? "This scene could not be saved."); return; }
    setBusy(true); setProblem(null);
    try {
      actions.current?.setCamera(parsed.data.camera);
      const blob = await actions.current?.capturePng();
      if (!blob) throw new Error("The browser could not export this view. Nothing was saved.");
      const file = new File([blob], `shot-${shot.index}-3d-blocking.png`, { type: "image/png" });
      const up = await uploadFile(file, "reference", undefined, { scope: ctx.scope });
      const asset: Asset = {
        id: `blocking-${up.id}`.slice(0, 100), uploadId: up.id, name: `Shot ${shot.index} · 3D blocking`, kind: "image", category: "3D blocking", url: up.url, mime: up.mime,
        description: "A frame from the 3D blocking of this shot.", prompt: "", status: "Draft", locked: false, version: 1, refs: [],
      };
      /* A locked shot or a full canvas is refused in its own words (rig-build's RigBuildError), and nothing changes. */
      const refused = ctx.rig.apply((p) => withBlockingFrame(p, nodeId, { scene: parsed.data, move, savedAt: new Date().toISOString() }, asset, asset.name));
      if (refused) { setProblem(refused); return; }
      void ctx.rig.save();
      ctx.toast(`Saved to ${label} as its reference · free`);
      closeBlocking();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The frame could not be saved. Nothing was changed.");
    } finally { setBusy(false); }
  }

  const ratio = (() => { const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(project.aspect.trim()); return m ? `${m[1]} / ${m[2]}` : "16 / 9"; })();
  const selected = scene.objects.find((o) => o.id === selectedId) ?? null;
  const sub = [label, source?.shot.duration ? clock(source.shot.duration) : null, source?.shot.framing?.toLowerCase() || null, moveWords(move).toLowerCase(), project.aspect].filter(Boolean).join(" · ");

  return (
    <div ref={box} className="gx-bko" role="dialog" aria-modal="true" aria-label="3D blocking" tabIndex={-1} data-testid="blocking-overlay" data-state={empty ? "empty" : "building"}>
      <div className="gx-bko-top">
        <div className="gx-bko-heading">
          <strong className="gx-bko-title">3D blocking</strong>
          {shots.length > 1 ? (
            <select className="gx-bko-pick" aria-label="Shot" value={nodeId} onChange={(e) => openBlocking(e.target.value)} data-testid="blocking-shot">
              {shots.map((s) => <option key={s.id} value={s.id}>{`Shot ${s.index}`}</option>)}
            </select>
          ) : null}
          <span className="gx-bko-sub" data-testid="blocking-sub">{sub}</span>
        </div>
        <div className="gx-bko-acts">
          <button type="button" className="gx-bko-btn" onClick={closeBlocking} data-testid="blocking-close">Close</button>
          {!empty ? (
            <button type="button" className="gx-bko-btn" data-primary="" disabled={busy || Boolean(blocked) || !ready} title={blocked ?? undefined} onClick={() => void saveAsReference()} data-testid="blocking-save">
              {busy ? "Saving…" : <>Use as reference for {label} · <Price value={FREE} /></>}
            </button>
          ) : null}
        </div>
      </div>
      <div className="gx-bko-main">
        <aside className="gx-bko-side gx-bko-side--l gx-scroll" aria-label="Objects">
          <div>
            <span className="gx-bko-eyebrow">Objects</span>
            {empty ? <p className="gx-bko-note" style={{ marginTop: 8 }}>Nothing in the scene yet.</p> : (
              <ul className="gx-bko-list" data-testid="blocking-objects">
                {scene.objects.map((o) => (
                  <li key={o.id} className="gx-bko-row" data-selected={selectedId === o.id || undefined}>
                    <button type="button" className="gx-bko-pickrow" onClick={() => setSelectedId(o.id)} aria-pressed={selectedId === o.id}>
                      <span className="gx-bko-name">{o.name}</span><span className="gx-bko-kind">{ROLE_LABEL[roleOf(o)]}</span>
                    </button>
                    <button type="button" className="gx-bko-btn" aria-pressed={o.visible} onClick={() => edit({ ...scene, objects: scene.objects.map((x) => (x.id === o.id ? { ...x, visible: !x.visible } : x)) })} data-testid="blocking-toggle">{o.visible ? "Shown" : "Hidden"}</button>
                  </li>
                ))}
                {scene.lights.map((l) => (
                  <li key={l.id} className="gx-bko-row"><span><span className="gx-bko-name">{l.name}</span><span className="gx-bko-kind">{l.type === "sun" ? "Key light" : "Light"}</span></span></li>
                ))}
              </ul>
            )}
            {selected ? <button type="button" className="gx-bko-add" style={{ marginTop: 10 }} onClick={() => { edit({ ...scene, objects: scene.objects.filter((o) => o.id !== selected.id) }); setSelectedId(null); }} data-testid="blocking-remove">Remove {selected.name}</button> : null}
          </div>
          <div>
            <span className="gx-bko-eyebrow">Add</span>
            <div className="gx-bko-adds">
              <button type="button" className="gx-bko-add" onClick={() => edit(addFigure(scene))} data-testid="blocking-add-figure">Figure</button>
              <button type="button" className="gx-bko-add" onClick={() => edit(addProp(scene))} data-testid="blocking-add-prop">Prop</button>
              {/* No price function and no provider are wired for this: it shows, disabled, with the words that say why. */}
              <button type="button" className="gx-bko-add" disabled aria-disabled="true" data-spend="unpriced" title="This has no price yet" data-testid="blocking-add-photo">Prop from a photo · price pending</button>
            </div>
          </div>
        </aside>
        <main className="gx-bko-stage">
          <div className="gx-bko-vp" onPointerUp={settle} onWheel={settle}>
            <div className="gx-bko-frame" style={{ ["--gx-bko-ratio" as string]: ratio }} data-testid="blocking-frame">
              <Viewport scene={scene} frame={1} selectedId={selectedId} mode="translate" grid playing={false} assetPreviews={EMPTY_PREVIEWS} quiet
                onSelect={setSelectedId}
                onTransform={(id, tr) => edit({ ...scene, objects: scene.objects.map((o) => (o.id === id ? { ...o, ...tr } : o)) })}
                onReady={onReady} />
              {empty ? (
                <div className="gx-bko-empty" data-testid="blocking-empty">
                  <strong>An empty scene</strong>
                  <button type="button" className="gx-bko-btn" data-primary="" onClick={addFromShot} data-testid="blocking-from-shot">Add from {label} · <Price value={FREE} /></button>
                </div>
              ) : null}
            </div>
          </div>
          {problem ? <p className="gx-bko-warn" role="alert" style={{ textAlign: "center", padding: "0 20px 8px" }}>{problem}</p> : <p className="gx-bko-help">Drag to orbit · scroll to zoom · shift-drag to pan · drag an object by its arrows</p>}
          <div className="gx-bko-tl" data-testid="blocking-timeline">
            <div className="gx-bko-tl-head">
              <span className="gx-bko-eyebrow">Camera move</span>
              <span>{moveWords(move)}{move.kind === "hold" ? "" : ` over ${duration} s`}</span>
              <button type="button" className="gx-bko-btn" disabled={move.kind === "hold" || !ready} aria-pressed={playing}
                onClick={() => { if (playing) setPlaying(false); else { if (t >= 1) setT(0); setPlaying(true); } }} data-testid="blocking-play">{playing ? "Pause" : "Play the move"}</button>
            </div>
            <div className="gx-bko-track">
              <input type="range" min={0} max={1000} step={1} value={Math.round(t * 1000)} aria-label="Camera move position" disabled={move.kind === "hold"}
                onChange={(e) => { setPlaying(false); setT(Number(e.target.value) / 1000); }} data-testid="blocking-scrub" />
              <span className="gx-bko-key" style={{ left: 0 }} aria-hidden="true" /><span className="gx-bko-key" style={{ left: "100%" }} aria-hidden="true" />
            </div>
            <div className="gx-bko-ticks"><span>0:00</span><span>{clock(duration / 2)}</span><span>{clock(duration)}</span></div>
          </div>
        </main>
        <aside className="gx-bko-side gx-bko-side--r gx-scroll" aria-label="Camera">
          <div>
            <span className="gx-bko-eyebrow">Camera</span>
            <div className="gx-bko-field"><span>Position across</span><Num label="Camera position across, metres" value={view.x} onCommit={(x) => edit(withCameraView(scene, { x }))} /></div>
            <div className="gx-bko-field"><span>Position depth</span><Num label="Camera position depth, metres" value={view.depth} onCommit={(depth) => edit(withCameraView(scene, { depth }))} /></div>
            <div className="gx-bko-field"><span>Height</span><Num label="Camera height, metres" value={view.height} min={0.1} max={50} onCommit={(height) => edit(withCameraView(scene, { height }))} /></div>
            <div className="gx-bko-field"><span>Tilt</span><Num label="Camera tilt, degrees" value={view.tilt} min={-80} max={80} step={1} onCommit={(tilt) => edit(withCameraView(scene, { tilt }))} /></div>
          </div>
          <div>
            <span className="gx-bko-eyebrow">Lens</span>
            <div className="gx-bko-seg" role="group" aria-label="Lens" style={{ marginTop: 8 }}>
              {LENSES.map((l) => <button key={l} type="button" aria-pressed={view.lens === l} onClick={() => edit(withLens(scene, l))} data-testid={`blocking-lens-${l}`}>{l}mm</button>)}
            </div>
            <div className="gx-bko-field"><span>Frame guide</span><span data-testid="blocking-guide">{project.aspect} · from the brief</span></div>
            <div className="gx-bko-field">
              <span>Move</span>
              <div className="gx-bko-seg" role="group" aria-label="Move">
                {(["hold", "push", "pull"] as MoveKind[]).map((k) => (
                  <button key={k} type="button" aria-pressed={move.kind === k} data-testid={`blocking-move-${k}`}
                    onClick={() => { setPlaying(false); setT(0); setMove({ ...move, kind: k, meters: k === "hold" ? 0 : move.meters || 1.2 }); }}>{k === "hold" ? "Hold" : k === "push" ? "Push" : "Pull"}</button>
                ))}
              </div>
            </div>
            {move.kind !== "hold" ? <div className="gx-bko-field"><span>Distance (m)</span><Num label="Move distance, metres" value={move.meters} min={0.1} max={100} onCommit={(meters) => { setPlaying(false); setT(0); setMove({ ...move, meters }); }} /></div> : null}
          </div>
          <p className="gx-bko-note">Free: opening, building and saving cost nothing. The saved frame is {label}&rsquo;s reference; remaking the shot is priced where you press it.</p>
        </aside>
      </div>
    </div>
  );
}

/** The 3D blocking overlay the board mounts once (components/graphite/board/GapOverlays.tsx). */
export function BlockingOverlay({ ctx }: { ctx: BoardCtx }) {
  const open = useOpenBlocking();
  return open ? <Overlay key={open.nodeId} ctx={ctx} nodeId={open.nodeId} /> : null;
}
