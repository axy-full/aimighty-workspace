"use client";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { AtomikHost, type PlanBridge } from "@/lib/workspace/atomik-host";
import { useAccount, useProjects, type WorkspaceAccount } from "@/lib/workspace/data";
import { useProjectLibrary } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { GenerateComposer } from "@/components/workspace/GenerateComposer";
import { GenerationStrip } from "@/components/workspace/GenerationStrip";
import { PAGE_BODIES } from "@/components/workspace/pages/registry";
import type { ShellSeams } from "@/components/workspace/WorkspaceShell";
import { inField, parseCtx, shortcutCommand, type CtxCapabilities, type CtxCommand, type CtxTarget } from "@/lib/shell/context-menu";
import { useShell } from "@/lib/shell/state";
import { ContextMenu } from "./ContextMenu";
import { BusinessView } from "./business/BusinessView";
import { CrewStrip, CrewView, useCrew } from "./crew/CrewView";
import { GenView } from "./GenView";
import { ASSET_LABEL, assetCapabilities, assetRef, type AssetRef } from "@/lib/shell/assets";
import { setShotDropHandler } from "@/lib/shell/drop-targets";
import { useAssetActions } from "@/lib/shell/use-asset-actions";
import { ViralView } from "./viral/ViralView";
import { SkillsView } from "./atomik/SkillsView";
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { PageHead } from "./PageHead";
import { Palette } from "./Palette";
import { ProjectHead } from "./ProjectHead";
import { StageStrip } from "./StageStrip";
import { TabBar } from "./TabBar";
import { WorkspaceView } from "./WorkspaceView";

/** What this build cannot do yet says so on the item; build step 3 (assets) wires the rest to the library's own routes. */

/**
 * One shell (design/particl-suites/README.md › Shell): header, stage strip,
 * and [Library 280] | [Stage] | [Inspector 320] with 1px hairline gutters —
 * overlays below 1280. It sits over the same state layer, Atomik host and Rig
 * provider as the shell it replaces, so every page body works from day one.
 */
export function SuitesShell({ scope, initialAccount, seams = {}, planBridge }: { scope: string; initialAccount: WorkspaceAccount | null; seams?: ShellSeams; planBridge?: PlanBridge }) {
  const ws = useWorkspace();
  const shell = useShell();
  const { state, dispatch, selectProject, toast } = ws;
  const session = useSession();
  const account = useAccount(initialAccount);
  const data = useProjects(scope, state.projectId, (id) => selectProject(id, { replace: true }));
  const project = data.project;
  const library = useProjectLibrary(scope, project?.id ?? null);
  const items = library.items;
  /* Loaded only while Crew is on screen; the open room is remembered per project, so coming back reopens it. */
  const crew = useCrew(shell.view === "crew" ? project?.id ?? null : null);
  const actions = useAssetActions({ scope, project, projects: data.projects, items });
  const [moving, setMoving] = useState<AssetRef | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const nameOf = (target: CtxTarget) => (target.kind === "asset" ? items.find((i) => i.take.id === target.id)?.take.name ?? "Asset" : target.kind === "node" ? "Node" : shell.view === "suite" ? shell.page.title : "Particl");
  const selection = (): CtxTarget => (state.selKind === "take" && state.selId ? { kind: "asset", id: state.selId } : { kind: "empty" });

  const clipPayload = shell.clip?.payload as { asset: AssetRef; fromProjectId: string } | undefined;
  const selectedAsset = (() => { const s = selection(); const e = s.kind === "asset" ? items.find((i) => i.take.id === s.id) : null; return e ? assetRef(e) : null; })();
  const caps: CtxCapabilities = (() => {
    const target = shell.ctx?.target;
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
    if (target.kind !== "asset") { toast(caps.why[cmd] ?? "Select an asset first."); return; }
    switch (cmd) {
      case "copy": actions.copy(target.id, "copy"); return;
      case "cut": actions.copy(target.id, "cut"); return;
      case "delete": void actions.remove(target.id); return;
      case "use-as-reference": actions.useAsReference(target.id); return;
      case "retry": actions.retry(target.id); return;
      case "open-in-inspector":
        dispatch({ type: "patch", patch: { selKind: "take", selId: target.id } });
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
  /* The Inspector's buttons and the Rig's drop use the same path. */
  useEffect(() => { shell.setRunCommand(command); setShotDropHandler((id, shot) => void actions.fileOnShot(id, shot)); return () => { shell.setRunCommand(null); setShotDropHandler(null); }; });

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
        else if (state.composer) dispatch({ type: "patch", patch: { composer: false } });
        else if (shell.libOpen || shell.inspOpen) shell.closePanels();
        return;
      }
      if (shell.palette || state.composer || inField(event.target)) return;
      const cmd = shortcutCommand(event);
      if (!cmd) return;
      const target = selection();
      if (cmd !== "undo" && cmd !== "paste" && target.kind === "empty") return;
      if (cmd === "paste" && !shell.clip) return;
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



  const overlay = !shell.wide;
  const showLibrary = shell.view !== "workspace" && (shell.wide || shell.libOpen);
  const showInspector = shell.view !== "workspace" && (shell.wide ? shell.inspector : shell.inspOpen);
  const columns = [shell.wide && showLibrary ? "280px" : null, "minmax(0,1fr)", shell.wide && showInspector ? "320px" : null].filter(Boolean).join(" ");
  const Body = PAGE_BODIES[state.page];

  return (
    <AtomikHost scope={scope} project={project} bridge={planBridge}>
      <div className="gx" data-view={shell.view} data-suite={shell.suite.id} onContextMenu={onContext} onClick={() => shell.ctx && shell.closeCtx()}>
        {session.workspace?.suspended ? (
          <div role="status" data-testid="workspace-suspended" style={{ padding: "8px 20px", background: "var(--gx-card)", borderBottom: "1px solid var(--gx-hair)", color: "var(--gx-waiting)" }}>
            This workspace is suspended{session.workspace.suspendedReason ? ` — ${session.workspace.suspendedReason}` : ""}. Rendering is paused; everything already made is still here.
          </div>
        ) : null}
        <Header account={account} />
        <StageStrip />
        {shell.view === "crew" ? <><CrewStrip room={crew} /><CrewView project={project} room={crew} scope={scope} /></> : shell.view === "workspace" ? <WorkspaceView account={account} /> : (
          <div className="gx-body" style={{ gridTemplateColumns: columns }} data-testid="shell-body" data-columns={columns}>
            {overlay && (shell.libOpen || shell.inspOpen) ? <div className="gx-scrim" onClick={shell.closePanels} data-testid="panel-scrim" /> : null}
            {showLibrary ? <Library items={items} ready={library.state.status === "ready"} overlay={overlay} now={now} onUseAsReference={actions.useAsReference} cutId={shell.clip?.mode === "cut" && shell.clip.target.kind === "asset" ? shell.clip.target.id : null} /> : null}
            <main className="gx-main" data-screen-label={shell.view === "gen" ? "gen" : shell.page.id}>
              <ProjectHead project={project} projects={data.projects} loading={data.status === "loading"}
                onPick={(id) => { try { localStorage.setItem(scope, id); } catch { /* the URL still carries it */ } selectProject(id); }} />
              {shell.view === "gen" ? (
                <>
                  <div className="gx-pagehead" data-row="page">
                    <h1 className="gx-h1" data-testid="page-title">Generate</h1>
                    <span className="gx-hint">Video · Images · Audio · 3D</span>
                    <span className="gx-spacer" />
                    {!shell.wide ? (<>
                      <button type="button" className="gx-hbtn" aria-pressed={shell.libOpen} onClick={shell.toggleLibrary} data-testid="toggle-library">Library</button>
                      <button type="button" className="gx-hbtn" aria-pressed={shell.inspOpen} onClick={shell.toggleInspector} data-testid="toggle-inspector">Inspector</button>
                    </>) : null}
                  </div>
                  <div className="gx-stage gx-scroll" data-testid="content">
                    <GenView scope={scope} project={project} items={items} workspaceName={account?.workspace?.name ?? null} onProject={(id) => selectProject(id, { replace: true })} />
                  </div>
                </>
              ) : (
                <>
                  <PageHead project={project} onGenerate={seams.onGenerate} generate={seams.generate} />
                  <div className="gx-stage gx-scroll" data-testid="content">
                    {shell.page.own && shell.suite.id === "business" ? (
                      <BusinessView key={shell.page.id} scope={scope} project={project} page={shell.page.id as "ads" | "dtc" | "setup"} />
                    ) : shell.page.own && shell.suite.id === "viral" ? (
                      <ViralView key={shell.page.id} scope={scope} project={project} page={shell.page.id as "motion" | "swap" | "history"} items={items} />
                    ) : shell.page.own && shell.suite.id === "atomik" && shell.page.id === "skills" ? <SkillsView /> : (
                      <div className="pxw gx-legacy gx-enter" key={shell.page.id}>
                        <div className="pxw-content"><Body page={state.page} project={project} scope={scope} /></div>
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="pxw gx-legacy" style={{ flex: "none", minHeight: 0 }}><GenerationStrip /></div>
            </main>
            {showInspector ? <Inspector scope={scope} project={project} overlay={overlay} /> : null}
          </div>
        )}
        <Palette items={items} onAsk={() => shell.goSuite("atomik", "agent")} />
        <div className="pxw gx-legacy" style={{ minHeight: 0, flex: "none" }}>
          <GenerateComposer scope={scope} project={project} onProject={(id) => selectProject(id, { replace: true })} workspaceName={account?.workspace?.name ?? null} />
        </div>
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
        {state.toast ? <div className="gx-toast" role="status" data-testid="toast">{state.toast}</div> : null}
      </div>
    </AtomikHost>
  );
}
