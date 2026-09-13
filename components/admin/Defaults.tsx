"use client";

import { Button } from "@/components/ui";
import Loader from "@/components/atomik/Loader";
import { defaultsLine } from "./adminFormat";
import type { LayerView } from "./types";

/**
 * What every new studio starts with (SOW surfaces board 12h, block 4):
 * one line computed from the platform layer — Setup rows, rules, recipes,
 * the starter production, the cap and its warning, the welcome grant —
 * and the outlined `Edit the defaults`, which opens the per-key editor.
 * Every number is read; the desk types none of them. The line itself is
 * lib/adminView's `defaultsLine`, the one the unit tests assert.
 */
export function summaryOf(view: LayerView | null, grantCredits: number): string | null {
  if (!view) return null;
  const s = view.summary;
  if (s) return defaultsLine({ setupRows: s.setupRows, rules: s.rules, recipes: s.recipes, starter: s.starter, capCredits: s.capCredits, warnPct: s.warnPct, grant: grantCredits });
  /* A route a version behind: count what the layer itself carries. The recipes are not in it (they live server-side,
     in lib/runs), so that part of the line is left out rather than printed as a number nobody read. */
  const l = view.layer;
  return defaultsLine({
    setupRows: Object.values(l.setup ?? {}).filter((v) => v != null && v !== "").length,
    rules: l.rules?.length ?? 0, recipes: 0, starter: l.starter?.name ?? "",
    capCredits: l.caps?.defaultCapCredits ?? null, warnPct: l.caps?.warnPct ?? 0, grant: grantCredits,
  }).replace(" · 0 recipes", "");
}

export default function Defaults({ view, grantCredits, onEdit }: { view: LayerView | null; grantCredits: number; onEdit: () => void }) {
  const line = summaryOf(view, grantCredits);
  return (
    <section aria-label="What every new studio starts with" data-desk-card=""
      className="col-span-2 flex items-center gap-[14px] rounded-card border border-border bg-card px-[20px] py-[18px] max-xl:col-span-1 max-md:flex-col max-md:items-start">
      <span className="flex-none text-[18px] font-semibold leading-none text-ink">What every new studio starts with</span>
      {line ? <span className="min-w-0 text-[14px] leading-[1.4] text-ink-body" data-defaults-line="">{line}</span> : <Loader size={14} label="Reading the platform layer" />}
      <Button variant="secondary" placement="desk" onClick={onEdit} disabled={!view} className="ml-auto flex-none max-md:ml-0">Edit the defaults</Button>
    </section>
  );
}
