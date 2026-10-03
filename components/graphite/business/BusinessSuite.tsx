"use client";
import "./business-own.css";
import type { Project } from "@/lib/workbench/studio";
import { isOwnPage } from "@/lib/shell/business-own";
import { BusinessOwnView } from "./BusinessOwnView";
import { BusinessView } from "./BusinessView";
import { ParticlSetup } from "./ParticlSetup";

/**
 * The Business suite's pages: Image ads, on Particl's API key for everyone
 * (BusinessView); Setup, the saved products, brand kit and reference ad
 * Particl made in this project; and Particl's own tools (Brand … Design).
 * Any other page id (an old link) is Image ads, the page the suite opens on.
 */
export function BusinessSuite({ scope, project, page }: { scope: string; project: Project | null; page: string }) {
  if (isOwnPage(page)) return <BusinessOwnView key={page} scope={scope} project={project} page={page} />;
  if (page === "setup") {
    return (
      <div className="bo-setup-stack" data-testid="business-setup">
        {project ? <ParticlSetup scope={scope} project={project} /> : <p className="gx-reason" data-testid="setup-no-project">Open a project first.</p>}
      </div>
    );
  }
  return <BusinessView key={page} scope={scope} project={project} />;
}
