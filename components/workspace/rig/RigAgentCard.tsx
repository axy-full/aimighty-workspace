"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DraftRequestError, draftRequest } from "@/lib/workbench/draft-request";
import type { RigAgentMode, RigAgentPaidStepView, RigAgentRunView, RigAgentState } from "@/lib/workbench/rig-agent-plan";
import { creditFigure, isRunLimitAmount } from "@/lib/runLimit";
import { chargeSentence } from "@/lib/errors";
import { useRig } from "./RigProvider";

/**
 * Atomik on the board (plan PRs 9 and 10): the run card on the Rig, the same on
 * a desk and on a phone. Ask for a board with a limit for the run ("up to about
 * N credits") and a mode (Ask before each render, or Auto up to the per-job
 * line); Atomik plans inside that limit and proposes the cards and how they
 * connect; approve the build (free) and watch the cards arrive for the whole
 * team; then each render the plan names is priced and — in Ask, with one tap —
 * rendered as a draft, and the card shows what each settled at against the
 * limit. Stop lets go of anything not sent; renders already on their way
 * settle at what they cost.
 *
 * Everything shown comes from the server's run (GET /api/workbench/team-canvas
 * ?agent=1): read often while Atomik works, now and then otherwise, so a
 * teammate's run shows here too. As its cards land, the board folds them in.
 */

type AskTerms = { limit: number; jobCeiling: number; planning: number | null };
type AgentAnswer = { enabled: boolean; run: RigAgentRunView | null; ask?: AskTerms | null };
const API = "/api/workbench/team-canvas";
const BUSY_MS = 1500;
const IDLE_MS = 12_000;
const ACTIVE: RigAgentState[] = ["planning", "running"];
const READ_FAILED = "Atomik's board could not be read.";

function isAnswer(value: unknown): value is { agent: AgentAnswer } {
  const agent = (value as { agent?: AgentAnswer } | null)?.agent;
  return !!agent && typeof agent.enabled === "boolean" && (agent.run === null || (typeof agent.run === "object" && typeof agent.run.id === "string"));
}

const STATE_LABEL: Record<RigAgentState, string> = {
  planning: "Planning", awaiting_approval: "Proposal", running: "Working", paused: "Paused", needs_you: "Needs you", done: "Done", stopped: "Stopped", failed: "Stopped",
};
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const cr = (credits: number) => `${creditFigure(credits)} cr`;

export function RigAgentCard() {
  const rig = useRig();
  const project = rig.project;
  const pid = project?.productionProjectId ?? null;
  const draftId = project?.id ?? null;
  const [answer, setAnswer] = useState<{ pid: string; value: AgentAnswer } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [goal, setGoal] = useState("");
  /* Null until the person types: the field shows the suggested limit (the workspace's approval line) until then. */
  const [limit, setLimit] = useState<string | null>(null);
  const [mode, setMode] = useState<RigAgentMode>("ask");
  const [raise, setRaise] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const agent = answer && answer.pid === pid ? answer.value : null;
  const run = agent?.run ?? null;
  const [terms, setTerms] = useState<AskTerms | null>(null);
  const { refresh } = rig.team;
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const read = useCallback(async (production: string) => {
    try {
      const query = `${API}?productionId=${encodeURIComponent(production)}&agent=1${draftId ? `&projectId=${encodeURIComponent(draftId)}` : ""}`;
      const value = await draftRequest<unknown>(query, rig.scope);
      if (!isAnswer(value)) throw new Error(READ_FAILED);
      setAnswer({ pid: production, value: value.agent });
      if (value.agent.ask) setTerms(value.agent.ask);
      setReadError(null);
    } catch {
      setReadError(READ_FAILED);
    }
  }, [rig.scope, draftId]);

  /* Read once the Rig has joined its team canvas (never alongside that first read), then often while Atomik works and
     now and then otherwise (a teammate may start a run). Switched off with nothing to show, it is read once. */
  const active = !!run && ACTIVE.includes(run.state);
  const watching = !agent || agent.enabled || !!run;
  const joined = rig.team.mode !== "off";
  useEffect(() => {
    if (!pid || !joined) return;
    let stopped = false;
    const tick = () => { if (!stopped && document.visibilityState !== "hidden") void read(pid); };
    tick();
    if (!watching) return () => { stopped = true; };
    const every = setInterval(tick, active ? BUSY_MS : IDLE_MS);
    return () => { stopped = true; clearInterval(every); };
  }, [pid, joined, active, watching, read]);

  const suggested = terms?.limit ?? null;
  const limitText = limit ?? (suggested != null ? String(suggested) : "");

  /* As cards land (or come off in an undo), and as takes land, the board folds them in now rather than at its next check. */
  const landed = run ? `${run.id}:${run.state}:${run.built.cards}:${run.built.wires}:${run.undo ? "u" : ""}:${run.paid.filter((p) => p.state === "done").length}` : "";
  const seen = useRef("");
  useEffect(() => {
    if (!landed || landed === seen.current) return;
    const first = !seen.current;
    seen.current = landed;
    if (!first) void refreshRef.current();
  }, [landed]);

  const send = useCallback(async (body: Record<string, unknown>, what: string) => {
    if (!pid) return;
    setBusy(what);
    setProblem(null);
    try {
      const value = await draftRequest<unknown>(API, rig.scope, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId: pid, ...body }) });
      if (!isAnswer(value)) throw new Error(READ_FAILED);
      setAnswer({ pid, value: { ...value.agent, ask: value.agent.ask ?? null } });
      return true;
    } catch (error) {
      setProblem(error instanceof DraftRequestError && error.status && error.status < 500 && error.status !== 401 ? error.message : "Atomik could not do that just now. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }, [pid, rig.scope]);

  if (!project || !pid || !draftId || rig.team.mode === "off") return null;
  /* Not read yet (or never readable: the card is an extra, and the next read tries again), or switched off with nothing to
     show: the card is not there at all. A run the switch paused stays, so it can be stopped or undone. */
  if (!agent || (!agent.enabled && !run)) return null;

  const planning = terms?.planning ?? null;
  const ask = async () => {
    const text = goal.trim();
    if (text.length < 3) { setProblem("Say what the board should hold."); return; }
    const credits = Number(limitText);
    if (!isRunLimitAmount(credits)) { setProblem("Set a limit for this run in credits."); return; }
    if (planning != null && credits < planning) { setProblem(`The limit has to cover planning: at least ${cr(planning)}.`); return; }
    const ok = await send({ action: "agent.plan", projectId: draftId, requestId: crypto.randomUUID(), goal: text, limit: credits, mode }, "plan");
    if (ok) { setComposing(false); setGoal(""); }
  };
  const act = (action: string, extra: Record<string, unknown> = {}) => run && send({ action, runId: run.id, ...(action === "agent.approve" ? { fingerprint: run.proposal?.fingerprint } : {}), ...extra }, action + (extra.seq ? `:${extra.seq}` : ""));
  const terminal = !run || ["done", "stopped", "failed"].includes(run.state);
  /* Nothing in progress: the last run (if any), and asking for a new one. */
  const showCompose = agent.enabled && terminal;
  const money = run?.money ?? null;
  const limited = run?.paid.find((p) => p.state === "paused" && p.pause === "limit") ?? null;
  const raiseTo = money && limited ? Math.ceil(money.limit + Math.max(0, (limited.worst ?? limited.quote ?? 0) - money.left)) : null;

  return (
    <section className="pxw-agent" data-testid="rig-agent" aria-label="Atomik on the board" data-state={run?.state ?? "idle"}>
      <div className="pxw-agent-head">
        <span className="pxw-agent-mark" aria-hidden="true">A</span>
        <span className="pxw-agent-kicker" data-functional-label="">ATOMIK</span>
        <span className="pxw-agent-state" data-testid="rig-agent-state">{run && !showCompose ? STATE_LABEL[run.state] : "Build the board"}</span>
        {money && !showCompose ? (
          <span className="pxw-agent-spend" data-testid="rig-agent-spend">{cr(money.spent)} of {cr(money.limit)}</span>
        ) : null}
      </div>

      {showCompose ? (
        <div className="pxw-agent-body">
          {run ? <LastRun run={run} /> : null}
          {composing || !run ? (
            <>
              <label className="pxw-agent-label" htmlFor="rig-agent-goal">What should Atomik lay out?</label>
              <textarea id="rig-agent-goal" className="pxw-agent-goal" data-testid="rig-agent-goal" rows={3} maxLength={2000} value={goal}
                placeholder="A harbour at dawn: the captain and her daughter, three shots from the pier to the boat."
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(); } }} />
              <div className="pxw-agent-limit">
                <label className="pxw-agent-label" htmlFor="rig-agent-limit">Limit for this run</label>
                <span className="pxw-agent-limit-field">
                  <span aria-hidden="true">up to about</span>
                  <input id="rig-agent-limit" className="pxw-agent-number" data-testid="rig-agent-limit" type="number" inputMode="decimal" min={planning ?? 0.1} step={0.1}
                    value={limitText} onChange={(e) => setLimit(e.target.value)} aria-describedby="rig-agent-limit-note" />
                  <span aria-hidden="true">cr</span>
                </span>
              </div>
              <div className="pxw-agent-mode" role="radiogroup" aria-labelledby="rig-agent-mode-label" data-testid="rig-agent-mode">
                <span className="pxw-agent-label" id="rig-agent-mode-label">Renders</span>
                <div className="pxw-agent-options">
                  <button type="button" role="radio" aria-checked={mode === "ask"} className="pxw-agent-option" data-testid="rig-agent-mode-ask" onClick={() => setMode("ask")}>
                    Ask me before each one
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "auto"} className="pxw-agent-option" data-testid="rig-agent-mode-auto" onClick={() => setMode("auto")}>
                    {terms ? `Auto up to about ${cr(terms.jobCeiling)} each` : "Auto up to the per-render line"}
                  </button>
                </div>
              </div>
              <p className="pxw-agent-note" id="rig-agent-limit-note" data-testid="rig-agent-terms">
                Planning is priced and counts toward this limit{planning != null ? ` (up to about ${cr(planning)})` : ""}. Placing cards is free. Every render is priced before it runs, and nothing passes the limit.
              </p>
            </>
          ) : null}
          <div className="pxw-agent-actions">
            {run?.canUndo ? <UndoButton busy={busy} onUndo={() => void act("agent.undo")} /> : null}
            {composing || !run ? (
              <button type="button" className="pxw-agent-primary" data-testid="rig-agent-propose" disabled={!!busy} onClick={() => void ask()}>
                {busy === "plan" ? "Asking…" : planning != null ? `Propose a board · up to about ${cr(planning)}` : "Propose a board"}
              </button>
            ) : (
              <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-new" disabled={!!busy} onClick={() => { setComposing(true); setGoal(run.state === "failed" ? run.goal : ""); }}>
                {run.state === "failed" ? "Ask again" : "New run"}
              </button>
            )}
          </div>
        </div>
      ) : run ? (
        <div className="pxw-agent-body">
          {money ? <MoneyLine run={run} /> : null}
          {run.state === "planning" ? <p className="pxw-agent-line" role="status">Atomik is planning the board…</p> : null}
          {run.state === "awaiting_approval" && run.proposal ? <Proposal run={run} /> : null}
          {(run.state === "running" || run.state === "paused" || run.state === "needs_you") && !run.steps.filter((s) => s.state !== "next").every((s) => s.state === "done" || s.state === "skipped") ? <Steps run={run} /> : null}
          {run.state === "needs_you" && run.reason ? <p className="pxw-agent-needs" role="status" data-testid="rig-agent-needs">{run.reason}</p> : null}
          {run.state === "paused" && run.reason ? <p className="pxw-agent-problem" role="status">{run.reason}</p> : null}
          {!terminal && !agent.enabled && run.state !== "paused" ? <p className="pxw-agent-problem" role="status">Atomik&apos;s board building is switched off right now.</p> : null}
          {!terminal && run.paid.length > 0 && run.state !== "awaiting_approval" && run.state !== "planning" ? <Renders run={run} busy={busy} onRender={(p) => void act("agent.render", { seq: p.seq, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}) })} onSkip={(p) => void act("agent.skip", { seq: p.seq })} /> : null}
          {limited && run.mine && raiseTo != null ? (
            <div className="pxw-agent-raise" data-testid="rig-agent-raise">
              <label className="pxw-agent-label" htmlFor="rig-agent-raise-limit">New limit for this run</label>
              <span className="pxw-agent-limit-field">
                <span aria-hidden="true">up to about</span>
                <input id="rig-agent-raise-limit" className="pxw-agent-number" data-testid="rig-agent-raise-limit" type="number" inputMode="decimal" min={raiseTo} step={0.1}
                  value={raise || String(raiseTo)} onChange={(e) => setRaise(e.target.value)} />
                <span aria-hidden="true">cr</span>
              </span>
              <button type="button" className="pxw-agent-primary" data-testid="rig-agent-raise-button" disabled={!!busy}
                onClick={async () => {
                  const next = Number(raise || raiseTo);
                  if (!isRunLimitAmount(next)) { setProblem("Set the new limit in credits."); return; }
                  if (await act("agent.limit", { limit: next })) setRaise("");
                }}>
                {busy === "agent.limit" ? "Raising…" : "Raise the limit"}
              </button>
            </div>
          ) : null}
          {terminal ? <LastRun run={run} /> : null}
          <div className="pxw-agent-actions">
            {run.state === "awaiting_approval" && run.mine ? (
              <>
                <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-decline" disabled={!!busy} onClick={() => void act("agent.decline")}>Not now</button>
                <button type="button" className="pxw-agent-primary" data-testid="rig-agent-approve" disabled={!!busy || !agent.enabled} onClick={() => void act("agent.approve")}>
                  {busy === "agent.approve" ? "Starting…" : "Build · free"}
                </button>
              </>
            ) : null}
            {run.state === "awaiting_approval" && !run.mine ? <p className="pxw-agent-note">Waiting for the person who asked to approve it.</p> : null}
            {["planning", "running", "paused", "needs_you"].includes(run.state) ? (
              <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-stop" disabled={!!busy} onClick={() => void act("agent.stop")}>{busy === "agent.stop" ? "Stopping…" : "Stop"}</button>
            ) : null}
            {run.canUndo ? <UndoButton busy={busy} onUndo={() => void act("agent.undo")} /> : null}
          </div>
        </div>
      ) : null}
      {problem ? <p className="pxw-agent-problem" role="alert" data-testid="rig-agent-problem">{problem}</p> : null}
      {readError ? (
        <div className="pxw-agent-actions" role="alert">
          <p className="pxw-agent-problem">{readError}</p>
          <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-reread" onClick={() => void read(pid)}>Try again</button>
        </div>
      ) : null}
    </section>
  );
}

function UndoButton({ busy, onUndo }: { busy: string | null; onUndo: () => void }) {
  return (
    <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-undo" disabled={!!busy} onClick={onUndo}>
      {busy === "agent.undo" ? "Undoing…" : "Undo the build"}
    </button>
  );
}

/** What the run may spend and has spent: the limit approved for it, never a vendor's cost. */
function MoneyLine({ run }: { run: RigAgentRunView }) {
  const m = run.money!;
  return (
    <p className="pxw-agent-money" data-testid="rig-agent-money">
      <span data-testid="rig-agent-spent">Spent {cr(m.spent)}</span>
      {m.inFlight ? <span data-testid="rig-agent-inflight"> · {cr(m.inFlight)} on its way</span> : null}
      <span> · about {cr(m.left)} left of {cr(m.limit)}</span>
      <span className="pxw-agent-mode-line" data-testid="rig-agent-mode-line"> · {m.mode === "auto" ? `Auto up to about ${cr(m.jobCeiling)} a render` : "Ask before each render"}</span>
    </p>
  );
}

/** The proposal: the cards by kind, the wires, the tidy, and the priced steps that come after. */
function Proposal({ run }: { run: RigAgentRunView }) {
  const p = run.proposal!;
  return (
    <div className="pxw-agent-proposal" role="group" aria-label="Atomik's proposal" data-testid="rig-agent-proposal">
      <div className="pxw-agent-title">{p.title}</div>
      {p.summary ? <p className="pxw-agent-line">{p.summary}</p> : null}
      <ul className="pxw-agent-groups">
        {p.groups.map((g) => (
          <li key={g.kind} data-kind={g.kind}><span className="pxw-agent-group">{g.label} · {g.titles.length}</span><span className="pxw-agent-titles">{g.titles.join(" · ")}</span></li>
        ))}
      </ul>
      <p className="pxw-agent-count" data-testid="rig-agent-count">
        {plural(p.cards, "card")} · {plural(p.wires, "wire")}{p.tidy ? " · tidied" : ""} · free
      </p>
      {p.next.map((line) => <p key={line} className="pxw-agent-next" data-testid="rig-agent-next">{line}</p>)}
    </div>
  );
}

/** A build in progress: each step as it lands, with anything a person's edit held. */
function Steps({ run }: { run: RigAgentRunView }) {
  const build = run.steps.filter((s) => s.state !== "next");
  const done = build.filter((s) => s.state === "done").length;
  return (
    <>
      <p className="pxw-agent-line" role="status" data-testid="rig-agent-progress">Building · {done} of {build.length} {build.length === 1 ? "step" : "steps"}</p>
      <ol className="pxw-agent-steps" data-testid="rig-agent-steps">
        {build.map((s) => (
          <li key={s.seq} data-state={s.state}><span aria-hidden="true">{s.state === "done" ? "✓" : "·"}</span><span>{s.label}</span></li>
        ))}
      </ol>
    </>
  );
}

const RENDER_STATE: Partial<Record<RigAgentPaidStepView["state"], string>> = {
  next: "Up next", waiting: "Ready", approved: "Approved · going next", sending: "Sending", rendering: "Rendering…",
  done: "Rendered · in Takes", failed: "Failed", paused: "Needs you", skipped: "Not rendered",
};

/** What a render cost or will cost, in credits, never cut short: its price before, its settled charge after. */
function priceOf(p: RigAgentPaidStepView): string {
  if (p.tool === "verify") return "Not charged";
  if (p.state === "done") return p.charged != null ? `${cr(p.charged)} settled` : "Settling";
  /* A failed take: what Particl's own ledger holds for it (the provider's outcome as the ledger recorded it). */
  if (p.state === "failed") return p.charge ? chargeSentence(p.charge) : "Settling";
  if (p.state === "skipped") return "Not charged";
  return p.quote != null ? `about ${cr(p.quote)}` : "Priced before it runs";
}

/** The renders after the build (and the checks of their takes): each priced, each approved, each settled. */
function Renders({ run, busy, onRender, onSkip }: { run: RigAgentRunView; busy: string | null; onRender: (p: RigAgentPaidStepView) => void; onSkip: (p: RigAgentPaidStepView) => void }) {
  return (
    <ol className="pxw-agent-renders" data-testid="rig-agent-renders">
      {run.paid.map((p) => {
        const open = p.state === "waiting" || p.state === "paused";
        const waitingOnOwner = open && !p.canRender && !run.mine && ["needs_you", "running"].includes(run.state);
        return (
          <li key={p.seq} className="pxw-agent-render" data-state={p.state} data-tool={p.tool} data-testid={`rig-agent-render-${p.seq}`}>
            <div className="pxw-agent-render-head">
              <span className="pxw-agent-render-title">{p.tool === "verify" ? `Check · ${p.title}` : p.title}</span>
              <span className="pxw-agent-render-price" data-testid="rig-agent-render-price">{priceOf(p)}</span>
            </div>
            <p className="pxw-agent-render-state" data-testid="rig-agent-render-state">
              {p.tool === "verify" ? p.reason
                : p.state === "failed" ? (p.charge?.settled ? `Failed · ${p.charge.credits > 0 ? "charged" : "not billed"}` : "Failed")
                : RENDER_STATE[p.state] ?? p.state}
              {waitingOnOwner ? " · waiting for the person who asked" : ""}
            </p>
            {p.tool === "render" && p.reason && (p.state === "paused" || p.state === "failed" || p.state === "approved") ? <p className="pxw-agent-note" data-testid="rig-agent-render-reason">{p.reason}</p> : null}
            {p.canRender ? (
              <div className="pxw-agent-actions">
                <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-skip" disabled={!!busy} onClick={() => onSkip(p)}>Skip</button>
                <button type="button" className="pxw-agent-primary" data-testid="rig-agent-render" disabled={!!busy} onClick={() => onRender(p)}>
                  {busy === `agent.render:${p.seq}` ? "Sending…"
                    : p.state === "paused" && (p.pause === "unpriced" || p.pause === "record" || p.quote == null) ? "Price again"
                    : p.quote != null ? `${p.state === "paused" ? "Retry" : "Render"} · about ${cr(p.quote)}` : "Render"}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A finished, stopped or undone run: what it placed, what was held, what it spent, and what comes next. */
function LastRun({ run }: { run: RigAgentRunView }) {
  const placed = `${plural(run.built.cards, "card")} · ${plural(run.built.wires, "wire")}`;
  const rendered = run.paid.filter((p) => p.tool === "render" && p.state === "done").length;
  return (
    <div className="pxw-agent-last" data-testid="rig-agent-last">
      {run.undo ? (
        <p className="pxw-agent-line" data-testid="rig-agent-undone">
          Undone · {plural(run.undo.removed, "card")} taken off{run.undo.kept ? ` · ${plural(run.undo.kept, "card")} kept` : ""}. Nothing is erased: the team canvas keeps them.
        </p>
      ) : run.state === "done" ? (
        <p className="pxw-agent-line" data-testid="rig-agent-built">Built · {placed} · free</p>
      ) : run.built.cards || run.built.wires ? (
        <p className="pxw-agent-line" data-testid="rig-agent-built">Placed before it stopped · {placed}</p>
      ) : null}
      {run.money ? (
        <p className="pxw-agent-line" data-testid="rig-agent-total">
          {rendered ? `${plural(rendered, "draft")} rendered · ` : ""}{cr(run.money.spent)} spent of {cr(run.money.limit)}{run.money.inFlight ? ` · ${cr(run.money.inFlight)} still settling` : ""}
        </p>
      ) : null}
      {run.reason && run.state !== "done" ? <p className="pxw-agent-note">{run.reason}</p> : null}
      {[...run.held, ...(run.undo?.reasons ?? [])].filter((why, i, all) => all.indexOf(why) === i).map((why) => (
        <p key={why} className="pxw-agent-held" data-testid="rig-agent-held">Held · {why}</p>
      ))}
      {run.paid.some((p) => p.tool === "render" && p.state !== "next") ? <Renders run={run} busy={null} onRender={() => {}} onSkip={() => {}} /> : null}
      {run.state === "done" && !run.undo && !run.paid.length ? run.proposal?.next.map((line) => <p key={line} className="pxw-agent-next" data-testid="rig-agent-next">{line}</p>) : null}
    </div>
  );
}
