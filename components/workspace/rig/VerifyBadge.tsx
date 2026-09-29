"use client";
import { useMemo } from "react";
import { VERIFY_RUBRIC, isVerifyCard, type Verdict } from "@/lib/workbench/verify";
import type { Project } from "@/lib/workbench/studio";
import { useVerifications } from "./use-verifications";
import "./rig-verify.css";

/*
 * The Takes badge of a Rig Verify check (plan PR 7): each take's newest check,
 * on its tile. A take checked against masters that have changed since says so.
 */

export type TakeVerdict = { verdict: Verdict; stale: boolean };
const WORDS: Record<Verdict, string> = { pass: "Verified", fail: "Failed its check", needs_you: "Check needs you" };

/** Each take's newest check (library id → verdict). Read only for a production that has a Verify card. */
export function useTakeVerdicts(scope: string, project: Pick<Project, "id" | "nodes"> | null | undefined): Map<string, TakeVerdict> {
  const checked = Boolean(project?.nodes.some(isVerifyCard));
  const { list } = useVerifications(scope, checked ? project!.id : null);
  return useMemo(() => {
    const out = new Map<string, TakeVerdict>();
    for (const v of [...(list ?? [])].sort((a, b) => b.createdAt - a.createdAt))
      if (!out.has(v.takeId)) out.set(v.takeId, { verdict: v.verdict, stale: v.mastersCurrent === false || v.rubric !== VERIFY_RUBRIC });
    return out;
  }, [list]);
}

export function TakeVerifyBadge({ verdict }: { verdict: TakeVerdict }) {
  return (
    <span className="gx-tile-verify" data-verdict={verdict.verdict} data-stale={verdict.stale || undefined} data-testid="take-verify">
      <span className="gx-tile-verify-dot" aria-hidden="true" />
      {WORDS[verdict.verdict]}{verdict.stale ? " · older master" : ""}
    </span>
  );
}
