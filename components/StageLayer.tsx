"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtCredits } from "@/lib/price";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import { STATE_WORD, type StageState } from "@/lib/runState";
import {
  layout, wiresOf, bandLayout, extent, dropPath, shapeLine,
  NODE_W, type Placed,
} from "@/lib/graph";

import type { RecipeGraph, RecipeStage, LockedElement } from "@/lib/runs";

/**
 * The recipe as an editable stage graph (brief 3, surface 1d).
 *
 * A desktop screen, and the first one in Rig that is. The handoff draws its
 * example at fixed coordinates; this lays a real recipe out from its own
 * shape, so a wire never points backwards and a branch falls below the line
 * it left rather than being placed by hand.
 *
 * The graph is a view, not the only way to edit — that is the brief's fifth
 * step, and the chat column it names is deliberately not here yet. What is
 * here is the recipe as it stands, the run painted onto it, and an inspector
 * that answers the two questions a stage raises: what feeds it, and what it
 * will cost.
 */
export default function StageLayer({ projectId }: { projectId: string }) {
  const { data, error, refresh } = useApi<{ recipe: RecipeGraph | null }>(
    `/api/rig/recipe/${encodeURIComponent(projectId)}`, 10_000);
  const [picked, setPicked] = useState<string | null>(null);

  const graph = data?.recipe ?? null;
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /* Writing the recipe is what makes this surface exist at all. Everything
     below it — the graph, the wires, the inspector — has always worked and
     has never had a row to draw. */
  async function makeRecipe() {
    setMaking(true); setFailed(null);
    try {
      const res = await fetch(`/api/rig/recipe/${encodeURIComponent(projectId)}`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `The server answered ${res.status}.`);
      refresh();
    } catch (e) { setFailed((e as Error).message); }
    finally { setMaking(false); }
  }
  const placed = useMemo(() => (graph ? layout(graph.stages) : []), [graph]);
  const band = useMemo(() => bandLayout(graph?.locked.length ?? 0), [graph]);
  const wires = useMemo(() => wiresOf(placed), [placed]);
  const size = useMemo(() => extent(placed, band), [placed, band]);

  if (error) return <Trouble label="The recipe didn't load" />;
  if (!data) return <Waiting />;
  if (!graph) {
    return (
      <div className="screen grid place-items-center">
        <div className="flex max-w-[46ch] flex-col items-center gap-4 text-center">
          <Empty
            title="No recipe yet"
            line="A recipe is the production written down as stages — brief, scene, shot list, keyframes, motion, post, audio, assembly."
          />
          {/* Writing one costs nothing and renders nothing: it is the shape of
              the production, not a run of it. The stages arrive queued, which
              is what they are. */}
          <button type="button" className="btn-primary" onClick={makeRecipe} disabled={making}>
            {making ? "Writing…" : "Write the recipe"}
          </button>
          {failed && <span className="text-[13px] text-lift">{failed}</span>}
        </div>
      </div>
    );
  }

  const at = new Map(placed.map((p) => [p.id, p]));
  const lockAt = new Map(graph.locked.map((l, i) => [l.id, band[i]]));

  /* What the inspector is showing: whatever was clicked, else the stage that
     wants a person, else the one that is working, else the first. */
  const shown =
    graph.stages.find((s) => s.id === picked)
    ?? graph.locked.find((l) => l.id === picked)
    ?? graph.stages.find((s) => s.state === "needs_you")
    ?? graph.stages.find((s) => s.state === "running")
    ?? graph.stages[0]
    ?? null;
  const isLock = shown !== null && "lockedBy" in shown;

  /* The dashed drops: every element a stage pins, from the band down onto it. */
  const drops = graph.stages.flatMap((s) =>
    s.locks.map((id) => {
      const from = lockAt.get(id);
      const to = at.get(s.id);
      return from && to ? { key: `${id}:${s.id}`, d: dropPath(from, to) } : null;
    }).filter(Boolean) as { key: string; d: string }[]);

  return (
    <div className="stg">
      <div className="stg-bar">
        <span className="stg-shape">{shapeLine(placed, graph.locked.length)}</span>
        <span className="stg-recipe">{graph.name}</span>
      </div>

      <div className="stg-graph">
        <div className="stg-canvas" style={{ width: size.w, height: size.h }}>
          <svg className="stg-wires" width={size.w} height={size.h} aria-hidden="true">
            {wires.map((w) => (
              <path key={`${w.from}:${w.to}`} d={w.d} className="stg-wire" />
            ))}
            {drops.map((d) => (
              <path key={d.key} d={d.d} className="stg-wire is-drop" />
            ))}
          </svg>

          {graph.locked.map((l, i) => (
            <button
              key={l.id} type="button"
              className={`stg-node is-locked${shown?.id === l.id ? " is-on" : ""}`}
              style={{ left: band[i].x, top: band[i].y, width: NODE_W }}
              onClick={() => setPicked(l.id)}
            >
              <span className="stg-node-top">
                <span className="stg-node-num">LK</span>
                <span className="stg-lock" aria-label="locked">◆</span>
              </span>
              <span className="stg-node-name">{l.name}</span>
              <span className="stg-node-engine">{l.kind}</span>
            </button>
          ))}

          {placed.map((p) => {
            const stage = graph.stages.find((s) => s.id === p.id)!;
            return <Node key={p.id} p={p} stage={stage} on={shown?.id === p.id} onPick={() => setPicked(p.id)} />;
          })}
        </div>
      </div>

      <aside className="stg-inspector">
        {shown ? (
          isLock
            ? <LockPanel el={shown as LockedElement} />
            : <StagePanel stage={shown as RecipeStage} stages={graph.stages} locked={graph.locked} />
        ) : null}
      </aside>
    </div>
  );
}

/* A stage node. 126 wide, per the handoff: number and state, name, engine,
   then a footer carrying what feeds it and what it costs. */
function Node({ p, stage, on, onPick }: { p: Placed; stage: RecipeStage; on: boolean; onPick: () => void }) {
  const attention = stage.state === "needs_you";
  return (
    <button
      type="button"
      className={`stg-node${on ? " is-on" : ""}${attention ? " is-attention" : ""}`}
      style={{ left: p.x, top: p.y, width: NODE_W }}
      onClick={onPick}
      aria-current={on ? "true" : undefined}
    >
      <span className="stg-node-top">
        <span className="stg-node-num">{String(stage.num).padStart(2, "0")}</span>
        <span className={`stg-dot is-${stage.state}`} />
      </span>
      <span className="stg-node-name">{stage.name}</span>
      <span className="stg-node-engine">{stage.engine || "no engine"}</span>
      <span className="stg-node-foot">
        <span>{stage.totalUnits ? `${stage.totalUnits}` : "—"}</span>
        <span className="stg-node-cost">{stage.credits ? fmtCredits(stage.credits) : "—"}</span>
      </span>
    </button>
  );
}

function StagePanel({ stage, stages, locked }: { stage: RecipeStage; stages: RecipeStage[]; locked: LockedElement[] }) {
  const pins = locked.filter((l) => stage.locks.includes(l.id));
  /* A stage is named, never keyed. An id in the inspector is an internal
     name shown to somebody who has no way to read it. */
  const feeds = stage.inputs
    .map((id) => stages.find((x) => x.id === id))
    .filter(Boolean) as RecipeStage[];
  const params = Object.entries(stage.params).filter(([, v]) => typeof v === "string" && v).slice(0, 8);
  return (
    <div className="stg-panel">
      <span className="stg-eyebrow">INSPECTOR · STAGE {String(stage.num).padStart(2, "0")}</span>
      <h2 className="stg-panel-name">{stage.name}</h2>
      <p className="stg-panel-said">{blurb(stage)}</p>

      <div className="stg-row"><i>Engine</i>{stage.engine || "none"}</div>
      <div className="stg-row"><i>State</i>{STATE_WORD[stage.state]}</div>
      {stage.totalUnits ? <div className="stg-row"><i>Runs on</i>{stage.totalUnits} shot{stage.totalUnits === 1 ? "" : "s"}</div> : null}

      <span className="stg-label">INPUTS</span>
      <div className="stg-inputs">
        {feeds.length === 0 && pins.length === 0 ? <span className="stg-none">Nothing feeds this stage. It starts the recipe.</span> : null}
        {feeds.map((f) => (
          <span key={f.id} className="stg-input">{f.name}<em>{String(f.num).padStart(2, "0")}</em></span>
        ))}
        {/* A pinned element reads as locked, because that is what it is. */}
        {pins.map((l) => (
          <span key={l.id} className="stg-input is-locked"><i />{l.name}<em>locked</em></span>
        ))}
      </div>

      {params.length ? (
        <>
          <span className="stg-label">PARAMETERS</span>
          <div className="stg-chips">
            {params.map(([k, v]) => <span key={k} className="stg-chip">{String(v)}</span>)}
          </div>
        </>
      ) : null}

      <div className="stg-estimate">
        <span className="stg-estimate-big">{stage.credits ? fmtCredits(stage.credits) : "0 cr"}</span>
        <span className="stg-estimate-math">{estimateLine(stage)}</span>
      </div>
    </div>
  );
}

/* Selecting something pinned says what it is and what unlocking would mean,
   because that is the only decision the band offers. */
function LockPanel({ el }: { el: LockedElement }) {
  return (
    <div className="stg-panel">
      <span className="stg-eyebrow">LOCKED FOR THIS RECIPE</span>
      <h2 className="stg-panel-name">{el.name}</h2>
      <p className="stg-panel-said">
        {el.lockedBy ? `Locked by ${el.lockedBy}` : "Locked"}
        {el.lockedAt ? ` on ${new Date(el.lockedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}.
        {" "}Unlocking lets any stage in this recipe swap the version, and every take made after that
        stops matching the ones before it.
      </p>
      <div className="stg-row"><i>Kind</i>{el.kind}</div>
    </div>
  );
}

/** A plain sentence about what the stage is for, from what it is. */
function blurb(s: RecipeStage): string {
  if (s.kind === "write") return "Words, not pictures. Everything downstream inherits what this settles.";
  if (s.kind === "assemble") return "Approved takes in shot order. Nothing here calls an engine.";
  return s.totalUnits
    ? `Runs once per shot — ${s.totalUnits} of them — and is priced that way.`
    : "Runs once per shot, and is priced that way.";
}

/** The maths under the estimate, in the same shape the run view uses. */
function estimateLine(s: RecipeStage): string {
  if (!s.credits) return "NOTHING ESTIMATED YET";
  if (!s.totalUnits) return `${s.credits} CR FOR THIS STAGE`;
  const done = s.doneUnits;
  const left = Math.max(0, s.totalUnits - done);
  return `${done} OF ${s.totalUnits} DONE · ${left} LEFT`;
}

export type { StageState };
