"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ParticlMark } from "@/components/ParticlMark";
import { AtomikMark } from "@/components/AtomikMark";
import { useSession } from "@/lib/session";
import { useShell } from "@/lib/shell/state";
import { CREW } from "@/lib/workbench/crew";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectSummary, WorkspaceAccount } from "@/lib/workspace/data";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { NewProjectForm, ProjectTile } from "../ProjectHead";
import { Glyph, type GlyphName } from "../icons";
import { usePersonalJobs } from "./usePersonalJobs";

/** Native modal supplies focus containment, Escape, and restoration to the opener. */
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; const opener = document.activeElement; node?.showModal(); return () => { node?.close(); if (opener instanceof HTMLElement) queueMicrotask(() => opener.focus()); }; }, []);
  return <dialog ref={ref} className="rd-dialog" aria-label={title} onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div className="rd-dialog-inner"><div className="rd-dialog-head"><h2>{title}</h2><button type="button" className="gx-hbtn" onClick={close}>Close</button></div>{children}</div>
  </dialog>;
}

type ProjectProps = {
  project: Project | null; projects: ProjectSummary[]; loading: boolean; error: string | null;
  onRetry: () => void; onPick: (id: string) => void; onCreate: (name: string) => Promise<string | null>;
};

export function ShellTopBar({ account, ...projects }: ProjectProps & { account: WorkspaceAccount | null }) {
  const shell = useShell();
  const { name } = useSession();
  const jobs = usePersonalJobs();
  const [switching, setSwitching] = useState(false);
  const [naming, setNaming] = useState(false);
  const title = projects.project?.name ?? (projects.loading ? "Opening…" : projects.error ? "Projects didn’t load" : "Choose a project");
  const suite = shell.view === "gen" ? "Gen" : shell.view === "workspace" ? "Workspace" : shell.view === "crew" ? "Crew" : shell.suite.label;
  const page = shell.view === "suite" ? shell.page.label : null;
  const credits = account?.credits?.balance;
  return <header className="rd-topbar" data-row="header">
    <button type="button" className="rd-brand" onClick={shell.goGen} aria-label="Particl home"><ParticlMark size={13} /></button>
    <button type="button" className="rd-project" onClick={() => setSwitching(true)} aria-haspopup="dialog" aria-expanded={switching} data-testid="project-switcher" title={title}>
      <span className="rd-project-dot" /><span data-testid="project-name">{title}</span><span aria-hidden="true">▾</span>
    </button>
    <div className="rd-crumb"><span>/</span><span>{suite}</span>{page && <><span>/</span><strong>{page}</strong></>}</div>
    <button type="button" className="rd-search" onClick={() => shell.setPalette(true)} aria-label="Search, run or ask Atomik" data-testid="header-search"><Glyph name="search" /><span>Search, run or ask Atomik</span><kbd>⌘K</kbd></button>
    <button type="button" className="rd-credits" onClick={() => shell.goWorkspace("credits")} data-testid="workspace-credits"><Glyph name="bolt" /><span>{credits == null ? "—" : credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} cr</span></button>
    <button type="button" className="rd-jobs" onClick={() => shell.goSuite("atomik", "runs")} data-testid="running-jobs" title="Your takes across projects"><i className={jobs?.counts?.rendering ? "rd-live" : ""} />{jobs?.error ? "Jobs unavailable" : jobs?.counts ? `${jobs.counts.rendering} rendering · ${jobs.counts.held} held` : "Loading jobs…"}</button>
    <button type="button" className="gx-primary rd-topup" onClick={() => shell.goWorkspace("credits")}>Top up</button>
    <button type="button" className="rd-avatar" onClick={() => shell.goWorkspace()} aria-label="Workspace and account" data-testid="workspace-avatar">{(name || "Workspace").split(/\s+/).slice(0, 2).map((n) => n[0]).join("").toUpperCase()}</button>
    {switching ? <Modal title="Projects" close={() => setSwitching(false)}>
      <p className="rd-secondary">Switching waits for pending saves before opening the next project.</p>
      {projects.error ? <p role="alert">{projects.error}<button type="button" className="gx-hbtn" onClick={projects.onRetry}>Retry</button></p> : null}
      <div className="rd-projects">{projects.projects.map((p) => <button type="button" key={p.id} className="rd-project-option" aria-current={p.id === projects.project?.id ? "true" : undefined} onClick={() => { setSwitching(false); projects.onPick(p.id); }}><ProjectTile name={p.name} /><span>{p.name}</span>{p.id === projects.project?.id ? <span aria-hidden="true">✓</span> : null}</button>)}</div>
      {naming ? <NewProjectForm onCreate={projects.onCreate} onDone={() => { setNaming(false); setSwitching(false); }} onCancel={() => setNaming(false)} /> : <button type="button" className="gx-hbtn rd-new-project" onClick={() => setNaming(true)}>+ New project</button>}
    </Modal> : null}
  </header>;
}

const RAIL: { id: "gen" | "studio" | "business" | "viral" | "atomik" | "workspace"; label: string; icon: GlyphName }[] = [
  { id: "gen", label: "Gen", icon: "spark" }, { id: "studio", label: "Studio", icon: "clap" },
  { id: "business", label: "Business", icon: "tag" }, { id: "viral", label: "Viral", icon: "bolt" },
  { id: "atomik", label: "Atomik", icon: "atom" }, { id: "workspace", label: "Workspace", icon: "grid" },
];
function Rail() {
  const shell = useShell();
  const selected = shell.view === "suite" ? shell.suite.id : shell.view === "crew" ? "atomik" : shell.view;
  return <nav className="rd-rail" aria-label="Suites">{RAIL.map((item) => <button type="button" key={item.id} aria-current={selected === item.id ? "page" : undefined} onClick={() => item.id === "gen" ? shell.goGen() : item.id === "workspace" ? shell.goWorkspace() : shell.goSuite(item.id)}>{item.id === "atomik" ? <AtomikMark size={21} /> : <Glyph name={item.icon} size={21} />}<span>{item.label}</span></button>)}</nav>;
}

function department(page: string, suite: string) {
  if (suite === "business") return "Producer";
  if (["boards", "astra", "rig"].includes(page)) return "DOP";
  if (["takes", "edit", "deliver"].includes(page)) return "Editor";
  if (["cast", "environment"].includes(page)) return "Production designer";
  if (page === "brief" || page === "beats") return "Director";
  return "Genie";
}

export function CrewButton({ onAsk }: { onAsk: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const shell = useShell();
  const choose = (name: string, task: string) => { setOpen(false); onAsk(`${name}: ${task}. Propose a plan for the current project, with inputs, steps and a quote for approval before any generation.`); };
  return <><button type="button" className="gx-hbtn" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="open-crew"><Glyph name="crew" />Crew</button>
    {open ? <Modal title="Crew" close={() => setOpen(false)}><p className="rd-secondary">Genie routes the request. Each department proposes one task at a time for your review.</p>
      <div className="rd-crew-grid"><button type="button" className="rd-crew-card" onClick={() => choose("Genie", "Route this project to the right departments")}><AtomikMark /><strong>Genie</strong><span>Plan & route</span></button>
        {CREW.filter((role) => role.id !== "marketing").map((role) => <button type="button" className="rd-crew-card" key={role.id} onClick={() => choose(role.name, role.output)}><span className="rd-role-initials">{role.initials}</span><strong>{role.name}</strong><span>{role.domain}</span></button>)}
      </div><button type="button" className="gx-hbtn" onClick={() => { setOpen(false); shell.goCrew(); }}>Open Crew room</button>
    </Modal> : null}</>;
}

export function Provenance({ items }: { items: LibraryEntry[] }) {
  const { state } = useWorkspace();
  const shell = useShell();
  const atomik = useAtomik();
  const entry = state.selKind === "take" ? items.find((i) => i.take.id === state.selId) : null;
  const run = atomik.runFor(state.page);
  const source = entry?.asset;
  return <section className="rd-provenance" aria-label="Provenance" data-testid="provenance"><h3>PROVENANCE · {shell.view === "gen" ? "Genie" : department(shell.page.id, shell.suite.id)}</h3>
    {source ? source.origin === "upload" ? <p>Uploaded original. {entry?.take.sha256 ? "File integrity recorded." : "No agent provenance recorded."}</p> : <p>Generated take · {source.value.id}. {source.value.creditsBilled != null && !source.value.providerCreditQuote ? `${source.value.creditsBilled} cr recorded.` : "No settled credit amount recorded."} No agent approval provenance recorded for this take.</p> : <p>{run ? `Current plan: ${atomik.plan(state.page)?.title ?? "Atomik"} · ${run.status}. Open the plan to review its inputs and approval.` : "No agent provenance recorded for this selection. Select a take or open a plan to inspect its source."}</p>}
  </section>;
}

function Dock({ project, onAsk }: { project: Project | null; onAsk: (text: string) => void }) {
  const shell = useShell();
  const { state, dispatch } = useWorkspace();
  const atomik = useAtomik();
  const [request, setRequest] = useState("");
  const plan = atomik.plan(state.page);
  const run = atomik.runFor(state.page);
  if (shell.view === "suite" && shell.suite.id === "atomik" && shell.page.id === "agent") return null;
  const label = shell.view === "gen" ? "Genie" : department(shell.page.id, shell.suite.id);
  const directPlan = shell.view === "suite";
  const quote = run?.quote;
  return <div className="rd-dock" data-testid="atomik-dock">
    <div className="rd-dock-context"><div><AtomikMark /><span>ATOMIK · {label.toUpperCase()}</span></div><p>{project ? `Plan the next step for ${project.name}.` : "Open a project to plan your next step."}</p></div>
    <button type="button" className="rd-plan" disabled={!project} onClick={() => directPlan ? dispatch({ type: "patch", patch: { agentOpen: true } }) : onAsk(`Plan the next step for ${shell.view === "gen" ? "generation" : shell.view} in this project. Prepare a quote for approval before any generation.`)} data-testid="dock-plan">{directPlan ? plan?.title ?? "Review plan" : "Plan with Atomik"}<span>{quote?.unit === "cr" ? `${quote.credits} cr` : "live quote"}</span></button>
    <CrewButton onAsk={onAsk} />
    <form className="rd-ask" onSubmit={(e) => { e.preventDefault(); if (request.trim()) { onAsk(request.trim()); setRequest(""); } }}><input aria-label="Ask Atomik about this page" placeholder="Ask Atomik about this page" value={request} onChange={(e) => setRequest(e.target.value)} /><button type="submit" aria-label="Send request to Atomik" disabled={!request.trim()}>↑</button></form>
  </div>;
}

export function ShellFrame({ enabled, children, inspector, project, onAsk }: { enabled: boolean; children: ReactNode; inspector: ReactNode; project: Project | null; onAsk: (text: string) => void }) {
  const shell = useShell();
  if (!enabled) return children;
  return <div className="rd-frame"><Rail /><div className="rd-canvas">
    <div className="rd-tools"><button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("assets")} data-testid="all-assets"><Glyph name="stack" />All assets</button><button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("tools")}>Tools</button><button type="button" className="gx-hbtn" onClick={shell.toggleInspector} aria-pressed={shell.wide ? shell.inspector : shell.inspOpen}>Inspector</button></div>
    {children}<Dock project={project} onAsk={onAsk} />
  </div>{inspector}</div>;
}

/** Views without a selected stage must not inherit the underlying Brief inspector. */
export function ViewSummary({ project, items, onAsk }: { project: Project | null; items: LibraryEntry[]; onAsk: (text: string) => void }) {
  const shell = useShell();
  const title = shell.view === "gen" ? "Generate" : shell.view === "crew" ? "Crew" : "Workspace";
  return <div className="rd-view-summary"><h2>{title}</h2><p>{project?.name ?? "No project selected"}</p><dl className="gx-facts"><div><dt>Project</dt><dd>{project?.name ?? "—"}</dd></div><div><dt>Assets loaded</dt><dd>{items.length}</dd></div>{project ? <><div><dt>Aspect</dt><dd>{project.aspect}</dd></div><div><dt>Frame rate</dt><dd>{project.fps} fps</dd></div></> : null}</dl><p className="rd-secondary">Select a take to inspect its source, settings and original file.</p><button type="button" className="gx-primary" disabled={!project} onClick={() => onAsk(`Prepare a plan for ${title.toLowerCase()} in this project with a quote for approval.`)}>Plan with Atomik · live quote</button></div>;
}
