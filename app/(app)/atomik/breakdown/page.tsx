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
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { useOnChange } from "@/lib/changes";
import { usePageTitle } from "@/lib/usePageTitle";
import { usd } from "@/lib/format";
import { CATEGORIES } from "@/lib/studio";
import { DEFAULT_MODEL_ID, estimateCostUsd } from "@/lib/models";
import { mentionsIn } from "@/lib/mentions";
import { appAlert, appConfirm } from "@/components/dialog";
import { Waiting } from "@/components/ParticlMark";
import PickProduction from "@/components/atomik/PickProduction";
import type { Treatment, Scene } from "@/lib/atomikDocs";
import type { CastMember } from "@/lib/cast";
import type { Shot } from "@/lib/shots";

type Loaded = { treatment: Treatment | null; cast: CastMember[] };
/** A shot's scene as a number: "SC01", "1" and "Scene 1" all mean scene 1. */
const sceneNo = (scene: string) => Number((scene ?? "").replace(/\D/g, "")) || 0;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const SETUP = ["shot", "angle", "move", "lens"];
/** One take of a shot: Seedance bills 5s minimum, so shorter shots price at 5s. */
export function takeCost(planned: number | null): number {
  return estimateCostUsd(DEFAULT_MODEL_ID, "1080p", "16:9", Math.max(5, planned ?? 5))?.net ?? 0;
}

export default function BreakdownPage() {
  usePageTitle("Atomik · Breakdown");
  const { selection, current } = useProject();
  const scoped = selection !== "all" && selection !== "unfiled";
  if (!scoped) return <div className="ak-page"><PickProduction stage="Breakdown" /></div>;
  return <Breakdown key={selection} projectId={selection} runtimeTarget={current?.runtimeTarget ?? null} />;
}

function Breakdown({ projectId, runtimeTarget }: { projectId: string; runtimeTarget: number | null }) {
  const router = useRouter();
  const { signedIn } = useSession();
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
  const estimate = billable.reduce((a, s) => a + takeCost(s.planned), 0);

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
  async function remove(s: Shot) {
    if (!(await appConfirm(`Remove ${s.code}?`, "Takes filed against it stay in the library, unfiled.", { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/shots/${s.id}`, { method: "DELETE" });
    refresh();
  }

  if (!signedIn) return <div className="ak-page"><PickProduction stage="Breakdown" /></div>;
  if (!data || !shotData) return <Waiting label="Opening the breakdown" />;

  return (
    <>
      <div className="ak-bar">
        <span className="text-[14px] font-semibold">Breakdown</span>
        <span className="mono-s">{shots.length} SHOT{shots.length === 1 ? "" : "S"} · {mmss(runtime)} OF {mmss(target)} · EST. {usd(estimate, 2)} AT ONE TAKE EACH</span>
        <div className="cv-bar !h-1.5 w-[220px]">
          {scenes.map((sc) => <span key={sc.n} className={inScene(sc.n).filter((s) => s.kind !== "type").reduce((a, s) => a + (s.planned ?? 0), 0) > sc.secs ? "is-over" : "is-picked"} style={{ flex: Math.max(1, sc.secs) }} />)}
        </div>
        <span className="ak-sub !text-[12px]">Runtime is the sum of planned durations. Seedance bills 5s minimum, so every shot estimates at {usd(takeCost(5), 2)}.</span>
        <div className="ml-auto ak-cta is-bar"><button type="button" className="btn-primary" onClick={() => router.push("/atomik/shots")}>Build the shot list →</button></div>
      </div>

      <div className="ak-page !pt-7">
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
                <button type="button" className="btn-dashed self-start !px-2.5 !py-1.5" onClick={() => add(sc)}>+ Shot in this scene</button>
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
            <span className="mono-s !font-medium">{type ? "$0" : usd(takeCost(shot.planned), 2)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
