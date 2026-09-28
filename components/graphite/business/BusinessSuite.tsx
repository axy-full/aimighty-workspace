"use client";
import "@/app/business-own.css";
import type { Project } from "@/lib/workbench/studio";
import { isOwnPage } from "@/lib/shell/business-own";
import { BusinessOwnView } from "./BusinessOwnView";
import { BusinessView } from "./BusinessView";
import { ParticlSetup } from "./ParticlSetup";

/**
 * The Business suite's pages: Particl's own tools (Brand … Design) for
 * everyone; Setup with what Particl made in this project listed first; and
 * the connected account's Ads, Image ads and Setup lists as BusinessView
 * draws them.
 */
export function BusinessSuite({ scope, project, page }: { scope: string; project: Project | null; page: string }) {
  if (isOwnPage(page)) return <BusinessOwnView key={page} scope={scope} project={project} page={page} />;
  if (page === "setup") {
    return (
      <div className="bo-setup-stack">
        <ParticlSetup scope={scope} project={project} />
        <BusinessView key={page} scope={scope} project={project} page="setup" />
      </div>
    );
  }
  return <BusinessView key={page} scope={scope} project={project} page={page === "dtc" ? "dtc" : "ads"} />;
}
