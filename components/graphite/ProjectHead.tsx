"use client";
import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectSummary } from "@/lib/workspace/data";
import { useShell } from "@/lib/shell/state";
import { posterOf } from "./icons";

function posterStyle(name: string): React.CSSProperties {
  const p = posterOf(name);
  return { "--poster-from": p.from, "--poster-to": p.to, "--poster-glow": p.glow } as React.CSSProperties;
}
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";
}

/** `[DS] Project ▾` — the project switcher: a list with ✓ on the current one, and New project. */
export function ProjectHead({ project, projects, loading, onPick, onCreate }: {
  project: Project | null; projects: ProjectSummary[]; loading: boolean; onPick: (id: string) => void;
  /** Starts a project here and opens it; returns the refusal, or null. Without it, New project opens the older dialog. */
  onCreate?: (name: string) => Promise<string | null>;
}) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState("");
  const create = async () => {
    if (!onCreate || naming == null) return;
    setCreating(true); setProblem("");
    const why = await onCreate(naming.trim() || "Untitled");
    setCreating(false);
    if (why) { setProblem(why); return; }
    setNaming(null); setOpen(false);
  };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const name = project?.name ?? (loading ? "Opening…" : "No project");
  const meta = [project?.aspect, project?.fps ? `${project.fps} fps` : null].filter(Boolean).join(" · ");
  return (
    <div className="gx-project" ref={box} data-row="project">
      <button type="button" className="gx-project-btn" aria-haspopup="listbox" aria-expanded={open} title="Switch project" onClick={() => setOpen((v) => !v)} data-testid="project-switcher">
        <span className="gx-project-tile" aria-hidden="true" style={posterStyle(project?.name ?? "")}>{initials(project?.name ?? "")}</span>
        <span style={{ minWidth: 0 }}>
          <span className="gx-project-name"><span data-testid="project-name">{name}</span> <span style={{ color: "var(--gx-text-3)" }} aria-hidden="true">▾</span></span>
          <span className="gx-project-meta"><span className="gx-project-saved" aria-hidden="true" />{meta || shell.suite.name}</span>
        </span>
      </button>
      {open ? (
        <div className="gx-popover" role="listbox" aria-label="Projects">
          {projects.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === project?.id} className="gx-popover-item" onClick={() => { setOpen(false); onPick(p.id); }}>
              <span className="gx-project-tile" aria-hidden="true" style={posterStyle(p.name)}>{initials(p.name)}</span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              {p.id === project?.id ? <span style={{ color: "var(--gx-accent-text)" }} aria-hidden="true">✓</span> : null}
            </button>
          ))}
          {/* New project starts here and opens it in this shell (owner, 23 September: it used to leave for the older workbench). */}
          {!onCreate ? (
            <a className="gx-popover-item gx-popover-item--new" href="/workbench?new=1" style={{ textDecoration: "none" }}>
              <span aria-hidden="true">+</span>New project
            </a>
          ) : naming == null ? (
            <button type="button" className="gx-popover-item gx-popover-item--new" onClick={() => setNaming("")} data-testid="project-new">
              <span aria-hidden="true">+</span>New project
            </button>
          ) : (
            <form className="gx-project-new" onSubmit={(e) => { e.preventDefault(); void create(); }} data-testid="project-new-form">
              <input className="gx-field" autoFocus maxLength={120} placeholder="Project name" aria-label="New project name" value={naming} onChange={(e) => setNaming(e.target.value)} data-testid="project-new-name" />
              <button type="submit" className="gx-primary" disabled={creating} data-testid="project-new-create">{creating ? "Creating…" : "Create"}</button>
              {problem ? <p className="gx-reason" role="alert">{problem}</p> : null}
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
