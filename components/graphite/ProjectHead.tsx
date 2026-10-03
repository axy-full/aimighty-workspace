"use client";
import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectSummary } from "@/lib/workspace/data";
import { useShell } from "@/lib/shell/state";
import { posterOf } from "./icons";

function posterStyle(name: string): React.CSSProperties {
  const p = posterOf(name);
  return { "--poster-from": p.from, "--poster-to": p.to } as React.CSSProperties;
}
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";
}
/** A project's poster tile: its initials over the two colours its name picks. */
export function ProjectTile({ name }: { name: string }) {
  return <span className="gx-project-tile" aria-hidden="true" style={posterStyle(name)}>{initials(name)}</span>;
}

/** The longest project name a draft saves with (projectSchema › name). */
export const PROJECT_NAME_MAX = 100;

/**
 * The name field and Create that start a project: in the switcher below and on
 * Studio's first-run card (FirstRun), both through the shell's one `onCreate`.
 * One press makes one project: a second submit while the first is on its way is ignored.
 */
export function NewProjectForm({ onCreate, onDone, onCancel, testid = "project-new" }: {
  onCreate: (name: string) => Promise<string | null>; onDone?: () => void; onCancel?: () => void; testid?: string;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState("");
  const busy = useRef(false);
  const create = async () => {
    if (busy.current) return;
    busy.current = true; setCreating(true); setProblem("");
    const why = await onCreate(name.trim() || "Untitled").catch(() => "The project could not be created. Try again.");
    busy.current = false; setCreating(false);
    if (why) { setProblem(why); return; }
    onDone?.();
  };
  return (
    <form className="gx-project-new" onSubmit={(e) => { e.preventDefault(); void create(); }} data-testid={`${testid}-form`}>
      {/* 100: the longest name the save route takes (lib/workbench/studio-schema.ts). It said 120, and a longer name was refused after Create. */}
      <input className="gx-field" autoFocus maxLength={PROJECT_NAME_MAX} placeholder="Project name" aria-label="New project name" value={name} onChange={(e) => setName(e.target.value)} data-testid={`${testid}-name`} />
      <button type="submit" className="gx-primary" disabled={creating} data-testid={`${testid}-create`}>{creating ? "Creating…" : "Create"}</button>
      {onCancel ? <button type="button" className="gx-hbtn" onClick={onCancel} data-testid={`${testid}-cancel`}>Cancel</button> : null}
      {problem ? <p className="gx-reason" role="alert">{problem}</p> : null}
    </form>
  );
}

/** `[DS] Project ▾` — the project switcher: a list with ✓ on the current one, and New project. */
export function ProjectHead({ project, projects, loading, error = null, onPick, onCreate }: {
  project: Project | null; projects: ProjectSummary[]; loading: boolean; onPick: (id: string) => void;
  /** The project list could not be read: said here rather than "No project"; the banner under the head says why, with Try again. */
  error?: string | null;
  /** Starts a project here and opens it; returns the refusal, or null. Without it, New project opens the older dialog. */
  onCreate?: (name: string) => Promise<string | null>;
}) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const name = project?.name ?? (loading ? "Opening…" : error ? "Projects didn’t load" : "No project");
  const meta = [project?.aspect, project?.fps ? `${project.fps} fps` : null].filter(Boolean).join(" · ");
  /* A failed list read: no aspect or suite line under a name that is not a project. One Try again, in the banner below. */
  const failed = Boolean(error && !project);
  return (
    <div className="gx-project" ref={box} data-row="project">
      <button type="button" className="gx-project-btn" aria-haspopup="listbox" aria-expanded={open} title="Switch project" onClick={() => setOpen((v) => !v)} data-testid="project-switcher">
        <ProjectTile name={project?.name ?? ""} />
        <span style={{ minWidth: 0 }}>
          <span className="gx-project-name"><span className="gx-project-label" data-testid="project-name">{name}</span> <span style={{ color: "var(--gx-text-3)" }} aria-hidden="true">▾</span></span>
          {/* No "saved" dot: each stage says its own save state (Saved / Saving / Not saved) where the edit is made. */}
          {failed ? null : <span className="gx-project-meta">{meta || shell.suite.name}</span>}
        </span>
      </button>
      {open ? (
        <div className="gx-popover" role="listbox" aria-label="Projects">
          {projects.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === project?.id} className="gx-popover-item" onClick={() => { setOpen(false); onPick(p.id); }}>
              <ProjectTile name={p.name} />
              <span style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              {p.id === project?.id ? <span style={{ color: "var(--gx-accent-text)" }} aria-hidden="true">✓</span> : null}
            </button>
          ))}
          {/* New project starts here and opens it in this shell (owner, 23 September: it used to leave for the older workbench). */}
          {!onCreate ? (
            <a className="gx-popover-item gx-popover-item--new" href="/workbench?new=1" style={{ textDecoration: "none" }}>
              <span aria-hidden="true">+</span>New project
            </a>
          ) : !naming ? (
            <button type="button" className="gx-popover-item gx-popover-item--new" onClick={() => setNaming(true)} data-testid="project-new">
              <span aria-hidden="true">+</span>New project
            </button>
          ) : (
            <NewProjectForm onCreate={onCreate} onDone={() => { setNaming(false); setOpen(false); }} />
          )}
        </div>
      ) : null}
    </div>
  );
}
