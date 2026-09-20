"use client";
import { useEffect } from "react";
import { AtomikHost, type PlanBridge } from "@/lib/workspace/atomik-host";
import { projectUploads, useAccount, useProjects, type WorkspaceAccount } from "@/lib/workspace/data";
import { useProjectLibrary } from "@/lib/workspace/library";
import { keyContextFor, legendBindings, resolveKey, stepSelection, WORKSPACE_BINDINGS, type KeyBinding, type ShellAction } from "@/lib/workspace/keys";
import { generateAvailability, listFor } from "@/lib/workspace/navigation";
import { PAGES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { AtomikPanel } from "./AtomikPanel";
import { Breadcrumb } from "./Breadcrumb";
import { GenerationStrip } from "./GenerationStrip";
import { Home } from "./Home";
import { Inspector } from "./Inspector";
import { Library, type MediaItem } from "./Library";
import { PageHeader, primaryAvailability, type GenerateStatus } from "./PageHeader";
import { Palette } from "./Palette";
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
  /** Play / pause the preview (Space). Absent: Space is left to the browser. */
  onTogglePlay?: () => void;
  /** The live quote on Generate and anything blocking it. */
  generate?: GenerateStatus;
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

  /* Keyboard (04 "Keyboard"): one keymap, guarded against typing; ⌘K is the exception. */
  const onGenerate = seams.onGenerate;
  const onTogglePlay = seams.onTogglePlay;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = ws.state;
      const ctx = keyContextFor(current, { canGenerate: Boolean(onGenerate), canPlay: Boolean(onTogglePlay) });
      const shell = resolveKey(WORKSPACE_BINDINGS, event, ctx);
      if (shell) {
        const action = shell.action(event, ctx) as ShellAction;
        switch (action.type) {
          case "palette":
            event.preventDefault();
            dispatch({ type: "patch", patch: { palette: !current.palette, query: "" } });
            return;
          case "escape":
            if (current.palette) dispatch({ type: "patch", patch: { palette: false, query: "" } });
            else if (current.agentOpen) dispatch({ type: "patch", patch: { agentOpen: false } });
            return;
          case "enterStudio":
            event.preventDefault();
            go(current.suite, current.page);
            return;
          case "page": {
            event.preventDefault();
            const target = PAGES[current.suite][action.index];
            if (target) go(current.suite, target.id);
            return;
          }
          case "item": {
            const list = listFor(current.selKind, current.lists, current.libFilter) ?? [];
            const next = stepSelection(list, current.selId, action.step);
            if (!next) return;
            event.preventDefault();
            dispatch({ type: "patch", patch: { selId: next } });
            ws.syncUrl();
            return;
          }
          case "generate": {
            event.preventDefault();
            const availability = generateAvailability(current, Boolean(onGenerate));
            if (availability.enabled) onGenerate?.();
            else ws.toast(availability.reason);
            return;
          }
          case "toggleAtomik":
            event.preventDefault();
            dispatch({ type: "patch", patch: { agentOpen: !current.agentOpen } });
            return;
          case "toggleInspector":
            event.preventDefault();
            dispatch({ type: "toggleInspector" });
            return;
          case "play":
            event.preventDefault();
            onTogglePlay?.();
            return;
        }
      }
      if (current.palette) return;
      const extra = seams.bindings && resolveKey(seams.bindings, event, ctx);
      if (extra) extra.action(event, ctx);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, go, dispatch, seams.bindings, onGenerate, onTogglePlay]);

  const openProject = (id: string) => {
    try { localStorage.setItem(scope, id); } catch { /* The URL still carries the project. */ }
    /* Opening a project enters the active suite's first page (prototype `onOpen`). */
    ws.openProject(id, state.suite, PAGES[state.suite][0].id);
  };

  /* Media: the project library's uploads once read, the draft's filed uploads until then. */
  const library = useProjectLibrary(scope, project?.id ?? null);
  const uploads: MediaItem[] = library.state.status === "ready"
    ? library.items.filter((item) => item.take.kind === "UPLOAD").map((item) => ({ id: item.take.id, name: item.take.name, url: item.url, media: item.media, takeId: item.take.id }))
    : projectUploads(project).map((asset) => ({ id: asset.id, name: asset.name, url: asset.url || null, media: asset.kind === "image" || asset.kind === "video" ? asset.kind : null, takeId: null }));
  const Body = PAGE_BODIES[state.page];
  const availability = primaryAvailability(state, seams.onGenerate, seams.generate);
  const reason = availability.reason ?? (state.page === "rig" ? seams.generate?.notice ?? null : null);

  return (
    <AtomikHost scope={scope} project={project} bridge={planBridge}>
    <div className="pxw" data-view={state.view}>
      <TopBar account={account} onOpenPalette={seams.onOpenPalette ?? (() => dispatch({ type: "patch", patch: { palette: true, query: "" } }))} />
      {state.view === "studio" ? (
        <>
          <StageTabs />
          <div className="pxw-studio" data-testid="studio-row">
            <Library uploads={uploads} />
            <main className="pxw-main" data-screen-label={state.page}>
              <ProjectHeader project={project} loading={data.status === "loading"} />
              <PageHeader project={project} onGenerate={seams.onGenerate} generate={seams.generate} />
              <Breadcrumb projectName={projectName || "Project"} reason={reason} />
              <div className="pxw-content" data-testid="content">
                <Body page={state.page} project={project} scope={scope} />
              </div>
              <GenerationStrip />
            </main>
            {state.inspector ? <Inspector scope={scope} project={project} /> : null}
          </div>
          <StatusBar
            projectName={projectName}
            bindings={[...legendBindings(), ...(seams.bindings ?? [])] as KeyBinding<unknown>[]}
            live={{ canGenerate: Boolean(onGenerate), canPlay: Boolean(onTogglePlay) }}
          />
        </>
      ) : (
        <Home projects={data.projects} project={project} status={data.status} error={data.error} onOpenProject={openProject} />
      )}
      <AtomikPanel />
      <Palette onGenerate={onGenerate} />
      <ToastHost />
    </div>
    </AtomikHost>
  );
}

