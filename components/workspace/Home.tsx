"use client";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectSummary } from "@/lib/workspace/data";
import { avatarGradient, initialsOf, mediaBands, shortDate } from "@/lib/workspace/format";
import { getSuite, PAGES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";
import { PAGE_ICONS } from "./icons";
import { Button, ButtonLink, IconTile, Kicker, TILE } from "./ui";

/** Complete / In progress / Ready — derived from runs, never fixed. */
function featureState(state: ReturnType<typeof useWorkspace>["state"], id: PageId) {
  if (state.completed[id]) return { label: "Complete", color: "var(--pxw-green)" };
  if (state.run?.page === id && state.run.status !== "done") return { label: "In progress", color: "var(--pxw-blue-ink)" };
  return { label: "Ready", color: "var(--pxw-neutral-state)" };
}

/** Project selector first, then the active suite's pages as cards. */
export function Home({
  projects,
  project,
  status,
  error,
  onOpenProject,
}: {
  projects: ProjectSummary[];
  project: Project | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  onOpenProject: (id: string) => void;
}) {
  const { state, go, dispatch } = useWorkspace();
  const suite = getSuite(state.suite);
  const pages = PAGES[state.suite];
  return (
    <div className="pxw-home">
      <div className="pxw-home-inner">
        <div className="pxw-home-head">
          <div>
            <Kicker>Project</Kicker>
            <h1 className="pxw-home-title">Pick a project to work in</h1>
            <div className="pxw-home-sub">Every suite reads and writes the same project. Choose one before you open a room.</div>
          </div>
          <div className="pxw-home-actions">
            {/* New project still opens the old shell's dialog: the workspace
                has no create flow of its own yet (docs/workspace-switchover.md),
                and `?new=1` is a legacy-only param, so it renders there. The
                old "Open saved…" link pointed at `/`, which IS this page now. */}
            {/* Generation is the first thing most people come for; it needs no project. */}
            <Button variant="primary" data-testid="home-generate" onClick={() => dispatch({ type: "patch", patch: { composer: true } })}>Generate</Button>
            <ButtonLink href="/workbench?new=1">New project</ButtonLink>
          </div>
        </div>

        {projects.length ? (
          <div className="pxw-projects" role="list" aria-label="Projects">
            {projects.map((p) => {
              const current = p.id === (project?.id ?? state.projectId);
              const [c1, c2] = mediaBands(p.id);
              const meta = current && project?.description ? project.description : p.updatedAt ? `Updated ${shortDate(p.updatedAt)}` : "";
              return (
                <button key={p.id} type="button" role="listitem" className="pxw-project-card" aria-current={current ? "true" : undefined} data-project={p.id} onClick={() => onOpenProject(p.id)}>
                  <span className="pxw-project-media" aria-hidden="true">
                    <span style={{ inset: 0, background: c1 }} />
                    <span style={{ left: 0, right: 0, bottom: 0, height: "52%", background: c2 }} />
                    <span className="pxw-project-slate">{p.name.toUpperCase()}</span>
                  </span>
                  <span className="pxw-project-body">
                    <span className="pxw-project-row">
                      <span className="pxw-project-card-avatar" style={{ background: avatarGradient(p.id) }} aria-hidden="true">{initialsOf(p.name)}</span>
                      <span className="pxw-project-card-text">
                        <span className="pxw-project-card-name">{p.name}</span>
                        {meta ? <span className="pxw-project-card-meta">{meta}</span> : null}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="pxw-home-empty" role="status">
            {status === "loading" ? "Loading your projects…" : status === "error" ? error : "No projects yet. Start one with New project."}
          </div>
        )}

        <h2 className="pxw-suite-title">{suite.name}</h2>
        <div className="pxw-suite-desc">{suite.desc}</div>
        <div className="pxw-features" aria-label={`${suite.name} pages`}>
          {pages.map((p, i) => {
            const s = featureState(state, p.id);
            return (
              <button key={p.id} type="button" className="pxw-feature" data-feature={p.id} onClick={() => go(state.suite, p.id)}>
                <span className="pxw-feature-top">
                  <IconTile icon={PAGE_ICONS[p.id]} size={30} tint={i % TILE.length} />
                  <span className="pxw-feature-num" data-functional-label="">{String(i + 1).padStart(2, "0")}</span>
                </span>
                <span className="pxw-feature-name">{p.title}</span>
                <span className="pxw-feature-desc">{p.description}</span>
                <span className="pxw-feature-state">
                  <span className="pxw-dot" style={{ background: s.color }} aria-hidden="true" />
                  <span className="pxw-feature-state-label">{s.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

