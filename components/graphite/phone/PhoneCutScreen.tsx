"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TimelinePreview } from "@/components/workbench/TimelinePreview";
import { colorLutAsset } from "@/lib/workbench/color";
import type { Project } from "@/lib/workbench/studio";
import { reviewProjectTake, type LibraryEntry } from "@/lib/workspace/library";
import { shotAt } from "@/lib/workspace/stems";
import { useWorkspace } from "@/lib/workspace/state";
import { cutOf } from "../board/cards/cut/cut-model";
import { clock, shotTakes } from "../board/cards/take/take-model";
import { useLoudness } from "../board/edit/loudness-store";
import { Eyebrow } from "./PhoneChrome";
import { approveWords, cutLine, cutRows, pendingTakes } from "./cut-model";

/**
 * The phone's Cut (Gaps A frames, `screen=cut`): watch the cut (its picture, clip by clip) and approve it, and nothing more.
 * Approving is the takes in the cut that wait for a person, each the review trail's free approval; it spends nothing, and
 * Undo writes every take back. With no connection it waits ("Needs a connection"). Trims, sound, the loudness check and the
 * export are the desktop's Edit & Sound; the loudness line says what the last check there found, and "Not checked" until
 * there was one. There is no captions line: Cut cannot show captions.
 */
export function PhoneCutScreen({ scope, project, items, online }: { scope: string; project: Project | null; items: readonly LibraryEntry[]; online: boolean }) {
  const { toast } = useWorkspace();
  const list = useMemo(() => [...items], [items]);
  const rows = useMemo(() => (project ? shotTakes(project, list) : []), [project, list]);
  const cut = useMemo(() => (project ? cutOf(project, rows, list) : null), [project, rows, list]);
  const loud = useLoudness(project ?? ({ id: "", shots: [], assets: [], fps: 24 } as unknown as Project));
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const total = project ? project.shots.reduce((n, s) => n + s.duration, 0) : 0;
  const fps = project?.fps ?? 24;
  const ticker = useRef<{ at: number; from: number } | null>(null);
  useEffect(() => {
    if (!playing) { ticker.current = null; return; }
    let raf = 0;
    const tick = (now: number) => {
      ticker.current ??= { at: now, from: frame };
      const next = Math.floor(ticker.current.from + ((now - ticker.current.at) / 1000) * fps);
      if (next >= total) { setFrame(0); setPlaying(false); return; }
      setFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The clock restarts from the frame it had when play began.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, fps, total]);
  if (!project || !cut) return <p className="ph-quiet" role="status" data-testid="phone-cut-none">Pick a project on Home to see its cut.</p>;

  const pending = pendingTakes(project, rows, cut);
  const words = approveWords(pending, cut);
  const current = shotAt(project.shots, frame);
  const assets = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a]));
  const approve = async () => {
    if (!words.enabled || !online || busy) return;
    setBusy(true);
    const done: string[] = [];
    try {
      for (const p of pending) { await reviewProjectTake(scope, project.id, p.genId, "approved"); done.push(p.genId); }
      toast(done.length === 1 ? `${pending[0].label} approved` : `${done.length} takes approved`, {
        label: "Undo", kind: "undo",
        run: () => { void Promise.all(done.map((id) => reviewProjectTake(scope, project.id, id, ""))).then(() => toast("Undone"), (e: unknown) => toast(e instanceof Error ? e.message : "The review was not saved.")); },
      });
    } catch (cause) { toast(cause instanceof Error ? cause.message : "The review was not saved."); }
    finally { setBusy(false); }
  };
  const measured = loud.measured;
  return (
    <div className="ph-cut" data-testid="phone-cut">
      <div className="ph-cut-screen" data-testid="phone-cut-screen">
        {current ? <TimelinePreview key={current.shot.id} asset={assets.get(current.shot.assetId)} seconds={(current.shot.sourceIn + frame - current.start) / fps} playing={playing} grade={project.colorGrade} lut={colorLutAsset(project)} /> : <span className="ph-quiet">No takes in the cut yet.</span>}
        <button type="button" className="ph-cut-play" onClick={() => setPlaying((p) => !p)} disabled={!total} aria-label={playing ? "Pause the cut" : "Play the cut"} aria-pressed={playing} data-testid="phone-cut-play">{playing ? "❚❚" : "▶"}</button>
        <span className="ph-cut-time" data-testid="phone-cut-time">{clock(frame / fps)} / {clock(total / fps)}</span>
      </div>
      <div className="ph-cut-chips" role="list" aria-label="Clips in the cut">
        {cut.clips.map((c, i) => <span key={c.id} role="listitem" className="ph-cut-chip" data-approved={c.approved || undefined} data-testid="phone-cut-clip">{project.shots[i] ? c.label.replace(/ · v\d+$/, "") : c.label}</span>)}
        {cut.waiting.map((w) => <span key={w.shot} role="listitem" className="ph-cut-chip" data-waiting="" data-testid="phone-cut-waiting">{`Shot ${w.shot} waits`}</span>)}
      </div>
      <section className="ph-section" aria-label="The cut">
        <Eyebrow>The cut</Eyebrow>
        <p className="ph-row-line" data-testid="phone-cut-line">{cutLine(cut)}</p>
        {cutRows(project, cut, loud.target, measured ? measured.lufs : undefined).map((r) => (
          <div key={r.key} className="ph-row" data-testid={`phone-cut-${r.key}`}><span className="ph-row-title">{r.label}</span><span className="ph-row-line">{r.value}</span></div>
        ))}
      </section>
      <div className="ph-cut-actions" data-testid="mobile-actions">
        <button type="button" className="ph-btn ph-btn--hot ph-btn--wide" disabled={!words.enabled || !online || busy} onClick={() => void approve()} data-testid="phone-cut-approve">{!online && words.enabled ? "Approve the cut · Needs a connection" : words.label}</button>
        <p className="ph-row-line" data-testid="phone-cut-approve-line">{words.line} Approving is free.</p>
      </div>
    </div>
  );
}
