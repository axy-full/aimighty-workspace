"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useIsMobile } from "@/lib/useMobile";
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
  /* Desktop is the shape and the phone is the floor (brief rule 7, revised).
     On a wide screen the run is a list beside the one stage being looked at,
     which is the app's own two-pane idiom; on a phone the same stage opens in
     place, because there is nowhere to put a rail. */
  const mobile = useIsMobile();
  const { data, error, refresh } = useApi<{ run: Run | null }>(
    `/api/rig/runs/${encodeURIComponent(projectId)}?of=project`, 5_000);

  /* A stage AND a fix. A bare fix id would resolve against whichever stage
     stopped first, and the design's fix ids are generic words that collide
     across stages, so a tap on one card could price and spend on another. */
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

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

  /* What the rail is showing: whatever was clicked, else the thing that wants
     a person, else the thing that is working, else the top of the run. */
  const shown = run.stages.find((s) => s.id === opened)
    ?? run.stages.find((s) => s.state === "needs_you")
    ?? run.stages.find((s) => s.state === "running")
    ?? run.stages[0]
    ?? null;

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
    <div className={`rig-run${mobile ? "" : " is-wide"}`}>
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
            /* The fixes open in the card only on a phone. On a wide screen
               they live in the rail, where there is room for the reason to
               read as a sentence rather than a caption. */
            inline={mobile}
            selected={!mobile && shown?.id === s.id}
            onOpen={() => setOpened(s.id)}
            chosen={chosen?.stageId === s.id ? chosen.fixId : null}
            onChoose={(fixId) => setChosen({ stageId: s.id, fixId })}
          />
        ))}

        <p className="rig-foot-note">
          Stages price themselves per shot. A stage only runs on what is still in front of it, so
          an estimate falls as work is approved or skipped.
        </p>
      </div>

      {!mobile && shown ? (
        <aside className="rig-rail">
          <div className="rig-rail-body">
            <span className="rig-eyebrow">STAGE {String(shown.num).padStart(2, "0")}</span>
            <h2 className="rig-rail-name">{shown.name}</h2>
            {shown.sub ? <span className="rig-rail-sub">{shown.sub}</span> : null}

            <span className={`rig-well is-big${shown.hasOutput ? " has-output" : ""}`}>
              {shown.hasOutput ? "" : "—"}
            </span>

            <div className="rig-rail-facts">
              <span><i>State</i>{STATE_WORD[shown.state]}</span>
              <span><i>Cost</i>{costLabel(shown, fmtCredits)}</span>
              {shown.totalUnits ? <span><i>Progress</i>{progressLine(shown) || "—"}</span> : null}
              {shown.fixedWith ? <span><i>Got past with</i>{shown.fixedWith}</span> : null}
            </div>

            {shown.state === "needs_you" && shown.failure ? (
              <div className="rig-fixes">
                <p className="rig-reason">{shown.failure.reason}</p>
                <div className="rig-fix-list" role="radiogroup" aria-label={`Ways past ${shown.name}`}>
                  {shown.failure.fixes.map((f) => (
                    <button
                      key={f.id} type="button" role="radio"
                      aria-checked={chosen?.stageId === shown.id && chosen.fixId === f.id}
                      className={`rig-fix${chosen?.stageId === shown.id && chosen.fixId === f.id ? " is-on" : ""}`}
                      onClick={() => setChosen({ stageId: shown.id, fixId: f.id })}
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
          </div>
        </aside>
      ) : null}

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

/* One stage card. On a phone a stopped one opens in place; on a wide screen
   it is a row that puts itself in the rail. */
function Stage({ stage, chosen, onChoose, inline, selected, onOpen }: {
  stage: StageView;
  chosen: string | null;
  onChoose: (fixId: string) => void;
  inline: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const running = stage.state === "running";
  const failed = stage.state === "needs_you" && stage.failure !== null;
  const line = progressLine(stage);

  return (
    <section
      className={`rig-stage${failed ? " is-attention" : ""}${selected ? " is-open" : ""}${inline ? "" : " is-row"}`}
      onClick={inline ? undefined : onOpen}
      aria-current={selected ? "true" : undefined}
    >
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

      {inline && failed && stage.failure ? (
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
