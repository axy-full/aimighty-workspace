"use client";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useShell } from "@/lib/shell/state";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry, ProjectLibrary } from "@/lib/workspace/library";
import { LoadBanner } from "../TakeTile";
import { ViralTool, toolName } from "../viral/ViralView";
import { Compose } from "./Compose";
import { UPSCALE_NAME, UpscaleTool } from "./UpscaleTool";
import { Recent } from "./Recent";
import { useMake } from "./use-make";

export type MakeProps = {
  scope: string; project: Project | null; items: LibraryEntry[];
  library: ProjectLibrary; projects?: "loading" | "ready" | "error";
  projectsError?: string | null; onRetry?: () => void;
  workspaceName: string | null; onProject: (id: string) => void;
  /** The Inspector's column is open: Make sits beside it rather than over it. */
  beside?: boolean;
  /** The project's frame, so every card on Recent holds it. */
  aspect?: string | null;
  /** The workspace's live credit balance, when the shell reads it (for "Short by N cr"). */
  balance?: number | null;
  /** A board is open: results land on it too. */
  onBoard?: boolean;
  /** Open with the engine list showing (`make=change`). */
  listOpen?: boolean;
};

/**
 * Make with the new interface switched on (design/particl-graphite/README.md § 3.2; "Make frames.dc.html" 1–8):
 * a 440 px panel over any screen, full width on a phone. Its head is the title, Make | Recent and Close; its body is
 * the composer as the handoff draws it (Compose), Recent, or a quick tool. Left of whatever is docked at the right
 * edge (`--board-dock`, set by the shell from the board's dock), and beside the Inspector's column when that is open.
 * The logic is useMake's, which the phone's simple Make shares.
 */
export function Make({ scope, project, items, library, projects = "ready", projectsError = null, onRetry, workspaceName, onProject, beside = false, aspect = null, balance, onBoard, listOpen = false }: MakeProps) {
  const shell = useShell();
  /* Results land on the board too when the board is the screen under the panel (the shell's own view, unless the host says). */
  const make = useMake({ scope, project, projects, workspaceName, onProject, balance, onBoard: onBoard ?? shell.view === "board", listOpen });
  const panel = useRef<HTMLElement>(null);
  useMakeTop(panel);
  const title = make.tool === "upscale" ? UPSCALE_NAME : make.tool ? toolName(make.tool) : "Make";
  const tab = make.tool ?? (make.recent ? "recent" : make.state.type);
  return (
    <aside ref={panel} className="gx-make gx-mk" aria-label={title} data-testid="make-panel" data-ui="new" data-tab={tab}
      data-beside={beside ? "" : undefined} style={aspect ? ({ "--tile-aspect": aspect } as CSSProperties) : undefined}>
      <div className="gx-mk-head">
        <strong className="gx-mk-title" data-testid="make-title">{title}</strong>
        {make.tool ? null : (
          <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Make or Recent">
            <button type="button" role="tab" className="gx-seg-btn" aria-selected={!make.recent} onClick={() => shell.setMake(make.state.type)} data-testid="make-tab-make"><span>Make</span></button>
            <button type="button" role="tab" className="gx-seg-btn" aria-selected={make.recent} onClick={() => shell.setMake("recent")} data-testid="make-tab-recent"><span>Recent</span></button>
          </div>
        )}
        <span className="gx-spacer" />
        <button type="button" className="gx-mk-close" aria-label="Close Make" title="Close · Esc" onClick={shell.closeMake} data-testid="make-close">×</button>
      </div>
      <div className="gx-mk-body gx-scroll" data-testid="gen-view">
        {projectsError ? <LoadBanner banner={{ tone: "error", message: projectsError }} onRetry={onRetry ?? (() => undefined)} testId="projects-error" /> : null}
        {make.tool === "upscale" ? <UpscaleTool key="upscale" scope={scope} project={project} items={items} />
          : make.tool ? <ViralTool key={make.tool} scope={scope} page={make.tool} project={project} items={items} />
          : make.recent ? <Recent project={project} items={items} library={library} projects={projects} make={make} />
          : <Compose make={make} scope={scope} />}
      </div>
    </aside>
  );
}

/** The panel starts under the header, whatever its height on this screen; on the shell's root, so anything portalled there lines up too. */
function useMakeTop(panel: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = panel.current, root = el?.closest<HTMLElement>(".gx"), header = root?.querySelector<HTMLElement>(".gx-header");
    if (!el || !root || !header) return;
    const place = () => root.style.setProperty("--make-top", `${Math.max(0, Math.round(header.getBoundingClientRect().bottom - root.getBoundingClientRect().top))}px`);
    place();
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    watch?.observe(header); watch?.observe(root);
    return () => { watch?.disconnect(); root.style.removeProperty("--make-top"); };
  }, [panel]);
}
