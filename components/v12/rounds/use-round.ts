"use client";
import { useEffect } from "react";
import type { RigContext } from "@/components/workspace/rig/RigProvider";
import { isFinished, shotTakes } from "@/components/graphite/board/cards/take/take-model";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { cleanRounds, hasRound, isClientRound, roundOf, shotOfNodeMap, withRound } from "@/lib/v12/rounds";

/**
 * Keeps a client round once its plan is approved (redesign P2-c; lib/v12/rounds.ts): Atomik's run asked from a client's reply,
 * and its plan approved by a person (today's approval; nothing here approves anything). The round goes into the board's draft
 * (`boardRounds`, one edit, saved with it): its number, when, what each change was, and the take each shot had just before the
 * approval (R1, for Compare). A round is kept once, whenever the board is open after the approval.
 */
export function useRecordRound(opts: { on: boolean; project: Project | null; items: readonly LibraryEntry[]; run: RigAgentRunView | null; apply: RigContext["apply"] }) {
  const { on, project, items, run, apply } = opts;
  const approvedAt = run?.plan?.approval?.at ?? null;
  const runId = run?.id ?? null;
  const goal = run?.goal ?? "";
  /* The plan's renders, each by the card it is about (nodeId), as one key that changes only when the plan's steps do. */
  const stepsKey = run ? run.paid.filter((p) => p.tool === "render" && p.fixOf == null).map((p) => `${p.nodeId ?? ""}\t${p.title}`).join("\n") : "";
  useEffect(() => {
    if (!on || !project || !runId || approvedAt == null || !isClientRound(goal) || hasRound(cleanRounds(project.boardRounds), runId)) return;
    /* What each shot had when the plan was approved: its newest finished take from before that moment. */
    const before: Record<string, string> = {};
    const rows = shotTakes(project, items);
    for (const row of rows) {
      const was = row.versions.filter((v) => isFinished(v) && v.createdAt < approvedAt).at(-1);
      if (was) before[String(row.index)] = was.genId;
    }
    const round = roundOf({ runId, goal, steps: stepsKey ? stepsKey.split("\n").map((l) => { const [id, ...t] = l.split("\t"); return { nodeId: id || null, title: t.join("\t") }; }) : [], shots: shotOfNodeMap(rows), rounds: cleanRounds(project.boardRounds), before, at: approvedAt });
    if (!round.changes.length) return;
    apply((p) => (hasRound(cleanRounds(p.boardRounds), runId) ? p : { ...p, boardRounds: withRound(cleanRounds(p.boardRounds), round) }));
  }, [on, project, items, runId, approvedAt, goal, stepsKey, apply]);
}
