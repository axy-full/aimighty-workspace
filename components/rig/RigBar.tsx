"use client";

import { useRouter } from "next/navigation";
import { Segmented, Mono } from "@/components/ui";
import Ring from "@/components/atomik/Ring";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { useAtomikRail } from "@/lib/atomikRail";
import type { ReactNode } from "react";

/**
 * Rig's chrome (design/particl-v2/README.md §8, §9; boards 6a, 9b): the
 * 44px sub-bar — `0 20px 0 76px`, 12 apart, a .08 hairline — with the
 * `Canvas · Recipes · Run` segmented (`6px 12px`), the context chip (.12
 * pill, `6px 10px`, 500 13px, 8 apart inside), a mono line, and whatever
 * the page puts on the right (8 apart); and beside the work, the 56px
 * strip: the ring in a 36px, radius-10 button (.14 idle, .3 at a
 * checkpoint) that opens the rail, with `ASK ATOMIK · ⌘J` — or
 * `CHECKPOINT · ⌘J` — written down it.
 */
export type RigTab = "canvas" | "recipes" | "run";

export function RigBar({ tab, hrefs, chip, mono, right }: { tab: RigTab; hrefs: Record<RigTab, string>; chip: ReactNode; mono: ReactNode; right?: ReactNode }) {
  const router = useRouter();
  return (
    <div className="flex h-[44px] flex-none items-center gap-[12px] border-b border-border pl-[76px] pr-[20px] max-md:h-auto max-md:flex-wrap max-md:px-[16px] max-md:py-[10px]">
      <Segmented label="Rig" placement="bar" value={tab} onChange={(t) => router.push(hrefs[t])}
        options={[{ value: "canvas", label: "Canvas" }, { value: "recipes", label: "Recipes" }, { value: "run", label: "Run" }]} />
      <span className="flex items-center gap-[8px] whitespace-nowrap rounded-pill border border-[rgba(245,246,248,.12)] px-[10px] py-[6px] text-[13px] font-medium leading-none text-ink">{chip}</span>
      <Mono className="max-md:hidden">{mono}</Mono>
      {right && <span className="ml-auto flex items-center gap-[8px]">{right}</span>}
    </div>
  );
}

/** The strip beside the work: the ring button and the vertical word. */
export function RigStrip() {
  const { ring, word } = useAtomik();
  const rail = useAtomikRail();
  const live = word === "checkpoint";
  return (
    <aside className="flex w-[56px] flex-none flex-col items-center gap-[14px] border-r border-border py-[14px] max-md:hidden" aria-label="Atomik">
      <button type="button" onClick={rail.toggle} aria-label="Ask Atomik"
        className={`flex h-[36px] w-[36px] items-center justify-center rounded-tile border ${live ? "border-[rgba(245,246,248,.3)]" : "border-border-mid"}`}>
        {"steps" in ring && ring.steps ? <Ring steps={ring.steps} size={18} /> : <Ring mode={"mode" in ring && ring.mode ? ring.mode : "idle"} size={16} />}
      </button>
      <Mono className="[writing-mode:vertical-rl]">{live ? "Checkpoint" : "Ask Atomik"} · ⌘J</Mono>
    </aside>
  );
}

/** The three tabs' destinations for a project: its board, its recipe, its run. */
export function rigHrefs(projectId: string, boardId?: string | null, runId?: string | null): Record<RigTab, string> {
  return {
    canvas: boardId ? `/rig/canvas/${boardId}` : `/rig/canvas/new?project=${encodeURIComponent(projectId)}`,
    recipes: `/rig/recipes/${encodeURIComponent(projectId)}`,
    run: runId ? `/rig/run/${runId}` : `/rig/run/latest?project=${encodeURIComponent(projectId)}`,
  };
}

/** A 26px initials avatar, as the board's collaborator stack draws one (ink border = you). */
export function Avatar({ name, you = false }: { name: string | null; you?: boolean }) {
  const initials = (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";
  return (
    <span className={`-ml-[6px] flex h-[26px] w-[26px] items-center justify-center rounded-full border bg-card ui-mono !text-[10px] tracking-normal text-ink ${you ? "border-ink" : "border-[rgba(245,246,248,.18)]"}`} title={name ?? undefined}>{initials}</span>
  );
}
