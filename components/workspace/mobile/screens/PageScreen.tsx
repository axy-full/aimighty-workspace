"use client";
import type { Project } from "@/lib/workbench/studio";
import { getSuite, pageDef, subtitle } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { MOBILE_PAGES } from "./registry";

/**
 * Page (05-mobile, "Page templates"). The header block — crumb, 24px title
 * and the derived sub — is the shell's; the body below it is the page's own
 * template, registered in ./registry.tsx by wave M-B. A page with no template
 * yet says so in one line and keeps its stage plan reachable from the action
 * bar; it shows no placeholder content and no loader.
 */
export function PageScreen({ project, scope }: { project: Project | null; scope: string }) {
  const { state } = useWorkspace();
  const def = pageDef(state.page);
  const sub = subtitle(state, { aspect: project?.aspect, fps: project?.fps });
  const registered = MOBILE_PAGES[state.page];
  return (
    <div data-screen="page" data-page={state.page}>
      <div className="pxm-pad-x pxm-pad-top">
        <div className="pxm-crumbs">
          <span>{project?.name ?? "Project"}</span>
          <span className="pxm-crumb-sep" aria-hidden="true">›</span>
          <span className="pxm-crumb-here">{def.title}</span>
        </div>
        <h1 className="pxm-page-title" data-testid="mobile-page-title">{def.title}</h1>
        {sub ? <div className="pxm-page-sub">{sub}</div> : null}
      </div>
      {registered ? (
        <registered.Body page={state.page} project={project} scope={scope} />
      ) : (
        <p className="pxm-note" data-testid="mobile-page-pending">
          {def.description} This stage opens on the phone with its own template; {getSuite(state.suite).short.toLowerCase()} work is on the desktop until then.
        </p>
      )}
    </div>
  );
}
