"use client";

/**
 * Atomik · Breakdown — from the pipeline handoff.
 *
 * The treatment's scenes, each broken into shots. A scene card on the left
 * stays put while its shots scroll on the right: the shot's description,
 * its planned seconds, four setup chips, its cast tags, and what one take
 * of it will cost. Runtime is the sum of planned durations, and a scene
 * whose shots run longer than the scene shows it in grey.
 *
 * Shots written here ARE the production's shots — the same rows the shot
 * list sends across and Particl files takes against.
 */
import ModelMenu, { type PlannerModel } from "@/components/atomik/ModelMenu";
import { EffortPicker } from "@/components/atomik/ModelPicker";
import {usePaidAction} from "@/lib/usePaidAction";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { useOnChange } from "@/lib/changes";
import { usePageTitle } from "@/lib/usePageTitle";
import { usd } from "@/lib/format";
import { specToPhrase, CATEGORIES } from "@/lib/studio";
import { takeCost } from "@/lib/breakdownCost";
import QuotedAtomikAction from "@/components/atomik/QuotedAtomikAction";
import type { PaidTextQuote } from "@/lib/paidText";
import { mentionsIn } from "@/lib/mentions";
import { appAlert, appConfirm } from "@/components/dialog";
import { Waiting } from "@/components/ParticlMark";
import PickProduction from "@/components/atomik/PickProduction";
import type { Treatment, Scene } from "@/lib/atomikDocs";
import type { CastMember } from "@/lib/cast";
import type { Shot } from "@/lib/shots";
import { ENGINE_LABEL, type ShotProposal as BaseShotProposal } from "@/lib/shotBuilder";
type ShotProposal = BaseShotProposal & { takeUsd?: number };
import { useMoney } from "@/lib/price";

type Loaded = { treatment: Treatment | null; cast: CastMember[] };
/** A shot's scene as a number: "SC01", "1" and "Scene 1" all mean scene 1. */
const sceneNo = (scene: string) => Number((scene ?? "").replace(/\D/g, "")) || 0;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const SETUP = ["shot", "angle", "move", "lens"];

export default function BreakdownPage() {
  usePageTitle("Atomik · Breakdown");
  const { selection, current } = useProject();
  const scoped = selection !== "all" && selection !== "unfiled";
  if (!scoped) return <div className="ak-page"><PickProduction stage="Breakdown" /></div>;
  return <Breakdown key={selection} projectId={selection} runtimeTarget={current?.runtimeTarget ?? null} />;
}

function Breakdown({ projectId, runtimeTarget }: { projectId: string; runtimeTarget: number | null }) {
  const router = useRouter();
  const paid=usePaidAction(`/api/atomik/shots/draft:${projectId}`);
  const money = useMoney();
  const { signedIn, rates } = useSession();
  const { data: modelIndex } = useApi<{ models: { featured: PlannerModel[]; rest: PlannerModel[] } }>(signedIn ? "/api/atomik" : null, 0);
  const models = modelIndex?.models ?? { featured: [], rest: [] };
  const [selectedModel, setSelectedModel] = useState("auto");
  const [selectedEffort, setSelectedEffort] = useState("auto");
  const pendingInput = paid.pending ? JSON.parse(paid.pending.body) : null;
  const model = pendingInput?.model ?? (paid.pending ? "auto" : selectedModel);
  const effort = pendingInput?.effort ?? (paid.pending ? "auto" : selectedEffort);
  const { data } = useApi<Loaded>(signedIn ? `/api/atomik/treatment?projectId=${encodeURIComponent(projectId)}` : null, 0);
  const { data: shotData, refresh } = useApi<{ shots: Shot[] }>(signedIn ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 15_000);
  useOnChange(refresh);
  const shots = useMemo(() => shotData?.shots ?? [], [shotData]);
  const castNames = useMemo(() => (data?.cast ?? []).map((c) => c.name), [data]);
  const scenes: Scene[] = data?.treatment?.scenes ?? [];

  const inScene = (n: number) => shots.filter((s) => sceneNo(s.scene) === n);
  const unplaced = shots.filter((s) => !scenes.some((sc) => sc.n === sceneNo(s.scene)));
  const billable = shots.filter((s) => s.kind !== "type");
  const runtime = billable.reduce((a, s) => a + (s.planned ?? 0), 0);
  const target = runtimeTarget ?? scenes.reduce((a, s) => a + s.secs, 0);
  const estimate = billable.reduce((a, s) => a + takeCost(rates, s.planned, s.engine), 0);

  async function patch(s: Shot, body: Record<string, unknown>) {
    const res = await fetch(`/api/shots/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { await appAlert("Not saved", `The server answered ${res.status}.`); return; }
    refresh();
  }
  async function add(scene: Scene | null) {
    const res = await fetch("/api/shots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, scene: scene ? String(scene.n) : "", title: "", description: "",
        planned: 3, setup: data?.treatment?.setup ?? {}, cast: scene ? mentionsIn(scene.prose, castNames) : [],
      }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await appAlert("No shot added", j.error ?? `The server answered ${res.status}.`); return; }
    refresh();
  }
  /* The shot builder (brief 1.8): a scene's shots proposed with every row filled, cast tagged, an engine and its credits each — added one by one, never over what is here. */
  const [drafting, setDrafting] = useState<number | null>(null);
  const [proposals, setProposals] = useState<{ scene: number; shots: ShotProposal[]; sceneUsd: number; model: string; costUsd: number } | null>(null);
  async function draftShots(currentScene: Scene, quote?: PaidTextQuote) {
    if (!paid.pending && !quote) return;
    const pending=paid.pending?JSON.parse(paid.pending.body):null;
    const scene=pending?scenes.find(item=>item.n===pending.scene):currentScene;if(!scene)return;
    setDrafting(scene.n); setProposals(null);
    try {
      const {data:j}=await paid.run<{shots:ShotProposal[];sceneUsd?:number;model:string;costUsd?:number}>("/api/atomik/shots/draft",pending ?? {projectId,scene:scene.n,model:quote!.model,effort,maxCredits:quote!.estimateCredits});
      setProposals({ scene: scene.n, shots: j.shots as ShotProposal[], sceneUsd: Number(j.sceneUsd ?? 0), model: String(j.model), costUsd: Number(j.costUsd ?? 0) });
    } catch (e) { await appAlert("No shots drafted", (e as Error).message); }
    finally { setDrafting(null); }
  }
  async function addProposal(scene: number, p: ShotProposal) {
    const res = await fetch("/api/shots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      projectId, scene: String(scene), title: p.title, description: p.description, planned: p.planned, setup: { ...(data?.treatment?.setup ?? {}), ...p.setup }, cast: p.cast, engine: p.engine,
    }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await appAlert("No shot added", j.error ?? `The server answered ${res.status}.`); return; }
    setProposals((cur) => (cur ? { ...cur, shots: cur.shots.filter((x) => x !== p) } : cur));
    refresh();
  }
  async function remove(s: Shot) {
    if (!(await appConfirm(`Remove ${s.code}?`, "Takes filed against it stay in All takes, unfiled.", { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/shots/${s.id}`, { method: "DELETE" });
    refresh();
  }

  if (!signedIn) return <div className="ak-page"><PickProduction stage="Breakdown" /></div>;
  if (!data || !shotData) return <Waiting label="Opening the breakdown" />;

  return (
    <>
      <div className="ak-bar">
        {(paid.error||paid.pending)&&<p role={paid.error?"alert":"status"} className="ak-sub">{paid.error||"A shot draft awaits confirmation. Recover it from that scene."}</p>}
        <span className="text-[14px] font-semibold">Breakdown</span>
        <span className="mono-s">{shots.length} SHOT{shots.length === 1 ? "" : "S"} · {mmss(runtime)} OF {mmss(target)} · EST. {usd(estimate, 2)} AT ONE TAKE EACH</span>
        <div className="cv-bar !h-1.5 w-[220px]">
          {scenes.map((sc) => <span key={sc.n} className={inScene(sc.n).filter((s) => s.kind !== "type").reduce((a, s) => a + (s.planned ?? 0), 0) > sc.secs ? "is-over" : "is-picked"} style={{ flex: Math.max(1, sc.secs) }} />)}
        </div>
        <span className="ak-sub !text-[12px]">Runtime is the sum of planned durations. Seedance bills 5s minimum, so every shot estimates at {money.price(takeCost(rates, 5))}.</span>
        <div className="ml-auto ak-cta is-bar"><button type="button" className="btn-primary" onClick={() => router.push("/atomik/shots")}>Build the shot list →</button></div>
      </div>

      <div className="ak-page !pt-7">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono !text-[10px]">SHOT PLANNER</span>
          <ModelMenu value={model} models={models} onPick={(value) => { setSelectedModel(value); setSelectedEffort("auto"); }} disabled={drafting !== null || !!paid.pending} />
          <EffortPicker value={effort} model={[...models.featured, ...models.rest].find((item) => item.id === model)} onPick={setSelectedEffort} disabled={drafting !== null || !!paid.pending} compact />
        </div>
        {scenes.length === 0 && (
          <div className="ak-pick">
            <span className="ak-h2">No scenes yet</span>
            <span className="ak-sub">Write the treatment first — its scenes are what the breakdown fits shots into.</span>
            <button type="button" className="btn-secondary self-start" onClick={() => router.push("/atomik/treatment")}>Open the treatment →</button>
          </div>
        )}
        {scenes.map((sc) => {
          const list = inScene(sc.n);
          const planned = list.filter((s) => s.kind !== "type").reduce((a, s) => a + (s.planned ?? 0), 0);
          const sceneCast = mentionsIn(sc.prose, castNames);
          return (
            <div key={sc.n} className="ak-bd-row">
              <div className="ak-bd-scene">
                <div className="flex items-baseline justify-between">
                  <span className="mono !tracking-[.12em] !text-[10.5px]">SCENE {sc.n}</span>
                  <span className={`mono-v !text-[11px] ${planned > sc.secs ? "!text-faint" : ""}`}>{mmss(planned)} / {mmss(sc.secs)}</span>
                </div>
                <span className="text-[18px] font-semibold leading-[1.2] tracking-[-0.01em]">{sc.title || "Untitled"}</span>
                <p className="ak-sub m-0 !text-[13px]">{sc.prose.slice(0, 160)}{sc.prose.length > 160 ? "…" : ""}</p>
                <div className="flex flex-wrap gap-1">{sceneCast.map((c) => <span key={c} className="ak-tag">@{c}</span>)}</div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-dashed self-start !px-2.5 !py-1.5" onClick={() => add(sc)}>+ Shot in this scene</button>
                  <QuotedAtomikAction url="/api/atomik/shots/draft" body={{ projectId, scene: sc.n, model, effort, documentVersion: data?.treatment?.updatedAt }} label="Draft shots" className="btn-dashed self-start !px-2.5 !py-1.5" busy={drafting === sc.n} pending={!!paid.pending && pendingInput.scene === sc.n} disabled={drafting !== null || !!paid.error || (!!paid.pending && pendingInput.scene !== sc.n)} onRun={(quote) => draftShots(sc, quote)} />
                </div>
                {proposals && proposals.scene === sc.n && (
                  <div className="ak-proposal">
                    <span className="mono-s">PROPOSED BY {proposals.model.split("/").pop()} · {proposals.shots.length} SHOT{proposals.shots.length === 1 ? "" : "S"} · SCENE {money.inCredits ? money.approx(proposals.sceneUsd) : `≈ ${usd(proposals.sceneUsd, 2)}`} AT ONE TAKE EACH · WRITING {money.price(proposals.costUsd, "text")}</span>
                    {proposals.shots.map((p, i) => (
                      <div key={`${sc.n}-${i}`} className="ak-prop-shot">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-medium">{p.title || "Untitled"}</span>
                          <span className="mono-s">{p.planned}s · {ENGINE_LABEL[p.engine]} · {money.price(p.takeUsd ?? takeCost(rates, p.planned, p.engine))}</span>
                          {p.cast.length > 0 && <span className="mono-s">{p.cast.map((c) => `@${c}`).join(" ")}</span>}
                        </div>
                        <p className="text-[13px] leading-relaxed text-dim">{p.description}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] text-mute">{specToPhrase(p.setup) || "no rows set"} · {p.why}</span>
                          <button type="button" className="chip ml-auto" onClick={() => addProposal(sc.n, p)}>Add</button>
                        </div>
                      </div>
                    ))}
                    <div><button type="button" className="chip" onClick={() => setProposals(null)}>Close</button></div>
                  </div>
                )}
              </div>
              <div className="ak-bd-shots">
                {list.map((s) => <ShotCard key={s.id} shot={s} castNames={castNames} onPatch={(b) => patch(s, b)} onRemove={() => remove(s)} />)}
                {list.length === 0 && <span className="ak-sub self-center !text-[12.5px]">No shots in this scene yet.</span>}
              </div>
            </div>
          );
        })}
        {unplaced.length > 0 && (
          <div className="ak-bd-row">
            <div className="ak-bd-scene">
              <span className="mono !tracking-[.12em] !text-[10.5px]">NO SCENE</span>
              <span className="text-[18px] font-semibold leading-[1.2]">Unplaced</span>
              <p className="ak-sub m-0 !text-[13px]">Shots made in Particl before the treatment had scenes. Give each a scene number to place it.</p>
            </div>
            <div className="ak-bd-shots">
              {unplaced.map((s) => <ShotCard key={s.id} shot={s} castNames={castNames} scenes={scenes} onPatch={(b) => patch(s, b)} onRemove={() => remove(s)} />)}
            </div>
          </div>
        )}
        {scenes.length > 0 && <button type="button" className="btn-dashed self-start !px-3 !py-2" onClick={() => add(null)}>+ Shot without a scene</button>}
      </div>
    </>
  );
}

/** One shot: board, id, seconds, description, four setup chips, cast, cost. */
function ShotCard({ shot, castNames, scenes, onPatch, onRemove }: {
  shot: Shot; castNames: string[]; scenes?: Scene[]; onPatch: (b: Record<string, unknown>) => void; onRemove: () => void;
}) {
  /* Its own hooks rather than props: a card is rendered in a list and the
     session is the same for every one of them. */
  const money = useMoney();
  const { rates } = useSession();
  const priceOf = (planned: number | null) => money.price(takeCost(rates, planned));
  const [desc, setDesc] = useState(shot.description);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The patch waiting on the timer, so unmounting sends it instead of
     dropping the last keystrokes. */
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const flush = pending.current; pending.current = null;
    flush?.();
  }, []);
  const cast = [...new Set([...shot.cast, ...mentionsIn(desc, castNames)])];
  const type = shot.kind === "type";
  return (
    <div className="ak-shot">
      <div className="ak-shot-board">
        board · {shot.code}
        <span className="ak-shot-id">{shot.code}</span>
        <label className="ak-shot-secs">
          <select value={shot.planned ?? 3} onChange={(e) => onPatch({ planned: Number(e.target.value) })} aria-label="Planned seconds">
            {[1, 2, 3, 4, 5, 6, 8, 10, 12, 15].map((n) => <option key={n} value={n}>{n}s</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-2.5 p-[12px_14px_13px]">
        <textarea className="ak-shot-desc" rows={2} value={desc} placeholder="What the shot is — subject, action, @cast."
          onChange={(e) => {
            setDesc(e.target.value);
            if (timer.current) clearTimeout(timer.current);
            const v = e.target.value;
            pending.current = () => onPatch({ description: v, cast: [...new Set([...shot.cast, ...mentionsIn(v, castNames)])] });
            timer.current = setTimeout(() => { const f = pending.current; pending.current = null; f?.(); }, 800);
          }} />
        <div className="flex flex-wrap gap-1">
          {SETUP.map((k) => {
            const cat = CATEGORIES.find((c) => c.key === k)!;
            return (
              <label key={k} className="ak-tag is-line !py-[3px] !pr-1.5">
                <select value={shot.setup[k] ?? ""} onChange={(e) => onPatch({ setup: { ...shot.setup, [k]: e.target.value } })} aria-label={cat.label} className="ak-tag-select">
                  <option value="">{cat.label}</option>
                  {cat.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select><span className="text-[8px] text-dim">▼</span>
              </label>
            );
          })}
          {scenes && (
            <label className="ak-tag is-line !py-[3px]">
              <select value={shot.scene} onChange={(e) => onPatch({ scene: e.target.value })} aria-label="Scene" className="ak-tag-select">
                <option value="">Scene…</option>
                {scenes.map((sc) => <option key={sc.n} value={String(sc.n)}>Scene {sc.n}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-hair pt-2.5">
          <span className="flex flex-wrap gap-1">{cast.map((c) => <span key={c} className="ak-tag">@{c}</span>)}</span>
          <span className="flex items-center gap-2.5">
            <button type="button" className="ak-act is-muted" onClick={() => onPatch({ kind: type ? "render" : "type" })} title={type ? "Type only — click to make it a rendered shot" : "Renders — click to make it type only, which never renders and never costs"}>{type ? "TYPE ONLY" : "RENDERS"}</button>
            <button type="button" className="ak-act is-muted" onClick={onRemove} title="Remove">×</button>
            <span className="mono-s !font-medium">{type ? "0" : priceOf(shot.planned)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
