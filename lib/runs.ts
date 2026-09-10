import { db, ready, now, id } from "./db";
import {
  cleanFailure, isStageState,
  type Failure, type RunView, type StageState, type StageView,
} from "./runState";

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
  params: Record<string, unknown>;
  inputs: string[];
  locks: string[];
  position: number;
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
  projectId: string | null;
  stages: RecipeStage[];
  locked: LockedElement[];
  /** The run the states came from, if any. */
  runId: string | null;
};

export async function recipeOf(projectId: string): Promise<RecipeGraph | null> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM recipes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
    args: [projectId],
  });
  if (!rs.rows.length) return null;
  const r = rs.rows[0] as any;

  /* The newest run's states are painted onto the recipe, so the stage layer
     shows what is happening rather than a diagram of what could. A recipe
     nobody has run yet reads as all queued, which is true. */
  const latest = await db().execute({
    sql: `SELECT id FROM runs WHERE recipe_id = ? ORDER BY started_at DESC LIMIT 1`,
    args: [String(r.id)],
  });
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
    return {
      id: String(def.id),
      num: Number(def.num ?? 0),
      name: String(def.name ?? ""),
      kind: kind === "write" || kind === "assemble" ? kind : "render",
      engine: String(def.engine ?? ""),
      params,
      inputs: jsonList(def.inputs),
      locks: jsonList(def.locks),
      position: Number(def.position ?? 0),
      state: stageState(got?.state),
      /* The run's estimate when there is a run; the recipe's own price otherwise. */
      credits: Math.max(0, round2(Number(got?.estimate_credits ?? params.credits ?? 0))),
      spent: Math.max(0, round2(Number(got?.spent_credits ?? 0))),
      doneUnits: Math.max(0, Number(got?.done_units ?? 0)),
      totalUnits: Math.max(0, Number(got?.total_units ?? params.units ?? 0)),
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

  return { id: String(r.id), name: String(r.name ?? ""), projectId: r.project_id ?? null, stages, locked, runId };
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
};

/** A recipe and its stages, for a production that has none. */
export async function createRecipe(projectId: string | null, name: string, stages: NewStage[], by: string): Promise<string> {
  await ready();
  const ts = now();
  const rid = id("rec");
  await db().execute({
    sql: `INSERT INTO recipes (id, project_id, name, draft, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    args: [rid, projectId, name.slice(0, 80), 0, by, ts, ts],
  });
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
    await db().execute({
      sql: `INSERT INTO recipe_stages (id, recipe_id, num, name, kind, engine, params, inputs, position, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [idOf.get(s.num)!, rid, s.num, s.name.slice(0, 60), s.kind, (s.engine ?? "").slice(0, 60),
             JSON.stringify(params), JSON.stringify(inputs), i, ts, ts],
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
