"use client";

import { Suspense, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import type { RecipeGraph, RecipeSummary, RecipeStage } from "@/lib/runs";
import type { ProductionRow } from "@/lib/productions";
import { MODELS } from "@/lib/models";
import { MODE_WORD, STAGE_MODES, runTotal, asksCount, firstCheckpointCredits, planningCredits, type StageMode } from "@/lib/runState";
import { Button, Mono, PinnedBar, PinnedPrimary } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { usePhone } from "@/lib/usePhone";
import { ToastHost, useToast } from "@/components/ui/Toast";
import Loader, { PageLoader, LOADER_SIZES } from "@/components/atomik/Loader";
import { appPrompt } from "@/components/dialog";
import { RigBar, RigStrip, rigHrefs } from "@/components/rig/RigBar";

/**
 * Rig · Recipes (SOW surfaces board 12d; docs/particl-sow-v2.md §7.7): a
 * recipe is a saved way of making a film — the steps in order, which
 * engine does each, what it costs, and whether Atomik asks first or just
 * runs. Pick a recipe on the left; the price of the whole run, for the
 * project in context, shows before step one.
 *
 * The board: a 420px column of recipe cards (name at 600 16, a one-line
 * blurb, `SCOPE · N STEPS · EST` in mono; the picked one on a 2px ink
 * border) beside the recipe — its name at 600 22 with `Copy and change`
 * and `Open as a board` outlined at 38px; the steps table on `--card`
 * (`# · STEP · WHO DOES IT · COSTS · ATOMIK`, 56px rows, the engine and
 * its vendor from the registry, the price in mono, the Atomik word beside
 * an 8px dot — an accent ring when it asks); the whole-run card with its
 * eyebrow, the total at 600 28 beside how many checkpoints, and the one
 * filled primary `Run to first checkpoint · N CR` where N is every stage
 * before the first that asks; and the floor line. Engine names come from
 * the registry; prices from the rate table; nothing is typed.
 *
 * The word is the SOW's — checkpoint, not "stop" — and planning credits
 * are their own line (SOW §8). A workspace's own recipe edits in place: the
 * engine (the registry's, by kind) and the Atomik mode per step, the name.
 * The platform's two are read-only; `Copy and change` makes them yours.
 *
 * Below 768 (mobile README's chrome): the Rig bar's 52px title row, the
 * recipe cards stacked, the steps as rows (number · name over who ·
 * Atomik word over cost), the whole-run card, the two outlined actions at
 * 44px, and the primary pinned above the dock.
 */
export default function RecipesPage() {
  return <ToastHost><Suspense fallback={<PageLoader what="Opening · Recipes" />}><Recipes /></Suspense></ToastHost>;
}

const two = (n: number) => String(n).padStart(2, "0");
const UNIT_WORD: Record<string, string> = { panel: "panel", still: "still", take: "take", line: "line", view: "view", plan: "plan", face: "face" };

function Recipes() {
  const router = useRouter();
  const search = useSearchParams();
  const { signedIn } = useSession();
  const { current } = useProject();
  const money = useMoney();
  const toast = useToast();
  const rail = useAtomikRail();
  const phone = usePhone();
  usePageTitle("Recipes");
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  /* The project in context is one this workspace has: a stale or foreign `?project=` (an old link) falls back like a missing one. */
  const known = (id: string | null | undefined) => Boolean(id && prods?.productions.some((p) => p.projects.some((j) => j.id === id)));
  const projectId = [search.get("project"), current?.id].find(known) ?? prods?.productions[0]?.projects[0]?.id ?? null;
  const production = prods?.productions.find((p) => p.projects.some((j) => j.id === projectId)) ?? null;
  const proj = production?.projects.find((j) => j.id === projectId) ?? null;
  /* The server prices every card and the pane for the project in context — one shot count, one rounding per stage — so the page adds no money of its own. */
  const ctx = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  /* Nothing is asked for until the productions are known, so the first request already carries the project; and an
     answer priced for another project (the last URL's, still cached) is not shown — the server names the project it
     priced for, and the ring shows until this project's arrives. */
  const { data: rawList, refresh: refreshList } = useApi<{ recipes: RecipeSummary[]; shots: number | null; project: string | null }>(signedIn && prods ? `/api/rig/recipes${ctx}` : null, 0);
  const list = rawList && (rawList.project ?? null) === projectId ? rawList : null;
  const wanted = search.get("recipe");
  const [picked, setPicked] = useState<string | null>(null);
  /* The picked card, while it exists; else the one the link named; else this project's own; else the first. */
  const has = (id: string | null) => Boolean(id && list?.recipes.some((r) => r.id === id));
  const selectedId = has(picked) ? picked : has(wanted) ? wanted : (list?.recipes.find((r) => r.projectId === projectId)?.id ?? list?.recipes[0]?.id ?? null);
  const { data: one, refresh: refreshOne } = useApi<{ recipe: RecipeGraph; project: string | null }>(signedIn && list && selectedId ? `/api/rig/recipes/${encodeURIComponent(selectedId)}${ctx}` : null, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ stageId: string; x: number; y: number } | null>(null);

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to open the Rig.</div>;
  if (!list || !prods) return <PageLoader what="Opening · Recipes" />;
  /* The pane is the recipe priced for THIS project: anything else is the last project's numbers. */
  const recipe = one?.recipe && one.recipe.id === selectedId && (one.project ?? null) === projectId ? one.recipe : null;
  const staged: RecipeStage[] = recipe?.stages ?? [];
  const shots = recipe?.quotedShots ?? list.shots ?? 0;
  const total = runTotal(staged), asks = asksCount(staged), first = firstCheckpointCredits(staged), planning = planningCredits(staged);
  const fmt = (n: number) => money.price(n);
  const own = recipe?.scope === "workspace";
  /* A count that follows the shot list has nothing to count on a project with no shots. */
  const noShots = staged.some((s) => Boolean(s.perShot) && s.totalUnits === 0);
  const canRun = Boolean(recipe && recipe.stages.length && projectId) && !noShots;
  const hrefs = rigHrefs(projectId ?? "", null, null);

  /* ── the verbs ──────────────────────────────────────────────────────── */
  const run = async () => {
    if (!recipe || !projectId) { toast("Pick a project first — a run belongs to one."); return; }
    setBusy("run");
    const r = await fetch("/api/rig/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipeId: recipe.id, projectId }) });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { toast(j.error ?? "The run didn't start."); return; }
    router.push(`/rig/run/${j.id}`);
  };
  const fork = async () => {
    if (!recipe || !projectId) { toast("Pick a project first — a copy belongs to one."); return; }
    setBusy("fork");
    const r = await fetch(`/api/rig/recipes/${encodeURIComponent(recipe.id)}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { toast(j.error ?? "Not copied."); return; }
    await refreshList(); setPicked(j.id); toast(`${recipe.name} · copy · yours to change`);
  };
  const openBoard = async () => {
    if (!recipe || !projectId) { toast("Pick a project first — a board belongs to one."); return; }
    setBusy("board");
    const r = await fetch(`/api/rig/recipes/${encodeURIComponent(recipe.id)}/board`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { toast(j.error ?? "No board."); return; }
    router.push(`/rig/canvas/${j.boardId}`);
  };
  const patch = async (body: Record<string, unknown>, said: string) => {
    if (!recipe) return;
    const r = await fetch(`/api/rig/recipes/${encodeURIComponent(recipe.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error ?? "That didn't stick."); return; }
    await Promise.all([refreshOne(), refreshList()]); toast(said);
  };
  const rename = async () => { if (!recipe) return; const v = await appPrompt("Rename the recipe", recipe.name, "Name"); if (v?.trim()) patch({ name: v.trim() }, `Now ${v.trim()}`); };
  const setMode = async (stageId: string, mode: StageMode) => {
    let capCredits: number | null | undefined;
    if (mode === "under_cap") { const v = await appPrompt("Run it under how many credits?", "50", "Credits"); const n = Number(v); if (!Number.isFinite(n) || n <= 0) return; capCredits = Math.round(n); }
    patch({ stages: [{ id: stageId, mode, capCredits: mode === "under_cap" ? capCredits : null }] }, MODE_WORD[mode]);
  };
  const setEngine = (stageId: string, engine: string) => patch({ stages: [{ id: stageId, engine }] }, "Engine changed · re-priced from the registry");
  const menuStage = menu ? staged.find((s) => s.id === menu.stageId) ?? null : null;
  type Staged = RecipeStage;
  const modeItems: MenuItem[] = menuStage ? STAGE_MODES.map((m) => ({ kind: "item" as const, label: MODE_WORD[m], keys: menuStage.mode === m ? "·" : undefined, onSelect: () => { setMenu(null); setMode(menuStage.id, m); } })) : [];

  /* ── pieces ─────────────────────────────────────────────────────────── */
  const dot = (mode: StageMode) => <span aria-hidden="true" className={`block h-[8px] w-[8px] flex-none rounded-full ${mode === "asks" ? "border-[2px] border-accent" : "bg-[rgba(245,246,248,.45)]"}`} />;
  const modeCell = (s: Staged) => {
    const word = MODE_WORD[s.mode] + (s.mode === "under_cap" && s.capCredits ? ` · ${fmt(s.capCredits)}` : "");
    const inner = <span className={`flex items-center gap-[8px] text-[13px] font-medium leading-none ${s.mode === "asks" ? "text-ink" : "text-ink-muted"}`}>{dot(s.mode)}{word}</span>;
    return own
      ? <button type="button" aria-label={`Atomik on ${s.name}: ${word}`} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ stageId: s.id, x: r.left, y: r.bottom + 6 }); }} className="tap44 -mx-[6px] rounded-ctl px-[6px] py-[6px] text-left hover:bg-[rgba(245,246,248,.06)]">{inner}</button>
      : inner;
  };
  const whoCell = (s: Staged) => {
    const m = MODELS.find((x) => x.id === s.engine);
    if (!own || !m) return <span className="truncate text-[13.5px] leading-[1.2] text-ink-body">{s.who}</span>;
    const choices = MODELS.filter((x) => !x.hidden && x.kind === m.kind && (x.supportsTasks ?? ["generate"]).includes("generate"));
    return (
      <label className="relative flex min-w-0 items-center">
        <span className="truncate text-[13.5px] leading-[1.2] text-ink-body">{s.who} <span className="text-ink-muted">▾</span></span>
        {/* The invisible select is the target itself — the row on desktop, a 44px band centred on the row on a phone; a tap44 band on the label would paint over it. */}
        <select value={s.engine} onChange={(e) => setEngine(s.id, e.target.value)} aria-label={`Engine for ${s.name}`} className="absolute inset-x-0 cursor-pointer text-[16px] opacity-0 md:inset-y-0 max-md:top-1/2 max-md:h-[44px] max-md:-translate-y-1/2">
          {choices.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          {!choices.some((x) => x.id === s.engine) && <option value={s.engine}>{s.who}</option>}
        </select>
      </label>
    );
  };
  /* COSTS is the board's: the rate per unit on a batch (`1 CR / PANEL`), the stage's price on a single (`2 CR`); the batch is summed on the whole-run card. */
  const costCell = (s: Staged) => {
    const batch = Boolean(s.perShot) || s.totalUnits > 1;
    return <Mono cost tone="ink" className="whitespace-nowrap">{s.unit && batch && s.unitCredits != null ? `${fmt(s.unitCredits)} / ${UNIT_WORD[s.unit] ?? s.unit}` : fmt(s.credits)}</Mono>;
  };
  const card = (r: RecipeSummary) => {
    const on = r.id === selectedId;
    return (
      <button key={r.id} type="button" onClick={() => setPicked(r.id)} aria-pressed={on} aria-label={`Recipe ${r.name}`}
        className={`flex w-full flex-col gap-[8px] rounded-card border-[2px] bg-card p-[16px] text-left ${on ? "border-ink" : "border-[rgba(245,246,248,.08)] hover:border-border-hover"}`}>
        <span className="text-[16px] font-semibold leading-[1.1] text-ink">{r.name}</span>
        {r.blurb && <span className="text-[13px] leading-[1.3] text-ink-body">{r.blurb}</span>}
        <Mono>{r.scope === "platform" ? "Platform" : "Your studio"} · {r.steps} {r.steps === 1 ? "step" : "steps"} · {fmt(r.credits)}</Mono>
      </button>
    );
  };
  const wholeRun: ReactNode = recipe && (
    <div className="flex items-center gap-[14px] rounded-card border border-border bg-card px-[18px] py-[16px] max-md:flex-col max-md:items-stretch" data-whole-run="">
      <span className="flex min-w-0 flex-1 flex-col gap-[6px]">
        <Mono>Whole run{proj ? ` · ${proj.format || proj.name}` : ""} · {shots} {shots === 1 ? "shot" : "shots"}</Mono>
        <span className="flex flex-wrap items-baseline gap-[10px]">
          <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink" data-run-total="">{fmt(total)}</span>
          <span className="text-[15px] leading-none text-ink-body">· {asks} {asks === 1 ? "checkpoint" : "checkpoints"}</span>
          {planning > 0 && <Mono cost>planning {fmt(planning)}</Mono>}
        </span>
      </span>
      {!phone && <Button variant="primary" placement="composer" className="!rounded-tile !gap-[12px]" cost={first} busy={busy === "run"} busyLabel="Starting…" outlined={rail.open || !canRun} disabled={!canRun} onClick={run}>Run to first checkpoint</Button>}
    </div>
  );
  const footnote = <span className="text-[13px] leading-[1.4] text-ink-muted" data-floor="">Anything over 200 cr always asks. Training, publishing and deleting always ask.</span>;
  const actions = (tall: boolean) => (
    <span className="flex gap-[8px]">
      <Button variant="secondary" placement={tall ? "sheet" : "card"} className={tall ? "" : "!h-[38px] !rounded-tile !text-[13px]"} busy={busy === "fork"} busyLabel="Copying…" onClick={fork}>Copy and change</Button>
      <Button variant="secondary" placement={tall ? "sheet" : "card"} className={tall ? "" : "!h-[38px] !rounded-tile !text-[13px]"} busy={busy === "board"} busyLabel="Opening…" onClick={openBoard}>Open as a board</Button>
    </span>
  );
  const overlays = menu && <Menu x={menu.x} y={menu.y} title={menuStage ? `Atomik · ${menuStage.name}` : "Atomik"} items={modeItems} onClose={() => setMenu(null)} />;
  const chip = <>{production?.name ?? "Every production"}{proj ? <> <span className="text-ink-muted">›</span> {proj.name}</> : null}</>;
  const mono = `${list.recipes.length} ${list.recipes.length === 1 ? "recipe" : "recipes"}`;

  /* ── phone ──────────────────────────────────────────────────────────── */
  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <RigBar tab="recipes" hrefs={hrefs} chip={chip} mono={mono} phoneTitle={recipe?.name ?? "Recipes"} phoneMono={recipe ? `${recipe.stages.length} steps · ${fmt(total)} · ${asks} ${asks === 1 ? "checkpoint" : "checkpoints"}` : mono} />
        <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[16px] pb-[10px] pt-[14px]">
          {!list.recipes.length && <span className="text-[13px] leading-[1.5] text-ink-body">No recipes yet — save a board as one from Canvas.</span>}
          <div className="flex flex-col gap-[8px]" data-recipes="">{list.recipes.map(card)}</div>
          {!recipe && selectedId && <div className="flex items-center justify-center py-[40px]"><Loader size={LOADER_SIZES.well} /></div>}
          {recipe && (
            <>
              <div className="flex flex-col gap-[10px]" data-steps="">
                {staged.map((s) => (
                  <div key={s.id} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-card border border-border bg-card px-[12px] py-[10px]">
                    <Mono className="!tracking-[.1em]">{two(s.num)}</Mono>
                    <span className="flex min-w-0 flex-col gap-[4px]"><span className="truncate text-[14px] font-medium leading-[1.2] text-ink">{s.name}</span>{whoCell(s)}</span>
                    <span className="flex flex-col items-end gap-[6px]">{modeCell(s)}{costCell(s)}</span>
                  </div>
                ))}
              </div>
              {wholeRun}
              {actions(true)}
              {footnote}
            </>
          )}
        </div>
        {list.recipes.length > 0 && (
          <PinnedBar>
            <PinnedPrimary cost={fmt(first)} outlined={rail.open || !canRun} busy={busy === "run"} disabled={!canRun} onClick={run}>{busy === "run" ? "Starting…" : "Run to first checkpoint"}</PinnedPrimary>
          </PinnedBar>
        )}
        {overlays}
      </div>
    );
  }

  /* ── desktop ────────────────────────────────────────────────────────── */
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <RigBar tab="recipes" hrefs={hrefs} chip={chip} mono={mono} />
      <div className="grid min-h-0 flex-1 grid-cols-[56px_minmax(0,1fr)]">
        <RigStrip />
        <div className="grid min-h-0 grid-cols-[420px_minmax(0,1fr)] max-lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-[8px] overflow-auto border-r border-border px-[16px] py-[22px]" aria-label="Recipes" data-recipes="">
            <span className="px-[8px] pb-[10px] text-[18px] font-semibold leading-none text-ink">Recipes</span>
            {list.recipes.map(card)}
          </aside>
          <div className="flex min-h-0 flex-col gap-[16px] overflow-auto px-[28px] py-[22px]" data-recipe="">
            {recipe ? (
              <>
                <div className="flex items-center gap-[14px]">
                  <h1 className="truncate text-[22px] font-semibold leading-none text-ink">{recipe.name}</h1>
                  {own && <button type="button" onClick={rename} className="tap44 rounded-pill border border-border-mid px-[10px] py-[6px] text-[12px] font-medium leading-none text-ink-body hover:border-border-hover">Rename</button>}
                  <span className="ml-auto">{actions(false)}</span>
                </div>
                <div className="overflow-x-auto rounded-card border border-border bg-card" role="table" aria-label="Steps">
                  <div role="row" className="grid min-w-[560px] grid-cols-[36px_150px_minmax(0,1fr)_130px_150px] gap-[14px] border-b border-border px-[16px] py-[10px]">
                    {["#", "Step", "Who does it", "Costs", "Atomik"].map((h) => <Mono key={h} role="columnheader">{h}</Mono>)}
                  </div>
                  {staged.map((s) => (
                    <div key={s.id} role="row" className="grid min-h-[56px] min-w-[560px] grid-cols-[36px_150px_minmax(0,1fr)_130px_150px] items-center gap-[14px] border-b border-[rgba(245,246,248,.06)] px-[16px]" data-step={s.num}>
                      <Mono role="cell" className="!tracking-[.1em]">{two(s.num)}</Mono>
                      <span role="cell" className="truncate text-[15px] font-medium leading-[1.2] text-ink">{s.name}</span>
                      <span role="cell" className="min-w-0">{whoCell(s)}</span>
                      <span role="cell">{costCell(s)}</span>
                      <span role="cell">{modeCell(s)}</span>
                    </div>
                  ))}
                  {!staged.length && <span className="block px-[16px] py-[14px] text-[13px] text-ink-body">No steps yet.</span>}
                </div>
                {wholeRun}
                {footnote}
              </>
            ) : selectedId ? (
              <div className="flex flex-1 items-center justify-center"><Loader size={LOADER_SIZES.well} /></div>
            ) : list.recipes.length ? (
              <span className="text-[13px] leading-[1.5] text-ink-body">Pick a recipe on the left.</span>
            ) : (
              <span className="flex items-center gap-[12px] text-[13px] leading-[1.5] text-ink-body">No recipes yet — save a board as one from Canvas.<Button variant="secondary" placement="card" onClick={() => router.push(hrefs.canvas)}>Open Canvas</Button></span>
            )}
          </div>
        </div>
      </div>
      {overlays}
    </div>
  );
}
