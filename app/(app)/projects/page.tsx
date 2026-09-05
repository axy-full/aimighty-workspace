"use client";

/**
 * Projects — the productions, as a table. From the pipeline handoff.
 *
 * A production exists once, in both rooms: its words live in Atomik, its
 * renders live here. This page is the studio's list of them, and it reads
 * like a production board rather than a shelf of covers — stage, shots
 * approved over total, spend against cap, who is on it, what happened
 * last. Every number is the API's; the bars are the same numbers drawn.
 *
 * A row opens the production's Canvas. Right-click keeps rename, paste and
 * delete, the way it does everywhere.
 */
import Link from "next/link";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { usd, timeAgo } from "@/lib/format";
import { appPrompt, appAlert } from "@/components/dialog";
import LazyMedia from "@/components/LazyMedia";
import { Empty, Waiting } from "@/components/ParticlMark";
import type { Gen } from "@/components/GenCard";
import { usePageTitle } from "@/lib/usePageTitle";

type Row = {
  id: string; name: string; code: string; category: string; description: string; createdAt: number;
  genCount: number; spend: number; capUsd: number | null; kind: string | null; runtimeTarget: number | null;
  stage: string | null; live: number; shots: number; approvedShots: number; pickedShots: number;
  team: string[]; last: { at: number; who: string | null; what: string } | null;
};
type Stage = "Rendering" | "In review" | "Delivered" | "Brief only";

/** The stage the production is at, from what has happened to it. */
function stageOf(p: Row): Stage {
  const set = p.stage as Stage | null;
  if (set && ["Rendering", "In review", "Delivered", "Brief only"].includes(set)) return set;
  if (p.live > 0) return "Rendering";
  if (p.genCount === 0) return "Brief only";
  if (p.shots > 0 && p.approvedShots >= p.shots) return "Delivered";
  return "In review";
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function ProjectsPage() {
  usePageTitle("Projects");
  const router = useRouter();
  const { signedIn } = useSession();
  const { setSelection, refreshProjects } = useProject();
  const { data, refresh } = useApi<{ projects: Row[] }>(signedIn ? "/api/projects" : null, 30_000);
  const { data: month } = useApi<{ spentUsd: number }>(signedIn ? "/api/usage/summary" : null, 60_000);
  // One cheap page of recent renders supplies every thumbnail, newest first.
  const { data: recent } = useApi<{ generations: Gen[] }>(signedIn ? "/api/jobs?limit=60&sync=0" : null, 30_000);

  const coverFor = useMemo(() => {
    const map = new Map<string, Gen>();
    for (const g of recent?.generations ?? []) {
      if (g.status !== "succeeded" || !g.storedUrl) continue;
      const key = g.projectId ?? "unfiled";
      if (!map.has(key)) map.set(key, g);
    }
    return map;
  }, [recent]);

  const projects = data?.projects ?? [];
  const unfiled = recent?.generations.filter((g) => !g.projectId).length ?? 0;
  const totalShots = projects.reduce((a, p) => a + p.shots, 0);

  async function create() {
    const name = await appPrompt("New project", "", "Project name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { appAlert("Couldn't create the project", json.error); return; }
    refresh(); refreshProjects();
    setSelection(json.id);
    router.push(`/projects/${json.id}/canvas`);
  }

  return (
    <div className="page">
      <div className="page-inner flex flex-col gap-[22px]">
        <div className="page-head">
          <div>
            <h1 className="page-h1">Projects</h1>
            <p className="page-sub">A production exists once, in both rooms. Its words live in Atomik; its renders live here.</p>
          </div>
          <div className="page-acts">
            <Link href="/all" className="btn-secondary !h-[38px] !px-3.5 !text-[13px]">Browse every render →</Link>
            <button type="button" onClick={create} disabled={!signedIn} className="btn-primary !px-4"
              title={signedIn ? undefined : "Sign in to start a production"}>New project</button>
          </div>
        </div>

        {!signedIn ? (
          <Empty title="Productions are for the team"
            line="Sign in to see the studio's productions — their stage, their shots, what they have cost so far. Everything else on this screen is yours to look at." />
        ) : !data ? (
          <Waiting label="Reading the productions" />
        ) : projects.length === 0 ? (
          <Empty title="No productions yet" line="The first one is a good place to put a test render. Everything made inside it stays with it." />
        ) : (
          <div className="ptable-wrap">
            <div className="ptable">
              <div className="ptable-head">
                <span>Production</span><span>Stage</span><span>Shots · approved / total</span>
                <span>Spend / cap</span><span>Team</span><span>Last activity</span>
              </div>
              {projects.map((p) => {
                const stage = stageOf(p);
                const cover = coverFor.get(p.id);
                const approvedPct = p.shots ? Math.round((p.approvedShots / p.shots) * 100) : 0;
                const spendPct = p.capUsd ? Math.min(100, Math.round((p.spend / p.capUsd) * 100)) : 0;
                const sub = [p.kind || p.category || "production", p.runtimeTarget ? mmss(p.runtimeTarget) : `${p.genCount} render${p.genCount === 1 ? "" : "s"}`].join(" · ");
                return (
                  <Link key={p.id} href={`/projects/${p.id}/canvas`} className="ptable-row"
                    onClick={() => setSelection(p.id)}
                    data-project-target={p.id} data-project-name={p.name} data-project-count={p.genCount}>
                    <span className="ptable-name">
                      <span className="ptable-thumb" aria-hidden="true">
                        {cover?.storedUrl
                          ? <LazyMedia url={cover.storedUrl} kind={cover.kind === "image" ? "image" : "video"} alt="" />
                          : (p.code || p.name).toUpperCase().slice(0, 9)}
                      </span>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="ptable-title">{p.name}</span>
                        <span className="ptable-sub">{sub}</span>
                      </span>
                    </span>
                    <span className="ptable-stage">
                      <span className={`dot ${stage === "Rendering" ? "dot-picked" : stage === "In review" ? "dot-draft" : stage === "Delivered" ? "dot-approved" : "dot-none"}`} />
                      {stage}
                    </span>
                    <span className="ptable-stat">
                      <span className="ptable-stat-l"><span>{p.approvedShots} / {p.shots}</span><span>{p.pickedShots} picked</span></span>
                      <span className="ptable-bar is-approved"><span style={{ width: `${approvedPct}%` }} /></span>
                    </span>
                    <span className="ptable-stat">
                      <span className="ptable-stat-l"><span>{usd(p.spend, 2)}</span><span>{p.capUsd ? `of $${Math.round(p.capUsd)}` : "no cap"}</span></span>
                      <span className="ptable-bar"><span style={{ width: `${spendPct}%` }} /></span>
                    </span>
                    <span className="ptable-team" title={p.team.join(", ") || "Nobody has rendered here yet"}>
                      {p.team.slice(0, 5).map((n) => <span key={n} className="ptable-av">{initials(n)}</span>)}
                      {p.team.length === 0 && <span className="ptable-av">—</span>}
                    </span>
                    <span className="ptable-last">
                      <span>{p.last ? `${timeAgo(p.last.at)} · ${p.last.who ? `${initials(p.last.who)} ` : ""}${p.last.what}` : `${day(p.createdAt)} · created`}</span>
                      <span className="mono-s">{p.code ? `${p.code.toUpperCase()} · ` : ""}MADE IN PARTICL</span>
                    </span>
                  </Link>
                );
              })}
              <div className="ptable-foot">
                <span>
                  Projects are private to the studio team. Cast added inside a project stays with that production; cast added in All projects is available everywhere.
                  {unfiled > 0 && <> <Link href="/all" className="text-ink underline-offset-2 hover:underline">{unfiled} render{unfiled === 1 ? " sits" : "s sit"} outside any production →</Link></>}
                </span>
                <span className="mono-v whitespace-nowrap">
                  {projects.length} PRODUCTION{projects.length === 1 ? "" : "S"} · {totalShots} SHOT{totalShots === 1 ? "" : "S"} · {month ? usd(month.spentUsd, 2) : "—"} THIS MONTH
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
