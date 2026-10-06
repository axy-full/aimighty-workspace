"use client";
import { useState, type ReactNode } from "react";
import type { RigAgentPaidStepView, RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import type { QueueItem } from "@/lib/control-room/queue";
import type { ApprovalsState } from "@/lib/control-room/use-approvals";
import { chargeSentence } from "@/lib/errors";
import { isRunLimitAmount } from "@/lib/runLimit";
import { buildLine, placedWords, planItemOf, raiseTarget, renderItemOf, renderPrice, RENDER_STATE, runOpen, AGENT_OFF } from "@/lib/shell/board-agent";
import { creditsText, exact, FREE, priceWords, type PriceValue } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { Price, usePriceTitle } from "../../Price";
import type { BoardAgent } from "./use-board-agent";

/*
 * The docked panel's lines (design/particl-graphite/README.md § 3.1, frames e–g): Atomik's words, then the one
 * action each line offers. Everything shown is the server's run (lib/workbench/rig-agent*.ts); each approval is a
 * person's tap on that item's own row in the one approvals queue (lib/control-room), so every screen shows the same
 * price and wording. Stop, Skip, Undo and Raise are the run card's own actions.
 */

type Props = { agent: BoardAgent; approvals: ApprovalsState; sample: string | null };

/** A button that carries a price: "Render · 43 cr", with the dollars on hover. */
function PriceButton({ label, price, primary, quiet, disabled, onClick, testId }: {
  label: string; price?: PriceValue | null; primary?: boolean; quiet?: boolean; disabled?: boolean; onClick: () => void; testId?: string;
}) {
  const words = priceWords(price);
  const title = usePriceTitle(price);
  return (
    <button type="button" className={`ag-btn${primary ? " ag-btn-primary" : ""}${quiet ? " ag-btn-quiet" : ""}`} disabled={disabled} title={title ?? undefined} onClick={onClick} data-testid={testId} {...spendAttrsOf(price)}>
      {words ? `${label} · ${words}` : label}
    </button>
  );
}

function Msg({ children, actions, tone, testId }: { children: ReactNode; actions?: ReactNode; tone?: "needs" | "problem"; testId?: string }) {
  return (
    <div className="ag-msg" data-tone={tone} data-testid={testId}>
      <span className="ag-eyebrow">Atomik</span>
      <div className="ag-text">{children}</div>
      {actions ? <div className="ag-actions">{actions}</div> : null}
    </div>
  );
}

export function AgentLines({ agent, approvals, sample }: Props) {
  const answer = agent.answer;
  const run = answer?.run ?? null;
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [raise, setRaise] = useState("");

  /* One press at a time: the answer says why not, and the lines read again. */
  const press = async (what: string, work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(what);
    setSaid(null);
    const why = await work();
    setBusy(null);
    if (why) setSaid(why);
  };
  const act = (action: string, extra: Record<string, unknown> = {}) => run && agent.call({ action, runId: run.id, ...extra });
  const approve = (item: QueueItem) => async () => { const out = await approvals.approve(item); return out.ok ? null : out.reason; };
  const decline = (item: QueueItem) => async () => { const out = await approvals.decline(item); return out.ok ? null : out.reason; };

  if (!answer) return <Msg>{agent.readError ?? "Reading Atomik…"}{agent.readError ? <> <button type="button" className="ag-link" onClick={() => void agent.refresh()}>Try again</button></> : null}</Msg>;
  if (!answer.enabled && !run) return <Msg tone="problem" testId="agent-off">{AGENT_OFF}</Msg>;
  if (!run) return <Msg testId="agent-idle">Ask me to lay this board out, or tell me what to change. I plan first and show the price; nothing is spent until you say so.</Msg>;

  const items = approvals.items;
  const planItem = planItemOf(items, run);
  const open = runOpen(run);
  const raiseTo = run.mine ? raiseTarget(run) : null;

  return (
    <>
      {run.state === "planning" ? (
        <Msg testId="agent-planning" actions={<button type="button" className="ag-btn" disabled={!!busy} onClick={() => void press("stop", async () => (await act("agent.stop")) ?? null)} data-testid="agent-stop">{busy === "stop" ? "Stopping…" : "Stop"}</button>}>
          Planning the board…
        </Msg>
      ) : null}

      {run.state === "awaiting_approval" && run.proposal ? (
        <Msg testId="agent-proposal"
          actions={run.mine ? (
            <>
              <button type="button" className="ag-btn ag-btn-quiet" disabled={!!busy || !planItem} onClick={() => planItem && void press("decline", decline(planItem))} data-testid="agent-decline">Not now</button>
              <PriceButton label="Build" price={FREE} primary disabled={!!busy || !planItem || !planItem.canApprove} onClick={() => planItem && void press("build", approve(planItem))} testId="agent-build" />
            </>
          ) : undefined}>
          <strong className="ag-title">{run.proposal.title}</strong>
          {run.proposal.summary ? <span className="ag-sub">{run.proposal.summary}</span> : null}
          <span className="ag-sub ag-mono" data-testid="agent-count">{run.proposal.cards} {run.proposal.cards === 1 ? "card" : "cards"} · {run.proposal.wires} {run.proposal.wires === 1 ? "wire" : "wires"}{run.proposal.tidy ? " · tidied" : ""} · free</span>
          {run.proposal.next.map((line) => <span key={line} className="ag-sub">{line}</span>)}
          {!run.mine ? <span className="ag-sub">Waiting for the person who asked</span> : planItem && !planItem.canApprove && planItem.why ? <span className="ag-sub">{planItem.why}</span> : null}
        </Msg>
      ) : null}

      {(run.state === "running" || run.state === "paused" || run.state === "needs_you") && buildLine(run) && !run.steps.filter((s) => s.state !== "next").every((s) => s.state === "done" || s.state === "skipped") ? (
        <Msg testId="agent-building" actions={open ? <button type="button" className="ag-btn" disabled={!!busy} onClick={() => void press("stop", async () => (await act("agent.stop")) ?? null)} data-testid="agent-stop">{busy === "stop" ? "Stopping…" : "Stop"}</button> : undefined}>
          <span data-testid="agent-progress">{buildLine(run)}</span>
          {run.held.map((why) => <span key={why} className="ag-sub">Held · {why}</span>)}
        </Msg>
      ) : null}
      {run.reason && (run.state === "needs_you" || run.state === "paused") ? <Msg tone="needs" testId="agent-reason">{run.reason}</Msg> : null}

      {run.paid.filter((p) => p.state !== "next").map((p) => (
        <RenderLine key={p.seq} step={p} run={run} item={renderItemOf(items, run, p.seq)} busy={busy}
          onRender={(item) => void press(`render:${p.seq}`, approve(item))} onSkip={(item) => void press(`skip:${p.seq}`, decline(item))} />
      ))}

      {raiseTo ? (
        <Msg tone="needs" testId="agent-raise" actions={
          <button type="button" className="ag-btn ag-btn-primary" disabled={!!busy || !isRunLimitAmount(Number(raise || raiseTo.to))} data-testid="agent-raise-button"
            onClick={() => void press("raise", async () => {
              const to = Number(raise || raiseTo.to);
              const why = await act("agent.limit", { limit: to });
              if (!why) setRaise("");
              return why ?? null;
            })}>
            {busy === "raise" ? "Raising…" : `Raise to ${creditsText(Number(raise) || raiseTo.to)}`}
          </button>
        }>
          This run has used its limit. Raise it to carry on; you still approve each render at its own price.
          <label className="ag-field">
            <span>New limit</span>
            <input className="ag-number" type="number" inputMode="decimal" min={raiseTo.to} step={0.1} value={raise || String(raiseTo.to)} onChange={(e) => setRaise(e.target.value)} aria-label="New limit for this run in credits" />
            <span aria-hidden="true">cr</span>
          </label>
        </Msg>
      ) : null}

      {!open ? <Finished run={run} busy={busy} onUndo={() => void press("undo", async () => (await act("agent.undo")) ?? null)} /> : run.canUndo ? (
        <Msg actions={<button type="button" className="ag-btn" disabled={!!busy} onClick={() => void press("undo", async () => (await act("agent.undo")) ?? null)} data-testid="agent-undo">{busy === "undo" ? "Undoing…" : "Undo the build"}</button>}>
          Atomik’s build is on the board.
        </Msg>
      ) : null}

      {sample ? <Msg>{sample}</Msg> : null}
      {said ? <Msg tone="problem" testId="agent-said"><span role="alert">{said}</span></Msg> : null}
      {agent.readError ? <Msg tone="problem"><span role="alert">{agent.readError}</span> <button type="button" className="ag-link" onClick={() => void agent.refresh()}>Try again</button></Msg> : null}
    </>
  );
}

/** One render after the build: its title, its price, its state, and the person's two taps. */
function RenderLine({ step, run, item, busy, onRender, onSkip }: {
  step: RigAgentPaidStepView; run: RigAgentRunView; item: QueueItem | null; busy: string | null;
  onRender: (item: QueueItem) => void; onSkip: (item: QueueItem) => void;
}) {
  const verify = step.tool === "verify";
  const price = item?.price ?? renderPrice(step);
  const waiting = step.state === "waiting";
  const settled = step.state === "done" && step.charged != null ? exact(step.charged) : null;
  const state = verify ? step.reason
    : step.state === "failed" ? (step.charge?.settled ? (step.charge.credits > 0 ? chargeSentence(step.charge) : "Failed · Nothing billed") : "Failed")
    : RENDER_STATE[step.state] ?? step.state;
  const tapOk = waiting && !!item && item.canApprove;
  return (
    <Msg testId={`agent-render-${step.seq}`}
      actions={waiting && run.mine && item ? (
        <>
          {item.decline ? <button type="button" className="ag-btn ag-btn-quiet" disabled={!!busy} onClick={() => onSkip(item)} data-testid="agent-skip">Skip</button> : null}
          <PriceButton label="Render" price={price} primary disabled={!!busy || !tapOk} onClick={() => onRender(item)} testId="agent-render" />
        </>
      ) : undefined}>
      <span className="ag-row">
        <strong className="ag-title">{verify ? `Check · ${step.title}` : step.title}</strong>
        {verify ? <span className="ag-sub">Not charged</span> : settled ? <Price value={settled} className="ag-mono" /> : step.state === "skipped" ? <span className="ag-sub">Not charged</span> : <Price value={price} className="ag-mono" />}
      </span>
      <span className="ag-sub" data-testid="agent-render-state">{state}{!run.mine && (waiting || step.state === "paused") ? " · waiting for the person who asked" : ""}</span>
      {step.state === "paused" && step.reason ? <span className="ag-sub">{step.reason}</span> : null}
      {waiting && item && !item.canApprove && item.why ? <span className="ag-sub">{item.why}</span> : null}
      {waiting && item && (item.shortBy ?? 0) > 0 ? <span className="ag-sub">Short by {creditsText(item.shortBy!)}</span> : null}
    </Msg>
  );
}

/** A run that ended: what it placed, what it spent of its limit, and Undo or Ask again. */
function Finished({ run, busy, onUndo }: { run: RigAgentRunView; busy: string | null; onUndo: () => void }) {
  const rendered = run.paid.filter((p) => p.tool === "render" && p.state === "done").length;
  const money = run.money;
  return (
    <Msg testId="agent-finished" tone={run.state === "done" ? undefined : "problem"}
      actions={run.canUndo ? <button type="button" className="ag-btn" disabled={!!busy} onClick={onUndo} data-testid="agent-undo">{busy === "undo" ? "Undoing…" : "Undo the build"}</button> : undefined}>
      {run.undo ? <span data-testid="agent-undone">Undone · {run.undo.removed} {run.undo.removed === 1 ? "card" : "cards"} taken off{run.undo.kept ? ` · ${run.undo.kept} kept` : ""}. Nothing is erased.</span>
        : run.state === "done" ? <span data-testid="agent-built">Built · {placedWords(run)} · free</span>
        : <span>{run.built.cards || run.built.wires ? `Stopped after placing ${placedWords(run)}.` : "Stopped before anything was placed."}</span>}
      {money ? <span className="ag-sub" data-testid="agent-spent">{rendered ? `${rendered} ${rendered === 1 ? "render" : "renders"} · ` : ""}{creditsText(money.spent)} spent of {creditsText(money.limit)}{money.inFlight ? ` · ${creditsText(money.inFlight)} still settling` : ""}</span> : null}
      {run.reason && run.state !== "done" ? <span className="ag-sub">{run.reason}</span> : null}
      {[...run.held, ...(run.undo?.reasons ?? [])].filter((w, i, all) => all.indexOf(w) === i).map((why) => <span key={why} className="ag-sub">Held · {why}</span>)}
    </Msg>
  );
}
