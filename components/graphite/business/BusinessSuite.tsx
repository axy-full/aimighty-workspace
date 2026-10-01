"use client";
import "@/app/business-own.css";
import type { Project } from "@/lib/workbench/studio";
import { isOwnPage } from "@/lib/shell/business-own";
import { BusinessOwnView } from "./BusinessOwnView";
import { BusinessView } from "./BusinessView";
import { ParticlSetup } from "./ParticlSetup";

/**
 * The Business suite's pages: Particl's own tools (Brand … Design) for
 * everyone; Setup, the retired card with what Particl made in this project
 * listed after it; Ads, the retired card; and Image ads, on Particl's API key
 * for everyone — the last three as BusinessView draws them.
 */
export function BusinessSuite({ scope, project, page }: { scope: string; project: Project | null; page: string }) {
  if (isOwnPage(page)) return <BusinessOwnView key={page} scope={scope} project={project} page={page} />;
  if (page === "setup") {
    return (
      <div className="bo-setup-stack">
        <BusinessView key={page} scope={scope} project={project} page="setup" />
        <ParticlSetup scope={scope} project={project} />
      </div>
    );
  }
  return <BusinessView key={page} scope={scope} project={project} page={page === "dtc" ? "dtc" : "ads"} />;
}
