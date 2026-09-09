"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { fmtCredits } from "@/lib/price";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import {
  STATE_WORD, spentPct, remainingLine, holdingLine,
  primaryFor, progressLine, progressPct, costLabel, chosenFix,
  type RunView as Run, type StageView, type Choice,
} from "@/lib/runState";

/**
 * Watching a run, and fixing a stopped stage in place (brief 3, surface 1a).
 *
 * The primary screen of the whole layer, and it is a phone screen. Everything
 * on it exists to answer two questions a producer has while a production is
 * running: what has this cost so far, and is anything waiting on me.
 *
 * The design's fourth rule is the one that shapes it. A failure never
 * restarts a run. So a stage that stopped does not offer "retry" — it opens
 * in place with the real reason and the priced ways out, and the run carries
 * on from there. The sentence under the cost card exists for the same reason:
 * the question a producer actually has is not what broke, it is whether the
 * rest is lost.
 */
export default function RunView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data, error, refresh } = useApi<{ run: Run | null }>(
    `/api/rig/runs/${encodeURIComponent(projectId)}?of=project`, 5_000);

  /* A stage AND a fix. A bare fix id would resolve against whichever stage
     stopped first, and the design's fix ids are generic words that collide
     across stages, so a tap on one card could price and spend on another. */
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <Trouble label="This run didn't load" />;
  if (!data) return <Waiting />;
  const run = data.run;
  if (!run) {
    return (
      <Empty
        title="No run yet"
        line="A recipe run shows every stage of this production, what each one costs, and anything waiting on you."
      />
    );
  }

  /* Resolved against the run as it is NOW, so a choice made before the poll
     moved on simply stops resolving rather than quietly meaning something
     else. */
  const picked = chosenFix(run.stages, chosen);
  const primary = primaryFor(run, picked?.fix ?? null);
  const holding = holdingLine(run.stages);

  async function press() {
    if (!picked || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/rig/runs/${encodeURIComponent(run!.id)}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: picked.stage.id, fixId: picked.fix.id }),
      });
      if (res.ok) { setChosen(null); await refresh(); }
    } finally { setBusy(false); }
  }

  async function pause() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/rig/runs/${encodeURIComponent(run!.id)}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: run!.state === "paused" ? "running" : "paused" }),
      });
      await refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="rig-run">
      <header className="rig-run-head">
        <button className="rig-icon" onClick={() => router.back()} aria-label="Back">←</button>
        <span className="rig-run-title">
          <span className="rig-run-name">Run {String(run.num).padStart(2, "0")}</span>
          <span className="rig-run-meta">
            {[run.projectName.toUpperCase(), run.startedAt ? `STARTED ${clock(run.startedAt)}` : ""]
              .filter(Boolean).join(" · ")}
          </span>
        </span>
      </header>

      <div className="rig-run-body">
        <section className="rig-cost">
          <span className="rig-eyebrow">SPENT OF RUN ESTIMATE</span>
          {/* Credits, and only credits. The reference shows the dollar
              equivalent beside them; the brief says the product speaks
              credits everywhere but the top-up screen, and the brief wins. */}
          <div className="rig-cost-figures">
            <span className="rig-cost-big">{run.spent}</span>
            <span className="rig-cost-of">of {run.estimate} credits</span>
          </div>
          <div className="rig-bar"><i style={{ width: `${spentPct(run.spent, run.estimate)}%` }} /></div>
          <div className="rig-cost-line">
            <span>{run.done} of {run.total} stages complete</span>
            <span>{remainingLine(run.stages)}</span>
          </div>
        </section>

        {holding ? (
          <p className="rig-holding"><i /> {holding}</p>
        ) : null}

        {run.stages.map((s) => (
          <Stage
            key={s.id} stage={s}
            chosen={chosen?.stageId === s.id ? chosen.fixId : null}
            onChoose={(fixId) => setChosen({ stageId: s.id, fixId })}
          />
        ))}

        <p className="rig-foot-note">
          Stages price themselves per shot. A stage only runs on what is still in front of it, so
          an estimate falls as work is approved or skipped.
        </p>
      </div>

      <div className="rig-run-bar">
        <button className="rig-secondary" onClick={pause} disabled={busy || run.state === "done"}>
          {run.state === "paused" ? "Resume" : "Pause"}
        </button>
        <button className="rig-primary" onClick={press} disabled={!primary.enabled || busy}>
          <span>{primary.label}</span>
          <span className="rig-primary-cost">{fmtCredits(primary.credits)}</span>
        </button>
      </div>
    </div>
  );
}

/* One stage card. A stopped one opens in place; nothing else does. */
function Stage({ stage, chosen, onChoose }: {
  stage: StageView;
  chosen: string | null;
  onChoose: (fixId: string) => void;
}) {
  const running = stage.state === "running";
  const failed = stage.state === "needs_you" && stage.failure !== null;
  const line = progressLine(stage);

  return (
    <section className={`rig-stage${failed ? " is-attention" : ""}`}>
      <div className="rig-stage-top">
        <span className={`rig-well${stage.hasOutput ? " has-output" : ""}`}>{stage.hasOutput ? "" : "—"}</span>
        <span className="rig-stage-names">
          <span className="rig-stage-name">{stage.name}</span>
          {stage.sub ? <span className="rig-stage-sub">{stage.sub}</span> : null}
        </span>
        <span className="rig-stage-right">
          <span className={`rig-state is-${stage.state}`}>
            <i /> {STATE_WORD[stage.state]}
          </span>
          <span className="rig-stage-cost">{costLabel(stage, fmtCredits)}</span>
        </span>
      </div>

      {running && line ? (
        <div className="rig-progress">
          <div className="rig-bar is-accent"><i style={{ width: `${progressPct(stage)}%` }} /></div>
          <div className="rig-progress-line"><span>{line.toUpperCase()}</span></div>
        </div>
      ) : null}

      {failed && stage.failure ? (
        <div className="rig-fixes">
          <p className="rig-reason">{stage.failure.reason}</p>
          <div className="rig-fix-list" role="radiogroup" aria-label={`Ways past ${stage.name}`}>
            {stage.failure.fixes.map((f) => (
              <button
                key={f.id} type="button" role="radio" aria-checked={chosen === f.id}
                className={`rig-fix${chosen === f.id ? " is-on" : ""}`}
                onClick={() => onChoose(f.id)}
              >
                <span className="rig-mark" />
                <span className="rig-fix-words">
                  <span className="rig-fix-label">{f.label}</span>
                  <span className="rig-fix-note">{f.note}</span>
                </span>
                <span className="rig-fix-cost">{fmtCredits(f.credits)}</span>
              </button>
            ))}
          </div>
          <span className="rig-fixed-note">FIXED IN PLACE · THE RUN CONTINUES FROM HERE</span>
        </div>
      ) : null}

      {stage.fixedWith ? (
        <span className="rig-fixed-note">GOT PAST WITH · {stage.fixedWith.toUpperCase()}</span>
      ) : null}
    </section>
  );
}

/** The hour a run started, in the reader's own clock. */
function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return ""; }
}
