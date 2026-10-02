"use client";
import SubatomikWorkspace from "@/components/suites/SubatomikWorkspace";
import { SuiteProjectProvider } from "@/components/suites/SuiteProjectContext";

/**
 * The existing Subatomik studio for this project, mounted in the shell. It
 * keeps its own behaviour: connected credits by default for the workspace
 * owner, a live quote before submission (a missing or stale one blocks),
 * sources, results and the synchronized comparison. Sources, Compare and
 * History open the same studio at its library or results section.
 *
 * Its connected-account form no longer feeds the page's Atomik plan: Atomik
 * runs Motion Transfer and Object Swap on the API-key transform engines only
 * (lib/workspace/plans.ts), from /api/generate bodies a page publishes.
 */
export default function SubatomikTool({
  variant,
  projectId,
}: {
  variant: "motion-transfer" | "object-swap";
  projectId: string;
}) {
  return (
    <div className="pxw-tool pxw-tool--subatomik" data-tool-body="subatomik">
      <SuiteProjectProvider projectId={projectId} ready>
        <SubatomikWorkspace embedded variant={variant} />
      </SuiteProjectProvider>
    </div>
  );
}
