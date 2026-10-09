"use client";
import { rigDeleteHandler, setRigUndoSink, type RigUndo } from "@/lib/shell/rig-commands";
import { newProject } from "@/lib/workbench/studio";
import { useEffect, useRef, useState } from "react";
import { useNewInterface, useSession } from "@/lib/session";
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
import { inField, inSelectionSurface, parseCtx, shortcutApplies, shortcutCommand, type CtxCapabilities, type CtxCommand, type CtxTarget } from "@/lib/shell/context-menu";
import { holdAgentRequest, prefillAgentRequest, takeHeldAgentRequest } from "@/lib/shell/agent-draft";
import { useShell } from "@/lib/shell/state";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { useRecreatePrice } from "@/lib/shell/use-recreate-price";
import { ctxPrice } from "@/lib/shell/recreate-price";
import type { RecipeSource } from "@/lib/shell/recipe";
import { JobsTrayProvider } from "@/lib/shell/use-jobs-tray";
import { useLibraryFollowsJobs } from "@/lib/shell/use-library-follows-jobs";
import { boundUndo, splitUndoHint } from "@/lib/shell/undo";
import { AtomikSheet } from "./AtomikSheet";
import { ContextMenu } from "./ContextMenu";
import { AtomikGate } from "./AtomikGate";
import { MakePanel } from "./MakePanel";
import { ASSET_LABEL, assetCapabilities, assetRef, type AssetRef } from "@/lib/shell/assets";
import { setShotDropHandler } from "@/lib/shell/drop-targets";
import { useAssetActions } from "@/lib/shell/use-asset-actions";
import { INSPECTOR_SURFACE, endBindings, galleryItems, pickGallery, publishedGallery, setPreviewBinder, type BoundAction } from "@/lib/shell/preview-bridge";
import { stillCurrent } from "@/lib/shell/asset-link";
import { copyAssetLink } from "@/lib/shell/copy-asset-link";
import { Header } from "./Header";
import { LoadBanner } from "./TakeTile";
import { Palette } from "./Palette";
import { PROJECT_NAME_MAX, ProjectHead } from "./ProjectHead";
import { StageStrip } from "./StageStrip";
import { useCompact } from "@/lib/shell/use-compact";
import { isMakeTool } from "@/lib/shell/make";
import dynamic from "next/dynamic";
/* The new interface's frame loads only for a workspace that has it (lib/newInterface.ts): customers never download it.
   SuitesApp draws nothing until the browser is there, so the frame's own chunk is the only wait, and only for them. */
const V12Shell = dynamic(() => import("@/components/v12/V12Shell").then((m) => m.V12Shell));
/* Make as a page (redesign C3): only with the switch on at desktop sizes, so a customer never downloads it. */
const V12Make = dynamic(() => import("@/components/v12/make/V12Make").then((m) => m.V12Make));
import { useRig } from "@/components/workspace/rig/RigProvider";
import { TabBar } from "./TabBar";
import { SwitchingVeil } from "./SwitchingVeil";
import { WorkspaceView } from "./WorkspaceView";
import Boundary from "@/components/Boundary";
import { throwIfArmed } from "@/lib/shell/fault";
import { PanelFault } from "./PanelFault";
import type { ProjectActions } from "./FirstRun";
import { AtomikMount, PhoneMount, ScreenBody, SettingsBody, type ScreenContext } from "./screens";
import { isLanded } from "@/lib/shell/screens";
import { seededProject, type CreateSeed } from "@/lib/shell/create-project";

/** What this build cannot do yet says so on the item; build step 3 (assets) wires the rest to the library's own routes. */

/** Mounted inside the jobs tray's provider: a finished take lands in the open project's Library (lib/shell/use-library-follows-jobs.ts). */
function LibraryFollowsJobs({ projectId, refresh }: { projectId: string | null; refresh: () => Promise<void> }) {
  useLibraryFollowsJobs(projectId, refresh);
  return null;
}

/**
 * One shell (design/particl-graphite/README.md › Shell): the header, then one screen (Home, the board, Settings or Atomik's control
 * room), with Make, Atomik's panel and ⌘K over it. It sits over the state layer, Atomik host and Rig provider. The old suite pages
 * (Studio's stages and overview, Business, Viral, Crew) and the Library and Inspector columns they were drawn in are gone.
 */
export function SuitesShell({ scope, initialAccount, planBridge }: { scope: string; initialAccount: WorkspaceAccount | null; planBridge?: PlanBridge }) {
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
  const actions = useAssetActions({ scope, project, projects: data.projects, items });
  const [moving, setMoving] = useState<AssetRef | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const nameOf = (target: CtxTarget) => (target.kind === "asset" ? items.find((i) => i.take.id === target.id)?.take.name ?? "Asset" : target.kind === "node" ? project?.nodes.find((n) => n.id === target.id)?.title || "Shot" : shell.view === "suite" ? shell.page.title : "Particl");
  const selection = (): CtxTarget => (state.selKind === "take" && state.selId ? { kind: "asset", id: state.selId } : state.selKind === "shot" && state.selId ? { kind: "node", id: state.selId } : { kind: "empty" });

  const clipPayload = shell.clip?.payload as { asset: AssetRef; fromProjectId: string } | undefined;
  const selectedAsset = (() => { const s = selection(); const e = s.kind === "asset" ? items.find((i) => i.take.id === s.id) : null; return e ? assetRef(e) : null; })();
  /* The take under an open right-click menu, when Recreate can run for it: its price is read here (lib/shell/use-recreate-price.ts). */
  const ctxTarget = shell.ctx?.target;
  const ctxEntry = ctxTarget?.kind === "asset" ? items.find((i) => i.take.id === ctxTarget.id) ?? null : null;
  /* The sample workspace spends nothing, and the hook fails closed: no priced Recreate in the menu, and no quote asked for it. */
  const spendOff = useSampleWorkspace();
  const recreatable = !spendOff && ctxEntry && ctxEntry.asset.origin === "generation" && !assetRef(ctxEntry).noRecreate ? ctxEntry : null;
  const recreatePrice = useRecreatePrice(session.requestScope ?? scope, recreatable?.take.id ?? null, recreatable ? (recreatable.asset.value as RecipeSource) : null, project?.aspect);
  const caps: CtxCapabilities = (() => {
    const target = shell.ctx?.target;
    /* A Rig shot: Delete (with ⌘Z) while the Rig is on screen; the asset commands do not apply. */
    if (target?.kind === "node") return { can: rigDeleteHandler() ? { delete: true } : {}, why: { delete: "Open the Board to delete a shot." }, hasClipboard: Boolean(shell.clip), canUndo: shell.canUndo };
    const entry = target?.kind === "asset" ? items.find((i) => i.take.id === target.id) : null;
    const base = assetCapabilities({
      asset: entry ? assetRef(entry) : selectedAsset, clip: shell.clip && clipPayload ? { mode: shell.clip.mode, asset: clipPayload.asset } : null,
      projectId: project?.id ?? null, otherProjects: data.projects.filter((p) => p.id !== project?.id).length, canUndo: shell.canUndo,
    });
    /* Recreate spends once Make is pressed: its price is Make's own, read from the server's quote while the menu is open. */
    if (spendOff) { const { retry: _retry, ...can } = base.can; void _retry; return { ...base, can, why: { ...base.why, retry: spendOff } }; }
    return base.can.retry && recreatePrice ? { ...base, price: { retry: ctxPrice(recreatePrice, session.rates.creditUsd) } } : base;
  })();

  const command = (cmd: CtxCommand, target: CtxTarget) => {
    switch (cmd) {
      case "generate-here": shell.openMake(); return;
      /* The Library is the board's drawer. */
      case "open-library": shell.goBoard({ drawer: "library" }); return;
      case "undo": void shell.undo(); return;
      case "paste": void actions.paste(); return;
    }
    if (target.kind === "node") {
      const remove = rigDeleteHandler();
      if (cmd !== "delete") { toast("Not available for a shot."); return; }
      if (!remove) { toast("Open the Board to delete a shot."); return; }
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
      /* The take opens on the board's Shots, in the board's own Inspector. */
      case "open-in-inspector":
        shell.selectAsset(target.id, { reason: "pick" });
        shell.goBoard({ region: "shots" });
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
    shell.pushUndo(boundUndo(entry, rigProject.current ?? state.projectId, () => rigProject.current, "the Board is still opening this project."), entry.say);
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

  /* One keymap: ⌘K, ⌥M, Esc, and the menu's shortcuts on the selection when focus is not in a field. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      /* A screen that handled the key (the board's own shortcuts, a panel's field) has said so: the shell's keymap leaves it. */
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "k") { event.preventDefault(); shell.setPalette(!shell.palette); return; }
      if (event.key === "Escape") {
        if (shell.ctx) shell.closeCtx();
        else if (shell.palette) shell.setPalette(false);
        else if (state.agentOpen) dispatch({ type: "patch", patch: { agentOpen: false } });
        else if (state.composer) dispatch({ type: "patch", patch: { composer: false } });
        else if (state.agentOpen) dispatch({ type: "patch", patch: { agentOpen: false } });
        /* Atomik's panel (new interface) closes after ⌘K and the menus, before Make, unless a sheet is open over it. */
        else if (shell.atomik && !document.querySelector(".gx-veil")) shell.closeAtomik();
        /* Make closes with Esc, except from a field (Esc there closes the field's own list first) or while a sheet is open over it.
           Make as a page (the new interface's, [data-v12-make]) is a place, not a panel: Esc does not leave it. */
        else if (shell.make && !inField(event.target) && !document.querySelector(".gx-veil") && !document.querySelector("[data-v12-make]")) shell.closeMake();
        return;
      }
      /* ⌥M opens and closes Make (README § 6), from anywhere, a field included: ⌥M types nothing a prompt needs. */
      if (event.altKey && !mod && event.code === "KeyM") { event.preventDefault(); if (shell.make) shell.closeMake(); else shell.openMake(); return; }
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
    /* The words open Atomik's panel (`&atomik=1&q=…`), which takes them from there. */
    if (isLanded("atomik")) { shell.openAtomik("panel", text); return; }
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
  /* The same path with a seed's fields set (Home's templates, a brief): answers the new project's id, or why it could not be made. */
  const createFromSeed = async (name: string, seed: CreateSeed = {}): Promise<{ id: string; productionId?: string | null } | { error: string }> => {
    const created = seededProject(name, seed);
    const response = await fetch("/api/workbench/projects", { method: "PUT", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify({ project: created, revision: 0 }) }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { error?: unknown; project?: { productionProjectId?: unknown }; productionProjectId?: unknown } | null;
    if (!response?.ok) return { error: typeof body?.error === "string" ? body.error : "The project could not be created. Try again." };
    pickProject(created.id);
    toast(`${created.name} is open`);
    const production = body?.project?.productionProjectId ?? body?.productionProjectId;
    return { id: created.id, productionId: typeof production === "string" ? production : null };
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
  /* One way to make a project from a seed, whichever surface asks (Home, ⌘K): the shell's own, registered like its command path. */
  useEffect(() => { shell.setCreateProject(createFromSeed); return () => shell.setCreateProject(null); });
  const projectActions: ProjectActions = { projects: data.projects, onPick: pickProject, onCreate: createProject, onStarter: openStarter };
  /* The project list failed to read: said, with Try again, instead of an empty shell (a failed library read is each grid's own banner). */
  const projectsError = data.status === "error" ? data.error ?? "Projects could not be loaded." : null;
  /* Every card and skeleton holds the project's frame (the card contract, components/graphite/TakeTile.tsx). */
  const aspect = tileAspect(project?.aspect);

  /* The screens (lib/shell/screens.ts): Home and the board fill the body under the header; Settings and Atomik's control room are the
     other two places, and the control room keeps the project chip and the strip. Nothing else is a page. */
  const fullScreen = shell.screen === "home" || shell.screen === "board" || shell.screen === "board-ads" || shell.screen === "board-social";
  const projectHead = (
    <ProjectHead project={project} projects={data.projects} loading={data.status === "loading"} error={projectsError}
      onPick={pickProject} onCreate={createProject} />
  );
  /* A phone's top bar carries the project switcher in its second row, beside the page strip:
     one bar instead of four rows between the screen's edge and the page (components/graphite/phone.css). */
  const compact = useCompact();
  const bar = compact && shell.view === "suite" ? <>{projectHead}<StageStrip /></> : null;
  /* Each panel is walled off (components/Boundary.tsx): one that throws shows its own fault card and the rest keeps working.
     Moving to another page, project or selection gives it a fresh go. */
  const stageKey = `${shell.suite.id}:${shell.page.id}:${project?.id ?? ""}`;
  const stageProbe = `stage:${shell.page.id}`;
  const screenCtx: ScreenContext = { shell, scope, account, project, items, library, data, projectActions, now, onCreate: createFromSeed };
  /* The chrome variables: how far right panels reach (Home and the other views pad by it), and the board's dock (Make sits beside it). */
  const rootStyle = { "--gx-overlay-right": `${shell.make ? 441 : shell.atomik ? 341 : 0}px`, "--board-dock": `${shell.dockRight}px` } as React.CSSProperties;
  /* The phone's own screens replace the header, strip, body and tab bar (switch on and landed; lib/shell/screens.ts › phoneAt). */
  const phoneOn = shell.phone.on;
  const phonePage = shell.view === "workspace" ? { title: "Settings", body: shell.screen === "settings" ? <SettingsBody ctx={screenCtx} /> : <WorkspaceView account={account} /> } : null;

  /* The new interface's frame (components/v12/V12Shell.tsx), for a workspace with the switch on (lib/newInterface.ts), at
     desktop sizes only: a phone keeps PhoneApp. Like the phone's own choice above it reads the viewport, which the shell
     knows from its first render (SuitesApp draws nothing until the browser has it), so neither frame flashes first.
     With the switch off the header and body below render exactly as they always have. */
  const newInterface = useNewInterface();
  const v12 = newInterface && !compact && !phoneOn;
  /* With the switch on at desktop sizes, Make is a page in the frame's body (components/v12/make), not a panel; its quick
     tools (Motion transfer, Object swap, Upscale) still open as today's panel over that page. */
  const v12Make = v12 && Boolean(shell.make);
  const makePanel = Boolean(shell.make) && !phoneOn && !(v12Make && !isMakeTool(shell.make));
  const header = <Header account={account} project={project?.name ?? null} bar={bar} />;
  const desktopBody = <>
        {bar ? null : <StageStrip />}
        {/* The gate row approves a run at its quote; one that throws keeps its row, and the run waits in the engine. */}
        <Boundary what="The Atomik gate" probe="atomik-gate" fallback={(fault) => <div className="gx-fault-dock"><PanelFault fault={fault} name="atomik-gate" variant="inline" /></div>}>
          <AtomikGate />
        </Boundary>
        {fullScreen && linkCard && shell.screen !== "home" ? (
          /* A link to a take that has not opened yet (a teammate's, or another workspace's) says what it is doing before the board draws: offered, never made while it loads. */
          <div className="gx-screen gx-scroll" data-testid="screen" data-screen={shell.screen}><div className="gx-stage" data-testid="content">{linkCard}</div></div>
        ) : fullScreen ? (
          <div className="gx-screen" data-testid="screen" data-screen={shell.screen}><ScreenBody screen={shell.screen!} ctx={screenCtx} /></div>
        ) : shell.view === "workspace" && shell.screen === "settings" ? (
          <SettingsBody ctx={screenCtx} />
        ) : shell.view === "workspace" ? (
          <Boundary what="Workspace" probe="workspace" resetKey={`workspace:${shell.wsTab}`} fallback={(fault) => <div className="gx-fault-view gx-scroll"><PanelFault fault={fault} name="workspace" /></div>}>
            <WorkspaceView account={account} />
          </Boundary>
        ) : (
          <div className="gx-body" style={{ gridTemplateColumns: "minmax(0,1fr)", ...(aspect ? { "--tile-aspect": aspect } : {}) } as React.CSSProperties} data-testid="shell-body" data-columns="minmax(0,1fr)">
            <main className="gx-main" data-screen-label={shell.page.id}>
              {bar ? null : projectHead}
              {linkCard ? (
                <div className="gx-stage gx-scroll" data-testid="content">{linkCard}</div>
              ) : (
                <div className="gx-stage gx-scroll" data-testid="content">
                  <Boundary what={shell.page.title} probe={stageProbe} resetKey={stageKey} fallback={(fault) => <PanelFault fault={fault} name={stageProbe} />}>
                  {projectsError && !project ? (
                    /* With Make open the banner (and its one Try again) is Make's, where the draft waits. */
                    shell.make ? null : <LoadBanner banner={{ tone: "error", message: projectsError }} onRetry={data.retry} testId="projects-error" />
                  ) : (
                    <ScreenBody screen="control-room" ctx={screenCtx} />
                  )}
                  </Boundary>
                </div>
              )}
              <div className="pxw gx-legacy" style={{ flex: "none", minHeight: 0 }}>
                <Boundary what="The run strip" probe="strip" fallback={(fault) => <div className="gx-fault-dock"><PanelFault fault={fault} name="strip" variant="inline" /></div>}><GenerationStrip /></Boundary>
              </div>
            </main>
          </div>
        )}
  </>;

  return (
    <AtomikHost scope={scope} project={project} bridge={planBridge}>
      <JobsTrayProvider>
      <LibraryFollowsJobs projectId={project?.id ?? null} refresh={library.refresh} />
      <SwitchingVeil />
      <div className="gx" data-screen={shell.screen ?? undefined} data-phone={phoneOn ? (shell.phone.framed ? "framed" : "") : undefined}
        data-view={shell.view} data-suite={shell.suite.id} style={rootStyle} onContextMenu={onContext} onClick={() => shell.ctx && shell.closeCtx()}>
        {session.workspace?.suspended ? (
          <div role="status" data-testid="workspace-suspended" style={{ padding: "8px 20px", background: "var(--gx-card)", borderBottom: "1px solid var(--gx-hair)", color: "var(--gx-waiting)" }}>
            This workspace is suspended{session.workspace.suspendedReason ? ` — ${session.workspace.suspendedReason}` : ""}. Rendering is paused; everything already made is still here.
          </div>
        ) : null}
        {phoneOn ? (linkCard ? (
          /* A link to a take that cannot show it yet says what it is doing on a phone too: the phone's own screens draw nothing for it. */
          <div className="gx-screen gx-scroll" data-testid="screen" data-screen="link"><div className="gx-stage" data-testid="content">{linkCard}</div></div>
        ) : <PhoneMount ctx={screenCtx} page={phonePage} />) : v12 ? (
          <V12Shell header={header}>{v12Make ? (
            <Boundary what="Make" probe="gen" resetKey={`v12-make:${scope}`} fallback={(fault) => <div className="gx-fault-view gx-scroll"><PanelFault fault={fault} name="gen" /></div>}>
              <V12Make scope={scope} project={project} projects={data.status} projectsError={projectsError} onRetry={data.retry}
                workspaceName={account?.workspace?.name ?? null} onProject={(id) => selectProject(id, { replace: true })} balance={account?.credits?.balance ?? null} />
            </Boundary>
          ) : desktopBody}</V12Shell>
        ) : <>{header}{desktopBody}</>}
        {/* Make (README § 3.2): a panel over whatever is on screen, beside the Inspector's column when that is open. Its draft
            stays editable while the project list recovers ("Try again", never "Retry": that word is a take's own action). */}
        {makePanel ? (
          <Boundary what="Make" probe="gen" resetKey={`gen:${project?.id ?? ""}`} fallback={(fault) => <aside className="gx-make" aria-label="Make"><PanelFault fault={fault} name="gen" actions={<button type="button" className="gx-hbtn" onClick={shell.closeMake}>Close</button>} /></aside>}>
            <MakePanel scope={scope} project={project} items={items} library={library} projects={data.status} projectsError={projectsError} onRetry={data.retry}
              workspaceName={account?.workspace?.name ?? null} onProject={(id) => selectProject(id, { replace: true })}
              balance={account?.credits?.balance ?? null} aspect={aspect} />
          </Boundary>
        ) : null}
        <Boundary what="Search" probe="palette" resetKey={shell.palette ? "open" : "closed"} fallback={(fault) => !shell.palette ? null : (
          <div className="gx-veil" onClick={() => shell.setPalette(false)} data-testid="palette-veil">
            <div className="gx-fault-dialog" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}>
              <PanelFault fault={fault} name="palette" dialog actions={<button type="button" className="gx-hbtn" onClick={() => shell.setPalette(false)}>Close</button>} />
            </div>
          </div>
        )}>
          <Palette items={items} onAsk={ask} project={project} />
        </Boundary>
        {/* Atomik's panel (new interface, `&atomik=`): over whatever is on screen. */}
        {!phoneOn ? <AtomikMount ctx={screenCtx} /> : null}
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
        {phoneOn ? null : <TabBar />}
        {!phoneOn && state.toast ? (() => {
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
