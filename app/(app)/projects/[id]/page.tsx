"use client";

/**
 * R1 — the project overview.
 *
 * A project is the unit the business thinks in, so this is the page that
 * answers "what did this job cost us": total generations, credit and dollars,
 * who worked on it, how many takes each shot needed, and how much machine
 * time it burned. The shot list doubles as the place shots are created, so
 * the numbers on the dashboard have something to count.
 */
import { use, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { usd, hours, pct, timeAgo } from "@/lib/format";
import { type Analytics, Headline, BarList, ShotTable, Patterns } from "@/components/Analytics";
import { appPrompt, appAlert } from "@/components/dialog";
import { Waiting } from "@/components/ParticlMark";
import { usePageTitle } from "@/lib/usePageTitle";

type Project = { id: string; name: string; description: string; code?: string; category?: string };
type ShotRow = {
  id: string; code: string; scene: string; title: string; status: string;
  takes: number; ok: number; failed: number; spend: number;
};

export default function ProjectOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data } = useApi<Analytics>(`/api/analytics?projectId=${encodeURIComponent(id)}`, 30000);
  const { data: projects, refresh: refreshProjects } =
    useApi<{ projects: Project[] }>("/api/projects", 60000);
  const { data: shotData, refresh: refreshShots } =
    useApi<{ shots: ShotRow[] }>(`/api/shots?projectId=${encodeURIComponent(id)}`, 30000);
  const [busy, setBusy] = useState(false);

  const project = projects?.projects.find((p) => p.id === id);

  async function addShot() {
    if (busy) return;
    const code = await appPrompt("Shot code", "", "SH010 — blank numbers it for you");
    if (code === null) return;
    const scene = await appPrompt("Scene", "", "SC04 (optional)");
    if (scene === null) return;
    const title = await appPrompt("What is the shot?", "", "Rooftop wide (optional)");
    if (title === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/shots", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id, code, scene, title }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add the shot");
      refreshShots();
    } catch (e) {
      await appAlert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setCode() {
    const code = await appPrompt("Project code", project?.code ?? "", "NKA26");
    if (code === null) return;
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) await appAlert("Could not save the code");
    else refreshProjects();
  }

  async function setCategory() {
    const category = await appPrompt("Category", project?.category ?? "",
      "TVC · music video · social · title sequence");
    if (category === null) return;
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    if (!res.ok) await appAlert("Could not save the category");
    else refreshProjects();
  }

  usePageTitle(project?.name ?? "Project");
  if (!data) return <Waiting label="Reading the project" />;

  const t = data.totals;
  const shots = shotData?.shots ?? [];

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px] pb-10">
        <Link href="/projects" className="mt-6 inline-block text-[14px] text-blue">← Projects</Link>
        <Headline a={data} title={project?.name ?? "Project"} />

        {project?.description && (
          <p className="mt-4 max-w-[70ch] text-[15px] text-dim">{project.description}</p>
        )}

        <p className="mt-3 text-[14px] text-mute">
          Code{" "}
          <button onClick={setCode} className="font-mono text-blue">
            {project?.code || "set one"}
          </button>{" "}
          — the short form that appears in filenames. Category{" "}
          <button onClick={setCategory} className="text-blue">
            {project?.category || "set one"}
          </button>{" "}
          — how this job is grouped on the production dashboard.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/" className="chip bg-blue text-white">Open in Generate</Link>
          <Link href={`/canvas/${id}`} className="chip">Canvas</Link>
          <Link href="/all" className="chip">Library</Link>
          <Link href="/dashboard" className="chip">Production dashboard</Link>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="card px-5 py-5">
            <div className="flex items-center gap-3">
              <p className="grouplabel">Shots</p>
              <button onClick={addShot} disabled={busy}
                className="ml-auto text-[14px] text-blue disabled:opacity-50">+ Add shot</button>
            </div>
            <p className="mt-1 text-[13px] text-mute">
              Every render filed against a shot becomes a numbered version of it.
            </p>
            <div className="mt-4">
              <ShotTable rows={shots.map((s) => ({
                id: s.id, code: s.code, scene: s.scene, title: s.title, status: s.status,
                takes: s.takes, spend: s.spend, ok: s.ok, failed: s.failed, latest: 0,
              }))} />
            </div>
          </section>

          <div className="flex flex-col gap-6">
            <section className="card px-5 py-5">
              <p className="grouplabel">Who worked on it</p>
              <div className="mt-4">
                <BarList empty="No renders yet."
                  rows={data.byPerson.map((p) => ({
                    key: p.id || p.name, label: p.name, value: p.spend,
                    note: `${p.n} render${p.n === 1 ? "" : "s"}`,
                  }))} />
              </div>
            </section>

            <section className="card px-5 py-5">
              <p className="grouplabel">By model</p>
              <div className="mt-4">
                <BarList empty="No renders yet."
                  rows={data.byModel.map((m) => ({
                    key: m.model, label: m.label, value: m.spend, note: `${m.n}`,
                  }))} />
              </div>
            </section>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="card px-5 py-5">
            <p className="grouplabel">How this project was made</p>
            <div className="mt-4"><Patterns a={data} /></div>
          </section>

          <section className="card px-5 py-5">
            <p className="grouplabel">Cost of this project</p>
            <div className="rows mt-4">
              <div className="row"><span>Generations</span>
                <span className="row-value tabular-nums">{t.generations}</span></div>
              <div className="row"><span>Delivered</span>
                <span className="row-value tabular-nums">{t.succeeded} ({pct(t.successRate)})</span></div>
              <div className="row"><span>Failed</span>
                <span className="row-value tabular-nums">{t.failed}</span></div>
              <div className="row"><span>Render time</span>
                <span className="row-value tabular-nums">{hours(t.renderMs)}</span></div>
              <div className="row"><span>Renders</span>
                <span className="row-value tabular-nums">{usd(t.spend - t.promptSpend, 2)}</span></div>
              <div className="row">
                <span className="flex flex-col">
                  Prompt writing
                  <span className="text-[12px] text-mute">
                    {t.prompts} prompt{t.prompts === 1 ? "" : "s"} finished by the writer
                  </span>
                </span>
                <span className="row-value tabular-nums">{usd(t.promptSpend, 3)}</span></div>
              <div className="row"><span className="font-medium">Total cost</span>
                <span className="row-value font-semibold tabular-nums !text-bone">{usd(t.spend, 2)}</span></div>
            </div>
            <p className="mt-4 text-[13px] text-mute">
              All-in: the render plus what the prompt writer charged. Binned takes still
              count — money spent is money spent.
              {data.byDay.length > 0 && (
                <> Last activity {timeAgo(data.byDay[data.byDay.length - 1].day)}.</>
              )}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
