"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import type { RecipeGraph } from "@/lib/runs";
import type { ProductionRow } from "@/lib/productions";
import { Button, Mono } from "@/components/ui";
import { ToastHost, useToast } from "@/components/ui/Toast";
import { PageLoader } from "@/components/atomik/Loader";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { RigBar, RigStrip, rigHrefs } from "@/components/rig/RigBar";

/**
 * Rig · Recipes (design/particl-v2/README.md §1, §8): a board saved as a
 * reusable stage pipeline, with an engine and a price per stage — what
 * `Save as recipe` makes on the Canvas and what a Run executes. The handoff
 * draws no board for it, so it is set the way the run track is (§9): one
 * card per stage — number, name, engine, price — and the one filled
 * primary, `Run to first checkpoint · N CR`, quoted from the first paid
 * stage before it enables. Building a recipe is free; a run charges stage
 * by stage and stops at its first checkpoint for a person.
 */
export default function RecipesPage() {
  return <ToastHost><Recipes /></ToastHost>;
}

const two = (n: number) => String(n).padStart(2, "0");

function Recipes() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const { signedIn } = useSession();
  const money = useMoney();
  const toast = useToast();
  const rail = useAtomikRail();
  const { engineLabel } = useAtomik();
  const { data, refresh } = useApi<{ recipe: RecipeGraph | null }>(signedIn ? `/api/rig/recipe/${encodeURIComponent(projectId)}` : null, 0);
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  const production = prods?.productions.find((p) => p.projects.some((j) => j.id === projectId)) ?? null;
  const proj = production?.projects.find((j) => j.id === projectId) ?? null;
  usePageTitle("Recipes");
  const [busy, setBusy] = useState(false);
  const fmt = (n: number) => money.price(n);

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to open the Rig.</div>;
  if (!data || !prods) return <PageLoader what="Opening · Recipes" />;
  const recipe = data.recipe;
  const hrefs = rigHrefs(projectId, null, recipe?.runId ?? null);
  const total = recipe?.stages.reduce((a, s) => a + s.credits, 0) ?? 0;
  const firstPaid = recipe?.stages.find((s) => s.kind !== "write") ?? recipe?.stages[0] ?? null;

  const make = async () => {
    setBusy(true);
    const r = await fetch(`/api/rig/recipe/${encodeURIComponent(projectId)}`, { method: "POST" });
    setBusy(false); refresh();
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error ?? "No recipe made."); } else toast("Recipe saved · eight stages");
  };
  const run = async () => {
    if (!recipe) return;
    setBusy(true);
    const r = await fetch("/api/rig/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { toast(j.error ?? "The run didn't start."); return; }
    router.push(`/rig/run/${j.id}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <RigBar tab="recipes" hrefs={hrefs}
        chip={<>{production?.name ?? "Production"} <span className="text-ink-muted">›</span> {proj?.name ?? "project"}</>}
        mono={recipe ? `${recipe.name} · ${recipe.stages.length} stages · ${fmt(total)} a run` : "no recipe yet"}
        right={recipe ? <Button variant="primary" placement="header" cost={firstPaid?.credits ?? 0} busy={busy} busyLabel="Starting…" outlined={rail.open} onClick={run}>Run to first checkpoint</Button>
          : <Button variant="primary" placement="header" cost={0} busy={busy} busyLabel="Saving…" outlined={rail.open} onClick={make}>Save the eight stages as a recipe</Button>} />
      <div className="grid min-h-0 flex-1 grid-cols-[56px_minmax(0,1fr)] max-md:grid-cols-1">
        <RigStrip />
        <div className="flex min-h-0 flex-col gap-[18px] overflow-auto px-[24px] pb-[24px] pt-[20px] max-md:px-[16px]">
          {recipe ? (
            <div className="flex flex-col gap-[10px]">
              <Mono>{recipe.name} · {recipe.stages.length} stages · an engine and a price per stage · building is free</Mono>
              <div className="grid gap-[8px] max-md:grid-cols-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, recipe.stages.length)}, minmax(0, 1fr))` }} role="list" aria-label="Stages">
                {recipe.stages.map((s) => (
                  <div key={s.id} role="listitem" className="flex flex-col gap-[8px] rounded-card border border-border bg-card p-[10px]">
                    <span className="flex items-center gap-[6px]"><span className="ui-mono !tracking-[.1em] text-ink-muted">{two(s.num)}</span><span className="truncate text-[13px] font-semibold leading-[1.1] text-ink">{s.name}</span></span>
                    <span className="h-[62px] rounded-[6px] border border-dashed border-[rgba(245,246,248,.16)]" />
                    <span className="flex flex-col gap-[4px]">
                      <span className="ui-mono !tracking-[.1em] text-ink-muted">{s.kind}{s.inputs.length ? ` · after ${s.inputs.map((id) => two(recipe.stages.find((x) => x.id === id)?.num ?? 0)).join(", ")}` : ""}</span>
                      <span className="flex justify-between ui-mono ui-mono-cost text-ink-muted"><span className="truncate">{s.engine ? engineLabel(s.engine) : "—"}</span><span className="ml-[6px] flex-none text-ink">{fmt(s.credits)}{s.totalUnits > 1 ? ` · ×${s.totalUnits}` : ""}</span></span>
                    </span>
                  </div>
                ))}
              </div>
              {recipe.locked.length > 0 && <Mono>Locked · {recipe.locked.map((l) => l.name).join(" · ")}</Mono>}
            </div>
          ) : (
            <span className="text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>No recipe here yet. A recipe is a board saved as stages, each with its engine and its price — `Save as recipe` on the Canvas makes one from the board&rsquo;s generate nodes, or save the eight default stages (Brief, Scene, Shot list, Keyframes, Motion, Post, Audio, Assembly) from here.</span>
          )}
        </div>
      </div>
    </div>
  );
}
