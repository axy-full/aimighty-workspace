"use client";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { useShell } from "@/lib/shell/state";
import { useFreshProject } from "@/lib/shell/use-fresh-project";
import { recentTakes, stageCards, upNext } from "@/lib/shell/studio-home";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { Glyph } from "../icons";

/**
 * Studio home (Particl Mobile.dc.html › STUDIO HOME): the project's name in
 * the gradient, *Up next* (the first shot without a render, one tap into Rig),
 * the eight stages as cards with a live line and a status dot, and the recent
 * takes. Every card routes to its page; every figure is the project's own.
 */
export function StudioHome({ project: loaded, items }: { project: Project | null; items: LibraryEntry[] }) {
  const shell = useShell();
  /* The stages edit their own drafts: the grid counts the project as saved now, not as first loaded. */
  const project = useFreshProject(loaded);
  const { dispatch } = useWorkspace();
  const cards = stageCards(project, items);
  const next = upNext(project);
  const recent = recentTakes(items);
  const openTake = (entry: LibraryEntry) => {
    dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } });
    shell.openInspector();
  };
  return (
    <div className="gx-home gx-enter" data-testid="studio-home">
      <span className="gx-home-eyebrow">Studio</span>
      <h1 className="gx-h1 gx-home-title" data-testid="page-title">{project?.name ?? "No project"}</h1>
      {next ? (
        <div className="gx-home-next" data-testid="home-up-next">
          <span className="gx-home-next-ic" aria-hidden="true"><Glyph name="spark" size={20} /></span>
          <span className="gx-home-next-text">
            <span className="gx-home-next-title">Up next · Shot {String(next.index).padStart(2, "0")}</span>
            <span className="gx-home-next-meta">{next.name} · quoted when you open it</span>
          </span>
          <button type="button" className="gx-primary" onClick={() => shell.goSuite("studio", "rig")} data-testid="home-generate-next">Open in Rig</button>
        </div>
      ) : null}
      <div className="gx-home-grid" role="list" aria-label="Stages">
        {cards.map((card) => (
          <button key={card.id} type="button" role="listitem" className="gx-home-card" data-status={card.status} data-testid={`home-stage-${card.id}`} onClick={() => shell.goSuite("studio", card.id)}>
            <span className="gx-home-card-glow" aria-hidden="true" />
            <span className="gx-home-card-head"><span className="gx-home-card-n">{card.n}</span><span className="gx-home-dot" aria-hidden="true" /></span>
            <span><span className="gx-home-card-label">{card.label}</span><span className="gx-home-card-meta">{card.meta}</span></span>
          </button>
        ))}
      </div>
      <div className="gx-home-row-head">
        <span className="gx-home-row-title">Recent takes</span>
        <button type="button" className="cw-link" onClick={() => shell.openLibrary("assets")} data-testid="home-all-assets">All assets ›</button>
      </div>
      {recent.length ? (
        <div className="gx-home-recent" data-testid="home-recent">
          {recent.map((entry) => (
            <button key={entry.take.id} type="button" className="gx-home-take" onClick={() => openTake(entry)} title={entry.take.name}>
              <span className="gx-home-take-thumb" {...previewAttrs(entryPreview(entry))}>{entry.url && (entry.media === "image" || entry.media === "video") ? <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} className="gx-lazy" /> : entry.media === "audio" ? <span className="gx-badge">AUDIO</span> : null}</span>
              <span className="gx-home-take-name">{entry.take.name}</span>
              <span className="gx-home-take-meta">{entry.take.meta}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="gx-empty">Nothing rendered in this project yet. Takes land here as they finish.</p>
      )}
    </div>
  );
}
