"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { notFound } from "next/navigation";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import { Segmented, Mono } from "@/components/ui";
import { ToastHost } from "@/components/ui/Toast";
import Composer, { type ComposerKind } from "@/components/make/Composer";
import UnfiledWall from "@/components/make/UnfiledWall";
import { usePhone } from "@/lib/usePhone";

/**
 * Make (design/particl-v2/README.md §10; board 8a): free generation with
 * nothing required. `/make/video`, `/make/images`, `/make/audio`.
 *
 * Left, the unfiled wall: a 52px bar (`0 24px`, 14 apart, a .06 rule) with
 * `Video · Images · Audio` (`8px 14px`), `UNFILED · 9 TAKES · 117 CR ·
 * NOTHING REQUIRED`, and the 220px search; then the days, four cards
 * across (three beside the compact rail, two beside the expanded one —
 * §5). Right, the one composer in its 400px rail on `#0F1116`.
 *
 * Below 768 (design/particl-v2-mobile, board M4): the sticky block —
 * `Video · Images · Audio` full width over `UNFILED · 9 TAKES · 117 CR` —
 * the wall two across (`12px 16px`, days 14 apart), and the composer
 * docked at the bottom as a card above the pinned `Render`, opening as
 * the M9 sheet. No search on a phone.
 */
const KINDS: { slug: string; kind: ComposerKind; label: string }[] = [
  { slug: "video", kind: "video", label: "Video" },
  { slug: "images", kind: "image", label: "Images" },
  { slug: "audio", kind: "audio", label: "Audio" },
];

export default function MakePage() {
  return <ToastHost><Make /></ToastHost>;
}

function Make() {
  const { kind: slug } = useParams<{ kind: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const rail = useAtomikRail();
  const phone = usePhone();
  const entry = KINDS.find((k) => k.slug === slug);
  if (!entry) notFound();
  usePageTitle(`Make · ${entry.label}`);
  const [q, setQ] = useState("");
  const [totals, setTotals] = useState<{ takes: number; spent: string } | null>(null);
  const [tick, setTick] = useState(0);
  /* 12i: `/make/video?starter=1` is where signup lands — the composer opens with the demo cast already in the prompt. */
  const starter = search.get("starter") === "1";
  const columns = rail.state === "expanded" ? "grid-cols-2" : rail.state === "compact" ? "grid-cols-3" : "grid-cols-4";

  if (phone) return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <div className="flex flex-none flex-col gap-[10px] border-b border-border px-[16px] pb-[10px] pt-[12px]" data-make-head="">
        <Segmented label="Make" fill value={entry.slug} onChange={(s) => router.push(`/make/${s}`)} options={KINDS.map((k) => ({ value: k.slug, label: k.label }))} />
        <Mono>Unfiled · {totals ? `${totals.takes} ${totals.takes === 1 ? "take" : "takes"} · ${totals.spent}` : "—"}</Mono>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[16px] pb-[10px] pt-[12px]">
        <UnfiledWall key={`${entry.kind}:${tick}`} kind={entry.kind} search={q} columns={columns} onTotals={setTotals} phone />
      </div>
      <Composer kind={entry.kind} initialRef={search.get("ref")} starter={starter} onMade={() => setTick((t) => t + 1)} />
    </div>
  );
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px] bg-ground text-ink">
      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-[52px] flex-none items-center gap-[14px] border-b border-hairline px-[24px]">
          <Segmented label="Make" placement="toolbar" value={entry.slug} onChange={(s) => router.push(`/make/${s}`)} options={KINDS.map((k) => ({ value: k.slug, label: k.label }))} />
          <Mono>Unfiled · {totals ? `${totals.takes} ${totals.takes === 1 ? "take" : "takes"} · ${totals.spent}` : "—"} · nothing required</Mono>
          <label className="ml-auto flex h-[36px] w-[220px] items-center gap-[8px] rounded-pill border border-border bg-card px-[12px] text-[13px] text-ink-muted">
            <span className="ui-mono !text-[12px] tracking-normal">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search unfiled…" aria-label="Search unfiled" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-0 placeholder:text-ink-muted" />
          </label>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-auto px-[24px] pb-[24px] pt-[18px]">
          <UnfiledWall key={`${entry.kind}:${tick}`} kind={entry.kind} search={q} columns={columns} onTotals={setTotals} />
        </div>
      </section>
      <aside className="ui-rail relative flex min-h-0 flex-col border-l border-border" aria-label="Composer">
        <Composer kind={entry.kind} initialRef={search.get("ref")} starter={starter} onMade={() => setTick((t) => t + 1)} />
      </aside>
    </div>
  );
}
