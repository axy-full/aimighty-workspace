"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import type { RunView, StageView, Fix } from "@/lib/runState";
import type { RecipeGraph } from "@/lib/runs";
import type { ProductionRow } from "@/lib/productions";
import type { Generation } from "@/lib/jobs";
import type { StepState } from "@/lib/ring";
import { Button, Mono, Chip, CapBar, Placeholder, PinnedBar } from "@/components/ui";
import { usePhone } from "@/lib/usePhone";
import { ToastHost, useToast } from "@/components/ui/Toast";
import Ring from "@/components/atomik/Ring";
import { PageLoader } from "@/components/atomik/Loader";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import LazyMedia from "@/components/LazyMedia";
import { RigBar, RigStrip, rigHrefs } from "@/components/rig/RigBar";

/**
 * Rig · Run + checkpoint (design/particl-v2/README.md §9; board 9b), value
 * for value.
 *
 * The sub-bar: the tabs, `Production › Project · Run 02 ▼`, `RECIPE · … ·
 * STARTED 14:02 · 3 OF 8 STEPS`, and `19 of 253 cr` over the 160×3 bar.
 * The 56px strip at `.3` with `CHECKPOINT · ⌘J`.
 *
 * The pinned checkpoint card: `--card`, 1px at .3, radius 14, `18px 20px`,
 * an `auto 1fr auto` grid 20 apart — the ring at 64 in its checkpoint
 * state; the eyebrow `ATOMIK · CHECKPOINT · STOPPED BEFORE STEP 04`, the
 * 20/1.2 headline, one paragraph at 13.5/1.45, `PLANNING · 3 CR · …`; and
 * the right column (280 wide): `Continue · keyframes · 24 CR` (46px, radius
 * 12) over `Change engine` / `Stop here` (40px, radius 10, .16).
 *
 * The stage track: equal cards 8 apart — `--card`, radius 12, 10px padding,
 * 8 apart inside: number, name, the state dot; the result area (2×2
 * thumbnails 16:10 as they arrive, a text-result placeholder for a writing
 * stage, a dashed 62px well for a queued one); `DONE / CHECKPOINT / QUEUED`
 * in mono at .1em (done accent, checkpoint ink, queued muted); engine and
 * cost (queued costs muted). The checkpoint stage carries the selection
 * ring. A failed stage reads `NEEDS YOU` and its priced fixes open in
 * place; the run never restarts.
 *
 * Below: `What just finished` (the project's newest takes six-up, `PICKED`
 * on the picked ones) and `What's next` (engine, per-unit cost, the next
 * checkpoint's price, the stage's settings as chips).
 *
 * Below 768 (design/particl-v2-mobile, board M6): the checkpoint card
 * first (`.3`, radius 14, `16px`: the ring at 48 beside `ATOMIK ·
 * CHECKPOINT · BEFORE STEP 04` and the 19px headline; the next step and
 * its price in one sentence; the planning line), then the steps as rows
 * (`22px 72px 1fr auto`, 10 apart, `10px 12px`, radius 12): number, the
 * 72×44 thumb (striped when done, dashed when queued), name over engine,
 * the state dot and word over the cost (queued costs muted); the
 * checkpoint row carries the selection ring. `Continue · keyframes · 24
 * CR` at 52px, then `Change engine` / `Stop here` at 44px, pinned. The
 * two cards below the track are desktop's.
 */
export default function RunPage() {
  return <ToastHost><Run /></ToastHost>;
}

const RING: Record<StageView["state"], StepState> = { done: "done", running: "running", queued: "queued", needs_you: "needsYou", skipped: "done" };
const two = (n: number) => String(n).padStart(2, "0");
/** `Keyframes` → `keyframes`, as the board writes a stage's name mid-sentence; an engine's name keeps its case. */
const lower = (name: string) => name.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

function Run() {
  const { runId } = useParams<{ runId: string }>();
  const search = useSearchParams();
  const { signedIn } = useSession();
  const money = useMoney();
  const toast = useToast();
  const atomik = useAtomik();
  const rail = useAtomikRail();
  const project = search.get("project");
  const url = runId === "latest" ? (project ? `/api/rig/runs/${encodeURIComponent(project)}?of=project` : null) : `/api/rig/runs/${encodeURIComponent(runId)}`;
  const { data, refresh } = useApi<{ run: RunView | null }>(signedIn ? url : null, 5_000);
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  const run = data?.run ?? null;
  const projectId = run?.projectId ?? project ?? null;
  const { data: recipeData } = useApi<{ recipe: RecipeGraph | null }>(projectId ? `/api/rig/recipe/${encodeURIComponent(projectId)}` : null, 0);
  const { data: latest } = useApi<{ generations: Generation[] }>(projectId ? `/api/jobs?projectId=${encodeURIComponent(projectId)}&limit=6&status=succeeded&sync=0` : null, 15_000);
  const production = prods?.productions.find((p) => p.projects.some((j) => j.id === projectId)) ?? null;
  const proj = production?.projects.find((j) => j.id === projectId) ?? null;
  usePageTitle(run ? `Run ${two(run.num)}` : "Run");
  const [busy, setBusy] = useState(false);
  const phone = usePhone();
  const fmt = (n: number) => money.price(n);

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to open the Rig.</div>;
  if (!data || !prods) return <PageLoader what="Opening · Run" />;
  const hrefs = rigHrefs(projectId ?? "", null, run?.id ?? null);

  if (!run) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <RigBar tab="run" hrefs={hrefs} chip={<>{production?.name ?? "Project"} <span className="text-ink-muted">›</span> {proj?.name ?? "deliverable"}</>} mono="no run yet" phoneTitle={proj?.name ?? "Run"} />
        <div className="grid min-h-0 flex-1 grid-cols-[56px_minmax(0,1fr)] max-md:grid-cols-1"><RigStrip /><div className="p-[24px] text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>Nothing has run here yet. Save a board as a recipe, then run it to the first checkpoint from Recipes.</div></div>
      </div>
    );
  }

  const stageAt = run.stages.find((s) => s.state === "needs_you") ?? run.stages.find((s) => s.state === "queued") ?? null;
  const checkpoint = run.state !== "done" ? stageAt : null;
  const lastDone = [...run.stages].reverse().find((s) => s.state === "done") ?? null;
  const next = run.stages.find((s) => s.state === "queued") ?? null;
  const after = next ? run.stages.find((s) => s.num > next.num) ?? null : null;
  const recipeStage = (s: StageView | null) => (s && recipeData?.recipe ? recipeData.recipe.stages.find((r) => r.id === s.id) ?? null : null);
  const nextDef = recipeStage(next);
  /** A stage's engine by its name, and its sub-line with the engine's id replaced by that name. */
  const engineOf = (s: StageView | null) => { const d = recipeStage(s); return d?.engine ? atomik.engineLabel(d.engine) : ""; };
  const subOf = (s: StageView) => { const d = recipeStage(s); return d?.engine ? s.sub.replace(d.engine, atomik.engineLabel(d.engine)) : s.sub; };
  const setState = async (state: "running" | "paused") => {
    setBusy(true);
    const r = await fetch(`/api/rig/runs/${run.id}/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
    setBusy(false); refresh();
    toast(r.ok ? (state === "running" ? `Run ${two(run.num)} continues` : "Stopped here · nothing more is charged") : "That didn't stick.");
  };
  const applyFix = async (stage: StageView, fix: Fix) => {
    setBusy(true);
    const r = await fetch(`/api/rig/runs/${run.id}/fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stageId: stage.id, fixId: fix.id }) });
    setBusy(false); refresh();
    toast(r.ok ? `${stage.name} · ${fix.label} · ${fmt(fix.credits)}` : "That fix didn't take.");
  };
  const ringSteps: StepState[] = run.stages.slice(0, 8).map((s) => (checkpoint && s.id === checkpoint.id ? "checkpoint" : RING[s.state]));
  const gens = latest?.generations ?? [];
  const picked = gens.filter((g) => g.reviewState === "picked" || g.reviewState === "approved").length;
  const bar = (
    <RigBar tab="run" hrefs={hrefs}
      chip={<>{production?.name ?? "Project"} <span className="text-ink-muted">›</span> {proj?.name ?? run.projectName} <span className="text-ink-muted">·</span> Run {two(run.num)}<span className="text-[9px] text-ink-muted">▼</span></>}
      mono={`Recipe · ${recipeData?.recipe?.name ?? run.projectName} · started ${new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${run.done} of ${run.total} steps`}
      phoneTitle={`Run ${two(run.num)}`} phoneMono={`${run.done} of ${run.total} steps · ${fmt(run.spent)} of ${fmt(run.estimate || run.spent)}`}
      right={<CapBar spent={run.spent} cap={run.estimate || run.spent || 1} placement="row" />} />
  );

  if (phone) return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      {bar}
      <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-auto px-[16px] pb-[10px] pt-[12px]">
        {checkpoint && (
          <div className="flex flex-col gap-[10px] rounded-mobile border border-[rgba(245,246,248,.3)] bg-card p-[16px]" aria-label="Checkpoint">
            <span className="flex items-center gap-[12px]">
              <Ring steps={ringSteps} size={48} />
              <span className="flex min-w-0 flex-col gap-[5px]">
                <Mono>Atomik · {checkpoint.state === "needs_you" ? "needs you" : "checkpoint"} · {checkpoint.state === "needs_you" ? `step ${two(checkpoint.num)} stopped` : `before step ${two(checkpoint.num)}`}</Mono>
                <span className="text-[19px] font-semibold leading-[1.2] text-ink">{lastDone ? `${lastDone.name} done · ${fmt(run.spent)} spent.` : "Ready."}</span>
              </span>
            </span>
            <span className="text-[14px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>
              {checkpoint.state === "needs_you" && checkpoint.failure ? `${checkpoint.failure.unit}: ${checkpoint.failure.reason} Pick a fix — each one is priced — and the run carries on from here.`
                : `Next: ${lower(checkpoint.name)}${engineOf(checkpoint) ? ` on ${engineOf(checkpoint)}` : ""} · ${fmt(checkpoint.credits)}. ${checkpoint.totalUnits ? `${checkpoint.totalUnits} units at ${fmt(checkpoint.credits / checkpoint.totalUnits)} each. ` : ""}Nothing runs until you say so.`}
            </span>
            <Mono>Planning · {fmt(atomik.totals.planning)}{atomik.chat?.model ? ` · ${atomik.engineLabel(atomik.chat.model)}` : ""}</Mono>
          </div>
        )}
        <div className="flex flex-col gap-[12px]" role="list" aria-label="Stages">
          {run.stages.map((s) => {
            const at = checkpoint?.id === s.id;
            const word = s.state === "done" ? "done" : at ? "checkpoint" : s.state === "needs_you" ? "needs you" : s.state === "running" ? "running" : s.state === "skipped" ? "skipped" : "queued";
            const tone = s.state === "done" ? "text-accent" : at || s.state === "needs_you" ? "text-ink" : "text-ink-muted";
            const dot = s.state === "done" ? "bg-accent" : s.state === "running" || at ? "border-2 border-accent" : s.state === "needs_you" ? "bg-ink" : "border-[1.5px] border-dashed border-ink-muted";
            const def = recipeStage(s);
            return (
              <div key={s.id} role="listitem" className={`grid grid-cols-[22px_72px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-card border bg-card px-[12px] py-[10px] ${at ? "border-ink ui-node-selected" : "border-border"}`}>
                <span className="ui-mono tracking-normal text-ink-muted">{two(s.num)}</span>
                <span className={`flex h-[44px] items-center justify-center rounded-[6px] border ${s.state === "done" ? (s.hasOutput ? "border-border ui-placeholder" : "border-border bg-ground") : "border-dashed border-[rgba(245,246,248,.16)]"}`}>
                  <span className="ui-mono tracking-normal text-ink-muted">{s.state === "done" ? (s.hasOutput ? `${s.doneUnits || s.totalUnits || ""}` : "txt") : "—"}</span>
                </span>
                <span className="flex min-w-0 flex-col gap-[4px]">
                  <span className="truncate text-[14px] font-medium leading-[1.2] text-ink">{s.name}</span>
                  <Mono className="truncate">{def?.engine ? atomik.engineLabel(def.engine) : subOf(s) || "—"}</Mono>
                  {s.state === "needs_you" && s.failure && !at && <span className="flex flex-wrap gap-[6px] pt-[2px]">{s.failure.fixes.map((f) => <Chip key={f.id} variant="filter" tone="ink" onClick={() => applyFix(s, f)}>{f.label} · {fmt(f.credits)}</Chip>)}</span>}
                </span>
                <span className="flex flex-col items-end gap-[5px]">
                  <span className={`flex items-center gap-[5px] whitespace-nowrap ui-mono !tracking-[.1em] ${tone}`}><span className={`box-border block h-[7px] w-[7px] rounded-full ${dot}`} />{word}</span>
                  <Mono cost tone={s.state === "queued" ? "muted" : "ink"}>{fmt(s.state === "done" ? s.spent : s.credits)}</Mono>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <PinnedBar className="flex-col">
        {checkpoint ? (
          checkpoint.state === "needs_you" && checkpoint.failure ? (
            checkpoint.failure.fixes.map((f, i) => (
              <button key={f.id} type="button" disabled={busy} onClick={() => applyFix(checkpoint, f)}
                className={`flex ${i === 0 ? "h-[52px]" : "h-[44px]"} w-full items-center justify-between rounded-mobile px-[16px] text-[15px] font-semibold leading-none ${i === 0 && !rail.open ? "bg-action text-on-action hover:bg-action-hover" : "border border-[rgba(245,246,248,.2)] text-ink-body"}`}>
                <span className="truncate">{f.label}</span><span className={`ui-mono ui-mono-cost !text-[12px] ${i === 0 && !rail.open ? "text-on-primary-cost" : "text-ink-muted"}`}>{fmt(f.credits)}</span>
              </button>
            ))
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => setState("running")} data-render=""
                className={`flex h-[52px] w-full items-center justify-between rounded-mobile px-[16px] text-[15px] font-semibold leading-none ${rail.open ? "border border-[rgba(245,246,248,.2)] text-ink-body" : "bg-action text-on-action hover:bg-action-hover"}`}>
                <span className="truncate">{busy ? "Continuing…" : `Continue · ${lower(checkpoint.name)}`}</span><span className={`ui-mono ui-mono-cost !text-[12px] ${rail.open ? "text-ink-muted" : "text-on-primary-cost"}`}>{fmt(checkpoint.credits)}</span>
              </button>
              <span className="flex gap-[8px]">
                <button type="button" onClick={() => { rail.compact(); toast("Change the engine in Atomik's sheet"); }} className="flex h-[44px] flex-1 items-center justify-center rounded-card border border-[rgba(245,246,248,.16)] text-[13.5px] font-medium leading-none text-ink">Change engine</button>
                <button type="button" onClick={() => setState("paused")} className="flex h-[44px] flex-1 items-center justify-center rounded-card border border-[rgba(245,246,248,.16)] text-[13.5px] font-medium leading-none text-ink-body">Stop here</button>
              </span>
            </>
          )
        ) : <Mono className="py-[16px] text-center">{run.state === "done" ? "Every step has run" : "Nothing to decide right now"}</Mono>}
      </PinnedBar>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      {bar}
      <div className="grid min-h-0 flex-1 grid-cols-[56px_minmax(0,1fr)] max-md:grid-cols-1">
        <RigStrip />
        <div className="flex min-h-0 flex-col gap-[18px] overflow-auto px-[24px] pb-[24px] pt-[20px] max-md:px-[16px]">
          {checkpoint && (
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[20px] rounded-mobile border border-[rgba(245,246,248,.3)] bg-card px-[20px] py-[18px] max-md:grid-cols-1" aria-label="Checkpoint">
              <Ring steps={ringSteps} size={64} />
              <span className="flex min-w-0 flex-col gap-[7px]">
                <Mono>Atomik · {checkpoint.state === "needs_you" ? "needs you" : "checkpoint"} · {checkpoint.state === "needs_you" ? `step ${two(checkpoint.num)} stopped` : `stopped before step ${two(checkpoint.num)}`}</Mono>
                <span className="text-[20px] font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
                  {lastDone ? `${lastDone.name} done · ${fmt(run.spent)} spent.` : "Ready."} {checkpoint.state === "needs_you" && checkpoint.failure ? `${checkpoint.failure.unit}: ${checkpoint.failure.reason}` : `Next: ${lower(checkpoint.name)}${engineOf(checkpoint) ? ` on ${engineOf(checkpoint)}` : ""} · ${fmt(checkpoint.credits)}.`}
                </span>
                <span className="text-[13.5px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>
                  {checkpoint.state === "needs_you" ? "A step stopped. Pick a fix — each one is priced — and the run carries on from here; it never restarts." : `${checkpoint.totalUnits ? `${checkpoint.totalUnits} units at ${fmt(checkpoint.totalUnits ? checkpoint.credits / checkpoint.totalUnits : checkpoint.credits)} each. ` : ""}Nothing runs until you say so.`}
                </span>
                <Mono>Planning · {fmt(atomik.totals.planning)}{atomik.chat?.model ? ` · ${atomik.engineLabel(atomik.chat.model)}` : ""}</Mono>
              </span>
              <span className="flex min-w-[280px] flex-col gap-[8px] max-md:min-w-0">
                {checkpoint.state === "needs_you" && checkpoint.failure ? (
                  checkpoint.failure.fixes.map((f, i) => <Button key={f.id} variant={i === 0 ? "primary" : "secondary"} placement="rail" cost={f.credits} busy={busy} busyLabel="Applying…" onClick={() => applyFix(checkpoint, f)}>{f.label}</Button>)
                ) : (
                  <>
                    <Button variant="primary" placement="rail" cost={checkpoint.credits} busy={busy} busyLabel="Continuing…" outlined={rail.open} onClick={() => setState("running")}>Continue · {lower(checkpoint.name)}</Button>
                    <span className="flex gap-[8px]">
                      <button type="button" onClick={() => { rail.compact(); toast("Change the engine in Atomik's rail"); }} className="flex h-[40px] flex-1 items-center justify-center rounded-tile border border-[rgba(245,246,248,.16)] text-[13px] font-medium leading-none text-ink">Change engine</button>
                      <button type="button" onClick={() => setState("paused")} className="flex h-[40px] flex-1 items-center justify-center rounded-tile border border-[rgba(245,246,248,.16)] text-[13px] font-medium leading-none text-ink-body">Stop here</button>
                    </span>
                  </>
                )}
              </span>
            </div>
          )}
          <div className="flex flex-col gap-[10px]">
            <Mono>The run · {run.total} paid steps · thumbnails arrive as they finish</Mono>
            <div className="grid gap-[8px] max-md:grid-cols-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, run.stages.length)}, minmax(0, 1fr))` }} role="list" aria-label="Stages">
              {run.stages.map((s) => {
                const at = checkpoint?.id === s.id;
                const word = s.state === "done" ? "done" : at ? "checkpoint" : s.state === "needs_you" ? "needs you" : s.state === "running" ? "running" : s.state === "skipped" ? "skipped" : "queued";
                const tone = s.state === "done" ? "text-accent" : at || s.state === "needs_you" ? "text-ink" : "text-ink-muted";
                const def = recipeStage(s);
                return (
                  <div key={s.id} role="listitem" className={`flex flex-col gap-[8px] rounded-card border bg-card p-[10px] ${at ? "border-ink ui-node-selected" : "border-border"}`}>
                    <span className="flex items-center gap-[6px]">
                      <span className="ui-mono !tracking-[.1em] text-ink-muted">{two(s.num)}</span>
                      <span className="truncate text-[13px] font-semibold leading-[1.1] text-ink">{s.name}</span>
                      <span className={`ml-auto box-border block h-[8px] w-[8px] flex-none rounded-full ${s.state === "done" ? "bg-accent" : s.state === "running" || at ? "border-2 border-accent" : s.state === "needs_you" ? "bg-ink" : "border-[1.5px] border-dashed border-ink-muted"}`} />
                    </span>
                    {s.hasOutput ? (
                      <span className="grid grid-cols-2 gap-[4px]">{[0, 1, 2, 3].map((k) => <Placeholder key={k} ratio="16/10" className="rounded-badge border border-[rgba(245,246,248,.1)]" />)}</span>
                    ) : s.state === "done" ? (
                      <span className="box-border flex h-[62px] flex-col gap-[5px] rounded-[6px] border border-border bg-ground px-[8px] py-[7px]">{[80, 62, 70].map((w) => <span key={w} className="h-[6px] rounded-[3px] bg-[rgba(245,246,248,.2)]" style={{ width: `${w}%` }} />)}</span>
                    ) : (
                      <span className="h-[62px] rounded-[6px] border border-dashed border-[rgba(245,246,248,.16)]" />
                    )}
                    <span className="flex flex-col gap-[4px]">
                      <span className={`ui-mono !tracking-[.1em] ${tone}`}>{word}</span>
                      <span className="flex justify-between ui-mono ui-mono-cost text-ink-muted"><span className="truncate">{def?.engine ? atomik.engineLabel(def.engine) : subOf(s) || "—"}</span><span className={`ml-[6px] flex-none ${s.state === "queued" ? "" : "text-ink"}`}>{fmt(s.state === "done" ? s.spent : s.credits)}</span></span>
                    </span>
                    {s.state === "needs_you" && s.failure && !at && (
                      <span className="flex flex-col gap-[6px]">{s.failure.fixes.map((f) => <Chip key={f.id} variant="filter" tone="ink" onClick={() => applyFix(s, f)}>{f.label} · {fmt(f.credits)}</Chip>)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-[12px] max-md:grid-cols-1">
            <div className="flex flex-col gap-[10px] rounded-card border border-border bg-card px-[16px] py-[14px]">
              <span className="flex items-baseline justify-between gap-[12px]"><span className="text-[14px] font-semibold leading-none text-ink">What just finished{lastDone ? ` · ${lastDone.name}` : ""}</span><Mono className="truncate">{lastDone ? `${lastDone.doneUnits || gens.length} ${lastDone.hasOutput ? "panels" : "units"} · ${fmt(lastDone.spent)}${picked ? ` · ${picked} picked by Atomik, change any` : ""}` : "nothing yet"}</Mono></span>
              {lastDone?.hasOutput && gens.length ? (
                <div className="grid grid-cols-6 gap-[8px] max-md:grid-cols-3">
                  {gens.slice(0, 6).map((g, k) => (
                    <span key={g.id} className="flex flex-col gap-[5px]">
                      <span className={`relative box-border aspect-video overflow-hidden rounded-[6px] border ui-placeholder ${g.reviewState === "picked" || g.reviewState === "approved" ? "border-2 border-ink" : "border-[rgba(245,246,248,.1)]"}`}>
                        {(g.storedUrl ?? g.sourceUrl) && <LazyMedia url={(g.storedUrl ?? g.sourceUrl)!} kind={g.kind === "video" ? "video" : "image"} className="absolute inset-0 h-full w-full object-cover" />}
                        {(g.reviewState === "picked" || g.reviewState === "approved") && <span className="absolute right-[4px] top-[4px] rounded-[3px] bg-ink px-[4px] py-[3px] ui-mono !text-[9.5px] !tracking-[.06em] text-ground">Picked</span>}
                      </span>
                      <Mono cost className="truncate">{g.shotCode ? `${g.shotCode} · ${String.fromCharCode(65 + (k % 2))}` : `Take · ${k + 1}`}</Mono>
                    </span>
                  ))}
                </div>
              ) : <span className="text-[13px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>{lastDone ? "A writing step: its result is in the project." : "The first step has not finished."}</span>}
            </div>
            <div className="flex flex-col gap-[10px] rounded-card border border-border bg-card px-[16px] py-[14px]">
              <span className="flex items-baseline justify-between gap-[12px]"><span className="text-[14px] font-semibold leading-none text-ink">What&rsquo;s next{next ? ` · ${next.name}` : ""}</span><Mono className="truncate">{next ? `${nextDef?.engine ? atomik.engineLabel(nextDef.engine) : subOf(next) || "—"}${next.totalUnits ? ` · ${next.totalUnits} × ${fmt(next.credits / next.totalUnits)}` : ""}` : "done"}</Mono></span>
              <span className="text-[13px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>{next ? `${next.sub ? `${subOf(next)}. ` : ""}${after ? `After it, the next checkpoint is ${lower(after.name)} at ${fmt(after.credits)}.` : "It is the last step."}` : "Every step has run."}</span>
              {next && (nextDef || recipeData?.recipe?.locked.length) ? (
                <span className="flex flex-wrap gap-[6px]">
                  {Object.entries(nextDef?.params ?? {}).filter(([k, v]) => k !== "units" && k !== "credits" && (typeof v === "string" || typeof v === "number")).map(([k, v]) => <span key={k} className="rounded-pill border border-[rgba(245,246,248,.12)] px-[10px] py-[7px] text-[12px] font-medium leading-none text-ink">{String(v)}</span>)}
                  {next.totalUnits > 0 && <span className="rounded-pill border border-[rgba(245,246,248,.12)] px-[10px] py-[7px] text-[12px] font-medium leading-none text-ink">×{next.totalUnits}</span>}
                  {(recipeData?.recipe?.locked ?? []).map((l) => <span key={l.id} className="rounded-pill border border-[rgba(245,246,248,.12)] px-[10px] py-[7px] text-[12px] font-medium leading-none text-ink-body">{l.name}</span>)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
