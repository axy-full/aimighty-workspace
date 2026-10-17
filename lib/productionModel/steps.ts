import type { Client, InStatement, Row, Transaction } from "@libsql/client";
import { db, id as newId, now, ready } from "../db";
import { columnInstaller } from "../schemaInitialization";
import { requireTenant } from "../tenant";
import { filmTypeConfig, filmTypeSteps, STEP_KIND, type FilmTypeStep } from "./filmTypes";
import { ProductionModelOffError, productionModelOn } from "./flag";

/**
 * A v30 production's steps, and the frame of each canvas step (docs/plans/v30-data-model.md § 2.1, 2.2; PR A1).
 *
 * Where it lives: the workspace's OWN database (lib/db.ts: one database per workspace). Every row also carries
 * `workspace_id`, first in its key and in every index, and every query here filters on the store's own workspace
 * (the lib/pipeline/store.ts idiom), so a store built for one workspace never reads or writes another's row, even
 * pointed at the wrong database.
 *
 * What it adds (all additive, all created lazily by `ready()`, which only flag-on code reaches):
 *   - `projects.film_type` (nullable): the film type a v30 production was made as; NULL for every production before v30;
 *   - `projects.canvas_store` (nullable, `team` | `v30`): which store is the truth for the production's canvas; NULL
 *     reads as `team`, today's canvas. Nothing in this PR writes it;
 *   - `production_steps`: one row per step. `page_id` is made once from the step's kind (`shots`, then `shots-2` …),
 *     unique in its production, never reused, and never changed: a trigger refuses any update to it, so a rename or a
 *     reorder cannot move it. A canvas step's frame is its four `frame_*` columns, so there is exactly one frame per
 *     canvas step by construction (CHECKs: a canvas step always has one, a document step never does).
 * Nothing is erased (rule 13): removing a step stamps `removed_at`/`removed_by`, and restoring clears them.
 */

export type StepSurface = "document" | "canvas";
export type StepFrame = { x: number; y: number; w: number; h: number };
export type ProductionStep = {
  id: string;
  productionId: string;
  pageId: string;
  kind: string;
  surface: StepSurface;
  label: string;
  position: number;
  frame: StepFrame | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  removedAt: number | null;
  removedBy: string | null;
};

export class ProductionStepError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProductionStepError";
  }
}

/** Which store holds a production's canvas: NULL (every production before v30) is today's team canvas. */
export const canvasStoreOf = (value: unknown): "team" | "v30" => (value === "v30" ? "v30" : "team");

/* Where a new canvas step's frame goes: left to right, one frame's width and a gap apart. Layout only. */
export const DEFAULT_FRAME = { w: 1920, h: 1080, gap: 240 } as const;

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const NOT_HERE = "That project is not in this workspace.";
const NO_STEP = "That step is not in this workspace.";

export const PRODUCTION_STEPS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS production_steps(
     workspace_id TEXT NOT NULL, id TEXT NOT NULL, production_id TEXT NOT NULL,
     page_id TEXT NOT NULL, kind TEXT NOT NULL,
     surface TEXT NOT NULL CHECK(surface IN ('document','canvas')),
     label TEXT NOT NULL, position INTEGER NOT NULL,
     frame_x REAL, frame_y REAL, frame_w REAL, frame_h REAL,
     created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     removed_at INTEGER, removed_by TEXT,
     CHECK(surface='canvas' OR (frame_x IS NULL AND frame_y IS NULL AND frame_w IS NULL AND frame_h IS NULL)),
     CHECK(surface='document' OR (frame_x IS NOT NULL AND frame_y IS NOT NULL AND COALESCE(frame_w,0) > 0 AND COALESCE(frame_h,0) > 0)),
     PRIMARY KEY(workspace_id,id),
     UNIQUE(workspace_id,production_id,page_id))`,
  `CREATE INDEX IF NOT EXISTS idx_production_steps_order ON production_steps(workspace_id,production_id,position)`,
  `CREATE TRIGGER IF NOT EXISTS production_steps_page_id_fixed BEFORE UPDATE OF workspace_id,production_id,page_id,kind,surface ON production_steps
     WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.production_id IS NOT OLD.production_id OR NEW.page_id IS NOT OLD.page_id
       OR NEW.kind IS NOT OLD.kind OR NEW.surface IS NOT OLD.surface
     BEGIN SELECT RAISE(ABORT,'A step keeps its page id, kind and production'); END`,
];

const boots = new WeakMap<Client, Promise<void>>();

function stepOf(row: Row): ProductionStep {
  const hasFrame = row.frame_x !== null && row.frame_x !== undefined;
  return {
    id: String(row.id),
    productionId: String(row.production_id),
    pageId: String(row.page_id),
    kind: String(row.kind),
    surface: row.surface === "document" ? "document" : "canvas",
    label: String(row.label),
    position: Number(row.position),
    frame: hasFrame ? { x: Number(row.frame_x), y: Number(row.frame_y), w: Number(row.frame_w), h: Number(row.frame_h) } : null,
    createdBy: String(row.created_by ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    removedAt: row.removed_at === null || row.removed_at === undefined ? null : Number(row.removed_at),
    removedBy: row.removed_by === null || row.removed_by === undefined ? null : String(row.removed_by),
  };
}

function cleanLabel(label: unknown): string {
  const text = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
  if (!text || text.length > 60) throw new ProductionStepError("A step's name is 1 to 60 characters.", 400);
  return text;
}

function cleanFrame(frame: StepFrame): StepFrame {
  const ok = [frame.x, frame.y, frame.w, frame.h].every((n) => typeof n === "number" && Number.isFinite(n)) && frame.w > 0 && frame.h > 0;
  if (!ok) throw new ProductionStepError("A frame has a place and a size above zero.", 400);
  return { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
}

/** The page id a new step of this kind gets: the kind itself, else the kind with the next free number (`shots-2`). */
export function nextPageId(kind: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(kind)) return kind;
  for (let n = 2; ; n++) if (!used.has(`${kind}-${n}`)) return `${kind}-${n}`;
}

export class ProductionStepStore {
  constructor(
    private client: Client,
    readonly workspaceId: string,
    private env: Record<string, string | undefined> = process.env,
  ) {
    if (!workspaceId) throw new ProductionStepError("Steps need a workspace.", 401);
  }

  /** The two `projects` columns and the steps table. Safe to run on any database any number of times. */
  async ready(): Promise<void> {
    let pending = boots.get(this.client);
    if (!pending) {
      pending = (async () => {
        const addColumn = await columnInstaller(this.client);
        await addColumn("projects", "film_type TEXT");
        await addColumn("projects", "canvas_store TEXT CHECK(canvas_store IN ('team','v30'))");
        await this.client.batch(PRODUCTION_STEPS_SCHEMA, "write");
      })().catch((error) => {
        boots.delete(this.client);
        throw error;
      });
      boots.set(this.client, pending);
    }
    await pending;
  }

  private async write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ready();
    const tx = await this.client.transaction("write");
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  }

  private async production(tx: Pick<Transaction, "execute">, productionId: string): Promise<{ filmType: string | null }> {
    if (!ID.test(productionId)) throw new ProductionStepError(NOT_HERE, 404);
    const row = (await tx.execute({ sql: "SELECT film_type FROM projects WHERE id=?", args: [productionId] })).rows[0];
    if (!row) throw new ProductionStepError(NOT_HERE, 404);
    return { filmType: row.film_type === null || row.film_type === undefined ? null : String(row.film_type) };
  }

  private async rows(tx: Pick<Transaction, "execute">, productionId: string, removed: boolean): Promise<ProductionStep[]> {
    const rs = await tx.execute({
      sql: `SELECT * FROM production_steps WHERE workspace_id=? AND production_id=?${removed ? "" : " AND removed_at IS NULL"}
            ORDER BY position, created_at, id`,
      args: [this.workspaceId, productionId],
    });
    return rs.rows.map(stepOf);
  }

  private async step(tx: Pick<Transaction, "execute">, stepId: string): Promise<ProductionStep> {
    if (!ID.test(stepId)) throw new ProductionStepError(NO_STEP, 404);
    const row = (await tx.execute({ sql: "SELECT * FROM production_steps WHERE workspace_id=? AND id=?", args: [this.workspaceId, stepId] })).rows[0];
    if (!row) throw new ProductionStepError(NO_STEP, 404);
    return stepOf(row);
  }

  private insert(stepId: string, productionId: string, step: FilmTypeStep, pageId: string, position: number, frame: StepFrame | null, by: string, at: number): InStatement {
    return {
      sql: `INSERT INTO production_steps(workspace_id,id,production_id,page_id,kind,surface,label,position,frame_x,frame_y,frame_w,frame_h,created_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        this.workspaceId, stepId, productionId, pageId, step.kind, step.surface, step.label, position,
        frame?.x ?? null, frame?.y ?? null, frame?.w ?? null, frame?.h ?? null, by, at, at,
      ],
    };
  }

  /**
   * Give a production its film type's steps, once. A production that already has steps (removed ones included) gets
   * nothing new and its steps back, so running this twice, or from two windows at once, makes one set.
   */
  async ensureSteps(productionId: string, filmType: string, by: string): Promise<ProductionStep[]> {
    if (!STEP_KIND.test(filmType)) throw new ProductionStepError("That film type is not on the list.", 400);
    const steps = filmTypeSteps(filmType, this.env);
    if (!steps) throw new ProductionStepError("That film type is not on the list.", 400);
    return this.write(async (tx) => {
      const production = await this.production(tx, productionId);
      if (production.filmType && production.filmType !== filmType)
        throw new ProductionStepError("This project already has a film type.", 409);
      const existing = await this.rows(tx, productionId, true);
      if (existing.length) return existing.filter((s) => s.removedAt === null);
      const at = now();
      if (!production.filmType)
        await tx.execute({ sql: "UPDATE projects SET film_type=? WHERE id=? AND film_type IS NULL", args: [filmType, productionId] });
      const taken: string[] = [];
      let canvasIndex = 0;
      for (const [position, step] of steps.entries()) {
        const pageId = nextPageId(step.kind, taken);
        taken.push(pageId);
        const frame = step.surface === "canvas" ? { x: canvasIndex++ * (DEFAULT_FRAME.w + DEFAULT_FRAME.gap), y: 0, w: DEFAULT_FRAME.w, h: DEFAULT_FRAME.h } : null;
        await tx.execute(this.insert(newId("pstep"), productionId, step, pageId, position, frame, by, at));
      }
      return this.rows(tx, productionId, false);
    });
  }

  /** The production's steps in rail order; removed ones only when asked. */
  async list(productionId: string, opts: { removed?: boolean } = {}): Promise<ProductionStep[]> {
    await this.ready();
    if (!ID.test(productionId)) return [];
    return this.rows(this.client, productionId, Boolean(opts.removed));
  }

  /** One step of this workspace, or null: a step of another workspace reads exactly as one that does not exist. */
  async get(stepId: string): Promise<ProductionStep | null> {
    await this.ready();
    try {
      return await this.step(this.client, stepId);
    } catch (error) {
      if (error instanceof ProductionStepError && error.status === 404) return null;
      throw error;
    }
  }

  async byPageId(productionId: string, pageId: string): Promise<ProductionStep | null> {
    await this.ready();
    const row = (await this.client.execute({
      sql: "SELECT * FROM production_steps WHERE workspace_id=? AND production_id=? AND page_id=?",
      args: [this.workspaceId, productionId, pageId],
    })).rows[0];
    return row ? stepOf(row) : null;
  }

  /** A new name. The page id stays what it was. */
  async rename(stepId: string, label: string): Promise<ProductionStep> {
    const text = cleanLabel(label);
    return this.write(async (tx) => {
      await this.step(tx, stepId);
      await tx.execute({ sql: "UPDATE production_steps SET label=?, updated_at=? WHERE workspace_id=? AND id=?", args: [text, now(), this.workspaceId, stepId] });
      return this.step(tx, stepId);
    });
  }

  /** A new rail order: exactly the production's live steps, each once. Page ids stay what they were. */
  async reorder(productionId: string, stepIds: string[]): Promise<ProductionStep[]> {
    return this.write(async (tx) => {
      await this.production(tx, productionId);
      const live = await this.rows(tx, productionId, false);
      const ids = new Set(live.map((s) => s.id));
      if (stepIds.length !== live.length || new Set(stepIds).size !== stepIds.length || !stepIds.every((s) => ids.has(s)))
        throw new ProductionStepError("The order must list each of the project's steps once.", 409);
      const at = now();
      for (const [position, stepId] of stepIds.entries())
        await tx.execute({ sql: "UPDATE production_steps SET position=?, updated_at=? WHERE workspace_id=? AND id=?", args: [position, at, this.workspaceId, stepId] });
      return this.rows(tx, productionId, false);
    });
  }

  /** Another step of a kind the production's film type has (a second Shots step is `shots-2`), at the end of the rail. */
  async add(productionId: string, kind: string, by: string, label?: string): Promise<ProductionStep> {
    return this.write(async (tx) => {
      const production = await this.production(tx, productionId);
      if (!production.filmType) throw new ProductionStepError("This project has no steps yet.", 409);
      const step = filmTypeSteps(production.filmType, this.env)?.find((s) => s.kind === kind);
      if (!step) throw new ProductionStepError("That step is not one this project's film type has.", 400);
      const all = await this.rows(tx, productionId, true);
      const pageId = nextPageId(kind, all.map((s) => s.pageId));
      const position = all.reduce((max, s) => Math.max(max, s.position), -1) + 1;
      const right = all.filter((s) => s.removedAt === null && s.frame).reduce((max, s) => Math.max(max, s.frame!.x + s.frame!.w + DEFAULT_FRAME.gap), 0);
      const frame = step.surface === "canvas" ? { x: right, y: 0, w: DEFAULT_FRAME.w, h: DEFAULT_FRAME.h } : null;
      const stepId = newId("pstep");
      await tx.execute(this.insert(stepId, productionId, { ...step, label: label === undefined ? step.label : cleanLabel(label) }, pageId, position, frame, by, now()));
      return this.step(tx, stepId);
    });
  }

  /** Move or resize a canvas step's frame. A document step has none. */
  async moveFrame(stepId: string, frame: StepFrame): Promise<ProductionStep> {
    const next = cleanFrame(frame);
    return this.write(async (tx) => {
      const step = await this.step(tx, stepId);
      if (step.surface !== "canvas") throw new ProductionStepError("A document step has no frame.", 409);
      await tx.execute({
        sql: "UPDATE production_steps SET frame_x=?, frame_y=?, frame_w=?, frame_h=?, updated_at=? WHERE workspace_id=? AND id=?",
        args: [next.x, next.y, next.w, next.h, now(), this.workspaceId, stepId],
      });
      return this.step(tx, stepId);
    });
  }

  /** Take a step off the rail. Nothing is erased; its page id is never given to another step. */
  async remove(stepId: string, by: string): Promise<ProductionStep> {
    return this.write(async (tx) => {
      await this.step(tx, stepId);
      const at = now();
      await tx.execute({
        sql: "UPDATE production_steps SET removed_at=?, removed_by=?, updated_at=? WHERE workspace_id=? AND id=? AND removed_at IS NULL",
        args: [at, by, at, this.workspaceId, stepId],
      });
      return this.step(tx, stepId);
    });
  }

  /** Undo a removal. */
  async restore(stepId: string): Promise<ProductionStep> {
    return this.write(async (tx) => {
      await this.step(tx, stepId);
      await tx.execute({
        sql: "UPDATE production_steps SET removed_at=NULL, removed_by=NULL, updated_at=? WHERE workspace_id=? AND id=?",
        args: [now(), this.workspaceId, stepId],
      });
      return this.step(tx, stepId);
    });
  }
}

/**
 * The steps store for the workspace in scope, or a 404 when the production model is off for it (lib/productionModel/flag.ts).
 * With the flag off this refuses before touching the database, so no workspace database gains a column or a table.
 * Who may reach a production (lib/draftProject.ts mayReachProject) is the caller's question, as for the team canvas.
 */
export async function productionSteps(): Promise<ProductionStepStore> {
  const workspace = requireTenant();
  if (!(await productionModelOn(workspace))) throw new ProductionModelOffError();
  filmTypeConfig();
  await ready();
  return new ProductionStepStore(db(), workspace.id);
}
