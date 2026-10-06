"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cleanRule, cleanShotCap, type ApprovalRule } from "@/lib/approvalRule";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { useSession } from "@/lib/session";
import { DraftRequestError, draftRequest } from "@/lib/workbench/draft-request";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import type { BoardCtx } from "../types";
import { stepRequest, stepShots } from "./estimates";
import { planModel, type PlanModel, type PlanPrimary, type StepEstimate } from "./model";
import { AGENT_CHANGED } from "./use-run";

/*
 * The plan card's data and actions (CLAUDE.md rule 14: a plan is approved once):
 *  - the run is Atomik's on this production (the board's `agent`, read by the team-canvas GET), with the server's
 *    plan quote at the gate and the approval's record after it;
 *  - before the build, renders not yet priced are pre-quoted on the request the run will price (./estimates.ts);
 *  - the balance is the session's; the approval rule is the workspace's (GET /api/engines, as the composer reads it);
 *  - every action is the run's own, through POST /api/workbench/team-canvas, which takes a person's session only
 *    and only the person who asked: `agent.approve` (build, free); `agent.approvePlan` (the plan once, at the
 *    server's quote fingerprint); `agent.render` (a render outside the plan); `agent.limit`.
 * Nothing here works out a figure to spend: the plan's total and its ceiling are the server's.
 */

const API = "/api/workbench/team-canvas";

/** The workspace's cost approval rule and the viewer's role, as the composer reads them. Null until read. */
function useApprovalRule(scope: string): { rule: ApprovalRule; cap: number } | null {
  const [rule, setRule] = useState<{ rule: ApprovalRule; cap: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/engines", { headers: { "X-Workbench-Scope": scope } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { approval?: { rule?: unknown; shotCapCredits?: unknown } } | null) => {
        if (alive && body?.approval) setRule({ rule: cleanRule(body.approval.rule), cap: cleanShotCap(body.approval.shotCapCredits) });
      })
      .catch(() => { /* no rule read: no marks, the server still enforces it */ });
    return () => { alive = false; };
  }, [scope]);
  return rule;
}

export type PlanState = {
  model: PlanModel | null;
  busy: boolean;
  problem: string | null;
  held: boolean;
  setHeld: (held: boolean) => void;
  act: (primary: PlanPrimary) => Promise<void>;
};

export function usePlan(ctx: BoardCtx, run: RigAgentRunView | null, readOnly: string | null): PlanState {
  /* A null run (the sample) quotes nothing and acts on nothing. */
  const session = useSession();
  const rule = useApprovalRule(ctx.scope);
  const [held, setHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const project = ctx.project;

  /* The renders the run has not priced, on the request it will price. */
  const pending = useMemo(() => {
    if (!run) return new Map<number, ReturnType<typeof stepRequest>>();
    const shots = stepShots(run, project);
    const out = new Map<number, ReturnType<typeof stepRequest>>();
    for (const step of run.paid) {
      if (step.tool !== "render") continue;
      const nodeId = shots.get(step.seq);
      out.set(step.seq, nodeId ? stepRequest(project, nodeId) : null);
    }
    return out;
  }, [run, project]);
  const requests = useMemo(() => Object.fromEntries([...pending].flatMap(([seq, req]) => {
    const step = run?.paid.find((p) => p.seq === seq);
    return req && step?.quote == null && !["done", "failed", "skipped"].includes(step?.state ?? "") ? [[String(seq), { body: req.body }]] : [];
  })), [pending, run]);
  const quotes = useStageQuotes(ctx.scope, requests);
  const estimates: Record<number, StepEstimate> = {};
  for (const [seq, quote] of Object.entries(quotes.quotes)) {
    if (!quote) continue;
    if (quote.credits != null) estimates[Number(seq)] = { credits: quote.credits, approximate: Boolean(quote.approximate) };
    else if (quote.error) estimates[Number(seq)] = { unavailable: quote.error };
  }
  const meta: Record<number, string> = {};
  const stills = new Set<number>();
  for (const [seq, req] of pending) {
    if (!req) continue;
    meta[seq] = req.meta;
    if (req.still) stills.add(seq);
  }
  const inCredits = session.rates.unit === "cr";
  const admin = session.role === "owner" || session.role === "admin";
  const model = planModel({
    run, enabled: true, estimates, meta, stills, balance: inCredits && session.credits ? session.credits.balance : null,
    rule: rule ? { ...rule, admin } : null, readOnly,
  });

  const post = useCallback(async (body: Record<string, unknown>) => {
    await draftRequest<unknown>(API, ctx.scope, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId: ctx.productionId, ...body }) });
  }, [ctx.scope, ctx.productionId]);

  const act = useCallback(async (primary: PlanPrimary) => {
    if (!run || busy || primary.blocked) return;
    setBusy(true);
    setProblem(null);
    try {
      if (primary.kind === "approve") {
        await post({ action: "agent.approve", runId: run.id, fingerprint: primary.fingerprint });
      } else if (primary.kind === "plan") {
        await post({ action: "agent.approvePlan", runId: run.id, fingerprint: primary.fingerprint });
      } else if (primary.kind === "render") {
        await post({ action: "agent.render", runId: run.id, seq: primary.seq, ...(primary.fingerprint ? { fingerprint: primary.fingerprint } : {}) });
      } else {
        await post({ action: "agent.limit", runId: run.id, limit: primary.raiseTo });
      }
    } catch (error) {
      /* The run's own refusal words for a request it answered (as the Rig's run card shows them); otherwise a plain retry line. */
      setProblem(error instanceof DraftRequestError && error.status && error.status < 500 && error.status !== 401 ? error.message : "Atomik could not do that just now. Try again.");
    } finally {
      setBusy(false);
      /* Whoever reads the run for the board (Atomik's panel) reads it again now. */
      window.dispatchEvent(new Event(AGENT_CHANGED));
    }
  }, [run, busy, post]);

  return { model, busy, problem, held, setHeld, act };
}
