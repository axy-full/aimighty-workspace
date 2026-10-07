"use client";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { throwIfArmed } from "@/lib/shell/fault";
import { useShell } from "@/lib/shell/state";
import { useFreshProject } from "@/lib/shell/use-fresh-project";
import { recentProjects, recentTakes, runningTakes, stageCards, startsEmpty, upNext } from "@/lib/shell/studio-home";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { FirstRun, RecentProjects, type ProjectActions } from "../FirstRun";
import { Glyph } from "../icons";

/**
 * Studio home: the project's name in
 * the gradient, *Up next* (the first shot without a render, one tap into the Board),
 * the eight stages as cards with a live line and a status dot, and the recent
 * takes. Every card routes to its page; every figure is the project's own.
 *
 * The phone reaches it from Home's Studio tile; a desktop from the mark. It
 * also lists what is generating (always on a desktop, on a phone when
 * something is) and the other recent projects. With no project open it is
 * Studio's first run (FirstRun).
 */
export function StudioHome({ project: loaded, items, actions, loading = false, now }: { project: Project | null; items: LibraryEntry[]; actions: ProjectActions; loading?: boolean; now: number }) {
  /* Inside the stage's boundary (SuitesShell › stage:stages), like every stage body. */
  throwIfArmed("studio-home");
  const shell = useShell();
  /* The stages edit their own drafts: the grid counts the project as saved now, not as first loaded. */
  const project = useFreshProject(loaded);
  const { state, dispatch } = useWorkspace();
  const cards = stageCards(project, items);
  const next = upNext(project);
  const recent = recentTakes(items);
  const openTake = (entry: LibraryEntry) => {
    dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } });
    shell.openInspector();
  };
  if (!project) {
    return (
      <div className="gx-home gx-enter" data-testid="studio-home" data-wide={shell.wide || undefined}>
        <span className="gx-home-eyebrow">Studio</span>
        <h1 className="gx-h1 gx-home-title" data-testid="page-title">{loading ? "Studio" : "Start a production"}</h1>
        {loading ? <p className="gx-empty" role="status">Opening your projects…</p> : <FirstRun stage="home" actions={actions} now={now} />}
      </div>
    );
  }
  const running = runningTakes(items);
  /* The strip's own job (Gen, a composer) while it is in flight, until its take is filed in this project's library. */
  const strip = state.gen && state.gen.tone !== "green" && state.gen.tone !== "red" && !running.some((e) => e.take.sourceId === state.gen!.id) ? state.gen : null;
  const awaiting = state.run && state.run.status === "waiting" && !state.run.approved;
  const busy = running.length + (strip ? 1 : 0) + (awaiting ? 1 : 0);
  const others = recentProjects(actions.projects, project.id, shell.wide ? 4 : 3);
  return (
    <div className="gx-home gx-enter" data-testid="studio-home" data-wide={shell.wide || undefined}>
      <span className="gx-home-eyebrow">Studio</span>
      <h1 className="gx-h1 gx-home-title" data-testid="page-title">{project.name}</h1>
      {next ? (
        <div className="gx-home-next" data-testid="home-up-next">
          <span className="gx-home-next-ic" aria-hidden="true"><Glyph name="spark" size={20} /></span>
          <span className="gx-home-next-text">
            <span className="gx-home-next-title">Up next · Shot {String(next.index).padStart(2, "0")}</span>
            <span className="gx-home-next-meta">{next.name} · quoted when you open it</span>
          </span>
          <button type="button" className="gx-primary" onClick={() => shell.goSuite("studio", "rig")} data-testid="home-generate-next">Open the Board</button>
        </div>
      ) : startsEmpty(project) ? (
        <div className="gx-home-next" data-testid="home-up-next">
          <span className="gx-home-next-ic" aria-hidden="true"><Glyph name="spark" size={20} /></span>
          <span className="gx-home-next-text">
            <span className="gx-home-next-title">Up next · the brief</span>
            <span className="gx-home-next-meta">Write the idea; Beats splits it into shots</span>
          </span>
          <button type="button" className="gx-primary" onClick={() => shell.goSuite("studio", "brief")} data-testid="home-open-brief">Open Brief</button>
        </div>
      ) : null}
      {/* What is running: always on a desktop (its home is the overview), on a phone only when something is. */}
      {shell.wide || busy ? (
        <section className="gx-home-running" aria-label="Running" data-testid="home-running">
          <div className="gx-home-row-head"><span className="gx-home-row-title">Running</span></div>
          {busy ? (
            <ul className="gx-home-runs">
              {running.map((entry) => (
                <li key={entry.take.id}>
                  <button type="button" className="gx-home-run" onClick={() => openTake(entry)} title={entry.take.name} data-testid="home-run">
                    <span className="gx-jobs-dot" aria-hidden="true" />
                    <span className="gx-home-run-name">{entry.take.name}</span>
                    <span className="gx-home-run-meta">Generating{entry.take.meta ? ` · ${entry.take.meta}` : ""}</span>
                  </button>
                </li>
              ))}
              {strip ? (
                <li>
                  <button type="button" className="gx-home-run" onClick={() => shell.goSuite("atomik", "runs")} data-testid="home-run">
                    <span className="gx-jobs-dot" aria-hidden="true" />
                    <span className="gx-home-run-name">{strip.name}</span>
                    <span className="gx-home-run-meta">{strip.label ?? "Running"}</span>
                  </button>
                </li>
              ) : null}
              {awaiting ? (
                <li>
                  <button type="button" className="gx-home-run" onClick={() => dispatch({ type: "patch", patch: { agentOpen: true } })} data-testid="home-run-approve">
                    <span className="gx-jobs-dot gx-jobs-dot--wait" aria-hidden="true" />
                    <span className="gx-home-run-name">An Atomik plan is waiting</span>
                    <span className="gx-home-run-meta">Review its price and approve</span>
                  </button>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="gx-empty gx-home-idle" data-testid="home-running-idle">Nothing is generating. Takes you start show here until they land.</p>
          )}
        </section>
      ) : null}
      <div className="gx-home-grid" role="list" aria-label="Stages">
        {cards.map((card) => (
          <button key={card.id} type="button" role="listitem" className="gx-home-card" data-status={card.status} data-testid={`home-stage-${card.id}`} onClick={() => shell.goSuite("studio", card.id)}>
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
      {others.length ? <RecentProjects projects={others} onPick={actions.onPick} now={now} title="Other projects" heading="row" /> : null}
    </div>
  );
}
