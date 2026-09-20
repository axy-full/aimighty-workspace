"use client";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectSummary } from "@/lib/workspace/data";
import { avatarGradient, initialsOf, mediaBands, shortDate } from "@/lib/workspace/format";
import { progressDot, stagesLine, suiteProgress } from "@/lib/workspace/progress";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Projects (05-mobile, "Projects"): project cards at 2:1 with the slate badge,
 * the gradient avatar, a 3px progress bar and one derived line, then
 * `Open saved…` and `New project`.
 *
 * The bar and the line are computed from the same page states the Stages
 * screen reads (lib/workspace/progress.ts). They are shown for the project
 * that is open, because that is the project whose stage states the workspace
 * holds; the other cards show what is known about them and claim nothing
 * more — a number the data cannot support is left out, not invented.
 */
export function ProjectsScreen({
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
  const ws = useWorkspace();
  const { state } = ws;
  const openId = project?.id ?? state.projectId;
  const progress = suiteProgress(state, state.suite);
  const word = state.suite === "particl" ? "stages" : "tools";

  return (
    <div className="pxm-pad" data-screen="projects">
      <div className="pxm-kicker" data-functional-label="">PROJECT</div>
      <h1 className="pxm-h1">Pick a project</h1>
      <p className="pxm-lede">Every suite reads and writes the same project. Choose one before you open a room.</p>

      {projects.length ? (
        <div className="pxm-cards" role="list" aria-label="Projects">
          {projects.map((p) => {
            const open = p.id === openId;
            const [c1, c2] = mediaBands(p.id);
            const meta = open && project?.description ? project.description : p.updatedAt ? `Updated ${shortDate(p.updatedAt)}` : "";
            return (
              <button
                key={p.id}
                type="button"
                role="listitem"
                className="pxm-project"
                data-project={p.id}
                data-open={open ? "" : undefined}
                aria-current={open ? "true" : undefined}
                onClick={() => onOpenProject(p.id)}
              >
                <span className="pxm-project-media" aria-hidden="true">
                  <span className="pxm-band-a" style={{ background: c1 }} />
                  <span className="pxm-band-b" style={{ background: c2 }} />
                  <span className="pxm-slate">{p.name.toUpperCase()}</span>
                </span>
                <span className="pxm-project-body">
                  <span className="pxm-row">
                    <span className="pxm-project-avatar" style={{ background: avatarGradient(p.id) }} aria-hidden="true">{initialsOf(p.name)}</span>
                    <span className="pxm-grow">
                      <span className="pxm-project-name">{p.name}</span>
                      {meta ? <span className="pxm-project-meta">{meta}</span> : null}
                    </span>
                    <span className="pxm-chevron" aria-hidden="true">›</span>
                  </span>
                  {open ? (
                    <>
                      <span className="pxm-bar" aria-hidden="true">
                        <span className="pxm-bar-fill" style={{ width: `${progress.pct}%`, background: progressDot(progress) }} />
                      </span>
                      <span className="pxm-row pxm-project-state">
                        <span className="pxm-dot6" style={{ background: progressDot(progress) }} aria-hidden="true" />
                        <span className="pxm-project-progress" data-testid="mobile-project-progress">{stagesLine(progress, word)}</span>
                      </span>
                    </>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="pxm-empty" role="status">
          {status === "loading" ? "Loading your projects…" : status === "error" ? error : "No projects yet. Start one with New project."}
        </div>
      )}

      <div className="pxm-pair">
        {/* The saved list IS this screen, so `Open saved…` opens Search over
            every project, suite, stage and plan rather than a second list. */}
        <button type="button" className="pxm-control" onClick={() => ws.setSheet("search")}>Open saved…</button>
        {/* New project still opens the old shell's dialog: the workspace has no
            create flow of its own yet (docs/workspace-switchover.md). */}
        <a className="pxm-filled" href="/workbench?new=1">New project</a>
      </div>
    </div>
  );
}
