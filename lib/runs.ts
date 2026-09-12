import { db, ready, now, id } from "./db";
import {
  cleanFailure, isStageState, isStageMode, effectiveMode, runTotal, asksCount, firstCheckpointCredits,
  type Failure, type RunView, type StageState, type StageView, type StageMode,
} from "./runState";
import { MODELS, AUDIO_LABELS, DEFAULT_MODEL_ID, prettyModel } from "./models";
import { PROVIDERS } from "./providers";
import { DEFAULT_TEXT_MODELS } from "./platformLayer";
import { estimateCostUsd, estimateImageCostUsd } from "./vendorPricing";
import { billCredits } from "./creditTerms";
import { speechCredits, usdForCredits } from "./elevenlabs";
import { creditsApply } from "./credits";
import { currentTenant } from "./tenant";
import { createBoard, saveBoard, getBoard, type BoardNode, type BoardWire } from "./boards";
import { inputsFor } from "@/components/rig/nodes";

/**
 * Runs, read and written (brief 3, surface 1a).
 *
 * A recipe is the production written down as stages; a run is one execution
 * of it. This file assembles what the run view shows and records what a
 * person did about a stage that stopped.
 *
 * Every query goes through db(), the workspace in scope, which throws when
 * there is none.
 *
 * What is deliberately NOT here: the thing that advances a run on its own.
 * Stages are moved by the work they own — a render stage by its takes, a
 * writing stage by its document — and the scheduler that walks a recipe
 * start to finish is its own change with its own risks. This is the screen
 * that watches a run and the record of how a stopped stage was got past.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const stageState = (v: unknown): StageState => (isStageState(v) ? v : "queued");

/* A figure in the workspace's unit: whole credits stay whole, and a dollar
   workspace keeps its cents — the old `Math.round` turned a $0.13 stage into
   $0, which is not a price. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function getRun(runId: string): Promise<RunView | null> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT r.*, p.name AS project_name FROM runs r
          LEFT JOIN projects p ON p.id = r.project_id
          WHERE r.id = ?`,
    args: [runId],
  });
  if (!rs.rows.length) return null;
  const r = rs.rows[0] as any;

  const stages = await stagesOf(runId, String(r.recipe_id));
  return assemble(r, stages);
}

/** The run a production is on, newest first — what /rig opens to. */
export async function latestRun(projectId: string): Promise<RunView | null> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT id FROM runs WHERE project_id = ? ORDER BY started_at DESC, num DESC LIMIT 1`,
    args: [projectId],
  });
  if (!rs.rows.length) return null;
  return getRun(String((rs.rows[0] as any).id));
}

export async function listRuns(projectId: string, limit = 20): Promise<RunView[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT id FROM runs WHERE project_id = ? ORDER BY started_at DESC, num DESC LIMIT ?`,
    args: [projectId, Math.max(1, Math.min(limit, 50))],
  });
  const out: RunView[] = [];
  for (const row of rs.rows) {
    const one = await getRun(String((row as any).id));
    if (one) out.push(one);
  }
  return out;
}

/**
 * The stages of one run, in recipe order.
 *
 * A stage of the recipe with no row yet has not been reached, which is
 * exactly `queued` — so the recipe is the spine and the run's own rows fill
 * in over it, rather than a run having to write eight rows before it can be
 * looked at.
 */
async function stagesOf(runId: string, recipeId: string): Promise<StageView[]> {
  const [defs, rows] = await Promise.all([
    db().execute({
      sql: `SELECT * FROM recipe_stages WHERE recipe_id = ? ORDER BY position, num`,
      args: [recipeId],
    }),
    db().execute({ sql: `SELECT * FROM stage_runs WHERE run_id = ?`, args: [runId] }),
  ]);

  const byStage = new Map<string, any>();
  for (const row of rows.rows) byStage.set(String((row as any).stage_id), row);

  return defs.rows.map((d) => {
    const def = d as any;
    const got = byStage.get(String(def.id));
    const state = stageState(got?.state);
    let failure: Failure | null = null;
    if (got?.failure) {
      try { failure = cleanFailure(JSON.parse(String(got.failure))); } catch { failure = null; }
    }
    return {
      id: String(def.id),
      num: Number(def.num ?? 0),
      name: String(def.name ?? ""),
      sub: subLine(def, got),
      /* A stage that says it needs a person but offers nothing to do about
         it is worse than one that says it stopped, so it reads as queued
         until there is a way out to show. */
      state: state === "needs_you" && !failure ? "queued" : state,
      credits: Math.max(0, round2(Number(got?.estimate_credits ?? 0))),
      spent: Math.max(0, round2(Number(got?.spent_credits ?? 0))),
      doneUnits: Math.max(0, Number(got?.done_units ?? 0)),
      totalUnits: Math.max(0, Number(got?.total_units ?? 0)),
      hasOutput: hasOutput(got),
      failure,
      /* What the person chose, in the words they read — never the id. */
      fixedWith: got?.fixed_label ? String(got.fixed_label) : null,
    };
  });
}

/** "12 shots · Seedance 2.5" — what the stage does and what it does it with. */
function subLine(def: any, got: any): string {
  const units = Math.max(0, Number(got?.total_units ?? 0));
  const noun = String(def.kind) === "write" ? "document" : "shot";
  const count = units ? `${units} ${noun}${units === 1 ? "" : "s"}` : "";
  const engine = String(def.engine ?? "").trim();
  return [count, engine].filter(Boolean).join(" · ");
}

/**
 * Whether the stage has anything to show yet.
 *
 * The well is a picture of what a stage made, not a caption about it — the
 * handoff is explicit that a surface must never ship with text where a
 * thumbnail belongs. So this answers yes or no, and the frame itself is
 * wired when the stages carry their output.
 */
function hasOutput(got: any): boolean {
  return Math.max(0, Number(got?.done_units ?? 0)) > 0;
}

function assemble(r: any, stages: StageView[]): RunView {
  const spent = stages.reduce((n, s) => n + s.spent, 0);
  /* The run's estimate is what its stages add up to, not a number stored when
     it started: a fix that skips a stage or re-renders a shot moves it, and a
     header that kept quoting the old one would be quoting a plan nobody is
     following any more. A SKIPPED stage is the case that makes this true — it
     will never run, so what it would have cost is no longer part of the run,
     and only what it actually spent before it was skipped counts. */
  const estimate = stages.reduce(
    (n, s) => n + (s.state === "skipped" ? s.spent : Math.max(s.credits, s.spent)), 0);
  const stored = String(r.state ?? "running");
  return {
    id: String(r.id),
    num: Number(r.num ?? 1),
    recipeId: String(r.recipe_id ?? ""),
    projectId: r.project_id ?? null,
    projectName: String(r.project_name ?? ""),
    /* Paused is a fact about the run and needing somebody is a fact about a
       stage. Folding the second into the first hid the first: a paused run
       with a stopped stage read as running, so the button offered to pause a
       run that was already paused and nothing on the screen said so. */
    state: stored === "paused" ? "paused" : stored === "done" ? "done" : "running",
    needsYou: stages.some((s) => s.state === "needs_you"),
    startedAt: Number(r.started_at ?? 0),
    stages,
    spent,
    estimate,
    done: stages.filter((s) => s.state === "done" || s.state === "skipped").length,
    total: stages.length,
  };
}

/* ── The recipe as a graph (surface 1d) ─────────────────────────────────
   A run is one execution; the recipe is the thing itself. The stage layer
   reads this: the stages, what feeds each of them, and the elements pinned
   into the recipe that sit in the band above. */

export type RecipeStage = {
  id: string; num: number; name: string;
  kind: "write" | "render" | "assemble";
  engine: string;
  /** `Seedance 2.5 · ByteDance` — the engine and its vendor from the registry, never typed. */
  who: string;
  params: Record<string, unknown>;
  inputs: string[];
  locks: string[];
  position: number;
  /** What Atomik does here, the platform floor applied (SOW surfaces 12d). */
  mode: StageMode;
  capCredits: number | null;
  /** The unit the stage is priced by — panel, still, take, line, view. */
  unit: string | null;
  /** Units per shot of the project it runs on, when the count follows the shot list. */
  perShot: number | null;
  /** One unit's vendor dollars from the rate table, when the stage is priced by unit (`unit` set and the engine in the registry). */
  unitUsd: number | null;
  /** One unit's price in the workspace's unit, from the same table — the rate a steps table prints as `1 CR / PANEL`. */
  unitCredits: number | null;
  /** The stage's price as the platform floor reads it: in credits, whatever the workspace is billed in. */
  floorCredits: number;
  /** Where the latest run of this recipe got to, when there is one. */
  state: StageState;
  credits: number;
  spent: number;
  doneUnits: number;
  totalUnits: number;
};

export type LockedElement = { id: string; name: string; kind: string; lockedBy: string | null; lockedAt: number | null };

export type RecipeGraph = {
  id: string;
  name: string;
  blurb: string;
  /** A platform recipe belongs to no project and is seeded into every workspace; a workspace's own belongs to a project. */
  scope: "platform" | "workspace";
  projectId: string | null;
  boardId: string | null;
  stages: RecipeStage[];
  locked: LockedElement[];
  /** The run the states came from, if any. */
  runId: string | null;
  /** The shot count the per-shot stages were priced for, when a project was in context. */
  quotedShots: number | null;
};

/** How many shots a project has that render (a title card never does). */
export async function shotCount(projectId: string): Promise<number> {
  await ready();
  const rs = await db().execute({ sql: `SELECT COUNT(*) AS n FROM shots WHERE project_id = ? AND COALESCE(kind, 'render') != 'type'`, args: [projectId] });
  return Number((rs.rows[0] as any)?.n ?? 0);
}

/** True when the project is this workspace's. */
export async function projectExists(projectId: string): Promise<boolean> {
  await ready();
  const rs = await db().execute({ sql: `SELECT id FROM projects WHERE id = ? LIMIT 1`, args: [projectId] });
  return rs.rows.length > 0;
}

export async function recipeOf(projectId: string, opts: { shots?: number | null } = {}): Promise<RecipeGraph | null> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM recipes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
    args: [projectId],
  });
  if (!rs.rows.length) return null;
  return graphOf(rs.rows[0] as any, opts.shots ?? null, projectId);
}

/** One recipe by its own id — a platform one, or any project's — priced for a shot count when one is given, wearing that project's run. */
export async function recipeById(recipeId: string, opts: { shots?: number | null; projectId?: string | null } = {}): Promise<RecipeGraph | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM recipes WHERE id = ?`, args: [recipeId] });
  if (!rs.rows.length) return null;
  return graphOf(rs.rows[0] as any, opts.shots ?? null, opts.projectId ?? null);
}

/* ── The registry, read for a steps table ────────────────────────────── */

/** `Seedance 2.5 · ByteDance`: the engine's label and its vendor's short name from the registry. */
export function whoLine(engine: string): string {
  if (!engine) return "—";
  const m = MODELS.find((x) => x.id === engine);
  if (m) return `${m.label} · ${PROVIDERS.find((p) => p.id === m.provider)?.short ?? m.provider}`;
  if (engine === "elevenlabs" || AUDIO_LABELS[engine]) return `${AUDIO_LABELS[engine]?.label ?? "ElevenLabs"} · ElevenLabs`;
  if (engine.includes("/")) return `${prettyModel(engine)} · Vercel`;
  return engine;
}

/** A planning stage's estimate, in credits — an estimate, and always its own line on the run (SOW §8). */
export const PLANNING_ESTIMATE_CREDITS = 3;
/** The dollars behind that estimate, so a dollar workspace sees dollars too. */
const PLANNING_ESTIMATE_USD = PLANNING_ESTIMATE_CREDITS / 15;

/** What a unit is made of: a take is video, a panel, still or view is a still, a line is voice. */
export const UNIT_MEDIUM: Record<string, "video" | "image" | "audio" | "text"> = { take: "video", panel: "image", still: "image", view: "image", face: "image", line: "audio", plan: "text" };
/** The unit a stage is priced by when it carries none — read off what its engine makes, never typed. */
export const UNIT_OF_MEDIUM: Record<string, string> = { video: "take", image: "still", audio: "line", text: "plan" };

/** Whether an engine id is one the registry knows — a model, a voice, or a planning model on the gateway. */
export function engineKnown(engine: string): boolean {
  return Boolean(MODELS.some((m) => m.id === engine) || engine === "elevenlabs" || AUDIO_LABELS[engine] || /^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(engine));
}
/** The medium an engine makes, for matching it to a stage's unit. */
export function engineMedium(engine: string): "video" | "image" | "audio" | "text" | null {
  const m = MODELS.find((x) => x.id === engine);
  if (m) return m.kind;
  if (engine === "elevenlabs" || AUDIO_LABELS[engine]) return "audio";
  if (/^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(engine)) return "text";
  return null;
}

/**
 * One unit's vendor dollars from the rate table: a take is 5 seconds at
 * 1080p (or the engine's first resolution) without audio, a still is 1K,
 * a board panel is the standard still at its smallest size (§7A: one
 * credit), a line of voice is a hundred characters at the default voice.
 * Nothing here is typed; a change to the rate table moves every recipe.
 */
export function unitUsdFor(engine: string, kind: "write" | "render" | "assemble", unit?: string | null): number | null {
  if (kind === "write") return PLANNING_ESTIMATE_USD;
  const m = MODELS.find((x) => x.id === engine);
  if (m?.kind === "video" && (!unit || UNIT_MEDIUM[unit] === "video")) {
    const res = m.resolutions.includes("1080p") ? "1080p" : m.resolutions[0];
    const secs = m.durations.includes(5) ? 5 : (m.durations[0] ?? 5);
    return estimateCostUsd(m.id, res, m.ratios.includes("16:9") ? "16:9" : m.ratios[0], secs, 0, false, { audio: false })?.net ?? null;
  }
  if (m?.kind === "image" && (!unit || UNIT_MEDIUM[unit] === "image")) {
    const size = unit === "panel" ? m.resolutions[0] : m.resolutions.includes("1K") ? "1K" : m.resolutions[0];
    return estimateImageCostUsd(m.id, size, 0)?.net ?? null;
  }
  if ((engine === "elevenlabs" || AUDIO_LABELS[engine]) && (!unit || UNIT_MEDIUM[unit] === "audio")) {
    /* ElevenLabs counts characters as its own credits; the ledger converts them to dollars before billing. */
    return usdForCredits(speechCredits("A line of dialogue about a hundred characters long, read once, at the voice the shot was cast with.", engine === "elevenlabs" ? "eleven_multilingual_v2" : engine), null);
  }
  return null;
}

/** A stage's price in the workspace's unit, rounded ONCE for the whole batch (SOW §2: batches multiply before rounding). */
export function stagePrice(unitUsd: number, units: number, engine?: string | null): number {
  const usd = unitUsd * Math.max(1, units);
  const ws = currentTenant()?.workspace;
  /* A dollar workspace (its own keys) sees vendor dollars; everyone else, and a test with no tenant, sees credits. */
  return ws && !creditsApply(ws) ? round2(usd) : billCredits(usd, engine);
}

/** A price as the platform floor reads it — in credits whatever the workspace is billed in: a dollar workspace's figure is
 *  vendor dollars, so it is billed the way a credit workspace would be before the 200-cr line is tested. */
export function floorCreditsOf(price: number, engine?: string | null): number {
  const ws = currentTenant()?.workspace;
  return ws && !creditsApply(ws) ? billCredits(price, engine) : price;
}

/** One unit's price in the workspace's unit — for a test or a card, never for a batch. */
export function unitCreditsFor(engine: string, kind: "write" | "render" | "assemble", unit?: string | null): number | null {
  const usd = unitUsdFor(engine, kind, unit);
  return usd == null ? null : stagePrice(usd, 1, engine);
}

async function graphOf(r: any, shots: number | null = null, projectId: string | null = null): Promise<RecipeGraph> {

  /* The newest run's states are painted onto the recipe, so the stage layer
     shows what is happening rather than a diagram of what could. A recipe
     nobody has run yet reads as all queued, which is true. The run is the
     project's in context (a workspace recipe's own project when none is):
     a shared recipe never wears another project's run. */
  const paintFor = projectId ?? (r.project_id == null ? null : String(r.project_id));
  const latest = paintFor
    ? await db().execute({ sql: `SELECT id FROM runs WHERE recipe_id = ? AND project_id = ? ORDER BY started_at DESC LIMIT 1`, args: [String(r.id), paintFor] })
    : { rows: [] as unknown[] };
  const runId = latest.rows.length ? String((latest.rows[0] as any).id) : null;

  const [defs, states] = await Promise.all([
    db().execute({ sql: `SELECT * FROM recipe_stages WHERE recipe_id = ? ORDER BY position, num`, args: [String(r.id)] }),
    runId
      ? db().execute({ sql: `SELECT * FROM stage_runs WHERE run_id = ?`, args: [runId] })
      : Promise.resolve({ rows: [] as unknown[] }),
  ]);

  const byStage = new Map<string, any>();
  for (const row of states.rows) byStage.set(String((row as any).stage_id), row);

  const stages: RecipeStage[] = defs.rows.map((d) => {
    const def = d as any;
    const got = byStage.get(String(def.id));
    const kind = String(def.kind);
    const params = jsonOrEmpty(def.params);
    const k: RecipeStage["kind"] = kind === "write" || kind === "assemble" ? kind : "render";
    const engine = String(def.engine ?? "");
    const name = String(def.name ?? "");
    const unit = typeof params.unit === "string" ? params.unit : null;
    const perShot = typeof params.perShot === "number" && params.perShot > 0 ? params.perShot : null;
    /* A stage priced by unit (the platform's, or one edited here) is quoted from the rate table for the project's shots,
       rounded once for the batch — zero shots is zero units, never one; a stage the canvas priced keeps the canvas's
       figure. A run's own estimate and count are that run's (the run page shows them), never this project's quote. */
    const unitUsd = unit ? unitUsdFor(engine, k, unit) : null;
    const units = perShot && shots != null ? perShot * shots : Math.max(0, Number(params.units ?? 0));
    const credits = unitUsd != null ? (units > 0 ? stagePrice(unitUsd, units, engine) : 0) : Math.max(0, round2(Number(params.credits ?? 0)));
    const floorCredits = floorCreditsOf(credits, engine);
    return {
      id: String(def.id),
      num: Number(def.num ?? 0),
      name,
      kind: k,
      engine,
      who: whoLine(engine),
      params,
      inputs: jsonList(def.inputs),
      locks: jsonList(def.locks),
      position: Number(def.position ?? 0),
      mode: effectiveMode({ mode: def.mode, credits, floorCredits, name }),
      capCredits: def.cap_credits == null ? null : Number(def.cap_credits),
      unit,
      perShot,
      unitUsd,
      unitCredits: unitUsd != null ? stagePrice(unitUsd, 1, engine) : null,
      floorCredits,
      state: stageState(got?.state),
      credits,
      spent: Math.max(0, round2(Number(got?.spent_credits ?? 0))),
      doneUnits: Math.max(0, Number(got?.done_units ?? 0)),
      totalUnits: units,
    };
  });

  /* Everything any stage pins, in the order the stages cite them, so the band
     reads left to right the way the recipe does. */
  const wanted: string[] = [];
  for (const st of stages) for (const id of st.locks) if (!wanted.includes(id)) wanted.push(id);
  let locked: LockedElement[] = [];
  if (wanted.length) {
    const holes = wanted.map(() => "?").join(",");
    const els = await db().execute({
      sql: `SELECT id, name, kind, locked_by, locked_at FROM elements WHERE id IN (${holes})`,
      args: wanted,
    });
    const byId = new Map(els.rows.map((e) => [String((e as any).id), e as any]));
    locked = wanted.map((id) => byId.get(id)).filter(Boolean).map((e) => ({
      id: String(e.id), name: String(e.name ?? ""), kind: String(e.kind ?? ""),
      lockedBy: e.locked_by ?? null, lockedAt: e.locked_at == null ? null : Number(e.locked_at),
    }));
  }

  return {
    id: String(r.id), name: String(r.name ?? ""), blurb: String(r.blurb ?? ""),
    scope: r.project_id == null ? "platform" : "workspace", projectId: r.project_id ?? null, boardId: r.board_id ?? null,
    stages, locked, runId, quotedShots: shots,
  };
}

/* ── The workspace's recipes, listed (SOW surfaces 12d) ─────────────────── */

export type RecipeSummary = {
  id: string; name: string; blurb: string; scope: "platform" | "workspace"; projectId: string | null; boardId: string | null;
  steps: number; credits: number; asks: number; firstCheckpoint: number;
};

/** Every recipe the workspace can run: the platform's, then its own projects', newest first — priced for a shot count when one is given. */
export async function listRecipes(shots: number | null = null): Promise<RecipeSummary[]> {
  await ready();
  const rs = await db().execute(`SELECT * FROM recipes ORDER BY (project_id IS NULL) DESC, updated_at DESC LIMIT 100`);
  const rows = rs.rows as any[];
  if (!rows.length) return [];
  const holes = rows.map(() => "?").join(",");
  const st = await db().execute({ sql: `SELECT recipe_id, name, kind, engine, params, mode FROM recipe_stages WHERE recipe_id IN (${holes}) ORDER BY position, num`, args: rows.map((r) => String(r.id)) });
  const by = new Map<string, { name: string; kind: string; credits: number; floorCredits: number; mode: string }[]>();
  for (const s of st.rows as any[]) {
    const p = jsonOrEmpty(s.params);
    const kind: RecipeStage["kind"] = s.kind === "write" || s.kind === "assemble" ? s.kind : "render";
    const unit = typeof p.unit === "string" ? p.unit : null;
    const perShot = typeof p.perShot === "number" && p.perShot > 0 ? p.perShot : null;
    const unitUsd = unit ? unitUsdFor(String(s.engine ?? ""), kind, unit) : null;
    const units = perShot && shots != null ? perShot * shots : Math.max(0, Number(p.units ?? 0));
    const credits = unitUsd != null ? (units > 0 ? stagePrice(unitUsd, units, String(s.engine ?? "")) : 0) : Math.max(0, round2(Number(p.credits ?? 0)));
    const list = by.get(String(s.recipe_id)) ?? [];
    list.push({ name: String(s.name ?? ""), kind, credits, floorCredits: floorCreditsOf(credits, String(s.engine ?? "")), mode: String(s.mode ?? "asks") });
    by.set(String(s.recipe_id), list);
  }
  return rows.map((r) => {
    const stages = by.get(String(r.id)) ?? [];
    return {
      id: String(r.id), name: String(r.name ?? ""), blurb: String(r.blurb ?? ""),
      scope: r.project_id == null ? "platform" : "workspace", projectId: r.project_id ?? null, boardId: r.board_id ?? null,
      steps: stages.length, credits: runTotal(stages), asks: asksCount(stages), firstCheckpoint: firstCheckpointCredits(stages),
    };
  });
}

const jsonList = (raw: unknown): string[] => {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
};
const jsonOrEmpty = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/* ── Writing ────────────────────────────────────────────────────────── */

/**
 * Take one of the ways out of a stopped stage.
 *
 * The fix is recorded on the stage rather than applied to it and forgotten:
 * a run that was got past a refusal by skipping one shot is a different run
 * from one that re-rendered it, and six months later the only place that
 * difference survives is here.
 */
export async function applyFix(
  runId: string, stageId: string, fixId: string, by: string,
): Promise<{ ok: true; state: StageState } | { ok: false; error: string }> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM stage_runs WHERE run_id = ? AND stage_id = ?`,
    args: [runId, stageId],
  });
  if (!rs.rows.length) return { ok: false, error: "That stage is not part of this run." };
  const row = rs.rows[0] as any;

  let failure: Failure | null = null;
  try { failure = cleanFailure(JSON.parse(String(row.failure ?? "null"))); } catch { failure = null; }
  if (!failure) return { ok: false, error: "That stage is not waiting on anybody." };

  const fix = failure.fixes.find((f) => f.id === fixId);
  if (!fix) return { ok: false, error: "That is not one of the ways out of this stage." };

  /* Skipping leaves the stage behind deliberately, and the record says so.
     Anything else puts the stage back in the queue for the work to be tried
     again from here — never from the beginning of the run. */
  const state: StageState = fix.kind === "skip" ? "skipped" : "queued";
  const ts = now();
  await db().execute({
    sql: `UPDATE stage_runs SET state = ?, failure = NULL, fixed_with = ?, fixed_label = ?, fixed_by = ?, fixed_at = ?, updated_at = ?,
                 estimate_credits = ?
          WHERE run_id = ? AND stage_id = ?`,
    args: [state, fix.id, fix.label, by, ts, ts,
           /* A skipped stage will not run, so it stops quoting for work that
              will never happen; anything else keeps its estimate. */
           fix.kind === "skip" ? 0 : Math.max(0, round2(Number(row.estimate_credits ?? 0))),
           runId, stageId],
  });
  /* The stage is unblocked, and that is all. A run somebody paused stays
     paused: getting past a refusal is not the same decision as letting the
     rest of the money go, and quietly making it for them would release every
     queued stage behind it. */
  await db().execute({
    sql: `UPDATE runs SET updated_at = ? WHERE id = ?`,
    args: [ts, runId],
  });
  return { ok: true, state };
}

/** Hold a run where it is, or let it go on. Nothing already made is touched. */
export async function setRunState(runId: string, state: "running" | "paused", by: string): Promise<boolean> {
  await ready();
  void by;
  const rs = await db().execute({
    sql: `UPDATE runs SET state = ?, updated_at = ? WHERE id = ?`,
    args: [state, now(), runId],
  });
  return rs.rowsAffected > 0;
}

/* ── Making one ─────────────────────────────────────────────────────── */

/**
 * The eight stages a production is written down as (SOW §9, surface 1a).
 *
 * Named there and nowhere else in code until now, which is part of why the
 * node layer stayed empty: `createRecipe` has always worked, and nothing has
 * ever had a list of stages to hand it.
 *
 * `kind` is the only thing the graph reads off a stage to decide how it
 * draws, so it is the only thing set here. `engine` is deliberately left
 * empty: §7A routes stages to engines by price band (boards to a standard
 * panel, drafts to Kling Standard, heroes to Seedance or Kling Pro) and that
 * routing is not built, so writing engine ids in now would be inventing the
 * pricing behaviour rather than recording it.
 */
export const DEFAULT_STAGES: NewStage[] = [
  { num: 1, name: "Brief", kind: "write", inputs: [] },
  { num: 2, name: "Scene", kind: "write", inputs: [1] },
  { num: 3, name: "Shot list", kind: "write", inputs: [2] },
  { num: 4, name: "Keyframes", kind: "render", inputs: [3] },
  { num: 5, name: "Motion", kind: "render", inputs: [4] },
  { num: 6, name: "Post", kind: "render", inputs: [5] },
  /* Audio branches off the shot list rather than waiting for the picture,
     and Assembly joins both — which is the whole reason `inputs` exists and
     the recipe is not a list. The column's own comment says so. */
  { num: 7, name: "Audio", kind: "render", inputs: [3] },
  { num: 8, name: "Assembly", kind: "assemble", inputs: [6, 7] },
];

export type NewStage = {
  num: number; name: string; kind: "write" | "render" | "assemble";
  engine?: string; units?: number; credits?: number;
  /** The `num`s of the stages that feed this one. Resolved to ids on insert. */
  inputs?: number[];
  /** What Atomik does here (SOW surfaces 12d); absent = asks. */
  mode?: StageMode;
  capCredits?: number | null;
  /** The unit the stage is priced by, and how many per shot when the count follows the shot list. */
  unit?: string;
  perShot?: number;
};

/** A recipe and its stages, for a production that has none — or for the platform, with no project at all. */
export async function createRecipe(projectId: string | null, name: string, stages: NewStage[], by: string, opts: { blurb?: string; boardId?: string | null; id?: string } = {}): Promise<string> {
  await ready();
  const ts = now();
  const rid = opts.id ?? id("rec");
  const ins = await db().execute({
    sql: `INSERT OR IGNORE INTO recipes (id, project_id, name, blurb, board_id, draft, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [rid, projectId, name.slice(0, 80), (opts.blurb ?? "").slice(0, 160), opts.boardId ?? null, 0, by, ts, ts],
  });
  if (ins.rowsAffected === 0) return "";   // a fixed id already there: another read wrote it first
  /* Ids first, because a stage's inputs are OTHER stages' ids and half of
     them are not written yet. `inputs` is given as `num`s — the number a
     person reads on the node — and resolved here, so a caller never has to
     know what an id looks like. A num nothing matches is dropped rather than
     written as a dangling wire: `wiresOf` skips an input it cannot place, so
     a bad one would vanish from the canvas while staying in the row. */
  const idOf = new Map<number, string>();
  for (const s of stages) idOf.set(s.num, id("rst"));

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const inputs = (s.inputs ?? []).map((n) => idOf.get(n)).filter((v): v is string => Boolean(v));
    /* A stage's own price and unit count (design/particl-v2 §9: every stage
       priced as the recipe has it) live in `params`, so a recipe nobody has
       run yet still quotes what a run would cost. */
    const params: Record<string, unknown> = {};
    if (s.units != null) params.units = Math.max(1, Math.round(s.units));
    if (s.credits != null) params.credits = Math.max(0, round2(s.credits));
    if (s.unit) params.unit = s.unit.slice(0, 20);
    if (s.perShot != null && s.perShot > 0) params.perShot = Math.max(1, Math.round(s.perShot));
    await db().execute({
      sql: `INSERT INTO recipe_stages (id, recipe_id, num, name, kind, engine, params, inputs, position, mode, cap_credits, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [idOf.get(s.num)!, rid, s.num, s.name.slice(0, 60), s.kind, (s.engine ?? "").slice(0, 60),
             JSON.stringify(params), JSON.stringify(inputs), i, isStageMode(s.mode) ? s.mode : "asks", s.capCredits ?? null, ts, ts],
    });
  }
  return rid;
}

/** Start a run of a recipe, with every stage queued at its estimate. */
export async function startRun(
  recipeId: string, projectId: string | null, stages: { stageId: string; units: number; credits: number }[], by: string,
): Promise<string> {
  await ready();
  const ts = now();
  const counted = await db().execute({
    sql: `SELECT COALESCE(MAX(num), 0) AS n FROM runs WHERE project_id IS ?`,
    args: [projectId],
  });
  const num = Number((counted.rows[0] as any)?.n ?? 0) + 1;
  const rid = id("run");
  await db().execute({
    sql: `INSERT INTO runs (id, recipe_id, project_id, num, state, estimate_credits, started_by, started_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [rid, recipeId, projectId, num, "running",
           stages.reduce((n, s) => n + s.credits, 0), by, ts, ts],
  });
  for (const s of stages) {
    await db().execute({
      sql: `INSERT INTO stage_runs (id, run_id, stage_id, state, total_units, estimate_credits, updated_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [id("sr"), rid, s.stageId, "queued", s.units, s.credits, ts],
    });
  }
  return rid;
}

/* ── Editing, forking, opening as a board (SOW surfaces 12d) ────────────── */

export type StagePatch = { id: string; engine?: string; mode?: StageMode; capCredits?: number | null; units?: number; perShot?: number | null; name?: string };

/**
 * Change a recipe: its name, its blurb, and per stage the engine, the
 * Atomik mode, the cap, the unit count. A new engine re-prices the stage
 * from the rate table; a price is never typed.
 */
export async function updateRecipe(recipeId: string, patch: { name?: string; blurb?: string; stages?: StagePatch[] }): Promise<RecipeGraph | null> {
  await ready();
  const ts = now();
  /* Every stage is read and checked before anything is written, so a refused engine changes nothing at all. */
  const writes: { sql: string; args: (string | number | null)[] }[] = [];
  for (const p of patch.stages ?? []) {
    const cur = await db().execute({ sql: `SELECT * FROM recipe_stages WHERE id = ? AND recipe_id = ?`, args: [p.id, recipeId] });
    if (!cur.rows.length) continue;
    const row = cur.rows[0] as any;
    const kind: RecipeStage["kind"] = row.kind === "write" || row.kind === "assemble" ? row.kind : "render";
    const params = jsonOrEmpty(row.params);
    /* The unit the stage is priced by — stored, or read off the engine it has (a canvas-saved stage carries none). */
    const unit = typeof params.unit === "string" ? params.unit : (UNIT_OF_MEDIUM[engineMedium(String(row.engine ?? "")) ?? ""] ?? null);
    /* An engine is one the registry knows, and it makes what the stage's unit is made of. */
    let engine = String(row.engine ?? "");
    if (typeof p.engine === "string") {
      const want = p.engine.slice(0, 60);
      const medium = engineMedium(want);
      if (!engineKnown(want) || !medium || (unit && UNIT_MEDIUM[unit] && UNIT_MEDIUM[unit] !== medium)) return null;
      engine = want;
    }
    if (typeof p.units === "number" && p.units > 0) params.units = Math.max(1, Math.round(p.units));
    if (p.perShot === null) delete params.perShot; else if (typeof p.perShot === "number" && p.perShot > 0) params.perShot = Math.max(1, Math.round(p.perShot));
    /* A changed engine or count re-prices the stage from the registry, once for the batch — and a render stage the
       registry cannot price is refused, never written with the old engine's figure. The unit it was priced by stays
       on the stage, so every later read quotes it the same way. */
    if (typeof p.engine === "string" || typeof p.units === "number") {
      const unitUsd = unitUsdFor(engine, kind, unit);
      if (unitUsd == null) { if (kind === "render") return null; }
      else { params.credits = stagePrice(unitUsd, Math.max(1, Number(params.units ?? 1)), engine); if (unit && typeof params.unit !== "string") params.unit = unit; }
    }
    writes.push({
      sql: `UPDATE recipe_stages SET engine = ?, params = ?, mode = ?, cap_credits = ?, name = ?, updated_at = ? WHERE id = ?`,
      args: [engine, JSON.stringify(params), isStageMode(p.mode) ? p.mode : String(row.mode ?? "asks"),
             p.capCredits === undefined ? (row.cap_credits ?? null) : p.capCredits, typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : String(row.name ?? ""), ts, p.id],
    });
  }
  const sets: string[] = []; const args: (string | number)[] = [];
  if (typeof patch.name === "string" && patch.name.trim()) { sets.push("name = ?"); args.push(patch.name.trim().slice(0, 80)); }
  if (typeof patch.blurb === "string") { sets.push("blurb = ?"); args.push(patch.blurb.trim().slice(0, 160)); }
  sets.push("updated_at = ?"); args.push(ts);
  await db().execute({ sql: `UPDATE recipes SET ${sets.join(", ")} WHERE id = ?`, args: [...args, recipeId] });
  for (const w of writes) await db().execute(w);
  return recipeById(recipeId);
}

/** `Copy and change`: the same stages as a recipe of the workspace's own, under a project, ready to edit. */
export async function forkRecipe(recipeId: string, projectId: string, by: string): Promise<string | null> {
  await ready();
  const head = await db().execute({ sql: `SELECT * FROM recipes WHERE id = ?`, args: [recipeId] });
  if (!head.rows.length) return null;
  const src = head.rows[0] as any;
  /* The stored rows, verbatim — the recipe's own mode and counts, not a run's painting of them. */
  const defs = await db().execute({ sql: `SELECT * FROM recipe_stages WHERE recipe_id = ? ORDER BY position, num`, args: [recipeId] });
  const numOf = new Map((defs.rows as any[]).map((d) => [String(d.id), Number(d.num ?? 0)]));
  const stages: NewStage[] = (defs.rows as any[]).map((d) => {
    const p = jsonOrEmpty(d.params);
    return {
      num: Number(d.num ?? 0), name: String(d.name ?? ""), kind: d.kind === "write" || d.kind === "assemble" ? d.kind : "render", engine: String(d.engine ?? ""),
      units: typeof p.units === "number" ? p.units : undefined, credits: typeof p.credits === "number" ? p.credits : undefined,
      inputs: jsonList(d.inputs).map((i) => numOf.get(i)).filter((n): n is number => typeof n === "number"),
      mode: isStageMode(d.mode) ? d.mode : "asks", capCredits: d.cap_credits == null ? null : Number(d.cap_credits),
      unit: typeof p.unit === "string" ? p.unit : undefined, perShot: typeof p.perShot === "number" ? p.perShot : undefined,
    };
  });
  return createRecipe(projectId, `${String(src.name ?? "Recipe")} · copy`, stages, by, { blurb: String(src.blurb ?? "") });
}

/**
 * `Open as a board`: the board a recipe was saved from, or one laid out from
 * its stages — a node per stage, left to right, wired the way the stages
 * feed each other. Building is free; nothing here runs.
 */
export async function recipeToBoard(recipeId: string, projectId: string): Promise<string | null> {
  const r = await recipeById(recipeId);
  if (!r) return null;
  /* The board it was saved from — when that board is this project's. */
  const saved = r.boardId ? await getBoard(r.boardId) : null;
  if (saved && saved.projectId === projectId) return r.boardId;
  const board = await createBoard(projectId, r.name);
  const idOf = new Map(r.stages.map((s, i) => [s.id, `n${i + 1}`]));
  const kindOf = (s: RecipeStage): BoardNode["kind"] => { const m = MODELS.find((x) => x.id === s.engine); return m?.kind === "image" ? "image" : m?.kind === "video" ? "video" : s.kind === "assemble" ? "compare" : "note"; };
  const nodes: BoardNode[] = r.stages.map((s, i) => {
    const m = MODELS.find((x) => x.id === s.engine);
    const kind = kindOf(s);
    return {
      id: idOf.get(s.id)!, kind, x: 60 + i * 280, y: 140, label: s.name, ref: m ? { engine: m.id } : null,
      ports: [{ id: "out", label: "OUT" }], inputs: inputsFor(kind), output: null,
      settings: m?.kind === "video" ? { seconds: 5, resolution: m.resolutions.includes("1080p") ? "1080p" : m.resolutions[0], ratio: "16:9", count: 1 } : m?.kind === "image" ? { resolution: m.resolutions.includes("1K") ? "1K" : m.resolutions[0], ratio: "16:9", count: 1 } : {},
      state: "idle", credits: s.unitUsd != null ? stagePrice(s.unitUsd, 1, s.engine) : 0, staleSince: null, text: m ? undefined : `${s.name} · ${s.who}`,
    };
  });
  /* A wire lands on the slot the canvas reads: a still into a video node's `image`, a still into a still node's `refs`, two feeders into a compare's `a` and `b`. */
  const wires: BoardWire[] = [];
  const taken = new Map<string, number>();
  for (const s of r.stages) for (const from of s.inputs) {
    const src = r.stages.find((x) => x.id === from); const a = idOf.get(from), b = idOf.get(s.id);
    if (!src || !a || !b) continue;
    const to = kindOf(s), fromKind = kindOf(src);
    const slot = to === "video" && fromKind === "image" ? "image" : to === "image" && fromKind === "image" ? "refs" : to === "compare" ? ((taken.get(b) ?? 0) === 0 ? "a" : "b") : null;
    if (!slot) continue;
    taken.set(b, (taken.get(b) ?? 0) + 1);
    wires.push({ id: `w${wires.length + 1}`, from: { nodeId: a, portId: "out" }, to: { nodeId: b, slotId: slot }, kind: "created" });
  }
  await saveBoard(board.id, { nodes, wires });
  /* A workspace recipe remembers a board laid out in its own project (it had none, or none of its own); a board laid
     out for another project is a one-off, and the platform's recipes are read-only. */
  if (r.scope === "workspace" && projectId === r.projectId) await db().execute({ sql: `UPDATE recipes SET board_id = ?, updated_at = ? WHERE id = ?`, args: [board.id, now(), recipeId] });
  return board.id;
}

/* ── The platform's recipes (SOW §3 rule 3, §7.13; board 12i "two recipes") ──
   Seeded into every workspace, with no project of their own; every engine
   is a registry id and every price comes from the rate table at seed time.
   The unit counts that follow the shot list carry `perShot`, so a run on a
   ten-shot project prices ten shots and a run on three prices three. */

export const PLATFORM_RECIPES: { name: string; blurb: string; stages: NewStage[] }[] = [
  {
    name: "30-second spot",
    blurb: "Sketch everything cheaply, film only what you pick.",
    stages: [
      { num: 1, name: "Plan the shots", kind: "write", engine: DEFAULT_TEXT_MODELS.shot, units: 1, unit: "plan", mode: "alone", inputs: [] },
      { num: 2, name: "Sketch boards", kind: "render", engine: "gemini-3.1-flash-image", perShot: 3, unit: "panel", mode: "alone", inputs: [1] },
      { num: 3, name: "Keyframes", kind: "render", engine: "gemini-3-pro-image", perShot: 1, unit: "still", mode: "asks", inputs: [2] },
      { num: 4, name: "Draft takes", kind: "render", engine: "fal-ai/kling-video/v3/standard", perShot: 2, unit: "take", mode: "asks", inputs: [3] },
      { num: 5, name: "Hero takes", kind: "render", engine: DEFAULT_MODEL_ID, perShot: 1, unit: "take", mode: "asks", inputs: [4] },
      { num: 6, name: "Sound and cut", kind: "assemble", engine: "elevenlabs", perShot: 1, unit: "line", mode: "asks", inputs: [5] },
    ],
  },
  {
    name: "Product turntable",
    blurb: "One prop, eight views, a still that holds its shape.",
    stages: [
      { num: 1, name: "Hero still", kind: "render", engine: "gemini-3-pro-image", units: 1, unit: "still", mode: "alone", inputs: [] },
      { num: 2, name: "Turntable", kind: "render", engine: "gemini-3.1-flash-image", units: 8, unit: "view", mode: "alone", inputs: [1] },
      { num: 3, name: "Detail views", kind: "render", engine: "gemini-3.1-flash-image", units: 4, unit: "view", mode: "alone", inputs: [1] },
      { num: 4, name: "Cut out", kind: "render", engine: "fal-ai/bria/background/remove", units: 8, unit: "still", mode: "alone", inputs: [2] },
    ],
  },
];

/** A recipe's stages priced from the registry for a given shot count (ten when the list is unknown), rounded once per stage. */
export function priceStages(stages: NewStage[], shots = 10): NewStage[] {
  return stages.map((s) => {
    const units = s.perShot ? s.perShot * Math.max(1, shots) : Math.max(1, s.units ?? 1);
    const usd = unitUsdFor(s.engine ?? "", s.kind, s.unit);
    return { ...s, units, credits: usd == null ? (s.credits ?? 0) : stagePrice(usd, units, s.engine) };
  });
}

/** The platform's recipes have fixed ids, so two first reads at once write one copy. */
const PLATFORM_RECIPE_IDS = ["rec_platform_spot30", "rec_platform_turntable"];

/** The platform's recipes, written into this workspace once; harmless to call again, from any number of tabs. */
export async function ensurePlatformRecipes(by = "platform"): Promise<number> {
  await ready();
  let made = 0;
  for (let i = 0; i < PLATFORM_RECIPES.length; i++) {
    const r = PLATFORM_RECIPES[i];
    const id = PLATFORM_RECIPE_IDS[i];
    const have = await db().execute({ sql: `SELECT id FROM recipes WHERE id = ?`, args: [id] });
    if (have.rows.length) continue;
    const wrote = await createRecipe(null, r.name, priceStages(r.stages), by, { blurb: r.blurb, id });
    if (wrote) made++;
  }
  return made;
}
