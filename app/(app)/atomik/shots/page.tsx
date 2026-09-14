"use client";

/**
 * Atomik · Shot list — from the pipeline handoff.
 *
 * The contract with Particl. Order, cast tags, setup and the cap go across;
 * state, takes, cost and the master link come back. The right half of
 * every row is Particl's. The two share one database, so "Send changes"
 * is the producer saying the list is what they mean: it clears the
 * edited-since-last-send tint and stamps the status line.
 */
import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { useOnChange } from "@/lib/changes";
import { usePageTitle } from "@/lib/usePageTitle";
import { usd, timeAgo, downloadHref } from "@/lib/format";
import { CATEGORIES } from "@/lib/studio";
import { appAlert } from "@/components/dialog";
import { Waiting } from "@/components/ParticlMark";
import PickProduction from "@/components/atomik/PickProduction";
import { takeCost } from "@/lib/breakdownCost";
import type { Shot } from "@/lib/shots";
import type { Treatment } from "@/lib/atomikDocs";
import { useMoney } from "@/lib/price";

type Row = Shot & { takes: number; ok: number; failed: number; spend: number; state: string; master: { id: string; version: number | null; url: string | null } | null };
type Proj = { id: string; name: string; spend: number; credits?: number; capUsd: number | null; capCredits?: number | null };
/** A shot's scene as a number: "SC01", "1" and "Scene 1" all mean scene 1. */
const sceneNo = (scene: string) => Number((scene ?? "").replace(/\D/g, "")) || 0;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const labelOf = (key: string, v: string | null | undefined) => {
  const cat = CATEGORIES.find((c) => c.key === key);
  return cat?.options.find((o) => o.value === v)?.label.toLowerCase() ?? null;
};

export default function ShotListPage() {
  usePageTitle("Atomik · Shot list");
  const { selection, current } = useProject();
  const scoped = selection !== "all" && selection !== "unfiled";
  if (!scoped) return <div className="ak-page"><PickProduction stage="Shot list" /></div>;
  return <ShotList key={selection} projectId={selection} name={current?.name ?? "Production"} />;
}

function ShotList({ projectId, name }: { projectId: string; name: string }) {
  const money = useMoney();
  const { signedIn, rates } = useSession();
  const { data: shotData, refresh } = useApi<{ shots: Row[] }>(signedIn ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 15_000);
  const { data: projects } = useApi<{ projects: Proj[] }>(signedIn ? "/api/projects" : null, 30_000);
  const { data: trt } = useApi<{ treatment: Treatment | null }>(signedIn ? `/api/atomik/treatment?projectId=${encodeURIComponent(projectId)}` : null, 0);
  useOnChange(refresh);
  const [sending, setSending] = useState(false);
  const shots = useMemo(() => shotData?.shots ?? [], [shotData]);
  const project = projects?.projects.find((p) => p.id === projectId) ?? null;

  const billable = shots.filter((s) => s.kind !== "type");
  const runtime = billable.reduce((a, s) => a + (s.planned ?? 0), 0);
  const estimate = billable.reduce((a, s) => a + takeCost(rates, s.planned), 0);
  const spent = shots.reduce((a, s) => a + s.spend, 0);
  const n = (st: string) => shots.filter((s) => s.state === st).length;
  const open = shots.filter((s) => !["approved", "picked", "type"].includes(s.state)).length;
  const takesPerApproval = n("approved") ? shots.filter((s) => s.state === "approved").reduce((a, s) => a + s.takes, 0) / n("approved") : null;
  const dirty = shots.filter((s) => s.dirty).length;
  const lastSync = Math.max(0, ...shots.map((s) => s.syncedAt ?? 0));

  async function send() {
    setSending(true);
    try {
      const res = await fetch("/api/shots/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      refresh();
    } catch (e) { await appAlert("Not sent", (e as Error).message); }
    finally { setSending(false); }
  }
  function exportCsv() {
    const rows = [["#", "shot", "scene", "cast", "size", "angle", "move", "lens", "planned_s", "estimate_usd", "state", "takes", "spent_usd", "master"],
      ...shots.map((s) => [s.code, s.description || s.title, s.scene, s.cast.join(" "), labelOf("shot", s.setup.shot) ?? "", labelOf("angle", s.setup.angle) ?? "", labelOf("move", s.setup.move) ?? "", labelOf("lens", s.setup.lens) ?? "",
        s.planned ?? "", s.kind === "type" ? 0 : takeCost(rates, s.planned).toFixed(2), s.state, s.takes, s.spend.toFixed(2), s.master?.url ?? ""])];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_shot_list.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  if (!signedIn) return <div className="ak-page"><PickProduction stage="Shot list" /></div>;
  if (!shotData) return <Waiting label="Opening the shot list" />;

  return (
    <div className="ak-page !gap-5">
      <div className="page-head">
        <div className="flex flex-col gap-2">
          <h1 className="ak-h1 !text-[30px]">Shot list</h1>
          <p className="ak-sub !max-w-[720px]">The contract with Particl. Order, cast tags, setup and the cap go across; state, takes, cost and the master link come back. The right half of every row is Particl&rsquo;s.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2 ak-cta is-list">
            <button type="button" className="btn-secondary" onClick={exportCsv} disabled={!shots.length}>Export CSV ↓</button>
            <button type="button" className="btn-primary" onClick={send} disabled={sending || !shots.length}>
              {sending ? "Sending…" : "Send changes to Particl"}
              <span className="ak-badge">{dirty} SHOT{dirty === 1 ? "" : "S"}</span>
            </button>
          </div>
          <span className={`ak-state ${lastSync ? "is-approved" : "is-muted"}`}>
            <span className={`dot dot-sm ${lastSync ? "dot-approved" : "dot-none"}`} />
            {lastSync ? `SYNCED ${timeAgo(lastSync).toUpperCase()} · BOTH WAYS` : "NOT SENT YET"}
          </span>
        </div>
      </div>

      <div className="ak-tiles">
        <div className="ak-tile"><span className="mono !tracking-[.14em] !text-[10px]">SHOTS · RUNTIME</span><span className="ak-tile-v">{shots.length} · {mmss(runtime)}</span></div>
        <div className="ak-tile"><span className="mono !tracking-[.14em] !text-[10px]">ESTIMATE · ONE TAKE EACH</span><span className="ak-tile-v">{money.inCredits ? money.approx(estimate) : usd(estimate, 2)}</span></div>
        <div className="ak-tile"><span className="mono !tracking-[.14em] !text-[10px]">SPENT · FROM PARTICL</span><span className="ak-tile-v">{project ? money.of(project) : usd(spent, 2)} <span className="text-[13px] font-normal text-dim">{money.inCredits ? (project?.capCredits ? `of ${project.capCredits.toLocaleString("en-US")} cr` : "no cap") : project?.capUsd ? `of $${Math.round(project.capUsd)}` : "no cap"}</span></span></div>
        <div className="ak-tile"><span className="mono !tracking-[.14em] !text-[10px]">APPROVED · PICKED · OPEN</span><span className="ak-tile-v">{n("approved")} · {n("picked")} · {open}</span></div>
        <div className="ak-tile"><span className="mono !tracking-[.14em] !text-[10px]">TAKES PER APPROVAL</span><span className="ak-tile-v">{takesPerApproval != null ? takesPerApproval.toFixed(1) : "—"}</span></div>
      </div>

      <div className="ak-table-wrap">
        <div className="ak-table">
          <div className="ak-tr is-head">
            <span>#</span><span>SHOT</span><span>CAST</span><span>SIZE · ANGLE · MOVE · LENS</span><span>PLAN</span><span>EST.</span><span></span><span>PARTICL STATE</span><span className="text-right">TAKES</span><span className="text-right">SPENT</span><span className="text-right">MASTER</span>
          </div>
          <div className="ak-tr is-head2">
            <span className="ak-span6">ATOMIK → GOES ACROSS</span><span></span><span className="ak-span4">← PARTICL WRITES BACK</span>
          </div>
          {shots.map((s) => {
            const st = s.kind === "type" ? "type" : s.state;
            const word = st === "approved" ? "Approved" : st === "picked" ? "Picked" : st === "draft" ? "Draft" : st === "rendering" ? "Rendering" : st === "type" ? "Type only" : "No take yet";
            const setup = [labelOf("shot", s.setup.shot), labelOf("angle", s.setup.angle), labelOf("move", s.setup.move), labelOf("lens", s.setup.lens)].filter(Boolean).join(" · ") || (st === "type" ? "Type only" : "—");
            const scene = trt?.treatment?.scenes.find((sc) => sc.n === sceneNo(s.scene));
            return (
              <div key={s.id} className={`ak-tr ${s.dirty ? "is-dirty" : ""}`}>
                <span className="mono-v !text-[11px]">{s.code}</span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="text-[13px] font-medium leading-[1.3]">{s.description || s.title || "Untitled shot"}</span>
                  <span className="ak-sub !text-[11px]">{s.scene ? `Scene ${s.scene}${scene?.title ? ` · ${scene.title}` : ""}` : "No scene"}{s.dirty ? " · edited since last send" : ""}</span>
                </span>
                <span className="flex flex-wrap gap-[3px]">{s.cast.map((c) => <span key={c} className="ak-tag !text-[10.5px]">@{c}</span>)}</span>
                <span className="text-[12px] leading-[1.35]">{setup}</span>
                <span className="mono-v !text-[11px]">{s.planned != null ? `${s.planned}s` : "—"}</span>
                <span className="mono-s !text-[11px] !font-medium">{st === "type" ? "$0" : usd(takeCost(rates, s.planned), 2)}</span>
                <span className="ak-vrule" />
                <span className={`ak-state !text-[12px] !tracking-normal !font-medium ${st === "approved" ? "is-approved" : st === "none" || st === "type" ? "is-muted" : "is-ink"}`}>
                  <span className={`dot ${st === "approved" ? "dot-approved" : st === "picked" ? "dot-picked" : st === "draft" ? "dot-draft" : st === "rendering" ? "dot-rendering" : "dot-none"}`} />
                  {word}
                </span>
                <span className="mono-v text-right !text-[11px]">{s.takes || "—"}</span>
                <span className="mono-v text-right !text-[11px]">{s.spend ? usd(s.spend, 2) : "—"}</span>
                <span className="text-right">
                  {s.master?.url
                    ? <a href={downloadHref(s.master.url)} download className="ak-master">V{s.master.version ?? 1} ↓</a>
                    : <span className="mono-s">—</span>}
                </span>
              </div>
            );
          })}
          {shots.length === 0 && <div className="p-4"><span className="ak-sub !text-[12.5px]">No shots yet — break the treatment down first.</span></div>}
          <div className="ak-table-foot">
            <span>A sent-back take returns its shot to <span className="font-medium text-ink">Draft</span> with the director&rsquo;s note attached. Type-only shots never generate and never cost.</span>
            <span className="mono-v !text-[10.5px]">{shots.length} SHOTS · {mmss(runtime)} · EST. {usd(estimate, 2)} · SPENT {usd(spent, 2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
