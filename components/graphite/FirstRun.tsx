"use client";
import { useEffect, useRef, useState } from "react";
import { throwIfArmed } from "@/lib/shell/fault";
import { useShell } from "@/lib/shell/state";
import { FIRST_RUN_STEPS, recentProjects, savedAt } from "@/lib/shell/studio-home";
import { ago } from "@/lib/workspace/activity";
import type { ProjectSummary } from "@/lib/workspace/data";
import { NewProjectForm, ProjectTile } from "./ProjectHead";

/** The shell's project actions (components/graphite/SuitesShell): one pick, one create and one starter path for every surface. */
export type ProjectActions = {
  projects: ProjectSummary[];
  onPick: (id: string) => void;
  /** ProjectHead's own create: starts a project and opens it; the refusal, or null. */
  onCreate: (name: string) => Promise<string | null>;
  /** Opens the workspace's starter production (seeded on first use); the refusal, or null. */
  onStarter: () => Promise<string | null>;
};

/**
 * Studio's first run: with no project open, a stage shows this card instead of
 * a sentence. New project, then the starter production, then the four stages
 * a production moves through (each one tap away), then the recent projects.
 * The Studio home shows it too, without the stage's sentence.
 */
export function FirstRun({ stage, lead, actions, now }: { stage: string; lead?: string; actions: ProjectActions; now: number }) {
  /* It renders inside the stage's own boundary (SuitesShell): a throw here is that stage's fault card, never the shell's. */
  throwIfArmed("first-run");
  const shell = useShell();
  const [naming, setNaming] = useState(false);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState("");
  const busy = useRef(false);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  const said = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => { if (release.current) clearTimeout(release.current); }, []);
  /* A refusal is said under the button pressed, and brought into view: on a phone its scroll margin keeps it above the tab bar. */
  useEffect(() => { if (problem) said.current?.scrollIntoView({ block: "nearest" }); }, [problem]);
  const recent = recentProjects(actions.projects, null, 4);
  /* One press opens one starter: a second press while the first is on its way is ignored, and a success
     keeps the button busy until the project replaces this card (or, should its draft not read back, a few seconds). */
  const starter = async () => {
    if (busy.current) return;
    busy.current = true; setOpening(true); setProblem("");
    const why = await actions.onStarter().catch(() => "The starter production could not be opened. Try again.");
    if (!why) {
      release.current = setTimeout(() => { busy.current = false; setOpening(false); }, 8_000);
      return;
    }
    busy.current = false; setOpening(false); setProblem(why);
  };
  return (
    <section className="gx-first gx-enter" aria-label="Start a production" data-testid="first-run" data-stage={stage}>
      {lead ? <p className="gx-first-lead" data-testid={`${stage}-no-project`}>{lead}</p> : null}
      <div className="gx-first-actions">
        {naming ? (
          <NewProjectForm testid="first-run-new" onCreate={actions.onCreate} onCancel={() => setNaming(false)} />
        ) : (
          <button type="button" className="gx-primary" onClick={() => setNaming(true)} data-testid="first-run-new">New project</button>
        )}
        <button type="button" className="gx-hbtn gx-first-starter" onClick={() => void starter()} aria-disabled={opening || undefined} data-testid="first-run-starter">
          {opening ? "Opening the starter production…" : "Explore the starter production"}
        </button>
      </div>
      <p className="gx-first-note" data-testid="first-run-note">The starter is three shots with sample takes to look around in. Nothing is generated or charged.</p>
      {problem ? <p className="gx-gen-error" role="alert" ref={said} data-testid="first-run-problem">{problem}</p> : null}
      <div className="gx-first-how">
        <span className="gx-first-how-title" id={`gx-first-how-${stage}`}>How Studio works</span>
        <ol className="gx-first-steps" aria-labelledby={`gx-first-how-${stage}`} data-testid="first-run-steps">
          {FIRST_RUN_STEPS.map((step, i) => (
            <li key={step.id}>
              <button type="button" className="gx-first-step" aria-current={step.id === stage ? "step" : undefined} onClick={() => shell.goSuite("studio", step.id)} data-testid={`first-run-step-${step.id}`}>
                <span className="gx-first-step-n">{String(i + 1).padStart(2, "0")}</span>
                <span className="gx-first-step-label">{step.label}</span>
                <span className="gx-first-step-line">{step.line}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {recent.length ? <RecentProjects projects={recent} onPick={actions.onPick} now={now} /> : null}
    </section>
  );
}

/** Recent projects, one tap to open each: on the first-run card (under its eyebrow) and on the Studio home (a row title like its other sections). */
export function RecentProjects({ projects, onPick, now, title = "Recent projects", heading = "eyebrow" }: { projects: ProjectSummary[]; onPick: (id: string) => void; now: number; title?: string; heading?: "eyebrow" | "row" }) {
  return (
    <div className="gx-recent" data-testid="recent-projects">
      {heading === "row" ? <div className="gx-home-row-head"><span className="gx-home-row-title">{title}</span></div> : <span className="gx-recent-title">{title}</span>}
      <ul className="gx-recent-list">
        {projects.map((p) => {
          const at = savedAt(p);
          return (
            <li key={p.id}>
              <button type="button" className="gx-recent-row" onClick={() => onPick(p.id)} title={p.name} data-testid="recent-project">
                <ProjectTile name={p.name} />
                <span className="gx-recent-name">{p.name}</span>
                {at ? <span className="gx-recent-age">{ago(at, now)}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
