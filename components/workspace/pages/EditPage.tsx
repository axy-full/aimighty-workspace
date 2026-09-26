"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SoundGenerate } from "@/components/workbench/SoundGenerate";
import { useSoundPlacements } from "@/components/workbench/use-sound-placements";
import { SoundMix } from "@/components/workbench/SoundMix";
import { TimelinePreview } from "@/components/workbench/TimelinePreview";
import { useProductionJobs } from "@/components/workbench/use-production-jobs";
import { colorLutAsset } from "@/lib/workbench/color";
import type { SoundJobTask } from "@/lib/workbench/sound-generate";
import type { Project } from "@/lib/workbench/studio";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { useProjectLibrary } from "@/lib/workspace/library";
import { assembly, mmss, shotAt, stemRequests, stemRows, type StemId, type StemRow } from "@/lib/workspace/stems";
import { Button } from "../ui";
import type { PageBodyProps } from "./registry";
import "@/app/workspace-assets.css";
import { TimelineCut } from "@/components/graphite/production/TimelineCut";

const STATE: Record<StemRow["state"], { label: string; dot: string }> = {
  empty: { label: "Empty", dot: "var(--pxw-label-floor)" },
  generating: { label: "Generating", dot: "var(--pxw-blue-ink)" },
  scored: { label: "Scored", dot: "var(--pxw-green)" },
};

/** Edit & Sound: the assembly, its sound stems, and the mix. */
export function EditPage({ project: shellProject, scope }: PageBodyProps) {
  const draft = useDraftEditor(scope, shellProject?.id ?? null);
  if (!draft.project) {
    /* A failed read says so and offers it again; it never sits beside a loading line that will not change. */
    if (shellProject && draft.state.status === "error") {
      return (
        <div className="pxw-edit" data-page-body="edit">
          <p className="pxw-notice pxw-notice--error" role="alert">
            {draft.state.error || "This project could not be opened."}{" "}
            <Button onClick={() => void draft.reload()} data-testid="edit-retry">Retry</Button>
          </p>
        </div>
      );
    }
    return (
      <div className="pxw-edit" data-page-body="edit">
        <p className="pxw-empty" role="status">{shellProject ? "Loading the edit…" : "Open a project to see its edit."}</p>
      </div>
    );
  }
  return <EditBody key={draft.project.id} project={draft.project} scope={scope} draft={draft} />;
}

function EditBody({ project, scope, draft }: { project: Project; scope: string; draft: ReturnType<typeof useDraftEditor> }) {
  const jobs = useProductionJobs(project, true, draft.onChange, scope);
  const library = useProjectLibrary(scope, project.id);
  const [open, setOpen] = useState<{ stem: StemId; task: SoundJobTask } | null>(null);
  const [mixOpen, setMixOpen] = useState(false);
  const [composed, setComposed] = useState<Partial<Record<StemId, { task: SoundJobTask; body: Record<string, unknown>; text: string } | null>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const audioPicker = useRef<HTMLInputElement>(null);

  /* Transport: the edit owns the clock; TimelinePreview and the mix follow it. */
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pause = useCallback(() => setPlaying(false), []);
  const placed = useCallback((message: string) => { setProblem(null); setLanded(message); }, []);
  const failed = useCallback((message: string) => { setLanded(null); setProblem(message); }, []);
  /* Generated sound lands on its lane when it is ready, whichever stem row is open (or none). */
  const placements = useSoundPlacements({ scope, project, jobs: jobs.mediaJobs, onChange: draft.onChange, onPause: pause, onPlaced: placed, onFailed: failed });
  const rows = useMemo(() => stemRows(project, placements), [project, placements]);
  const cut = assembly(project);
  const clock = useRef<{ at: number; from: number } | null>(null);
  useEffect(() => {
    if (!playing) { clock.current = null; return; }
    let raf = 0;
    const tick = (now: number) => {
      clock.current ??= { at: now, from: frame };
      const next = Math.floor(clock.current.from + ((now - clock.current.at) / 1000) * project.fps);
      if (next >= cut.frames) { setFrame(0); setPlaying(false); return; }
      setFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The clock restarts from the frame it had when play began.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project.fps, cut.frames]);
  const current = shotAt(project.shots, frame);
  const assetsById = useMemo(() => new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a])), [project.assets, project.sharedAssets]);

  /* Approved takes in the cut: sequence clips whose generation is approved in the project library. */
  const approved = library.state.status === "ready"
    ? project.shots.filter((s) => {
      const id = assetsById.get(s.assetId)?.generationId;
      return !!id && library.state.generations.some((g) => g.id === id && g.reviewState === "approved");
    }).length
    : null;

  /* The Edit & Sound plan's request: what each open stem form would submit. */
  const stems = useMemo(() => stemRequests(project, composed), [project, composed]);
  usePlanRequest("stems", stems);

  const toggle = (row: StemRow) => setOpen((o) => (o?.stem === row.id && o.task === row.action.task ? null : { stem: row.id, task: row.action.task }));
  const uploadAudio = async (files: File[]) => {
    if (!files.length) return;
    setProblem(null);
    try { await draft.uploadAssets(files, "Audio"); } catch (error) { setProblem(error instanceof Error ? error.message : "The audio could not be added."); }
  };

  return (
    <div className="pxw-edit" data-page-body="edit" data-stem-requests={stems.length}>
      {problem || draft.state.error ? <p className="pxw-notice pxw-notice--error" role="alert">{problem ?? draft.state.error}</p> : null}
      {landed && !problem ? <p className="pxw-notice" role="status">{landed}</p> : null}
      <div className="pxw-assembly" data-testid="assembly" data-section="assembly">
        <div className="pxw-assembly-screen" aria-hidden={!current}>
          {current ? (
            <TimelinePreview
              key={current.shot.id}
              asset={assetsById.get(current.shot.assetId)}
              seconds={(current.shot.sourceIn + frame - current.start) / project.fps}
              playing={playing}
              grade={project.colorGrade}
              lut={colorLutAsset(project)}
            />
          ) : null}
        </div>
        <div className="pxw-assembly-text">
          <div className="pxw-assembly-title" data-testid="assembly-title">Assembly · {mmss(cut.seconds)}</div>
          <div className="pxw-assembly-sub">
            {cut.clips
              ? [`${cut.clips.toLocaleString("en-US")} ${cut.clips === 1 ? "clip" : "clips"}`, approved == null ? null : `${approved.toLocaleString("en-US")} approved ${approved === 1 ? "take" : "takes"}`, playing || frame ? mmss(frame / project.fps) : null].filter(Boolean).join(" · ")
              : "No takes in the sequence yet. Add them from the tray below."}
          </div>
        </div>
        <div className="pxw-spacer" />
        <Button onClick={() => setMixOpen((v) => !v)} aria-expanded={mixOpen} aria-controls="pxw-mix">Mix</Button>
        <Button onClick={() => setPlaying((p) => !p)} disabled={!cut.frames} aria-pressed={playing}>{playing ? "Pause" : "Play"}</Button>
      </div>

      <TimelineCut project={project} items={library.items} onChange={draft.onChange} scope={scope} />

      {rows.map((row) => {
        const s = STATE[row.state];
        const expanded = open?.stem === row.id;
        return (
          <div key={row.id} className="pxw-stem-wrap" data-section={row === rows[0] ? "sound" : undefined}>
            <div className="pxw-stem" data-stem={row.id} data-state={row.state}>
              <span className="pxw-stem-bar" style={{ background: row.state === "empty" ? "#2E2E34" : row.hue }} aria-hidden="true" />
              <span className="pxw-stem-name">
                <span>{row.name}</span>
                <span>{row.engine}</span>
              </span>
              <span className="pxw-stem-desc">
                <span>{row.names.length ? row.names.join(" · ") : row.empty}</span>
                {row.clips.length || row.pending ? (
                  <span className="pxw-stem-chips">
                    {row.clips.length ? <span>{`${row.clips.length.toLocaleString("en-US")} ${row.clips.length === 1 ? "clip" : "clips"}`}</span> : null}
                    {row.clips.length ? <span>{mmss(row.seconds)}</span> : null}
                    {row.pending ? <span>{`${row.pending.toLocaleString("en-US")} generating`}</span> : null}
                  </span>
                ) : null}
              </span>
              <span className="pxw-stem-state">
                <span className="pxw-dot" style={{ background: s.dot }} aria-hidden="true" />
                <span>{s.label}</span>
              </span>
              <Button className="pxw-stem-action" aria-expanded={expanded} onClick={() => toggle(row)}>{row.action.label}</Button>
            </div>
            {expanded && open ? (
              <div className="pxw-sound-host" data-testid={`composer-${row.id}`}>
                <SoundGenerate
                  key={`${project.id}:${open.task}`}
                  initialTask={open.task}
                  scope={scope}
                  project={project}
                  frame={frame}
                  jobs={jobs.mediaJobs}
                  enabled
                  onChange={draft.onChange}
                  onSave={() => draft.ensureSaved()}
                  onQueued={() => void jobs.refresh()}
                  onRequest={(request) => setComposed((c) => ({ ...c, [row.id]: request }))}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="pxw-stem-note">Ambience has no lane of its own in the edit; beds are generated as sound effects and sit on that lane.</p>

      <input ref={audioPicker} type="file" accept="audio/*,video/*" multiple hidden aria-label="Upload audio to this project" onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        void uploadAudio(files);
      }} />
      <div id="pxw-mix" className="pxw-sound-host" hidden={!mixOpen} data-testid="mix">
        {/* Always mounted: the mix plays the audio lanes against the transport even while folded away. */}
        <SoundMix project={project} frame={frame} playing={playing} onChange={draft.onChange} onPause={pause} onUpload={() => audioPicker.current?.click()} />
      </div>
    </div>
  );
}
