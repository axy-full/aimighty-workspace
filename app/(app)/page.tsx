"use client";

import Link from "next/link";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { usd } from "@/lib/format";
import { appPrompt, appAlert } from "@/components/dialog";
import LazyMedia from "@/components/LazyMedia";
import type { Gen } from "@/components/GenCard";
import { IconSearch, IconPlus } from "@/components/Icons";

/**
 * The way in. Projects are shown as work, not as rows in a menu — each one
 * wearing its most recent render, so the shelf is recognisable at a glance.
 */
export default function ProjectsPage() {
  const [q, setQ] = useState("");
  const router = useRouter();
  const { projects, setSelection, refreshProjects } = useProject();

  // One cheap page of recent clips supplies every cover, newest first.
  const { data } = useApi<{ generations: Gen[] }>("/api/jobs?limit=60&sync=0", 20000);

  const coverFor = useMemo(() => {
    const map = new Map<string, Gen>();
    for (const g of data?.generations ?? []) {
      if (g.status !== "succeeded" || !g.storedUrl) continue;
      const key = g.projectId ?? "unfiled";
      if (!map.has(key)) map.set(key, g);
    }
    return map;
  }, [data]);

  const shown = projects.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const unfiled = data?.generations.filter((g) => !g.projectId).length ?? 0;

  function open(id: string) {
    setSelection(id);
    router.push("/generate");
  }

  async function create() {
    const name = await appPrompt("New project", "", "Project name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { appAlert("Couldn't create the project", json.error); return; }
    refreshProjects();
    open(json.id);
  }

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px]">
        <div className="flex items-end gap-4 pt-6">
          <h1 className="h1">Projects</h1>
          <button onClick={create} className="mb-2 ml-auto text-[15px] font-medium text-blue">
            New Project
          </button>
        </div>

        <div className="relative mt-6 flex items-center">
          <span className="pointer-events-none absolute left-4 text-mute"><IconSearch /></span>
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
            className="h-[46px] w-full rounded-[14px] bg-panel2 pl-11 pr-4 text-[16px] text-bone placeholder:text-mute focus:bg-white focus:outline-none"
          />
        </div>

        <div className="mt-8 grid gap-x-4 gap-y-7 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))] max-[620px]:[grid-template-columns:repeat(2,minmax(0,1fr))] sm:gap-x-6">
          {shown.map((p) => {
            const cover = coverFor.get(p.id);
            return (
              <div key={p.id}>
                <button onClick={() => open(p.id)} className="group w-full text-left"
                data-project-target={p.id} data-project-name={p.name}>
                <div className="aspect-square overflow-hidden rounded-[var(--r-lg)] bg-thumb shadow-[var(--shadow-media)] transition-transform duration-200 group-hover:-translate-y-1">
                  {cover?.storedUrl ? (
                    <LazyMedia url={cover.storedUrl} kind={cover.kind === "image" ? "image" : "video"} alt={p.name} />
                  ) : (
                    <span className="grid h-full place-items-center text-[13px] text-mute">No renders yet</span>
                  )}
                </div>
                <p className="mt-3 text-[17px] font-semibold tracking-[-0.01em]">{p.name}</p>
                <p className="text-[14px] text-dim">
                  {p.genCount > 0
                    ? `${p.genCount} render${p.genCount === 1 ? "" : "s"} · ${usd(p.spend, 2)}`
                    : "Empty"}
                </p>
                </button>
                {/* Tapping the card opens the work; the overview is where the
                    job's shots, cost and people live. */}
                <Link href={`/projects/${p.id}`}
                  className="mt-0.5 inline-block text-[13px] text-blue">
                  Overview
                </Link>
                </div>
            );
          })}

          {/* Everything that was never filed still needs a way in. */}
          {unfiled > 0 && !q && (
            <button onClick={() => open("unfiled")} className="group text-left"
              data-project-target="unfiled" data-project-name="Unfiled">
              <div className="aspect-square overflow-hidden rounded-[var(--r-lg)] bg-thumb shadow-[var(--shadow-media)] transition-transform duration-200 group-hover:-translate-y-1">
                {coverFor.get("unfiled")?.storedUrl ? (
                  <LazyMedia
                    url={coverFor.get("unfiled")!.storedUrl!}
                    kind={coverFor.get("unfiled")!.kind === "image" ? "image" : "video"}
                    alt="Unfiled"
                  />
                ) : (
                  <span className="grid h-full place-items-center text-[13px] text-mute">Unfiled</span>
                )}
              </div>
              <p className="mt-3 text-[17px] font-semibold tracking-[-0.01em]">Unfiled</p>
              <p className="text-[14px] text-dim">Renders without a project</p>
            </button>
          )}

          <button onClick={create} className="group text-left">
            <div className="grid aspect-square place-items-center rounded-[var(--r-lg)] border-2 border-dashed border-line text-mute transition-colors group-hover:border-blue/50 group-hover:text-blue">
              <IconPlus className="!h-7 !w-7" />
            </div>
            <p className="mt-3 text-[17px] font-semibold tracking-[-0.01em]">New Project</p>
            <p className="text-[14px] text-dim">Start something</p>
          </button>
        </div>

        {projects.length === 0 && (
          <p className="mt-10 text-center text-[15px] text-dim">
            No projects yet — the first one is a good place to put a test render.
          </p>
        )}

        <div className="mt-12 flex justify-center">
          <button onClick={() => router.push("/all")} className="chip !text-[14px] !text-dim">
            Browse every render →
          </button>
        </div>
      </div>
    </div>
  );
}
