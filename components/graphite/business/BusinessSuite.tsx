"use client";
import "@/app/business-own.css";
import type { Project } from "@/lib/workbench/studio";
import { isOwnPage } from "@/lib/shell/business-own";
import { BusinessOwnView } from "./BusinessOwnView";
import { BusinessView } from "./BusinessView";
import { ParticlSetup } from "./ParticlSetup";

/**
 * The Business suite's pages: Particl's own tools (Brand … Design) for
 * everyone; Setup, with what Particl made in this project listed after the
 * connected account's lists (which keep their place, and their phone sheet);
 * and the account's Ads and Image ads as BusinessView draws them.
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
