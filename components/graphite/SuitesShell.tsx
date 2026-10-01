"use client";
import { rigDeleteHandler, setRigUndoSink, type RigUndo } from "@/lib/shell/rig-commands";
import { newProject } from "@/lib/workbench/studio";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { AtomikHost, type PlanBridge } from "@/lib/workspace/atomik-host";
import { useAccount, useProjects, type WorkspaceAccount } from "@/lib/workspace/data";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useAssetLink, useLinkView } from "@/lib/shell/use-asset-link";
import { AssetLinkCard } from "./AssetLinkCard";
import { tileAspect, uploadFilesToProject, useProjectLibrary } from "@/lib/workspace/library";
import { FILES_EVENT, type FilesDropDetail } from "@/components/DragLayer";
import { useWorkspace } from "@/lib/workspace/state";
import { GenerateComposer } from "@/components/workspace/GenerateComposer";
import { GenerationStrip } from "@/components/workspace/GenerationStrip";
import { PAGE_BODIES } from "@/components/workspace/pages/registry";
import type { ShellSeams } from "@/components/workspace/WorkspaceShell";
import { inField, inSelectionSurface, parseCtx, shortcutApplies, shortcutCommand, type CtxCapabilities, type CtxCommand, type CtxTarget } from "@/lib/shell/context-menu";
import { holdAgentRequest, prefillAgentRequest, takeHeldAgentRequest } from "@/lib/shell/agent-draft";
import { useShell } from "@/lib/shell/state";
import { JobsTrayProvider } from "@/lib/shell/use-jobs-tray";
import { boundUndo, splitUndoHint } from "@/lib/shell/undo";
import { AtomikSheet } from "./AtomikSheet";
import { ContextMenu } from "./ContextMenu";
import { AtomikGate } from "./AtomikGate";
import { BusinessSuite } from "./business/BusinessSuite";
import { CrewStrip, CrewView, useCrew } from "./crew/CrewView";
import { GenView } from "./GenView";
import { ASSET_LABEL, assetCapabilities, assetRef, type AssetRef } from "@/lib/shell/assets";
import { setShotDropHandler } from "@/lib/shell/drop-targets";
import { useAssetActions } from "@/lib/shell/use-asset-actions";
import { INSPECTOR_SURFACE, endBindings, galleryItems, pickGallery, publishedGallery, setPreviewBinder, type BoundAction } from "@/lib/shell/preview-bridge";
import { stillCurrent } from "@/lib/shell/asset-link";
import { copyAssetLink } from "@/lib/shell/copy-asset-link";
import { ViralView } from "./viral/ViralView";
import { ToolsView } from "./atomik/ToolsView";
import { MemoryView } from "./atomik/MemoryView";
import { SkillsView } from "./atomik/SkillsView";
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { LoadBanner } from "./TakeTile";
import { PageHead } from "./PageHead";
import { Palette } from "./Palette";
import { PROJECT_NAME_MAX, ProjectHead } from "./ProjectHead";
import { StageStrip } from "./StageStrip";
import { useCompact } from "@/lib/shell/use-compact";
import { Glyph } from "./icons";
import { WorkflowHosts } from "./tools/WorkflowHost";
import { WORKFLOW_SURFACES } from "@/lib/shell/workflows";
import { StudioHome } from "./mobile/StudioHome";
import { SuiteHome } from "./mobile/SuiteHome";
import { STAGE_VIEW_PAGES, StageView } from "./StageView";
import { BriefStage } from "./production/BriefStage";
import { BeatsStage } from "./production/BeatsStage";
import { StoryboardStage } from "./production/StoryboardStage";
import { CastStage } from "./production/CastStage";
import { EnvironmentStage } from "./production/EnvironmentStage";
import { EditStage } from "./production/EditStage";
import { AstraOutputs } from "./production/AstraOutputs";
import { RigLibrary } from "./production/RigExtras";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { TabBar } from "./TabBar";
import { WorkspaceView } from "./WorkspaceView";
import Boundary from "@/components/Boundary";
import { throwIfArmed } from "@/lib/shell/fault";
import { FaultAside, PanelFault } from "./PanelFault";
import { FirstRun, type ProjectActions } from "./FirstRun";

/** What this build cannot do yet says so on the item; build step 3 (assets) wires the rest to the library's own routes. */

/**
 * One shell (design/particl-suites/README.md › Shell): header, stage strip,
 * and [Library 280] | [Stage] | [Inspector 320] with 1px hairline gutters —
 * overlays below 1280. It sits over the same state layer, Atomik host and Rig
 * provider as the shell it replaces, so every page body works from day one.
 */
export function SuitesShell({ scope, initialAccount, seams = {}, planBridge }: { scope: string; initialAccount: WorkspaceAccount | null; seams?: ShellSeams; planBridge?: PlanBridge }) {
  /* A throw out here (the chrome itself) is app/suites/error.tsx's; everything below has its own boundary. */
  throwIfArmed("shell");
  const ws = useWorkspace();
  const shell = useShell();
  const { state, dispatch, selectProject, toast } = ws;
  const session = useSession();
  const account = useAccount(initialAccount);
  /* A link to a take holds project resolution until it can open in a project of this person's (lib/shell/use-asset-link.ts). */
  const scopedFetch = useScopedFetch();
  const linkControl = useAssetLink({ scope, workspace: session.workspace, workspaces: session.workspaces, projectId: state.projectId, selectProject, fetch: scopedFetch });
  const data = useProjects(scope, state.projectId, (id) => selectProject(id, { replace: true }), linkControl.hold);
  const linkView = useLinkView(linkControl, data);
  const linkCard = linkView.phase === "none" ? null : <AssetLinkCard link={linkControl} view={linkView} />;
  const project = data.project;
  const library = useProjectLibrary(scope, project?.id ?? null);
  const items = library.items;
  /* Loaded only while Crew is on screen; the open room is remembered per project, so coming back reopens it. */
  const crew = useCrew(shell.view === "crew" ? project?.id ?? null : null);
  const actions = useAssetActions({ scope, project, projects: data.projects, items });
  const [moving, setMoving] = useState<AssetRef | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const nameOf = (target: CtxTarget) => (target.kind === "asset" ? items.find((i) => i.take.id === target.id)?.take.name ?? "Asset" : target.kind === "node" ? project?.nodes.find((n) => n.id === target.id)?.title || "Shot" : shell.view === "suite" ? shell.page.title : "Particl");
  const selection = (): CtxTarget => (state.selKind === "take" && state.selId ? { kind: "asset", id: state.selId } : state.selKind === "shot" && state.selId ? { kind: "node", id: state.selId } : { kind: "empty" });

  const clipPayload = shell.clip?.payload as { asset: AssetRef; fromProjectId: string } | undefined;
  const selectedAsset = (() => { const s = selection(); const e = s.kind === "asset" ? items.find((i) => i.take.id === s.id) : null; return e ? assetRef(e) : null; })();
  const caps: CtxCapabilities = (() => {
    const target = shell.ctx?.target;
    /* A Rig shot: Delete (with ⌘Z) while the Rig is on screen; the asset commands do not apply. */
    if (target?.kind === "node") return { can: rigDeleteHandler() ? { delete: true } : {}, why: { delete: "Open the Rig to delete a shot." }, hasClipboard: Boolean(shell.clip), canUndo: shell.canUndo };
    const entry = target?.kind === "asset" ? items.find((i) => i.take.id === target.id) : null;
    return assetCapabilities({
      asset: entry ? assetRef(entry) : selectedAsset, clip: shell.clip && clipPayload ? { mode: shell.clip.mode, asset: clipPayload.asset } : null,
      projectId: project?.id ?? null, otherProjects: data.projects.filter((p) => p.id !== project?.id).length, canUndo: shell.canUndo,
    });
  })();

  const command = (cmd: CtxCommand, target: CtxTarget) => {
    switch (cmd) {
      case "generate-here": shell.goGen(); return;
      case "open-library": shell.openLibrary("assets"); return;
      case "toggle-inspector": shell.toggleInspector(); return;
      case "undo": void shell.undo(); return;
      case "paste": void actions.paste(); return;
    }
    if (target.kind === "node") {
      const remove = rigDeleteHandler();
      if (cmd !== "delete") { toast("Not available for a shot."); return; }
      if (!remove) { toast("Open the Rig to delete a shot."); return; }
      const why = remove(target.id);
      if (why) toast(why);
      return;
    }
    if (target.kind !== "asset") { toast(caps.why[cmd] ?? "Select an asset first."); return; }
    switch (cmd) {
      case "copy": actions.copy(target.id, "copy"); return;
      case "cut": actions.copy(target.id, "cut"); return;
      case "delete": void actions.remove(target.id); return;
      case "use-as-reference": actions.useAsReference(target.id); return;
      case "retry": actions.retry(target.id); return;
      case "open-in-inspector":
        shell.selectAsset(target.id, { reason: "pick" });
        shell.openInspector();
        return;
      case "move": {
        const entry = items.find((i) => i.take.id === target.id);
        if (entry && caps.can.move) setMoving(assetRef(entry)); else toast(caps.why.move ?? "Nothing to move.");
        return;
      }
      default: toast(caps.why[cmd] ?? "Not available for this selection.");
    }
  };
  /* A Rig step undoes only into the draft it was made in. Coming back to a project, the Rig still holds the
     previous project's draft until the new one loads: the step then refuses and stays on the stack. */
  const rigProjectId = useRig().project?.id ?? null;
  const rigProject = useRef(rigProjectId);
  useEffect(() => { rigProject.current = rigProjectId; }, [rigProjectId]);
  const sinkRigUndo = (entry: RigUndo) =>
    shell.pushUndo(boundUndo(entry, rigProject.current ?? state.projectId, () => rigProject.current, "the Rig is still opening this project."));
  /* The Inspector's buttons and the Rig's drop use the same path. */
  useEffect(() => { shell.setRunCommand(command); setShotDropHandler((id, shot) => void actions.fileOnShot(id, shot)); setRigUndoSink(sinkRigUndo); return () => { shell.setRunCommand(null); setShotDropHandler(null); setRigUndoSink(null); }; });

  /* The site's previewer binds to this shell (lib/shell/preview-bridge): a preview opened from the Library, the Takes desk or
     the Inspector walks that surface's whole list, its arrows move this selection, and its buttons are this shell's commands.
     Everything is read when it is used, and checked against the scope and project the preview was opened in. */
  const bridge = useRef({ scope, projectId: project?.id ?? null, items, production: project?.productionProjectId ?? null, workspace: session.workspace?.id ?? null });
  useEffect(() => { bridge.current = { scope, projectId: project?.id ?? null, items, production: project?.productionProjectId ?? null, workspace: session.workspace?.id ?? null }; });
  const { live: liveShell } = shell;
  useEffect(() => setPreviewBinder(({ surface, asset }) => {
    const at = bridge.current;
    let list = pickGallery(surface, asset, { takes: publishedGallery("takes") ?? undefined, library: publishedGallery("library") ?? undefined }, at.projectId);
    /* The Inspector with neither list on show (a phone, another page): the project's whole library, newest first. */
    if (!list && surface === INSPECTOR_SURFACE && asset && at.projectId) {
      const all = galleryItems(at.items), index = all.findIndex((item) => item.id === asset);
      if (index >= 0) list = { surface: "library", items: all, index };
    }
    if (!list) return null;
    const captured = { scope: at.scope, projectId: at.projectId };
    const current = () => stillCurrent(captured, { scope: bridge.current.scope, projectId: bridge.current.projectId });
    const entryOf = (id: string) => bridge.current.items.find((entry) => entry.take.id === id) ?? null;
    return {
      items: list.items,
      index: list.index,
      step: (id) => { if (current() && entryOf(id)) liveShell().selectAsset(id, { reason: "step" }); },
      actions: (id) => {
        const entry = entryOf(id);
        if (!entry || !current()) return {};
        const caps = assetCapabilities({ asset: assetRef(entry), clip: null, projectId: bridge.current.projectId, otherProjects: 0, canUndo: false });
        return {
          ...(entry.asset.origin === "generation" ? { recreate: { enabled: Boolean(caps.can.retry), why: caps.why.retry } } : {}),
          reference: { enabled: Boolean(caps.can["use-as-reference"]), why: caps.why["use-as-reference"] },
          ...(bridge.current.production && bridge.current.workspace ? { link: { enabled: true } } : {}),
        };
      },
      act: async (action: BoundAction, id: string) => {
        /* Checked again when pressed: a take gone from this project, or a project left, does nothing. */
        if (!current()) return { close: true };
        if (!entryOf(id)) return { said: "This take is no longer in this project." };
        if (action === "link") return { said: await copyAssetLink({ workspace: bridge.current.workspace, production: bridge.current.production, asset: id }) };
        /* Recreate hands the recipe to Gen and Use as reference sends the take there: no request is made, Gen prices on its button. */
        liveShell().runCommand?.(action === "recreate" ? "retry" : "use-as-reference", { kind: "asset", id });
        return { close: true };
      },
    };
  }), [liveShell]);
  /* Leaving this scope or project ends every preview bound to it. */
  const boundProject = project?.id ?? null;
  useEffect(() => endBindings, [scope, boundProject]);

  /* A file dropped where no target took it (components/DragLayer) is kept in this project's Library. */
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    const onFiles = (e: Event) => {
      const detail = (e as CustomEvent<FilesDropDetail>).detail;
      if (!detail?.files.length) return;
      detail.handled = true;
      void uploadFilesToProject(scope, projectId, detail.files)
        .then(({ ids, notes }) => toast(notes.length ? notes.join(" ") : `${ids.length} ${ids.length === 1 ? "file" : "files"} added to the Library`))
        .catch((error: unknown) => toast(error instanceof Error ? error.message : "The files could not be uploaded."));
    };
    window.addEventListener(FILES_EVENT, onFiles);
    return () => window.removeEventListener(FILES_EVENT, onFiles);
  }, [scope, projectId, toast]);

  /* Where the last press landed: a clicked tile leaves focus on the page in Safari and Firefox on macOS, so the keymap asks this instead. */
  const pressedInSurface = useRef(false);
  useEffect(() => {
    const onPress = (event: PointerEvent) => { pressedInSurface.current = inSelectionSurface(event.target); };
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  }, []);

  /* One keymap: ⌘K, ⌘J, Esc, and the menu's shortcuts on the selection when focus is not in a field. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "k") { event.preventDefault(); shell.setPalette(!shell.palette); return; }
      if (mod && key === "j") { event.preventDefault(); shell.toggleInspector(); return; }
      if (event.key === "Escape") {
        if (shell.ctx) shell.closeCtx();
        else if (shell.palette) shell.setPalette(false);
        else if (state.agentOpen) dispatch({ type: "patch", patch: { agentOpen: false } });
        else if (state.composer) dispatch({ type: "patch", patch: { composer: false } });
        else if (state.agentOpen) dispatch({ type: "patch", patch: { agentOpen: false } });
        else if (shell.libOpen || shell.inspOpen) shell.closePanels();
        return;
      }
      if (shell.palette || state.composer || state.agentOpen || inField(event.target)) return;
      const cmd = shortcutCommand(event);
      if (!cmd) return;
      const target = selection();
      if (cmd !== "undo" && cmd !== "paste" && target.kind === "empty") return;
      if (cmd === "paste" && !shell.clip) return;
      /* A selection lingers after its click: selected text keeps the browser's ⌘C/⌘X, and ⌫/⌘R/⌘D act only from where the selection is shown. */
      if (!shortcutApplies(cmd, { target: event.target, textSelected: Boolean(window.getSelection()?.toString()), selection: target.kind, pressedInSurface: pressedInSurface.current })) return;
      event.preventDefault();
      command(cmd, target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onContext = (event: React.MouseEvent) => {
    if (inField(event.target)) return;
    event.preventDefault();
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
    const parsed = parseCtx(el?.dataset.ctx);
    const target = parsed.kind === "empty" ? selection() : parsed;
    shell.openCtx({ x: event.clientX, y: event.clientY, target: el ? parsed : target, title: nameOf(el ? parsed : target) });
  };



  /* ⌘K › "Ask Atomik: …": the words land in the Agent's request box (still to be read and planned), not lost on the way.
     With no project open yet they wait in this tab and land as soon as one resolves. */
  const ask = (text: string) => {
    if (project) prefillAgentRequest(session.requestScope, "atomik", project.id, text);
    else if (holdAgentRequest(session.requestScope, text) && data.status !== "loading") toast("Your request goes into Agent once a project is open.");
    shell.goSuite("atomik", "agent");
  };
  const openProjectId = project?.id ?? null;
  const requestScope = session.requestScope;
  useEffect(() => {
    if (!openProjectId) return;
    const held = takeHeldAgentRequest(requestScope);
    if (held) prefillAgentRequest(requestScope, "atomik", openProjectId, held);
  }, [openProjectId, requestScope]);
  /* One way to open, start and explore a project, whichever surface asks: the switcher, a stage's first-run card, the Studio home. */
  /* Choosing a project leaves a link that has not opened yet: that project, not the link's, is what opens. */
  const pickProject = (id: string) => { if (linkControl.link) linkControl.dismiss(); try { localStorage.setItem(scope, id); } catch { /* the URL still carries it */ } selectProject(id); };
  const createProject = async (name: string) => {
    const created = newProject(name.slice(0, PROJECT_NAME_MAX));
    const response = await fetch("/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify({ project: created, revision: 0 }) }).catch(() => null);
    if (!response?.ok) return ((await response?.json().catch(() => null))?.error as string | undefined) ?? "The project could not be created. Try again.";
    pickProject(created.id);
    toast(`${created.name} is open`);
    return null;
  };
  /* The workspace's starter production, seeded on first use and opened as this person's draft; a second press opens the same one. */
  const openStarter = async () => {
    const response = await fetch("/api/workbench/projects", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify({ action: "starter" }) }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { project?: { id?: unknown; name?: unknown }; error?: unknown } | null;
    if (!response?.ok || typeof body?.project?.id !== "string") return typeof body?.error === "string" ? body.error : "The starter production could not be opened. Try again.";
    pickProject(body.project.id);
    toast(`${typeof body.project.name === "string" ? body.project.name : "The starter production"} is open. Its takes are samples: nothing was generated or charged.`);
    return null;
  };
  const projectActions: ProjectActions = { projects: data.projects, onPick: pickProject, onCreate: createProject, onStarter: openStarter };
  /* A Studio stage with no project open: while the list is still being read, say so; then the first-run card. */
  const noProject = (stage: string, lead: string) => data.status === "loading"
    ? <p className="gx-empty" role="status" data-testid={`${stage}-opening`}>Opening your projects…</p>
    : <FirstRun key={`first-run:${stage}`} stage={stage} lead={lead} actions={projectActions} now={now} />;
  /* The Studio stages whose bodies are tools (Rig, Astra, Edit & Sound, Deliver) keep them, with the same card above. */
  const firstRunAbove = !project && data.status === "ready" && shell.view === "suite" && shell.suite.id === "studio"
    ? <FirstRun key={`first-run:${shell.page.id}`} stage={shell.page.id} lead={`Open or create a project to use ${shell.page.title}.`} actions={projectActions} now={now} />
    : null;
  /* The project list failed to read: said, with Try again, instead of an empty shell (a failed library read is each grid's own banner). */
  const projectsError = data.status === "error" ? data.error ?? "Projects could not be loaded." : null;
  /* Every card and skeleton holds the project's frame (the card contract, components/graphite/TakeTile.tsx). */
  const aspect = tileAspect(project?.aspect);

  const overlay = !shell.wide;
  const showLibrary = shell.view !== "workspace" && (shell.wide || shell.libOpen);
  /* The desktop Studio home inspects nothing of its own: its Inspector column opens for a take picked there, never for a stage spec it does not show. */
  const onStudioHome = shell.view === "suite" && shell.suite.id === "studio" && shell.page.id === "stages";
  const showInspector = shell.view !== "workspace" && (shell.wide ? shell.inspector && !(onStudioHome && state.selKind !== "take") : shell.inspOpen);
  const columns = [shell.wide && showLibrary ? "280px" : null, "minmax(0,1fr)", shell.wide && showInspector ? "320px" : null].filter(Boolean).join(" ");
  const Body = PAGE_BODIES[state.page];
  const projectHead = (
    <ProjectHead project={project} projects={data.projects} loading={data.status === "loading"} error={projectsError}
      onPick={pickProject} onCreate={createProject} />
  );
  const genHead = (
    <div className="gx-pagehead" data-row="page">
      <h1 className="gx-h1" data-testid="page-title">Generate</h1>
      <span className="gx-hint">Video · Images · Audio</span>
      <span className="gx-spacer" />
      {!shell.wide ? (<>
        <button type="button" className="gx-hbtn gx-hbtn--glyph" aria-pressed={shell.libOpen} onClick={shell.toggleLibrary} data-testid="toggle-library"><span className="gx-hbtn-glyph" aria-hidden="true"><Glyph name="stack" size={18} /></span><span className="gx-hbtn-label">Library</span></button>
        <button type="button" className="gx-hbtn gx-hbtn--glyph" aria-pressed={shell.inspOpen} onClick={shell.toggleInspector} data-testid="toggle-inspector"><span className="gx-hbtn-glyph" aria-hidden="true"><Glyph name="info" size={18} /></span><span className="gx-hbtn-label">Inspector</span></button>
      </>) : null}
    </div>
  );
  /* A phone's top bar carries the project switcher in its second row, beside the page strip (or Gen's own buttons):
     one glass island instead of four rows between the screen's edge and the page (app/phone-chrome.css). */
  const compact = useCompact();
  const bar = compact && (shell.view === "suite" || shell.view === "gen") ? <>{projectHead}{shell.view === "gen" ? genHead : <StageStrip />}</> : null;
  /* Each panel is walled off (components/Boundary.tsx): one that throws shows its own fault card and the rest keeps working.
     Moving to another page, project or selection gives it a fresh go. */
  const stageKey = `${shell.suite.id}:${shell.page.id}:${project?.id ?? ""}`;
  const stageProbe = `stage:${shell.page.id}`;

  return (
    <AtomikHost scope={scope} project={project} bridge={planBridge}>
      <JobsTrayProvider>
      <div className="gx" data-view={shell.view} data-suite={shell.suite.id} onContextMenu={onContext} onClick={() => shell.ctx && shell.closeCtx()}>
        {session.workspace?.suspended ? (
          <div role="status" data-testid="workspace-suspended" style={{ padding: "8px 20px", background: "var(--gx-card)", borderBottom: "1px solid var(--gx-hair)", color: "var(--gx-waiting)" }}>
            This workspace is suspended{session.workspace.suspendedReason ? ` — ${session.workspace.suspendedReason}` : ""}. Rendering is paused; everything already made is still here.
          </div>
        ) : null}
        <Header account={account} bar={bar} />
        {bar ? null : <StageStrip />}
        {/* The gate row approves a run at its quote; one that throws keeps its row, and the run waits in the engine. */}
        <Boundary what="The Atomik gate" probe="atomik-gate" fallback={(fault) => <div className="gx-fault-dock"><PanelFault fault={fault} name="atomik-gate" variant="inline" /></div>}>
          <AtomikGate />
        </Boundary>
        {shell.view === "crew" ? <><CrewStrip room={crew} />
          <Boundary what="Crew" probe="crew" resetKey={`crew:${shell.crewPage}:${project?.id ?? ""}`} fallback={(fault) => <div className="gx-fault-view gx-scroll"><PanelFault fault={fault} name="crew" /></div>}>
            <CrewView project={project} room={crew} scope={scope} projectsError={projectsError} onRetry={data.retry} />
          </Boundary></> : shell.view === "workspace" ? (
          <Boundary what="Workspace" probe="workspace" resetKey={`workspace:${shell.wsTab}`} fallback={(fault) => <div className="gx-fault-view gx-scroll"><PanelFault fault={fault} name="workspace" /></div>}>
            <WorkspaceView account={account} />
          </Boundary>
        ) : (
          <div className="gx-body" style={{ gridTemplateColumns: columns, ...(aspect ? { "--tile-aspect": aspect } : {}) } as React.CSSProperties} data-testid="shell-body" data-columns={columns}>
            {overlay && (shell.libOpen || shell.inspOpen) ? <div className="gx-scrim" onClick={shell.closePanels} data-testid="panel-scrim" /> : null}
            {showLibrary ? (
              <Boundary what="The Library" probe="library" resetKey={`${project?.id ?? ""}:${shell.view}:${shell.page.id}`}
                fallback={(fault) => <FaultAside kind="library" overlay={overlay} fault={fault} onClose={overlay ? shell.closePanels : undefined} />}>
                <Library project={project} items={items} library={library} projects={data.status} overlay={overlay} now={now} onUseAsReference={actions.useAsReference} cutId={shell.clip?.mode === "cut" && shell.clip.target.kind === "asset" ? shell.clip.target.id : null} />
              </Boundary>
            ) : null}
            <main className="gx-main" data-screen-label={shell.view === "gen" ? "gen" : shell.page.id}>
              {bar ? null : projectHead}
              {/* Keep Gen's draft editable while generation waits for the project list to recover.
                  "Try again", never "Retry": that word is a take's own action (⌘R, Recreate in Gen). */}
              {shell.view === "gen" && projectsError ? <LoadBanner banner={{ tone: "error", message: projectsError }} onRetry={data.retry} testId="projects-error" /> : null}
              {linkCard ? (
                <div className="gx-stage gx-scroll" data-testid="content">{linkCard}</div>
              ) : shell.view === "gen" ? (
                <>
                  {bar ? null : genHead}
                  {/* Its own scroller: arriving in Gen (Open in Gen from a page scrolled down) starts at the composer's top. */}
                  <div className="gx-stage gx-scroll" data-testid="content" key="gen-stage">
                    <Boundary what="Generate" probe="gen" resetKey={`gen:${project?.id ?? ""}`} fallback={(fault) => <PanelFault fault={fault} name="gen" />}>
                      <GenView scope={scope} project={project} items={items} library={library} projects={data.status} workspaceName={account?.workspace?.name ?? null} onProject={(id) => selectProject(id, { replace: true })} />
                    </Boundary>
                  </div>
                </>
              ) : (
                <>
                  {/* The phone's Home and Studio stage grid carry their own titles; the page head is the stage's. */}
                  {(shell.page.id === "home" || shell.page.id === "stages") && shell.suite.id === "studio" ? null : <PageHead project={project} onGenerate={seams.onGenerate} generate={seams.generate} />}
                  <div className="gx-stage gx-scroll" data-testid="content">
                    <Boundary what={shell.page.title} probe={stageProbe} resetKey={stageKey} fallback={(fault) => <PanelFault fault={fault} name={stageProbe} />}>
                    {projectsError && !project ? (
                      <LoadBanner banner={{ tone: "error", message: projectsError }} onRetry={data.retry} testId="projects-error" />
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "home" ? (
                      <SuiteHome key="home" project={project} items={items} />
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "stages" ? (
                      <StudioHome key="stages" project={project} items={items} actions={projectActions} loading={data.status === "loading"} now={now} />
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "brief" ? (
                      project ? <BriefStage key={project.id} projectId={project.id} scope={scope} onBeats={() => shell.goSuite("studio", "beats")} /> : noProject("brief", "Open or create a project to write its script.")
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "beats" ? (
                      project ? <BeatsStage key={project.id} projectId={project.id} scope={scope} onBrief={() => shell.goSuite("studio", "brief")} onBoards={() => shell.goSuite("studio", "boards")} /> : noProject("beats", "Open or create a project to break its script into beats.")
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "takes" ? (
                      project ? <EditStage key={project.id} scope={scope} projectId={project.id} items={items} onTimeline={() => shell.goSuite("studio", "edit")} /> : noProject("takes", "Open or create a project to see its takes.")
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "environment" ? (
                      project ? <EnvironmentStage key={project.id} projectId={project.id} scope={scope} items={items} onBeats={() => shell.goSuite("studio", "beats")} /> : noProject("environment", "Open or create a project to build its world.")
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "cast" ? (
                      project ? <CastStage key={project.id} projectId={project.id} scope={scope} items={items} onBeats={() => shell.goSuite("studio", "beats")} /> : noProject("cast", "Open or create a project to cast it.")
                    ) : shell.page.own && shell.suite.id === "studio" && shell.page.id === "boards" ? (
                      project ? <StoryboardStage key={project.id} projectId={project.id} scope={scope} onBeats={() => shell.goSuite("studio", "beats")} onRig={() => shell.goSuite("studio", "rig")} /> : noProject("boards", "Open or create a project to storyboard it.")
                    ) : shell.page.own && shell.suite.id === "studio" && STAGE_VIEW_PAGES.includes(shell.page.legacy.page) ? (
                      <div className="gx-stage-host" key={shell.page.id}>
                        {firstRunAbove}
                        {WORKFLOW_SURFACES[`${shell.suite.id}:${shell.page.id}`] ? (
                          <div className="gx-extras" data-testid="page-workflows">
                            <WorkflowHosts surfaces={WORKFLOW_SURFACES[`${shell.suite.id}:${shell.page.id}`]} scope={scope} project={project} />
                          </div>
                        ) : null}
                        {shell.page.id === "astra" ? <AstraOutputs /> : null}
                        <StageView page={shell.page.legacy.page} project={project} scope={scope} />
                      </div>
                    ) : shell.page.own && shell.suite.id === "business" ? (
                      <BusinessSuite key={shell.page.id} scope={scope} project={project} page={shell.page.id} />
                    ) : shell.page.own && shell.suite.id === "viral" ? (
                      <ViralView key={shell.page.id} scope={scope} project={project} page={shell.page.id as "motion" | "swap" | "history"} items={items} />
                    ) : shell.page.own && shell.suite.id === "atomik" && shell.page.id === "skills" ? <ToolsView />
                    : shell.page.own && shell.suite.id === "atomik" && shell.page.id === "memory" ? <MemoryView key={project?.productionProjectId ?? "workspace"} scope={scope} project={project} />
                    : shell.page.own && shell.suite.id === "atomik" && shell.page.id === "saved-skills" ? <SkillsView key={project?.productionProjectId ?? "workspace"} scope={scope} project={project} /> : (<>
                      {firstRunAbove}
                      <div className="pxw gx-legacy gx-enter" key={shell.page.id}>
                        {WORKFLOW_SURFACES[`${shell.suite.id}:${shell.page.id}`] ? (
                          <div className="gx-extras" data-testid="page-workflows">
                            <WorkflowHosts surfaces={WORKFLOW_SURFACES[`${shell.suite.id}:${shell.page.id}`]} scope={scope} project={project} />
                          </div>
                        ) : null}
                        {shell.suite.id === "studio" && shell.page.id === "rig" ? <RigLibrary /> : null}
                        <div className="pxw-content"><Body page={state.page} project={project} scope={scope} /></div>
                      </div>
                    </>)}
                    </Boundary>
                  </div>
                </>
              )}
              <div className="pxw gx-legacy" style={{ flex: "none", minHeight: 0 }}>
                <Boundary what="The run strip" probe="strip" fallback={(fault) => <div className="gx-fault-dock"><PanelFault fault={fault} name="strip" variant="inline" /></div>}><GenerationStrip /></Boundary>
              </div>
            </main>
            {showInspector ? (
              <Boundary what="The Inspector" probe="inspector" resetKey={`${state.selKind}:${state.selId ?? ""}:${project?.id ?? ""}`}
                fallback={(fault) => <FaultAside kind="inspector" overlay={overlay} fault={fault} onClose={overlay ? shell.closePanels : shell.toggleInspector} />}>
                <Inspector scope={scope} project={project} overlay={overlay} held={Boolean(linkCard)} />
              </Boundary>
            ) : null}
          </div>
        )}
        <Boundary what="Search" probe="palette" resetKey={shell.palette ? "open" : "closed"} fallback={(fault) => !shell.palette ? null : (
          <div className="gx-veil" onClick={() => shell.setPalette(false)} data-testid="palette-veil">
            <div className="gx-fault-dialog" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}>
              <PanelFault fault={fault} name="palette" dialog actions={<button type="button" className="gx-hbtn" onClick={() => shell.setPalette(false)}>Close</button>} />
            </div>
          </div>
        )}>
          <Palette items={items} onAsk={ask} />
        </Boundary>
        <div className="pxw gx-legacy" style={{ minHeight: 0, flex: "none" }}>
          {/* Closed, the composer shows nothing, so a failure there shows nothing either until it is opened — like Search and Atomik. */}
          <Boundary what="The composer" probe="composer" resetKey={state.composer ? "open" : "closed"} fallback={(fault) => !state.composer ? null : (
            <div className="gx-fault-dock"><PanelFault fault={fault} name="composer" variant="inline"
              actions={<button type="button" className="gx-hbtn" onClick={() => dispatch({ type: "patch", patch: { composer: false } })}>Close</button>} /></div>
          )}>
            <GenerateComposer scope={scope} project={project} onProject={(id) => selectProject(id, { replace: true })} workspaceName={account?.workspace?.name ?? null} />
          </Boundary>
        </div>
        {/* The page's Atomik plan: "Run stage" and the Inspector's Approve open it; its gate approves. */}
        <Boundary what="Atomik" probe="atomik-sheet" resetKey={state.agentOpen ? "open" : "closed"} fallback={(fault) => !state.agentOpen ? null : (
          <div className="gx-veil" onClick={() => dispatch({ type: "patch", patch: { agentOpen: false } })} data-testid="atomik-veil">
            <div className="gx-fault-dialog" role="dialog" aria-modal="true" aria-label="Atomik" onClick={(e) => e.stopPropagation()}>
              <PanelFault fault={fault} name="atomik-sheet" dialog actions={<button type="button" className="gx-hbtn" onClick={() => dispatch({ type: "patch", patch: { agentOpen: false } })}>Close</button>} />
            </div>
          </div>
        )}>
          <AtomikSheet />
        </Boundary>
        <ContextMenu caps={caps} labels={shell.ctx?.target.kind === "asset" ? ASSET_LABEL : undefined} onCommand={(cmd) => command(cmd, shell.ctx?.target ?? selection())} />
        {moving ? (
          <div className="gx-veil" onClick={() => setMoving(null)} data-testid="move-veil">
            <div className="gx-sheet" role="dialog" aria-modal="true" aria-label={`Move ${moving.name} to`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMoving(null); } }}>
              <div className="gx-sheet-head"><span className="gx-panel-title">Move {moving.name} to…</span><button type="button" className="gx-hbtn" onClick={() => setMoving(null)}>Cancel</button></div>
              <div className="gx-sheet-list gx-scroll" role="listbox" aria-label="Projects">
                {data.projects.filter((p) => p.id !== project?.id).map((p) => (
                  <button key={p.id} type="button" role="option" aria-selected={false} className="gx-sheet-row" onClick={() => { const asset = moving; setMoving(null); void actions.moveTo(asset.id, p); }}>
                    <span className="gx-model-name">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <TabBar />
        {state.toast ? (() => {
          /* A confirmation with somewhere to go carries its Open (lib/shell/confirmations); one the undo stack can take back
             carries its Undo, the phone's ⌘Z (lib/shell/state › pushUndo), while that step is still the one ⌘Z would undo.
             A mouse over it, or keyboard focus on it, holds it on screen. A tap does not: on a phone it sits over the page's
             bottom actions, so it times out. */
          const given = ws.toastAction?.text === state.toast ? ws.toastAction.action : null;
          const action = given && (!given.live || given.live()) ? given : null;
          const undo = given?.kind === "undo";
          /* An undo toast's "⌘Z to undo" is for keyboards (hidden on touch screens), and only while ⌘Z would undo that step. */
          const { lead, hint } = undo ? splitUndoHint(state.toast) : { lead: state.toast, hint: "" };
          return (
            <div className="gx-toast" role="status" data-testid="toast" data-open={action ? "" : undefined}
              onPointerEnter={action ? (e) => { if (e.pointerType === "mouse") ws.holdToast(true); } : undefined}
              onPointerLeave={action ? (e) => { if (e.pointerType === "mouse") ws.holdToast(false); } : undefined}
              onFocus={action ? (e) => { if (e.target.matches(":focus-visible")) ws.holdToast(true); } : undefined}
              onBlur={action ? () => ws.holdToast(false) : undefined}>
              {action ? <>
                <span className="gx-toast-text">{lead}{hint ? <span className="gx-toast-kbd">{hint}</span> : null}</span>
                <button type="button" className={undo ? "gx-toast-undo" : "gx-toast-open"} onClick={(e) => { e.stopPropagation(); action.run(); }} data-testid={undo ? "toast-undo" : "toast-open"}>{action.label}</button>
              </> : lead}
            </div>
          );
        })() : null}
      </div>
      </JobsTrayProvider>
    </AtomikHost>
  );
}
