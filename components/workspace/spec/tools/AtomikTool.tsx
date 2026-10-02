"use client";
import AtomikSuite from "@/components/suites/AtomikSuite";
import { SuiteAgentPanel } from "@/components/suites/SuiteAgentPanel";
import ThreadsPanel from "@/components/atomik/threads/ThreadsPanel";
import type { AtomikPage } from "@/components/suites/atomik-suite-data";
import type { Project } from "@/lib/workbench/studio";

/**
 * The existing Atomik suite bodies (components/suites/AtomikSuite.tsx) for
 * this project: Runs (with the Atomik conversation), Recipes, Approvals,
 * Budget, Models and Generate, and on Agent the suite agent panel and the
 * project's Atomik threads (components/atomik/threads/ThreadsPanel.tsx). No Atomik
 * rail lives here, so the pages that drive one (Models' thinking picker,
 * Recipes' "Use in Atomik") leave those controls out; the agent picks its
 * model with each quote. Generate points to Gen: Atomik no longer generates
 * on a signed-in account.
 */
export default function AtomikTool({
  page,
  project,
  onPage,
}: {
  page: AtomikPage | "agent";
  project: Project;
  onPage: (page: AtomikPage) => void;
}) {
  if (page === "agent")
    return (
      <div className="pxw-tool pxw-tool--agent" data-tool-body="agent">
        {project.productionProjectId ? (
          <>
            <SuiteAgentPanel key={`${project.id}:atomik`} suite="atomik" project={project} />
            <ThreadsPanel key={`${project.id}:threads`} productionId={project.productionProjectId} />
          </>
        ) : (
          <p className="pxw-spec-work-empty">Save this project in Studio to plan it with the agent.</p>
        )}
      </div>
    );
  const suite = (
    <AtomikSuite
      pageOverride={page}
      embedded
      onPage={onPage}
    />
  );
  return (
    <div className="pxw-tool pxw-tool--atomik" data-tool-body={page}>
      {suite}
    </div>
  );
}
