"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { Segmented, Chip, Button, Mono, PinnedBar, PinnedPrimary } from "@/components/ui";
import { usePhone } from "@/lib/usePhone";
import { useAtomikRail } from "@/lib/atomikRail";
import type { DotState } from "@/components/ui";
import { PageLoader } from "@/components/atomik/Loader";
import ProductionHeader from "@/components/production/ProductionHeader";
import MediaTile, { type MediaItem } from "@/components/production/MediaTile";
import type { ProductionRow } from "@/lib/productions";
import type { Gen } from "@/components/GenCard";

/**
 * Project › Media (design/particl-v2/README.md §6; board 7b), value for
 * value. Under the production header: a 52px sub-bar, `0 24px`, 14 apart —
 * the `Shots · Boards · Approve · Media` segmented (`8px 14px`), the kind
 * pills (`All · 41`, `Takes · 22`, `Stills · 12`, `Audio · 5`, `Masters ·
 * 2`), and from the right the search (36px, 220 wide, `--card`, .08),
 * `BY SHOT ▾` in mono, and the one filled primary, `Download N masters ·
 * 0 CR`. The body (`0 24px 24px`, groups 20 apart): one group per shot —
 * its id in mono, its title 600 14/1.2, `N items · N cr` 400 12.5, a .07
 * hairline, `OPEN SHOT →` — over six columns of media tiles 10 apart.
 *
 * Media belongs to the project that made it and stays when a shot is
 * deleted; a take without a shot groups under `UNFILED`.
 *
 * Below 768 (design/particl-v2-mobile, board M2): the sub-tabs live in the
 * production header; the body is `12px 16px`, 16 apart — the kind pills
 * scrolling edge to edge, each group's line (`SH01`, the title, `N items ·
 * N cr` at the right) over two columns of tiles 8 apart — and `Download N
 * masters · 0 CR` pinned above the dock. No search, no `BY SHOT`.
 */
type Kind = "all" | "take" | "still" | "audio" | "master";
type Tab = "shots" | "boards" | "approve" | "media";

const KIND_WORD: Record<Exclude<Kind, "all">, string> = { take: "Takes", still: "Stills", audio: "Audio", master: "Masters" };

function kindOf(g: Gen): MediaItem["kind"] {
  if (g.task === "upscale") return "master";
  if (g.kind === "image") return "still";
  if (g.kind === "audio") return "audio";
  return "take";
}
function stateOf(g: Gen): { state: DotState; word: string } {
  if (g.status === "queued" || g.status === "running") return { state: "running", word: "rendering" };
  if (g.status === "failed") return { state: "none", word: "failed" };
  if (g.reviewState === "approved") return { state: "approved", word: "approved" };
  if (g.reviewState === "picked") return { state: "picked", word: "picked" };
  return { state: "draft", word: "draft" };
}
const initials = (name: string | null | undefined) => (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";

export default function ProjectMediaPage() {
  const { prod, project: projectId } = useParams<{ prod: string; project: string }>();
  const router = useRouter();
  const { signedIn } = useSession();
  const money = useMoney();
  const phone = usePhone();
  const rail = useAtomikRail();
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 30_000);
  const { data: jobs } = useApi<{ generations: Gen[] }>(signedIn ? `/api/jobs?projectId=${encodeURIComponent(projectId)}&limit=500` : null, 15_000);
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("media");

  const production = prods?.productions.find((p) => p.id === prod) ?? null;
  const project = production?.projects.find((j) => j.id === projectId) ?? null;
  usePageTitle(project ? `${project.name} · Media` : "Media");

  const items = useMemo(() => {
    const list = (jobs?.generations ?? []).filter((g) => g.status !== "failed" || true);
    return list.map((g): MediaItem & { shotId: string | null; shotCode: string | null; search: string; credits: number; usd: number } => {
      const k = kindOf(g); const st = stateOf(g);
      const label = k === "master" ? `${g.shotCode ?? "master"} · V${g.version ?? 1}` : k === "still" ? `S${g.version ?? 1}${g.title ? ` · ${g.title}` : ""}` : `v${g.version ?? 1}${g.title ? ` · ${g.title}` : ""}`;
      return {
        id: g.id, label, kind: k, state: st.state, stateWord: st.word, url: g.storedUrl ?? g.sourceUrl ?? null,
        model: g.model, cost: money.take(g), by: initials(g.authorName),
        resolution: typeof g.params?.resolution === "string" ? String(g.params.resolution).toUpperCase() : null,
        shotId: g.shotId ?? null, shotCode: g.shotCode ?? null, search: `${g.prompt} ${g.title ?? ""} ${g.model} ${g.shotCode ?? ""}`.toLowerCase(),
        credits: g.creditsBilled ?? 0, usd: g.costUsd ?? 0,
      };
    });
  }, [jobs, money]);

  const counts = useMemo(() => {
    const c = { all: items.length, take: 0, still: 0, audio: 0, master: 0 };
    for (const m of items) c[m.kind]++;
    return c;
  }, [items]);
  const shown = items.filter((m) => (kind === "all" || m.kind === kind) && (!q.trim() || m.search.includes(q.trim().toLowerCase())));
  const groups = useMemo(() => {
    const by = new Map<string, { id: string; code: string; title: string; items: typeof shown }>();
    for (const m of shown) {
      const key = m.shotId ?? "unfiled";
      const g = by.get(key) ?? { id: key, code: m.shotCode ?? "unfiled", title: m.shotCode ? "" : "Unfiled", items: [] };
      g.items.push(m); by.set(key, g);
    }
    return [...by.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [shown]);
  const masters = items.filter((m) => m.kind === "master" && m.url);

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to see this project.</div>;
  if (!prods || !jobs) return <PageLoader what={`Opening · ${project?.name ?? "project"}`} />;
  if (!production || !project) return <div className="p-[24px] text-[13px] text-ink-body">No such project. <Link href="/productions" className="text-ink">← Productions</Link></div>;

  const fmt = (n: number) => money.inCredits ? money.price(n) : money.price(n);
  const download = () => { for (const m of masters) window.open(m.url!, "_blank", "noopener"); };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <ProductionHeader production={production} project={project} />
      <div className="flex h-[52px] flex-none items-center gap-[14px] px-[24px] max-md:hidden">
        <Segmented label="Project" placement="toolbar" value={tab} onChange={(t) => { setTab(t); if (t === "shots") router.push(`/productions/${prod}/${projectId}/shots`); }}
          options={[{ value: "shots", label: "Shots" }, { value: "boards", label: "Boards" }, { value: "approve", label: "Approve" }, { value: "media", label: "Media" }]} />
        <span className="flex gap-[6px]">
          <Chip variant="filter" active={kind === "all"} onClick={() => setKind("all")}>All · {counts.all}</Chip>
          {(["take", "still", "audio", "master"] as const).map((k) => (
            <Chip key={k} variant="filter" active={kind === k} onClick={() => setKind(k)}>{KIND_WORD[k]} · {counts[k]}</Chip>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-[10px]">
          <label className="flex h-[36px] w-[220px] flex-none items-center gap-[8px] rounded-pill border border-border bg-card px-[12px] text-[13px] text-ink-muted">
            <span className="ui-mono tracking-normal">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this project…" aria-label="Search this project"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-muted max-md:text-[16px]" />
          </label>
          <Mono>By shot ▾</Mono>
          <Button variant="primary" placement="header" cost={0} disabled={!masters.length} onClick={download}>
            Download {masters.length} {masters.length === 1 ? "master" : "masters"}
          </Button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-auto px-[24px] pb-[24px] max-md:gap-[16px] max-md:px-[16px] max-md:pb-[10px] max-md:pt-[12px]">
        {phone && (
          <div className="-mx-[16px] flex gap-[6px] overflow-x-auto px-[16px]" data-kinds="">
            <Chip variant="filter" className="flex-none" active={kind === "all"} onClick={() => setKind("all")}>All · {counts.all}</Chip>
            {(["take", "still", "audio", "master"] as const).map((k) => (
              <Chip key={k} variant="filter" className="flex-none" active={kind === k} onClick={() => setKind(k)}>{KIND_WORD[k]} · {counts[k]}</Chip>
            ))}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.id} className="flex flex-col gap-[10px] max-md:gap-[8px]">
            <div className="flex items-baseline gap-[10px] max-md:gap-[8px]">
              <Mono tone="ink">{g.code}</Mono>
              {g.title && <span className="min-w-0 truncate text-[14px] font-semibold leading-[1.2] text-ink">{g.title}</span>}
              <span className="text-[12.5px] leading-none text-ink-body max-md:ml-auto max-md:flex-none max-md:text-[12px]">{g.items.length} {g.items.length === 1 ? "item" : "items"} · {fmt(g.items.reduce((a, m) => a + (money.inCredits ? m.credits : m.usd), 0))}</span>
              <span className="h-px flex-1 self-center bg-[rgba(245,246,248,.07)] max-md:hidden" />
              {g.id !== "unfiled" && <Link href={`/shots/${g.id}`} className="ui-mono text-ink-muted max-md:hidden">Open shot →</Link>}
            </div>
            <div className="grid grid-cols-6 gap-[10px] max-md:grid-cols-2 max-md:gap-[8px]">
              {g.items.map((m) => <MediaTile key={m.id} m={m} phone={phone} onOpen={() => { if (m.url) window.open(m.url, "_blank", "noopener"); }} />)}
            </div>
          </section>
        ))}
        {!groups.length && <span className="py-[24px] text-[13px] leading-[1.5] text-ink-body">Nothing here yet. Takes, stills, audio and masters land here as the project makes them.</span>}
      </div>
      <PinnedBar>
        <PinnedPrimary cost={fmt(0)} outlined={rail.open} disabled={!masters.length} onClick={download}>Download {masters.length} {masters.length === 1 ? "master" : "masters"}</PinnedPrimary>
      </PinnedBar>
    </div>
  );
}
