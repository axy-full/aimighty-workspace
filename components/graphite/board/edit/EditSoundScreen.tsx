"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Price } from "@/components/graphite/Price";
import { SoundGenerate } from "@/components/workbench/SoundGenerate";
import { SoundMix } from "@/components/workbench/SoundMix";
import { TimelinePreview } from "@/components/workbench/TimelinePreview";
import { useProductionJobs } from "@/components/workbench/use-production-jobs";
import { useSoundPlacements } from "@/components/workbench/use-sound-placements";
import { TimelineCut } from "@/components/graphite/production/TimelineCut";
import { FREE } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { audioClips } from "@/lib/workbench/audio";
import { colorLutAsset } from "@/lib/workbench/color";
import { LOUDNESS_TARGETS, gainToTarget, loudnessVerdict, verdictWords } from "@/lib/workbench/loudness";
import { measureCutLoudness } from "@/lib/workbench/measure-loudness";
import type { SoundJobTask } from "@/lib/workbench/sound-generate";
import type { Project } from "@/lib/workbench/studio";
import { setShotSeconds } from "@/lib/production/sequence";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { useProjectLibrary } from "@/lib/workspace/library";
import { shotAt, mmss } from "@/lib/workspace/stems";
import { cutOf } from "../cards/cut/cut-model";
import { shotTakes } from "../cards/take/take-model";
import type { BoardCtx } from "../cards/types";
import { editMeta, editTimeline, plannedSeconds, timecode, trimClock, trimOf } from "./edit-model";
import { useLoudness } from "./loudness-store";
import { useCutExport } from "./use-cut-export";
import "./edit-sound.css";

/*
 * Edit & Sound over the board (Gaps A frames, "Edit & Sound"): the cut's picture with its trims, the sound lanes, a loudness
 * check against the target chosen for the deliverable, and the export.
 *
 * Everything here is the code that exists: the draft editor (the same revision-checked save the old page used), the edit's
 * own sequence and audio lanes, Sound generation (SoundGenerate, which quotes its own price before anything is spent), the
 * sound mix, and the browser export (lib/workbench/render-movie.ts). The export is free and runs in this browser ("rendered
 * in your browser · keep this page open"): nothing here claims a server render. The loudness check measures the mix the
 * export would encode (BS.1770, lib/workbench/loudness.ts) and costs nothing. Cut cannot show captions, so there is no
 * captions lane and no captions control.
 */
const TOOLS = [["order", "Order and add takes"], ["mix", "Mix"]] as const;
type Tool = (typeof TOOLS)[number][0];

export function EditSoundScreen({ ctx, onClose }: { ctx: BoardCtx; onClose: () => void }) {
  const draft = useDraftEditor(ctx.scope, ctx.project.id);
  if (!draft.project) {
    return (
      <div className="gx-es-wait" data-testid="es-wait">
        {draft.state.status === "error"
          ? <p role="alert">{draft.state.error || "This project could not be opened."} <button type="button" className="gx-es-btn" onClick={() => void draft.reload()} data-testid="es-retry">Try again</button></p>
          : <p role="status">Loading the edit…</p>}
        <button type="button" className="gx-es-btn" onClick={onClose}>Close</button>
      </div>
    );
  }
  return <EditBody key={draft.project.id} project={draft.project} ctx={ctx} draft={draft} onClose={onClose} />;
}

type Draft = ReturnType<typeof useDraftEditor>;

function EditBody({ project, ctx, draft, onClose }: { project: Project; ctx: BoardCtx; draft: Draft; onClose: () => void }) {
  const scope = ctx.scope;
  const [problem, setProblem] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const jobs = useProductionJobs(project, true, draft.onChange, scope);
  const library = useProjectLibrary(scope, project.id);
  /* Generated sound lands on its lane when it is ready, whichever composer is open (or none). */
  useSoundPlacements({ scope, project, jobs: jobs.mediaJobs, onChange: draft.onChange, onPause: () => setPlaying(false), onPlaced: (m) => { setProblem(null); setLanded(m); }, onFailed: (m) => { setLanded(null); setProblem(m); } });
  const audioPicker = useRef<HTMLInputElement>(null);
  const uploadAudio = async (files: File[]) => {
    if (!files.length) return;
    setProblem(null);
    try { await draft.uploadAssets(files, "Audio"); } catch (error) { setProblem(error instanceof Error ? error.message : "The audio could not be added."); }
  };
  const rows = useMemo(() => shotTakes(project, library.items), [project, library.items]);
  const cut = useMemo(() => cutOf(project, rows, library.items), [project, rows, library.items]);
  const line = useMemo(() => editTimeline(project, cut), [project, cut]);
  const out = useCutExport(project, scope);
  const loud = useLoudness(project);
  const [tool, setTool] = useState<Tool | null>(null);
  const [composing, setComposing] = useState<SoundJobTask | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = project.shots.some((s) => s.id === selected) ? selected : project.shots[0]?.id ?? null;
  const trim = trimOf(project, cut, selectedId);

  /* Transport: the edit owns the clock; the preview and the mix follow it. */
  const total = line.picture.reduce((n, c) => n + c.len, 0);
  const clock = useRef<{ at: number; from: number } | null>(null);
  useEffect(() => {
    if (!playing) { clock.current = null; return; }
    let raf = 0;
    const tick = (now: number) => {
      clock.current ??= { at: now, from: frame };
      const next = Math.floor(clock.current.from + ((now - clock.current.at) / 1000) * project.fps);
      if (next >= total) { setFrame(0); setPlaying(false); return; }
      setFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The clock restarts from the frame it had when play began.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project.fps, total]);
  const current = shotAt(project.shots, frame);
  const assets = useMemo(() => new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a])), [project.assets, project.sharedAssets]);
  const seek = useCallback((to: number) => { setPlaying(false); setFrame(Math.max(0, Math.min(Math.max(0, total - 1), Math.round(to)))); }, [total]);

  /* Loudness: measured on the mix the export encodes, for the sound the cut holds now. */
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const measure = useCallback(async (snapshot: Project) => {
    if (measuring) return;
    setMeasuring(true); setMeasureError(null);
    try {
      const { audioFingerprint } = await import("@/lib/workbench/audio");
      const result = await measureCutLoudness(snapshot, new AbortController().signal);
      loud.record({ fingerprint: audioFingerprint(snapshot), lufs: result.lufs, reduced: result.reduced });
    } catch (cause) {
      setMeasureError(cause instanceof Error ? cause.message : "The check did not finish.");
    } finally { setMeasuring(false); }
  }, [measuring, loud]);
  const lanes = audioClips(project).filter((c) => c.id !== "legacy-soundtrack");
  const measured = loud.measured;
  const verdict = measured ? loudnessVerdict(measured.lufs, loud.target) : null;
  const normalise = () => {
    if (!measured || measured.lufs == null) return;
    const delta = gainToTarget(measured.lufs, loud.target);
    const next: Project = { ...project, audioClips: (project.audioClips ?? []).map((c) => ({ ...c, gainDb: Math.max(-60, Math.min(12, Math.round((c.gainDb + delta) * 10) / 10)) })) };
    draft.onChange(() => next);
    void measure(next);
  };

  const meta = editMeta(project, cut, plannedSeconds(project));
  const ratio = (() => { const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(project.aspect.trim()); return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? `${m[1]} / ${m[2]}` : "16 / 9"; })();
  const pct = (frames: number) => `${(frames / line.span) * 100}%`;
  const running = out.running;
  const percent = out.progress ? Math.round(out.progress.fraction * 100) : 0;
  const canExport = !out.invalid && Boolean(out.format) && cut.clips.length > 0 && !running;
  const why = cut.clips.length === 0 ? "Add takes to the cut first." : out.invalid || out.unavailable || null;

  return (
    <div className="gx-es" data-testid="es" data-rendering={running || undefined}>
      <header className="gx-es-top">
        <div className="gx-es-heading"><strong className="gx-es-title">Edit &amp; Sound</strong><span className="gx-es-meta" data-testid="es-meta">{meta}</span></div>
        <div className="gx-es-acts">
          <button type="button" className="gx-es-btn" onClick={onClose} data-testid="edit-sound-close">Close</button>
          {running ? (
            <>
              <button type="button" className="gx-es-btn" onClick={out.cancel} data-testid="es-cancel">Cancel</button>
              <button type="button" className="gx-es-btn" disabled data-testid="es-progress" role="status">Rendering the movie · {percent}%</button>
            </>
          ) : (
            <button type="button" className="gx-es-btn gx-es-btn--go" disabled={!canExport} title={why ?? "Encodes the cut into a video file in this browser. Free: nothing is charged."} onClick={() => void out.start()} data-testid="es-export" {...spendAttrsOf(FREE)}>
              Export the cut · <Price value={FREE} />
            </button>
          )}
        </div>
      </header>

      <div className="gx-es-stage">
        <div className="gx-es-main gx-scroll">
          <div className="gx-es-viewer" style={{ "--es-ratio": ratio } as CSSProperties} data-testid="es-viewer" aria-label="The cut's picture">
            {current ? (
              <TimelinePreview key={current.shot.id} asset={assets.get(current.shot.assetId)} seconds={(current.shot.sourceIn + frame - current.start) / project.fps} playing={playing} grade={project.colorGrade} lut={colorLutAsset(project)} />
            ) : <span className="gx-es-none">No takes in the cut yet.</span>}
            {running ? (
              <div className="gx-es-veil" data-testid="es-veil">
                <span>{out.progress?.phase ?? "Rendering"} · {percent}% · keep this page open</span>
                <progress max={1} value={out.progress?.fraction ?? 0} aria-label="Export progress" />
              </div>
            ) : null}
          </div>
          <div className="gx-es-transport">
            <button type="button" className="gx-es-btn" onClick={() => setPlaying((p) => !p)} disabled={!total} aria-pressed={playing} data-testid="es-play">{playing ? "Pause" : "Play"}</button>
            <span className="gx-es-time" data-testid="es-time">{timecode(frame, project.fps)} / {timecode(total, project.fps)}</span>
          </div>
          {out.file ? (
            <div className="gx-es-done" role="status" data-testid="es-done">
              <span>Export ready · {out.file.format === "mp4" ? "MP4" : "WebM"} · {out.file.width} × {out.file.height} · {out.file.seconds.toFixed(2)} s · {out.file.audio ? "audio included" : "silent"}{out.file.reduced ? " · mix reduced to stay under full scale" : ""}</span>
              <a className="gx-es-btn gx-es-btn--go" href={out.file.url} download={out.file.name} data-testid="es-download">Download {out.file.format === "mp4" ? "MP4" : "WebM"}</a>
            </div>
          ) : null}
          {out.error ? <p className="gx-es-note" data-tone="bad" role="alert" data-testid="es-export-error">{out.error} <button type="button" className="gx-es-link" onClick={() => void out.start()}>Try again</button></p> : null}
          {problem || draft.state.error ? <p className="gx-es-note" data-tone="bad" role="alert">{problem ?? draft.state.error}</p> : null}
          {landed && !problem ? <p className="gx-es-note" role="status">{landed}</p> : null}

          <div className="gx-es-tools" role="group" aria-label="More editing">
            {TOOLS.map(([id, label]) => (
              <button key={id} type="button" className="gx-es-btn" aria-pressed={tool === id} aria-expanded={tool === id} onClick={() => setTool((t) => (t === id ? null : id))} data-testid={`es-tool-${id}`}>{label}</button>
            ))}
          </div>
          <div className="pxw gx-legacy" data-testid="es-legacy">
            <div className="pxw-content gx-es-legacy">
              {tool === "order" ? <TimelineCut project={project} items={library.items} onChange={draft.onChange} scope={scope} /> : null}
              {/* Always mounted: the mix plays the sound lanes against the transport even while it is folded away. */}
              <div hidden={tool !== "mix"} data-testid="es-mix"><SoundMix project={project} frame={frame} playing={playing} onChange={draft.onChange} onPause={() => setPlaying(false)} onUpload={() => audioPicker.current?.click()} /></div>
              {composing && !ctx.exploreOnly ? (
                <div className="gx-es-compose" data-testid="es-compose">
                  <SoundGenerate key={`${project.id}:${composing}`} initialTask={composing} scope={scope} project={project} frame={frame} jobs={jobs.mediaJobs} enabled onChange={draft.onChange} onSave={() => draft.ensureSaved()} onQueued={() => void jobs.refresh()} />
                </div>
              ) : null}
              <input ref={audioPicker} type="file" accept="audio/*,video/*" multiple hidden aria-label="Upload audio to this project" onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void uploadAudio(files); }} />
            </div>
          </div>
        </div>

        <aside className="gx-es-side gx-scroll" aria-label="Selected clip, loudness and sound">
          <section className="gx-es-sec" data-testid="es-selected">
            <h3 className="gx-es-eyebrow">Selected{trim ? ` · ${trim.label}` : ""}</h3>
            {trim ? (
              <dl className="gx-es-rows">
                <div><dt>Trim in</dt><dd data-testid="es-trim-in">{trimClock(trim.trimIn)}</dd></div>
                <div><dt>Trim out</dt><dd data-testid="es-trim-out">{trimClock(trim.trimOut)}</dd></div>
                <div><dt><label htmlFor="es-length">Length (s)</label></dt><dd><SecondsField id="es-length" key={`${trim.shotId}:${trim.length}`} value={trim.length} onCommit={(s) => draft.onChange((p) => setShotSeconds(p, trim.shotId, s))} /></dd></div>
              </dl>
            ) : <p className="gx-es-quiet">Add takes to the cut, then pick a clip on the timeline.</p>}
          </section>

          <section className="gx-es-sec" data-testid="es-loudness">
            <h3 className="gx-es-eyebrow">Loudness · target per deliverable</h3>
            <div className="gx-es-chips" role="radiogroup" aria-label="Loudness target">
              {LOUDNESS_TARGETS.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={loud.target.id === t.id} className="gx-es-chip" onClick={() => loud.setTarget(t.id)} data-testid={`es-target-${t.id}`}>{loud.target.id === t.id ? "✓ " : ""}{t.label}</button>
              ))}
            </div>
            <div className="gx-es-check">
              <span className="gx-es-result" data-tone={measuring ? undefined : verdict ? (verdict.kind === "ok" ? "ok" : verdict.kind === "silent" ? undefined : "warn") : undefined} role="status" data-testid="es-loudness-result">
                {measuring ? "Measuring the mix…" : measured ? verdictWords(measured.lufs, loud.target) : "Not checked"}
              </span>
              {verdict && (verdict.kind === "loud" || verdict.kind === "quiet") && lanes.length ? (
                <button type="button" className="gx-es-btn" disabled={measuring} onClick={normalise} data-testid="es-normalise">Normalise · <Price value={FREE} /></button>
              ) : null}
              <button type="button" className="gx-es-btn" disabled={measuring || cut.clips.length === 0} onClick={() => void measure(project)} data-testid="es-loudness-check">{measured ? "Check again" : "Check loudness"} · <Price value={FREE} /></button>
            </div>
            {verdict && (verdict.kind === "loud" || verdict.kind === "quiet") && project.clipAudio !== false ? <p className="gx-es-quiet" data-testid="es-loudness-hint">The clips&apos; own sound is part of the mix. Normalise moves the sound lanes only; turn the clips&apos; sound off in Mix to move the rest.</p> : null}
            {measured?.reduced ? <p className="gx-es-quiet">The mix was turned down to stay under full scale before it was measured.</p> : null}
            {measureError ? <p className="gx-es-note" data-tone="bad" role="alert" data-testid="es-loudness-error">{measureError}</p> : null}
          </section>

          <section className="gx-es-sec" data-testid="es-sound">
            <h3 className="gx-es-eyebrow">Sound</h3>
            {/* The sample spends nothing (the board says so once): a new voice line, music or effect is not offered there. */}
            {ctx.exploreOnly ? null : <div className="gx-es-stack">
              <button type="button" className="gx-es-btn gx-es-btn--wide" aria-expanded={composing === "speech"} onClick={() => setComposing((c) => (c === "speech" ? null : "speech"))} data-testid="es-new-voice">New voice line</button>
              <button type="button" className="gx-es-btn gx-es-btn--wide" aria-expanded={composing === "music"} onClick={() => setComposing((c) => (c === "music" ? null : "music"))} data-testid="es-new-music">New music</button>
              <button type="button" className="gx-es-btn gx-es-btn--wide" aria-expanded={composing === "sound"} onClick={() => setComposing((c) => (c === "sound" ? null : "sound"))} data-testid="es-new-effect">New sound effect</button>
            </div>}
            {ctx.exploreOnly ? null : <p className="gx-es-quiet">Each one asks for its words first and shows its price before anything is made.</p>}
            <label className="gx-es-toggle"><input type="checkbox" checked={project.clipAudio !== false} onChange={(e) => draft.onChange((p) => ({ ...p, clipAudio: e.target.checked }))} data-testid="es-clip-audio" /><span>Include the clips&apos; own sound</span></label>
          </section>

          <section className="gx-es-sec" data-testid="es-export-sec">
            <h3 className="gx-es-eyebrow">Export</h3>
            <div className="gx-es-chips" role="radiogroup" aria-label="Resolution">
              {([720, 1080] as const).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={out.resolution === r} disabled={running} className="gx-es-chip" onClick={() => out.setResolution(r)} data-testid={`es-res-${r}`}>{out.resolution === r ? "✓ " : ""}{r}p</button>
              ))}
            </div>
            <p className="gx-es-quiet" data-testid="es-export-words">{out.size ? `${out.size.width} × ${out.size.height} · ` : ""}{project.fps} fps · {project.aspect} · rendered in your browser · keep this page open. Up to 3 minutes, no credits.</p>
            {out.unavailable ? <p className="gx-es-note" data-tone="bad" role="alert">{out.unavailable}</p> : null}
          </section>
        </aside>
      </div>

      <section className="gx-es-line" aria-label="Timeline" data-testid="es-timeline">
        <div className="gx-es-ruler" aria-hidden="true">
          <span className="gx-es-lane-name" />
          <div className="gx-es-track gx-es-ticks">{line.ticks.map((t) => <span key={t} data-end={t * line.fps >= line.span * 0.97 || undefined} style={{ left: pct(t * line.fps) }}>{mmss(t).replace(/^0/, "")}</span>)}</div>
        </div>
        <div className="gx-es-lane" data-testid="es-lane-picture">
          <span className="gx-es-lane-name">Picture</span>
          <div className="gx-es-track" onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * line.span); }}>
            {line.picture.map((c) => (
              <button key={c.id} type="button" className="gx-es-clip" style={{ left: pct(c.start), width: pct(c.len) }} aria-pressed={c.id === selectedId} data-approved={c.approved || undefined}
                onClick={() => { setSelected(c.id); seek(c.start); }} data-testid="es-clip">
                {c.label}{c.trimmed ? " · trimmed" : ""}
              </button>
            ))}
          </div>
        </div>
        {line.waiting.length ? (
          <div className="gx-es-lane" data-testid="es-lane-waiting">
            <span className="gx-es-lane-name">Not in the cut</span>
            <div className="gx-es-track gx-es-track--wait">
              {line.waiting.map((w) => <span key={w.shot} className="gx-es-wait-clip" data-testid="es-waiting">{`Shot ${w.shot} ${w.word}`}</span>)}
            </div>
          </div>
        ) : null}
        {line.lanes.map((l) => (
          <div key={l.id} className="gx-es-lane" data-testid={`es-lane-${l.id}`}>
            <span className="gx-es-lane-name">{l.name}</span>
            <div className="gx-es-track">
              {l.clips.length ? l.clips.map((c) => <span key={c.id} className="gx-es-clip gx-es-clip--sound" data-lane={l.id} data-muted={c.muted || undefined} style={{ left: pct(c.start), width: pct(c.len) }}>{c.label}</span>) : <span className="gx-es-empty">Nothing on this lane yet</span>}
            </div>
          </div>
        ))}
        <span className="gx-es-playhead" style={{ left: `calc(var(--es-name) + (100% - var(--es-name)) * ${frame / line.span})` }} aria-hidden="true" data-testid="es-playhead" />
      </section>
    </div>
  );
}

/** A number of seconds, committed on Enter or when the field is left. */
function SecondsField({ id, value, onCommit }: { id: string; value: number; onCommit: (seconds: number) => void }) {
  const [text, setText] = useState(String(Math.round(value * 100) / 100));
  const commit = () => { const n = Number(text); if (Number.isFinite(n) && n >= 0.1 && n <= 3600 && Math.abs(n - value) > 0.004) onCommit(n); else setText(String(Math.round(value * 100) / 100)); };
  return <input id={id} className="gx-es-input" type="number" inputMode="decimal" min={0.1} max={3600} step={0.1} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} data-testid="es-length" />;
}
