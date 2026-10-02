"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { useAgentChoice } from "@/components/graphite/production/AgentBar";
import { useAgentRuns } from "@/components/graphite/production/use-agent-runs";
import { timeAgo } from "@/lib/format";
import { verifyJudge } from "@/lib/production/agent";
import { useMoney } from "@/lib/price";
import { forgetAtomikVideoFrames, prepareAtomikVideoFrames, staleAtomikFrames } from "@/lib/workbench/atomik-video-frames";
import type { DevelopmentJob, DevelopmentQuote } from "@/lib/workbench/development-types";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import {
  CHECK_VERDICT_WORDS, STANDING_WORDS, VERDICT_WORDS, VERIFY_CHECK_LABELS, holdWorthSaying, isVerifyCard, verdictLine, verificationFor,
  verifyCardFor, verifyFrameUrl, verifySubject, withVerifyLast, type TakeVerification, type VerifyStanding, type VerifySubject,
} from "@/lib/workbench/verify";
import { formatCredits } from "@/lib/workspace/cost";
import type { RigShot } from "@/lib/workspace/shots";
import { Kicker } from "../ui";
import { useRig } from "./RigProvider";
import { useVerifications } from "./use-verifications";
import "./rig-verify.css";

/*
 * The Rig's Verify card (plan PR 7): a check of one take against its masters,
 * priced first ("about N cr"), charged in credits at what the judge actually
 * used, and free to read again. The scorecard shows on the card, in the Card
 * Inspector, and as a badge on the take in Takes (./VerifyBadge.tsx).
 */

const KIND_WORD = { cast: "Cast", environment: "Environment", element: "Element" } as const;

/** What a card shows: the stored check for what it checks now, or the newest it asked for, with how it stands. */
function useShown(node: CanvasNode, project: Project) {
  const rig = useRig();
  const checks = useVerifications(rig.scope, project.id);
  const subject = useMemo(() => verifySubject(project, node), [project, node]);
  const shown = useMemo(() => verificationFor(checks.list ?? [], node.id, subject), [checks.list, node.id, subject]);
  /* A teammate's check reached this canvas (its card's last verdict) before this window read it: read now, once. */
  const lastId = node.verify?.last?.id;
  const { refresh, list } = checks;
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!lastId || !list || asked.current.has(lastId) || list.some((v) => v.id === lastId)) return;
    asked.current.add(lastId);
    void refresh();
  }, [lastId, list, refresh]);
  return { checks, subject, shown };
}

const usdOf = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
/** The price in the one unit this workspace pays in, approximate: a check settles at what the judge actually used. */
function aboutPrice(quote: Pick<DevelopmentQuote, "estimateCredits" | "estimateUsd">, inCredits: boolean): string {
  const usd = usdOf(quote.estimateUsd);
  if (!inCredits) return usd != null ? `about $${usd.toFixed(4)}` : `about ${formatCredits(quote.estimateCredits)}`;
  if (quote.estimateCredits > 0 || usd == null) return `about ${formatCredits(quote.estimateCredits)}`;
  return `about $${usd.toFixed(4)} on your key`;
}
/** While a check runs: what is held for it, its ceiling (a running job carries the reservation, not the estimate). */
function heldPrice(job: Pick<DevelopmentJob, "estimateCredits" | "estimateUsd">, inCredits: boolean): string {
  const usd = usdOf(job.estimateUsd);
  if (!inCredits) return usd != null ? `up to $${usd.toFixed(4)}` : `up to ${formatCredits(job.estimateCredits)}`;
  if (job.estimateCredits > 0) return `up to ${formatCredits(job.estimateCredits)} held`;
  return usd != null ? `up to $${usd.toFixed(4)} on your key` : "billed on your key";
}

/* ── On the canvas ─────────────────────────────────────────────────────── */

/**
 * The card's verdict on the canvas, and what it found or whether it is still about these masters: one flow of words,
 * two lines at most (rig-verify.css). On the board's fixed-height card it stands where a description would.
 */
export function VerifyCardLine({ node }: { node: CanvasNode }) {
  const rig = useRig();
  if (!rig.project || !isVerifyCard(node)) return null;
  return <CardLine node={node} project={rig.project} />;
}
function CardLine({ node, project }: { node: CanvasNode; project: Project }) {
  const { shown, subject } = useShown(node, project);
  const v = shown?.verification;
  const stale = shown && shown.standing !== "current" ? STANDING_WORDS[shown.standing] : null;
  return (
    <span className="pxw-graph-verify" data-testid="rig-verify-line" data-verdict={v?.verdict ?? "none"} data-standing={shown?.standing}>
      <span className="pxw-graph-verify-verdict" data-functional-label="">{v ? VERDICT_WORDS[v.verdict].toUpperCase() : "NOT CHECKED"}</span>{" "}
      <span className="pxw-graph-verify-detail">{stale ?? (v ? verdictLine(v.checks) : subject.problem ?? `${subject.checks.length} checks · priced before it runs`)}</span>
    </span>
  );
}

/* ── In the shot Inspector ─────────────────────────────────────────────── */

/** "Verify this take": the shot's Verify card, made (free) and wired to the shot and its masters, or opened. */
export function VerifyShotEntry({ shot }: { shot: RigShot }) {
  const rig = useRig();
  const [problem, setProblem] = useState<string | null>(null);
  const existing = rig.project?.nodes.some((n) => isVerifyCard(n) && n.linked.includes(shot.id));
  return (
    <div className="pxw-verify-entry" data-testid="rig-verify-entry">
      <Kicker className="pxw-insp-section">Verify</Kicker>
      <p className="pxw-inspector-note">Check this shot’s take against its Cast, Environment and Element cards: face, wardrobe, place, props and glitches. Priced before it runs.</p>
      <button type="button" className="pxw-btn pxw-btn--control pxw-verify-button" data-testid="rig-verify-open"
        onClick={() => setProblem(rig.apply((p) => verifyCardFor(p, shot.id), true))}>
        {existing ? "Open its Verify card" : "Verify this take"}
      </button>
      {problem ? <p className="pxw-insp-error" role="alert">{problem}</p> : null}
    </div>
  );
}

/* ── In the Card Inspector ─────────────────────────────────────────────── */

const FREE = "Already checked against these masters: this is the stored scorecard. Reading it again is free.";

/** A Verify card's Inspector section: what it checks, the price and the approve, and the scorecard. */
export function VerifySection({ node, project }: { node: CanvasNode; project: Project }) {
  if (!isVerifyCard(node)) return null;
  return <Section node={node} project={project} />;
}

function Section({ node, project }: { node: CanvasNode; project: Project }) {
  const rig = useRig();
  const { inCredits } = useMoney();
  const { checks, subject, shown } = useShown(node, project);
  const runs = useAgentRuns({ scope: rig.scope, projectId: project.id, save: rig.save });
  const agent = useAgentChoice(runs.models);
  /* The judge: the Production agent's own choice when it can see; else the newest of its family that can, else any that can. */
  const { model: judge, effort } = verifyJudge(runs.models, agent.choice);
  /* The stored check a press of Verify found (read free): said while the card still shows that check. */
  const [freeFor, setFreeFor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const cancel = useRef<AbortController | null>(null);
  useEffect(() => () => cancel.current?.abort(), []);

  const jobs = useMemo(() => runs.jobs.filter((j) => j.kind === "verify" && j.nodeId === node.id).sort((a, b) => b.createdAt - a.createdAt), [runs.jobs, node.id]);
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  const latest = jobs[0];
  const quote = runs.quote && runs.quote.input.kind === "verify" && runs.quote.input.nodeId === node.id ? runs.quote : null;
  const stored = quote?.value.stored ?? null;

  /* A check this window started finished: the board reads it, and the card's verdict goes to everyone on the canvas. */
  const taken = useRef(new Set<string>());
  const { refresh } = checks;
  useEffect(() => {
    const done = jobs.find((j) => j.status === "succeeded" && j.result?.verify);
    if (!done || taken.current.has(done.id)) return;
    taken.current.add(done.id);
    void refresh();
    if (done.updatedAt > (node.verify?.last?.at ?? 0))
      rig.apply((p) => withVerifyLast(p, node.id, { id: done.id, takeId: done.result!.verify!.takeId, verdict: done.result!.verify!.verdict, at: done.updatedAt }));
  }, [jobs, node.id, node.verify?.last?.at, refresh, rig]);
  /* The quote found the stored check (a teammate's, say): read it, free. */
  useEffect(() => { if (stored) void refresh(); }, [stored, refresh]);
  /* A saved still that is gone: forget this take's stills, so the next press samples fresh ones. */
  const takeAsset = subject.take?.asset ?? null;
  useEffect(() => {
    if (runs.error && staleAtomikFrames(runs.error) && takeAsset) forgetAtomikVideoFrames([takeAsset], project.id, rig.scope);
  }, [runs.error, takeAsset, project.id, rig.scope]);

  const current = shown?.standing === "current" ? shown.verification : null;
  const blocked = subject.problem
    ?? (!runs.loaded ? "Reading the agent’s runs…"
      : runs.pending ? "An earlier agent request is unconfirmed. Recover it from its stage first."
      : active ? null
      : runs.configured === false || !runs.models.length ? "No agent is connected to this workspace. Connect one in Workspace › Engines."
      : !judge ? "None of this workspace’s agents can see images. Connect a Claude, OpenAI or Grok model that can."
      : null);

  const ask = async () => {
    setFreeFor(null); setProblem(null);
    /* The same take against the same masters: the stored scorecard, and nothing is asked of the server. */
    if (current) { setFreeFor(current.id); return; }
    if (!judge || !takeAsset) return;
    let videoFrames;
    if (takeAsset.kind === "video") {
      cancel.current?.abort();
      const controller = new AbortController();
      cancel.current = controller;
      setPreparing(true);
      try {
        /* Its stills are filed against the saved project: a take that has only just landed (an Atomik run's) is saved first. */
        if (!(await rig.save())) throw new Error("Save the project before checking this take.");
        videoFrames = await prepareAtomikVideoFrames([takeAsset], project.id, rig.scope, controller.signal);
      }
      catch (error) { setProblem(error instanceof Error ? error.message : "The take’s frames could not be prepared."); return; }
      finally { setPreparing(false); }
    }
    await runs.estimate({ kind: "verify", model: judge.id, effort, nodeId: node.id, ...(videoFrames ? { videoFrames } : {}) });
  };
  const price = quote && !stored ? aboutPrice(quote.value, inCredits) : null;
  /* The ceiling the wallet holds while it runs, said in small type when it is well above the estimate. */
  const hold = price && quote && inCredits && holdWorthSaying(quote.value.estimateCredits, quote.value.holdCredits) ? quote.value.holdCredits! : null;
  const busy = preparing ? "Preparing the take’s frames…" : runs.busy === "Estimating…" ? "Getting the price…" : runs.busy;

  return (
    <div data-section="verify" data-testid="card-verify" data-verdict={shown?.verification.verdict} data-standing={shown?.standing}>
      <Kicker className="pxw-insp-section">Verify</Kicker>
      <Subject subject={subject} />
      {shown ? <Scorecard verification={shown.verification} standing={shown.standing} /> : (
        <p className="pxw-inspector-note" data-testid="card-verify-none">Not checked yet.</p>
      )}
      {checks.error && !checks.list ? (
        <p className="pxw-insp-error" role="alert" data-testid="card-verify-read">The checks could not be read. <button type="button" className="pxw-link-button" onClick={() => void refresh()}>Try again</button></p>
      ) : null}
      <div className="pxw-verify-action" data-testid="card-verify-action">
        {active ? (
          <p className="pxw-insp-notice" role="status" data-testid="card-verify-running">Checking · {heldPrice(active, inCredits)}. The scorecard lands here when it is done.</p>
        ) : price && quote ? (
          <>
            <p className="pxw-verify-price" data-testid="card-verify-price">
              One check by {thinkingModelName(quote.input.model)}: {price}, {inCredits && quote.value.estimateCredits > 0 ? "charged in credits once it is done" : inCredits ? "billed on your key once it is done" : "billed once it is done"}, at what the check actually used.
            </p>
            {hold != null ? <p className="pxw-verify-hold" data-testid="card-verify-hold">Up to {formatCredits(hold)} held while it runs.</p> : null}
            <div className="pxw-verify-buttons">
              <button type="button" className="pxw-btn pxw-btn--control pxw-verify-button" disabled={Boolean(runs.busy)} onClick={runs.clearQuote}>Cancel</button>
              <button type="button" className="pxw-btn pxw-btn--primary pxw-verify-button" data-testid="card-verify-start" disabled={Boolean(runs.busy) || Boolean(blocked)}
                onClick={() => void runs.start()}>{runs.busy === "Starting…" ? "Starting…" : `Verify · ${price}`}</button>
            </div>
          </>
        ) : (
          <>
            <button type="button" className="pxw-btn pxw-btn--primary pxw-verify-button" data-testid="card-verify-estimate" disabled={Boolean(busy) || Boolean(blocked)}
              aria-describedby={blocked ? `verify-blocked-${node.id}` : undefined} onClick={() => void ask()}>
              {busy || (shown && shown.standing !== "current" ? "Verify again" : "Verify")}
            </button>
            {blocked ? <p className="pxw-inspector-note" id={`verify-blocked-${node.id}`} data-testid="card-verify-blocked">{blocked}</p>
              : !current ? <p className="pxw-inspector-note">The price comes first{judge ? `, from ${thinkingModelName(judge.id)}` : ""}. Nothing is sent until you approve it.</p> : null}
          </>
        )}
        {current && (current.id === freeFor || current.id === stored?.id) ? <p className="pxw-insp-notice" role="status" data-testid="card-verify-free">{FREE}</p> : null}
        {problem || runs.error ? <p className="pxw-insp-error" role="alert" data-testid="card-verify-error">{problem ?? runs.error}</p> : null}
        {!active && latest && (latest.status === "failed" || latest.status === "uncertain") && (!shown || shown.verification.createdAt < latest.updatedAt) && latest.error ? (
          <p className="pxw-insp-error" role="alert" data-testid="card-verify-failed">{latest.error}</p>
        ) : null}
      </div>
    </div>
  );
}

function Subject({ subject }: { subject: VerifySubject }) {
  const take = subject.take;
  return (
    <div className="pxw-verify-subject" data-testid="card-verify-subject">
      <p className="pxw-verify-what" data-testid="card-verify-take">
        <span className="pxw-verify-label" data-functional-label="">Take</span>
        <span>{take ? `${take.node.title}${take.asset ? ` · v${take.asset.version} · ${take.asset.kind === "video" ? "video, three frames" : "still"}` : " · no take yet"}` : "No shot wired in"}</span>
      </p>
      <p className="pxw-verify-what" data-testid="card-verify-masters">
        <span className="pxw-verify-label" data-functional-label="">Masters</span>
        <span>{subject.masters.length ? subject.masters.map((m) => `${KIND_WORD[m.kind]} · ${m.node.title}${m.asset ? ` v${m.asset.version}` : ""}`).join(", ") : "None wired in: only glitches are checked"}</span>
      </p>
      <p className="pxw-verify-what" data-testid="card-verify-checks">
        <span className="pxw-verify-label" data-functional-label="">Checks</span>
        <span>{subject.checks.map((c) => VERIFY_CHECK_LABELS[c]).join(", ")}</span>
      </p>
      {subject.context.length ? <p className="pxw-inspector-note">Not scored: {subject.context.map((n) => n.title).join(", ")}. Refs and notes are context.</p> : null}
    </div>
  );
}

function Scorecard({ verification: v, standing }: { verification: TakeVerification; standing: VerifyStanding }) {
  const charge = v.ownKey ? "billed on your key" : `${formatCredits(v.credits)} charged`;
  return (
    <div className="pxw-verify-card" data-testid="card-verify-scorecard" data-verdict={v.verdict}>
      <p className="pxw-verify-verdict" data-testid="card-verify-verdict">
        <span className="pxw-verify-dot" aria-hidden="true" />
        <span className="pxw-verify-verdict-word">{VERDICT_WORDS[v.verdict]}</span>
        <span className="pxw-verify-verdict-line">{verdictLine(v.checks)}</span>
      </p>
      {standing !== "current" ? (
        <p className="pxw-verify-stale" data-testid="card-verify-stale">{STANDING_WORDS[standing]}. Verify again to check it against the current ones.</p>
      ) : null}
      {v.verdict === "needs_you" ? <p className="pxw-inspector-note" data-testid="card-verify-needs-you">The check was not sure, so nothing passed on a guess. Look at the take and decide.</p> : null}
      <ul className="pxw-verify-rows">
        {v.checks.map((c) => {
          const thumb = c.frame != null ? verifyFrameUrl(v.frames[c.frame], v.takeId) : null;
          return (
            <li className="pxw-verify-row" key={c.check} data-check={c.check} data-verdict={c.verdict} data-testid="card-verify-row">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {thumb ? <img className="pxw-verify-thumb" src={thumb} alt="" loading="lazy" decoding="async" /> : <span className="pxw-verify-thumb" aria-hidden="true" />}
              <span className="pxw-verify-row-text">
                <span className="pxw-verify-row-head">
                  <span className="pxw-verify-row-name">{VERIFY_CHECK_LABELS[c.check]}</span>
                  <span className="pxw-verify-row-verdict" data-functional-label="">{CHECK_VERDICT_WORDS[c.verdict]}</span>
                </span>
                {c.reasons.map((reason, i) => <span className="pxw-verify-reason" key={i}>{reason}</span>)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="pxw-verify-meta" data-testid="card-verify-meta">Checked {timeAgo(v.createdAt)} by {thinkingModelName(v.judgeModel)} · {charge}</p>
    </div>
  );
}
