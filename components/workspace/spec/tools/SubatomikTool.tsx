"use client";
import { useCallback, useMemo, useState } from "react";
import SubatomikWorkspace from "@/components/suites/SubatomikWorkspace";
import { SuiteProjectProvider } from "@/components/suites/SuiteProjectContext";
import type { ConsumerGenjutsuInput } from "@/lib/higgsfield-consumer/genjutsu-contract";
import { usePlanRequest } from "@/lib/workspace/atomik-host";

/**
 * The existing Subatomik studio for this project, mounted in the shell. It
 * keeps its own behaviour: connected credits by default for the workspace
 * owner, a live quote before submission (a missing or stale one blocks),
 * sources, results and the synchronized comparison. Sources, Compare and
 * History open the same studio at its library or results section.
 *
 * On Motion Transfer and Object Swap the form's quote input — exactly what
 * the form itself sends, and only once it could send it — is the request the
 * page's Atomik plan prices at its gate.
 */
export default function SubatomikTool({
  variant,
  projectId,
  publish,
}: {
  variant: "motion-transfer" | "object-swap";
  projectId: string;
  /** Which plan request the form feeds; null on Sources, Compare and History. */
  publish: "motion" | "swap" | null;
}) {
  const [input, setInput] = useState<ConsumerGenjutsuInput | null>(null);
  const onInput = useCallback((next: ConsumerGenjutsuInput | null) => setInput(next), []);
  /* The plan re-adds the variant; the rest is the form's own body. */
  const request = useMemo(() => (publish && input ? requestOf(input) : undefined), [publish, input]);
  usePlanRequest(publish ?? "motion", publish ? request : undefined);
  return (
    <div className="pxw-tool pxw-tool--subatomik" data-tool-body="subatomik">
      <SuiteProjectProvider projectId={projectId} ready>
        <SubatomikWorkspace embedded variant={variant} onConnectedInput={publish ? onInput : undefined} />
      </SuiteProjectProvider>
    </div>
  );
}

function requestOf(input: ConsumerGenjutsuInput): Record<string, unknown> {
  const { variant: _variant, ...rest } = input;
  void _variant;
  return rest;
}
