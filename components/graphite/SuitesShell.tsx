"use client";
import { useEffect, useMemo, useState } from "react";
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
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { PageHead } from "./PageHead";
import { Palette } from "./Palette";
import { ProjectHead } from "./ProjectHead";
import { StageStrip } from "./StageStrip";
import { WorkspaceView } from "./WorkspaceView";

/** What this build cannot do yet says so on the item; build step 3 (assets) wires the rest to the library's own routes. */
const LATER = "Arrives with asset actions in the next build step.";
const WHY: CtxCapabilities["why"] = { cut: LATER, paste: LATER, duplicate: LATER, move: LATER, delete: LATER, "use-as-reference": LATER, bypass: "Open Rig to bypass a node.", unplug: "Open Rig to unplug a node." };

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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const nameOf = (target: CtxTarget) => (target.kind === "asset" ? items.find((i) => i.take.id === target.id)?.take.name ?? "Asset" : target.kind === "node" ? "Node" : shell.view === "suite" ? shell.page.title : "Particl");
  const selection = (): CtxTarget => (state.selKind === "take" && state.selId ? { kind: "asset", id: state.selId } : { kind: "empty" });

  const command = (cmd: CtxCommand, target: CtxTarget) => {
    switch (cmd) {
      case "generate-here": shell.goGen(); dispatch({ type: "patch", patch: { composer: true } }); return;
      case "open-library": shell.openLibrary("assets"); return;
      case "toggle-inspector": shell.toggleInspector(); return;
      case "undo": void shell.undo(); return;
      case "copy":
        if (target.kind === "empty") return;
        shell.setClip({ mode: "copy", target, name: nameOf(target) });
        toast(`${nameOf(target)} copied`);
        return;
      case "open-in-inspector":
        if (target.kind !== "asset") return;
        dispatch({ type: "patch", patch: { selKind: "take", selId: target.id } });
        shell.openInspector();
        return;
      case "retry":
        shell.goGen(); dispatch({ type: "patch", patch: { composer: true } });
        return;
      default:
        toast(WHY[cmd] ?? LATER);
    }
  };

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
      if (cmd !== "undo" && target.kind === "empty") return;
      if (cmd === "copy" || cmd === "undo") { event.preventDefault(); command(cmd, target); }
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

  const caps = useMemo<CtxCapabilities>(() => ({
    can: { copy: true, "open-in-inspector": true, retry: true },
    why: WHY, hasClipboard: false, canUndo: shell.canUndo,
  }), [shell.canUndo]);

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
        {shell.view === "workspace" ? <WorkspaceView account={account} /> : (
          <div className="gx-body" style={{ gridTemplateColumns: columns }} data-testid="shell-body" data-columns={columns}>
            {overlay && (shell.libOpen || shell.inspOpen) ? <div className="gx-scrim" onClick={shell.closePanels} data-testid="panel-scrim" /> : null}
            {showLibrary ? <Library items={items} ready={library.state.status === "ready"} overlay={overlay} now={now} /> : null}
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
                    <button type="button" className="gx-primary" data-testid="open-composer" onClick={() => dispatch({ type: "patch", patch: { composer: true } })}>Generate</button>
                  </div>
                  <div className="gx-stage gx-scroll"><p className="gx-empty gx-enter" style={{ padding: 20 }}>Results land in Takes and in Library › Assets, on every page.</p></div>
                </>
              ) : (
                <>
                  <PageHead project={project} onGenerate={seams.onGenerate} generate={seams.generate} />
                  <div className="gx-stage gx-scroll" data-testid="content">
                    <div className="pxw gx-legacy gx-enter" key={shell.page.id}>
                      <div className="pxw-content"><Body page={state.page} project={project} scope={scope} /></div>
                    </div>
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
        <ContextMenu caps={caps} onCommand={(cmd) => command(cmd, shell.ctx?.target ?? selection())} />
        {state.toast ? <div className="gx-toast" role="status" data-testid="toast">{state.toast}</div> : null}
      </div>
    </AtomikHost>
  );
}
