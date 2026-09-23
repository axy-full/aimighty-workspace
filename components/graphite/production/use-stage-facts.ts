"use client";
import { useEffect } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { clearSpecFacts, publishSpecFacts } from "@/lib/workspace/spec-store";
import type { PageId } from "@/lib/workspace/types";

/** The Inspector's facts read the draft a Production stage has on screen, not the last saved copy. */
export function useStageFacts(page: PageId, project: Project | null) {
  const atomik = useAtomik();
  const runStatus = atomik.runFor(page)?.status ?? null;
  const planCompleted = Boolean(atomik.state.completed[page]);
  const planPrice = atomik.plan(page)?.priceLabel ?? null;
  useEffect(() => { publishSpecFacts(page, { project, runs: null, budget: null, planRun: runStatus ? { status: runStatus } : null, planCompleted, planPrice }); }, [page, project, runStatus, planCompleted, planPrice]);
  useEffect(() => () => clearSpecFacts(page), [page]);
}
