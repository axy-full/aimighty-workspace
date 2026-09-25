"use client";
import { useState } from "react";
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
export function TimelineCut({ project, items, onChange }: { project: Project; items: LibraryEntry[]; onChange: (fn: (p: Project) => Project) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const takes = items.filter((e) => (e.media === "video" || e.media === "image") && e.url);
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  return (
    <section className="pd-cut" aria-label="The cut" data-testid="timeline-cut" data-section="cut">
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
      ) : <p className="gx-hint">The cut is empty. Add takes from the tray below.</p>}
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
