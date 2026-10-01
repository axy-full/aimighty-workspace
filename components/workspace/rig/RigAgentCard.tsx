"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DraftRequestError, draftRequest } from "@/lib/workbench/draft-request";
import type { RigAgentRunView, RigAgentState } from "@/lib/workbench/rig-agent-plan";
import { useRig } from "./RigProvider";

/**
 * Atomik builds the board (plan PR 9): the run card on the Rig, the same on a
 * desk and on a phone. Ask for a board; Atomik proposes the cards and how they
 * connect; approve it (free) and watch the cards arrive for the whole team; undo
 * it. A render the proposal names is shown as the priced next step and never
 * runs from here.
 *
 * Everything shown comes from the server's run (GET /api/workbench/team-canvas
 * ?agent=1): read often while Atomik plans or builds, now and then otherwise, so
 * a teammate's build shows here too. As its cards land, the board folds them in.
 */

type AgentAnswer = { enabled: boolean; run: RigAgentRunView | null };
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
  planning: "Planning", awaiting_approval: "Proposal", running: "Building", paused: "Paused", done: "Built", stopped: "Stopped", failed: "Stopped",
};
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function RigAgentCard() {
  const rig = useRig();
  const project = rig.project;
  const pid = project?.productionProjectId ?? null;
  const draftId = project?.id ?? null;
  const [answer, setAnswer] = useState<{ pid: string; value: AgentAnswer } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const agent = answer && answer.pid === pid ? answer.value : null;
  const run = agent?.run ?? null;
  const { refresh } = rig.team;
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const read = useCallback(async (production: string) => {
    try {
      const value = await draftRequest<unknown>(`${API}?productionId=${encodeURIComponent(production)}&agent=1`, rig.scope);
      if (!isAnswer(value)) throw new Error(READ_FAILED);
      setAnswer({ pid: production, value: value.agent });
      setReadError(null);
    } catch {
      setReadError(READ_FAILED);
    }
  }, [rig.scope]);

  /* Read once the Rig has joined its team canvas (never alongside that first read), then often while Atomik works and
     now and then otherwise (a teammate may start a build). Switched off with nothing to show, it is read once. */
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

  /* As cards land (or come off in an undo), the board folds them in now rather than at its next check. */
  const landed = run ? `${run.id}:${run.state}:${run.built.cards}:${run.built.wires}:${run.undo ? "u" : ""}` : "";
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
      setAnswer({ pid, value: value.agent });
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

  const ask = async () => {
    const text = goal.trim();
    if (text.length < 3) { setProblem("Say what the board should hold."); return; }
    const ok = await send({ action: "agent.plan", projectId: draftId, requestId: crypto.randomUUID(), goal: text }, "plan");
    if (ok) { setComposing(false); setGoal(""); }
  };
  const act = (action: string) => run && send({ action, runId: run.id, ...(action === "agent.approve" ? { fingerprint: run.proposal?.fingerprint } : {}) }, action);
  const terminal = !run || ["done", "stopped", "failed"].includes(run.state);
  /* Nothing in progress: the last build (if any), and asking for a new one. */
  const showCompose = agent.enabled && terminal;

  return (
    <section className="pxw-agent" data-testid="rig-agent" aria-label="Atomik builds the board" data-state={run?.state ?? "idle"}>
      <div className="pxw-agent-head">
        <span className="pxw-agent-mark" aria-hidden="true">A</span>
        <span className="pxw-agent-kicker" data-functional-label="">ATOMIK</span>
        <span className="pxw-agent-state" data-testid="rig-agent-state">{run && !showCompose ? STATE_LABEL[run.state] : "Build the board"}</span>
        <span className="pxw-agent-free" data-testid="rig-agent-free">Free</span>
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
              <p className="pxw-agent-note">Atomik proposes the cards and wires; you approve before anything is placed. Building is free. Nothing renders.</p>
            </>
          ) : null}
          <div className="pxw-agent-actions">
            {run?.canUndo ? <UndoButton busy={busy} onUndo={() => void act("agent.undo")} /> : null}
            {composing || !run ? (
              <button type="button" className="pxw-agent-primary" data-testid="rig-agent-propose" disabled={!!busy} onClick={() => void ask()}>
                {busy === "plan" ? "Asking…" : "Propose a board"}
              </button>
            ) : (
              <button type="button" className="pxw-agent-quiet" data-testid="rig-agent-new" disabled={!!busy} onClick={() => { setComposing(true); setGoal(run.state === "failed" ? run.goal : ""); }}>
                {run.state === "failed" ? "Ask again" : "New build"}
              </button>
            )}
          </div>
        </div>
      ) : run ? (
        <div className="pxw-agent-body">
          {run.state === "planning" ? <p className="pxw-agent-line" role="status">Atomik is planning the board…</p> : null}
          {run.state === "awaiting_approval" && run.proposal ? <Proposal run={run} /> : null}
          {run.state === "running" || run.state === "paused" ? <Steps run={run} /> : null}
          {run.state === "paused" && run.reason ? <p className="pxw-agent-problem" role="status">{run.reason}</p> : null}
          {!terminal && !agent.enabled && run.state !== "paused" ? <p className="pxw-agent-problem" role="status">Atomik&apos;s board building is switched off right now.</p> : null}
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
            {run.state === "planning" || run.state === "running" || run.state === "paused" ? (
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

/** The proposal: the cards by kind, the wires, the tidy, and the priced steps that come after (never run here). */
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

/** A build in progress: each step as it lands, with anything a person's edit or a locked master held. */
function Steps({ run }: { run: RigAgentRunView }) {
  const build = run.steps.filter((s) => s.state !== "next");
  const done = build.filter((s) => s.state === "done").length;
  return (
    <>
      <p className="pxw-agent-line" role="status" data-testid="rig-agent-progress">Building · {done} of {build.length} {build.length === 1 ? "step" : "steps"}</p>
      <ol className="pxw-agent-steps" data-testid="rig-agent-steps">
        {build.map((s) => (
          <li key={s.seq} data-state={s.state} data-held={s.held.length ? "" : undefined}><span aria-hidden="true">{s.state === "done" ? "✓" : "·"}</span><span>{s.label}{s.held.length ? " · held" : ""}</span></li>
        ))}
      </ol>
      {run.held.map((why) => <p key={why} className="pxw-agent-held" data-testid="rig-agent-held">Held · {why}</p>)}
    </>
  );
}

/** A finished, stopped or undone build: what it placed, what was held, and what comes next. */
function LastRun({ run }: { run: RigAgentRunView }) {
  const placed = `${plural(run.built.cards, "card")} · ${plural(run.built.wires, "wire")}`;
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
      {run.reason && run.state !== "done" ? <p className="pxw-agent-note">{run.reason}</p> : null}
      {[...run.held, ...(run.undo?.reasons ?? [])].filter((why, i, all) => all.indexOf(why) === i).map((why) => (
        <p key={why} className="pxw-agent-held" data-testid="rig-agent-held">Held · {why}</p>
      ))}
      {run.state === "done" && !run.undo ? run.proposal?.next.map((line) => <p key={line} className="pxw-agent-next" data-testid="rig-agent-next">{line}</p>) : null}
    </div>
  );
}
