"use client";
import { useEffect } from "react";
import { AtomikHost, type PlanBridge } from "@/lib/workspace/atomik-host";
import { projectUploads, useAccount, useProjects, type WorkspaceAccount } from "@/lib/workspace/data";
import { resolveKey, SHELL_BINDINGS, type KeyBinding, type ShellAction } from "@/lib/workspace/keys";
import { PAGES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { AtomikPanel } from "./AtomikPanel";
import { Breadcrumb } from "./Breadcrumb";
import { GenerationStrip } from "./GenerationStrip";
import { Home } from "./Home";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { PageHeader, primaryAvailability } from "./PageHeader";
import { ProjectHeader } from "./ProjectHeader";
import { PAGE_BODIES } from "./pages/registry";
import { StageTabs } from "./StageTabs";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { ToastHost } from "./ui";

/** Hooks later PRs plug into without reshaping the shell. */
export type ShellSeams = {
  /** ⌘K palette. The Search button calls this; nothing opens until it exists. */
  onOpenPalette?: () => void;
  /** Generate the selected shot. Absent: Generate is disabled with its reason. */
  onGenerate?: () => void;
  /** Extra key bindings, checked after the shell's own. */
  bindings?: KeyBinding<unknown>[];
};

export function WorkspaceShell({ scope, initialAccount, seams = {}, planBridge }: { scope: string; initialAccount: WorkspaceAccount | null; seams?: ShellSeams; planBridge?: PlanBridge }) {
  const ws = useWorkspace();
  const { state, dispatch, go, selectProject } = ws;
  const account = useAccount(initialAccount);
  const data = useProjects(scope, state.projectId, (id) => selectProject(id, { replace: true }));
  const project = data.project;
  const projectName = project?.name ?? "";

  /* Keyboard: the shell's bindings, guarded against typing. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ctx = { state: ws.state, pageCount: PAGES[ws.state.suite].length };
      const shell = resolveKey(SHELL_BINDINGS, event, ctx);
      if (shell) {
        const action = shell.action(event, ctx) as ShellAction;
        if (action.type === "page") {
          event.preventDefault();
          const target = PAGES[ws.state.suite][action.index];
          if (target) go(ws.state.suite, target.id);
        } else if (action.type === "toggleInspector") {
          event.preventDefault();
          dispatch({ type: "toggleInspector" });
        } else if (action.type === "escape") {
          if (ws.state.palette) dispatch({ type: "patch", patch: { palette: false } });
          else if (ws.state.agentOpen) dispatch({ type: "patch", patch: { agentOpen: false } });
        }
        return;
      }
      const extra = seams.bindings && resolveKey(seams.bindings, event, ctx);
      if (extra) extra.action(event, ctx);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws.state, go, dispatch, seams.bindings]);

  const openProject = (id: string) => {
    try { localStorage.setItem(scope, id); } catch { /* The URL still carries the project. */ }
    /* Opening a project enters the active suite's first page (prototype `onOpen`). */
    ws.openProject(id, state.suite, PAGES[state.suite][0].id);
  };

  const uploads = projectUploads(project);
  const Body = PAGE_BODIES[state.page];
  const reason = primaryAvailability(state, seams.onGenerate).reason;

  return (
    <AtomikHost scope={scope} project={project} bridge={planBridge}>
    <div className="pxw" data-view={state.view}>
      <TopBar account={account} onOpenPalette={seams.onOpenPalette} />
      {state.view === "studio" ? (
        <>
          <StageTabs />
          <div className="pxw-studio" data-testid="studio-row">
            <Library uploads={uploads} />
            <main className="pxw-main" data-screen-label={state.page}>
              <ProjectHeader project={project} loading={data.status === "loading"} />
              <PageHeader project={project} onGenerate={seams.onGenerate} />
              <Breadcrumb projectName={projectName || "Project"} reason={reason} />
              <div className="pxw-content" data-testid="content">
                <Body page={state.page} project={project} />
              </div>
              <GenerationStrip />
            </main>
            {state.inspector ? <Inspector /> : null}
          </div>
          <StatusBar projectName={projectName} bindings={[...SHELL_BINDINGS, ...(seams.bindings ?? [])] as KeyBinding<unknown>[]} />
        </>
      ) : (
        <Home projects={data.projects} project={project} status={data.status} error={data.error} onOpenProject={openProject} />
      )}
      <AtomikPanel />
      <ToastHost />
    </div>
    </AtomikHost>
  );
}

