"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney, creditsNumber } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { appPrompt, appAlert } from "@/components/dialog";
import { Segmented, Button, Chip, CapBar, Stepper, Mono, Placeholder } from "@/components/ui";
import { PageLoader } from "@/components/atomik/Loader";
import LazyMedia from "@/components/LazyMedia";
import type { ProductionRow, ProjectRow } from "@/lib/productions";
import { clock } from "@/components/production/ProductionHeader";

/**
 * Productions (design/particl-v2/README.md §6; board 7a), value for value.
 *
 * Page header 64px, `0 24px`, 16 apart: `Productions` at 600 20px −0.02em
 * over the mono totals (`4 PRODUCTIONS · 9 PROJECTS · 8 NEED YOU · 808 OF
 * 1,550 CR`); the `Active · Delivered · All` segmented 12px on; from the
 * right `New project in…` (38px secondary pill) and `New production` (the
 * one filled primary). Body `0 24px 24px`, rows 12 apart.
 *
 * A production row: `--card`, .08, radius 12, `14px 16px 16px`, 12 apart.
 * Its head, 14 apart: name 600 16/1.1 over the client line 400 12.5/1.2;
 * `N PROJECTS` in mono 6px on; the `N need you` pill; spent of cap over
 * the 160×3 bar, right-aligned; `Rig · assets`. Beneath, the projects in
 * five columns 10 apart: a tile on `--ground`, .08, radius 10 (hover .24)
 * — a 16:7 well with the `41 MEDIA` chip and the need chip (6px dot);
 * `10px 12px 12px`, 7 apart: name 600 13.5/1.2, `format · N SHOTS` 400
 * 12/1.2 `--ink-body`, the six dots and the step's name, `228 / 400 CR ·
 * 57%` over a 3px bar. The last cell is the dashed `+ Project`.
 */
type Filter = "active" | "delivered" | "all";

export default function ProductionsPage() {
  usePageTitle("Productions");
  const router = useRouter();
  const { signedIn } = useSession();
  const money = useMoney();
  const { data, refresh } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 30_000);
  const [filter, setFilter] = useState<Filter>("active");
  const all = useMemo(() => data?.productions ?? [], [data]);
  const shown = all.filter((p) => filter === "all" || p.status === filter);

  const totals = useMemo(() => {
    const projects = all.reduce((a, p) => a + p.projects.length, 0);
    const need = all.reduce((a, p) => a + p.needYou, 0);
    const spent = all.reduce((a, p) => a + (money.inCredits ? p.spentCredits : p.spentUsd), 0);
    const cap = all.reduce((a, p) => a + (money.inCredits ? (p.capCredits ?? 0) : (p.capUsd ?? 0)), 0);
    return { productions: all.length, projects, need, spent, cap };
  }, [all, money.inCredits]);

  const newProduction = async () => {
    const name = await appPrompt("New production", "", "Handbag TVC", "The client job. Projects — the deliverables — go inside it.");
    if (!name?.trim()) return;
    const r = await fetch("/api/productions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!r.ok) { await appAlert("Not created", `The server answered ${r.status}.`); return; }
    refresh();
  };
  const newProject = async (production: ProductionRow) => {
    const name = await appPrompt(`New project in ${production.name}`, "", "30s hero spot", "A deliverable: 30s hero, 15s cutdown, 9:16 socials, key visuals.");
    if (!name?.trim()) return;
    const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, productionId: production.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { await appAlert("Not created", j.error ?? `The server answered ${r.status}.`); return; }
    refresh();
    if (j.id) router.push(`/productions/${production.id}/${j.id}/media`);
  };
  const newProjectIn = async () => {
    if (!all.length) { await newProduction(); return; }
    const pick = await appPrompt("New project in…", all[0].name, undefined, all.map((p) => p.name).join(" · "));
    const production = all.find((p) => p.name.toLowerCase() === (pick ?? "").trim().toLowerCase());
    if (production) await newProject(production);
  };

  const fmt = (n: number) => money.inCredits ? `${creditsNumber(n)} cr` : money.price(n);

  if (!data && signedIn) return <PageLoader what="Opening · Productions" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <div className="flex h-[64px] flex-none items-center gap-[16px] px-[24px] max-md:h-auto max-md:flex-wrap max-md:gap-[10px] max-md:px-[16px] max-md:py-[12px]">
        <span className="flex flex-col gap-[5px]">
          <h1 className="ui-page-title">Productions</h1>
          <Mono>{totals.productions} productions · {totals.projects} projects · {totals.need} need you · {totals.cap > 0 ? `${fmt(totals.spent)} of ${fmt(totals.cap)}` : `${fmt(totals.spent)} spent`}</Mono>
        </span>
        <Segmented label="Show" value={filter} onChange={setFilter} className="ml-[12px]"
          options={[{ value: "active", label: "Active" }, { value: "delivered", label: "Delivered" }, { value: "all", label: "All" }]} />
        <span className="ml-auto flex gap-[8px]">
          <Button placement="header" onClick={newProjectIn}>New project in…</Button>
          <Button variant="primary" placement="header" onClick={newProduction}>New production</Button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-auto px-[24px] pb-[24px] max-md:px-[16px]">
        {shown.map((p) => <ProductionCard key={p.id} production={p} fmt={fmt} inCredits={money.inCredits} onNewProject={() => newProject(p)} />)}
        {!shown.length && (
          <span className="py-[24px] text-[13px] leading-[1.5] text-ink-body">
            {signedIn ? (all.length ? "Nothing here under this filter." : "No productions yet. Start one — the client job — and put its deliverables inside.") : "Sign in to see your productions."}
          </span>
        )}
      </div>
    </div>
  );
}

function ProductionCard({ production: p, fmt, inCredits, onNewProject }: { production: ProductionRow; fmt: (n: number) => string; inCredits: boolean; onNewProject: () => void }) {
  const spent = inCredits ? p.spentCredits : p.spentUsd;
  const cap = inCredits ? p.capCredits : p.capUsd;
  return (
    <section className="flex flex-col gap-[12px] rounded-card border border-border bg-card px-[16px] pb-[16px] pt-[14px]">
      <div className="flex items-center gap-[14px] max-md:flex-wrap">
        <span className="flex min-w-0 flex-col gap-[4px]">
          <span className="text-[16px] font-semibold leading-[1.1] text-ink">{p.name}</span>
          <span className="text-[12.5px] leading-[1.2] text-ink-body">{p.client || (p.status === "delivered" ? "delivered" : "in production")}</span>
        </span>
        <Mono className="ml-[6px]">{p.projects.length} {p.projects.length === 1 ? "project" : "projects"}</Mono>
        {p.needYou > 0 && <Chip variant="need">{p.needYou} need you</Chip>}
        <span className="ml-auto">
          {cap !== null && cap !== undefined ? <CapBar spent={spent} cap={cap} placement="row" /> : <Mono>{fmt(spent)} spent · no cap</Mono>}
        </span>
        <Chip variant="pill">Rig · assets</Chip>
      </div>
      <div className="grid grid-cols-5 gap-[10px] max-md:grid-cols-2">
        {p.projects.map((j) => <ProjectTile key={j.id} production={p} project={j} fmt={fmt} inCredits={inCredits} />)}
        <button type="button" onClick={onNewProject}
          className="flex min-h-[120px] items-center justify-center rounded-tile border border-dashed border-[rgba(245,246,248,.18)] text-[13px] font-medium leading-none text-ink-body">
          + Project
        </button>
      </div>
    </section>
  );
}

function ProjectTile({ production, project: j, fmt, inCredits }: { production: ProductionRow; project: ProjectRow; fmt: (n: number) => string; inCredits: boolean }) {
  const spent = inCredits ? j.spentCredits : j.spentUsd;
  const cap = inCredits ? j.capCredits : j.capUsd;
  const line = [j.format || null, j.runtimeSecs ? clock(j.runtimeSecs) : null].filter(Boolean).join(" · ");
  return (
    <Link href={`/productions/${production.id}/${j.id}/media`}
      className="flex flex-col overflow-hidden rounded-tile border border-border bg-ground hover:border-border-hover">
      <span className={`relative block aspect-[16/7] border-b ${j.mediaCount ? "border-border" : "border-dashed border-[rgba(245,246,248,.2)]"}`}>
        {j.mediaCount ? <TileWell projectId={j.id} /> : null}
        <span className="ui-chip-scrim absolute left-[8px] top-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{j.mediaCount} media</span></span>
        {j.needYou > 0 && (
          <span className="ui-chip-scrim absolute right-[8px] top-[8px] flex items-center gap-[6px] rounded-badge px-[6px] py-[4px]">
            <span aria-hidden="true" className="block h-[6px] w-[6px] rounded-full bg-ink" /><span className="ui-mono text-ink">{j.needYou}</span>
          </span>
        )}
      </span>
      <span className="flex flex-col gap-[7px] px-[12px] pb-[12px] pt-[10px]">
        <span className="flex flex-col gap-[3px]">
          <span className="truncate text-[13.5px] font-semibold leading-[1.2] text-ink">{j.name}</span>
          <span className="truncate text-[12px] leading-[1.2] text-ink-body">{line ? `${line} · ` : ""}{j.shots} shots</span>
        </span>
        <Stepper current={j.step} compact />
        {cap !== null && cap !== undefined ? <CapBar spent={spent} cap={cap} placement="tile" /> : <Mono cost tone="ink">{fmt(spent)}</Mono>}
      </span>
    </Link>
  );
}

/** The project's newest frame in its well — real media, never a stand-in. */
function TileWell({ projectId }: { projectId: string }) {
  const { data } = useApi<{ generations: { id: string; url: string | null; kind: string; status: string }[] }>(`/api/jobs?projectId=${encodeURIComponent(projectId)}&limit=1&status=succeeded&sync=0`, 0);
  const g = data?.generations?.[0];
  if (!g?.url) return <Placeholder ratio="16/7" />;
  return <span className="absolute inset-0"><LazyMedia url={g.url} kind={g.kind === "image" ? "image" : "video"} className="h-full w-full object-cover" /></span>;
}
