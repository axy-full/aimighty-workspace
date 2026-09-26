"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { isDroppable, readDrop } from "@/lib/drop";
import { uploadFilesToProject } from "@/lib/workspace/library";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";
import { addTakeToCut, moveShot, removeShot, setShotSeconds } from "@/lib/production/sequence";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * Production › Timeline: the picture track as a list — every shot in order, its
 * length in seconds, moved or taken out — and the project's takes, any of which
 * goes on the end of the cut in one press. Sound stays in the lanes below.
 */
export function TimelineCut({ project, items, onChange, scope }: { project: Project; items: LibraryEntry[]; onChange: (fn: (p: Project) => Project) => void; scope?: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const takes = useMemo(() => items.filter((e) => (e.media === "video" || e.media === "image") && e.url), [items]);
  /* Dropped files join the cut once the Library lists them (their upload reloads it) — whichever of the two comes last. */
  const pending = useRef<string[]>([]);
  const [landed, setLanded] = useState(0);
  useEffect(() => {
    if (!pending.current.length) return;
    const ready = pending.current.map((id) => takes.find((t) => t.take.id === id)).filter((t): t is LibraryEntry => Boolean(t));
    if (!ready.length) return;
    pending.current = pending.current.filter((id) => !ready.some((t) => t.take.id === id));
    /* A full cut or asset library says so, as a drop does; it never throws out of the effect. */
    let why: string | null = null;
    onChange((p) => ready.reduce((acc, t) => { if (why) return acc; try { return addTakeToCut(acc, t); } catch (cause) { why = cause instanceof Error ? cause.message : "It could not be added."; return acc; } }, p));
    if (why) setProblem(why);
  }, [takes, onChange, landed]);
  /* A take dropped on the cut goes on its end: a tile from anywhere, or picture and video files from the device. */
  const drop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false); setProblem(null);
    const { ids, files } = readDrop(e.dataTransfer, project.assets);
    const found = ids.map((id) => takes.find((t) => t.take.id === id)).filter((t): t is LibraryEntry => Boolean(t));
    if (ids.length > found.length) setProblem("Only this project's pictures and videos go on the picture track.");
    if (found.length) { try { onChange((p) => found.reduce((acc, t) => addTakeToCut(acc, t), p)); } catch (cause) { setProblem(cause instanceof Error ? cause.message : "It could not be added."); } }
    if (!files.length) return;
    if (!scope) { setProblem("Files cannot be uploaded here."); return; }
    void uploadFilesToProject(scope, project.id, files).then(({ uploads, notes }) => {
      pending.current.push(...uploads.filter((u) => u.kind === "image" || u.kind === "video").map((u) => `upload:${u.id}`));
      setLanded((n) => n + 1);
      const skipped = uploads.filter((u) => u.kind !== "image" && u.kind !== "video").length;
      if (notes.length || skipped) setProblem([...notes, ...(skipped ? ["Sound and documents are kept in the Library; sound goes on the lanes below."] : [])].join(" "));
    }).catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : "The files could not be uploaded."));
  };
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  return (
    <section className="pd-cut" aria-label="The cut" data-testid="timeline-cut" data-section="cut" data-drop={over || undefined}
      onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }} onDrop={drop}>
      <div className="pd-row-head">
        <span className="gx-eyebrow" data-functional-label="">Picture · {project.shots.length} {project.shots.length === 1 ? "shot" : "shots"}</span>
      </div>
      {project.shots.length ? (
        <ol className="pd-cut-list">
          {project.shots.map((shot, i) => {
            const asset = assets.get(shot.assetId);
            return (
              <li key={shot.id} className="pd-cut-row" data-testid="timeline-shot">
                <span className="pd-cut-thumb">{asset?.url && (asset.kind === "image" || asset.kind === "video") ? <LazyMedia url={asset.url} kind={asset.kind} alt="" name={asset.name} className="gx-lazy" /> : asset ? <span {...previewAttrs(assetPreview(asset))} aria-hidden="true">♪</span> : null}</span>
                <span className="pd-cut-name" title={shot.name}>{shot.name}</span>
                <label className="pd-seconds"><span className="gx-hint">Seconds</span>
                  <input className="gx-field" type="number" min={0.1} max={3600} step={0.5} aria-label={`${shot.name} seconds`} value={Math.round((shot.duration / project.fps) * 100) / 100}
                    onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onChange((p) => setShotSeconds(p, shot.id, n)); }} />
                </label>
                <span className="pd-order">
                  <button type="button" className="gx-hbtn" aria-label={`Move ${shot.name} earlier`} disabled={i === 0} onClick={() => onChange((p) => moveShot(p, i, -1))}>↑</button>
                  <button type="button" className="gx-hbtn" aria-label={`Move ${shot.name} later`} disabled={i === project.shots.length - 1} onClick={() => onChange((p) => moveShot(p, i, 1))}>↓</button>
                  <button type="button" className="gx-hbtn" aria-label={`Take ${shot.name} out of the cut`} onClick={() => onChange((p) => removeShot(p, shot.id))}>×</button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : <p className="gx-hint">The cut is empty. Add takes from the tray below, or drop them here.</p>}
      <details className="pd-more" open={!project.shots.length}>
        <summary>Add takes · {takes.length} in this project</summary>
        <div className="pd-take-grid" role="list" aria-label="Takes to add">
          {takes.map((e) => (
            <div key={e.take.id} className="pd-take" role="listitem">
              <LazyMedia url={e.url!} kind={e.media === "video" ? "video" : "image"} alt="" name={e.take.name} className="gx-lazy" />
              <span className="gx-badge">{e.media === "video" ? "VIDEO" : "IMAGE"}</span>
              <span className="pd-take-name">{e.take.name}</span>
              <button type="button" className="gx-hbtn pd-take-add" aria-label={`Add ${e.take.name} to the cut`} onClick={() => { setProblem(null); try { onChange((p) => addTakeToCut(p, e)); } catch (cause) { setProblem(cause instanceof Error ? cause.message : "It could not be added."); } }} data-testid="timeline-add">+ Add</button>
            </div>
          ))}
          {!takes.length ? <p className="gx-hint">No takes yet — render them in Storyboards, Cast, Rig or Edit.</p> : null}
        </div>
      </details>
      {problem ? <p className="gx-gen-error" role="alert">{problem}</p> : null}
    </section>
  );
}
