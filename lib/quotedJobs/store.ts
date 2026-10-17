import type { Client, InStatement, Row, Transaction } from "@libsql/client";
import { creditsApply } from "../credits";
import { db, id as newId, now, ready } from "../db";
import { failureCopy } from "../errors";
import { jobCsv, jobErrorLine, publicCommand, publicJob, recreateRecipe, type PublicCommand, type PublicJob, type Recipe, type ViewOptions } from "../jobView";
import { parseOutcome, type ProviderOutcome } from "../providerOutcome";
import { ceilTenths } from "../runLimit";
import { assertPerson, PeopleOnlyError, type Caller } from "../security/people-only";
import { requireTenant } from "../tenant";
import { isPersonApprover } from "../workbench/plan-approval";
import { JobsOffError, jobsOn } from "./flag";
import {
  COMMAND_MOVES, COMMAND_STATES, DECIDERS, FINISHED, JOB_MOVES, JOB_STATUSES, PRODUCTS, REFUND_STATUSES,
  refundStatusOf, sqlList, type CommandState, type Decider, type JobProduct, type JobStatus,
} from "./vocabulary";

/**
 * v30 jobs and Agent commands (docs/plans/v30-data-model.md § 4.1, 4.2; PR A3), and the only writer of both tables.
 *
 * Where it lives: the workspace's OWN database (lib/db.ts: one database per workspace). Both tables also carry
 * `workspace_id`, first in every key and every index, and every query here filters on the store's own workspace (the
 * lib/pipeline/store.ts idiom). THE tenant defence is the factory: the store is built only by `quotedJobs()`, which
 * always pairs db() with requireTenant().id, so product code cannot point a store at another workspace's database.
 * Behind it, as extra layers: every method refuses unless the store's workspace is the one in scope, and a production
 * whose jobs are already held under another workspace's id is answered as not found.
 *
 * What a row holds, and what it does not:
 *   - `quoted_jobs`: one row per job, written only once it has a quote (brief rule 4), with who decided (`decider`:
 *     agent | director), what it makes (`product`), its engine (PRIVATE: read only here and by lib/jobView.ts), the
 *     quote in credits, a pointer to the meter record (`meter_id`), the take it made, its status and, once it fails or
 *     is cancelled, its refund status (lib/quotedJobs/vocabulary.ts refundStatusOf).
 *   - One unit: every quote is in credits, for every workspace. The house too is quoted in credits, at cost, as
 *     `quotedCredits()` (lib/credits.ts) already counts it for its approvals, so no engine dollars sit on this table.
 *   - NOT the actual charge: that is `meter_events.billed_credits`, read in the workspace through `credit_receipts`
 *     (lib/creditReceipts.ts). NOT a vendor cost: that stays on `meter_events`, on the platform admin desk.
 *   - `agent_commands`: one row per Agent instruction, with the total quoted before it ran. `instruction` holds ONLY
 *     the person's own words, never a prompt Atomik wrote or anything naming an engine (the wiring, PR A10, must keep
 *     to that). Its total spent is never stored: it is the sum of its jobs' receipts. The approval stays in
 *     `rig_plan_approvals`; a command points at it, after this store has checked it.
 *
 * Money: nothing here reserves, meters, settles, refunds or charges anything, and no paid path calls this store (that
 * is PR A10, after the freeze). `refund_status` records what the vendor did; it changes no bill.
 *
 * States move forward only: THIS STORE enforces the moves (vocabulary.ts JOB_MOVES, COMMAND_MOVES). The tables add
 * what a second writer could break: a quote is required, the fixed fields never change, the pointers are set once, a
 * finished row stays finished, and a refund status exists exactly on a failed or cancelled job.
 *
 * Every read returns lib/jobView.ts output, never a raw row, so nothing outside these two files ever holds an Agent
 * job's engine. Nothing is erased: there is no delete.
 */

export class QuotedJobError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "QuotedJobError";
  }
}

/** A quote, in credits, as `quotedCredits()` gives it for the workspace in scope (at cost for the house). */
export type QuoteInput = { credits: number };

export type NewCommand = {
  productionId?: string | null;
  stepId?: string | null;
  /** The person's own words. Never a prompt Atomik wrote, never an engine's name. */
  instruction: string;
  quote: QuoteInput;
  by: string;
};

export type NewJob = {
  productionId?: string | null;
  stepId?: string | null;
  nodeId?: string | null;
  commandId?: string | null;
  decider: Decider;
  product: JobProduct;
  /** The engine chosen for it. Private: no read returns it for an Agent job. */
  engine?: string | null;
  quote: QuoteInput;
  /** The product's own row: `paid_text_jobs:<id>`, `document_imports:<id>` … */
  sourceRef?: string | null;
  meterId?: string | null;
  takeId?: string | null;
  by: string;
};

export type JobFilter = { productionId?: string; stepId?: string; commandId?: string; limit?: number };

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ENGINE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SOURCE_REF = /^[a-z][a-z0-9_]{0,63}:[A-Za-z0-9_-]{1,100}$/;
const NOT_HERE = "That project is not in this workspace.";
const NO_JOB = "That job is not in this workspace.";
const NO_COMMAND = "That instruction is not in this workspace.";
const NO_APPROVAL = "That approval is not in this workspace.";
const OTHER_SCOPE = "This store is not for the workspace in scope.";

export const QUOTED_JOBS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS agent_commands(
     workspace_id TEXT NOT NULL, id TEXT NOT NULL, production_id TEXT, step_id TEXT,
     instruction TEXT NOT NULL,
     quote_tenths INTEGER NOT NULL CHECK(quote_tenths >= 0),
     approval_ref TEXT, run_ref TEXT,
     state TEXT NOT NULL CHECK(state IN (${sqlList(COMMAND_STATES)})),
     created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     CHECK(state IN ('quoted','declined','cancelled') OR approval_ref IS NOT NULL),
     PRIMARY KEY(workspace_id,id))`,
  `CREATE INDEX IF NOT EXISTS idx_agent_commands_production ON agent_commands(workspace_id,production_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_commands_member ON agent_commands(workspace_id,created_by,created_at)`,
  `CREATE TRIGGER IF NOT EXISTS agent_commands_fixed BEFORE UPDATE ON agent_commands
     WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.production_id IS NOT OLD.production_id
       OR NEW.step_id IS NOT OLD.step_id OR NEW.instruction IS NOT OLD.instruction OR NEW.quote_tenths IS NOT OLD.quote_tenths
       OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
       OR (OLD.approval_ref IS NOT NULL AND NEW.approval_ref IS NOT OLD.approval_ref)
       OR (OLD.run_ref IS NOT NULL AND NEW.run_ref IS NOT OLD.run_ref)
       OR (OLD.state IN ('done','failed','cancelled','declined') AND NEW.state IS NOT OLD.state)
     BEGIN SELECT RAISE(ABORT,'An instruction keeps its words, its quote and its approval'); END`,

  `CREATE TABLE IF NOT EXISTS quoted_jobs(
     workspace_id TEXT NOT NULL, id TEXT NOT NULL,
     production_id TEXT, step_id TEXT, node_id TEXT, command_id TEXT,
     decider TEXT NOT NULL CHECK(decider IN (${sqlList(DECIDERS)})),
     product TEXT NOT NULL CHECK(product IN (${sqlList(PRODUCTS)})),
     engine TEXT,
     quote_tenths INTEGER NOT NULL CHECK(quote_tenths >= 0),
     quoted_at INTEGER NOT NULL,
     meter_id TEXT, take_id TEXT, source_ref TEXT,
     status TEXT NOT NULL CHECK(status IN (${sqlList(JOB_STATUSES)})),
     refund_status TEXT CHECK(refund_status IS NULL OR refund_status IN (${sqlList(REFUND_STATUSES)})),
     error_public TEXT,
     created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
     started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
     CHECK(command_id IS NULL OR decider = 'agent'),
     CHECK((status IN ('failed','cancelled')) = (refund_status IS NOT NULL)),
     PRIMARY KEY(workspace_id,id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_quoted_jobs_meter ON quoted_jobs(workspace_id,meter_id) WHERE meter_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_quoted_jobs_production ON quoted_jobs(workspace_id,production_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_quoted_jobs_command ON quoted_jobs(workspace_id,command_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quoted_jobs_step ON quoted_jobs(workspace_id,step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quoted_jobs_take ON quoted_jobs(workspace_id,take_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quoted_jobs_member ON quoted_jobs(workspace_id,created_by,created_at)`,
  /* What was quoted, who decided and what it was made with are written once. The meter and take pointers are set once.
     A finished job stays finished, with the refund status it was given. */
  `CREATE TRIGGER IF NOT EXISTS quoted_jobs_fixed BEFORE UPDATE ON quoted_jobs
     WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.production_id IS NOT OLD.production_id
       OR NEW.step_id IS NOT OLD.step_id OR NEW.node_id IS NOT OLD.node_id OR NEW.command_id IS NOT OLD.command_id
       OR NEW.decider IS NOT OLD.decider OR NEW.product IS NOT OLD.product OR NEW.engine IS NOT OLD.engine
       OR NEW.quote_tenths IS NOT OLD.quote_tenths OR NEW.quoted_at IS NOT OLD.quoted_at
       OR NEW.source_ref IS NOT OLD.source_ref OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
       OR (OLD.meter_id IS NOT NULL AND NEW.meter_id IS NOT OLD.meter_id)
       OR (OLD.take_id IS NOT NULL AND NEW.take_id IS NOT OLD.take_id)
       OR (OLD.status IN ('done','failed','cancelled') AND (NEW.status IS NOT OLD.status OR NEW.refund_status IS NOT OLD.refund_status OR NEW.error_public IS NOT OLD.error_public))
     BEGIN SELECT RAISE(ABORT,'A job keeps its quote, its decider and its engine'); END`,
];

/* The read every job view is built from: the job, its receipt (the meter's, replicated), and its take. */
const JOB_READ = `SELECT j.*, r.credits AS receipt_credits,
       g.model AS take_model, g.prompt AS take_prompt, g.params AS take_params, g.provider_outcome AS take_outcome,
       p.recorded AS take_recorded
  FROM quoted_jobs j
  LEFT JOIN credit_receipts r ON r.event_id = j.meter_id
  LEFT JOIN generations g ON g.id = j.take_id
  LEFT JOIN take_provenance p ON p.take_id = j.take_id`;

const COMMAND_READ = `SELECT c.*,
       (SELECT COALESCE(SUM(r.credits),0) FROM quoted_jobs j JOIN credit_receipts r ON r.event_id = j.meter_id
         WHERE j.workspace_id = c.workspace_id AND j.command_id = c.id) AS total_credits,
       (SELECT COUNT(*) FROM quoted_jobs j WHERE j.workspace_id = c.workspace_id AND j.command_id = c.id) AS job_count,
       (SELECT COALESCE(SUM(j.quote_tenths),0) FROM quoted_jobs j WHERE j.workspace_id = c.workspace_id AND j.command_id = c.id) AS jobs_quote_tenths
  FROM agent_commands c`;

const boots = new WeakMap<Client, Promise<void>>();

function cleanId(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ID.test(value)) throw new QuotedJobError(`That ${what} id is not valid.`, 400);
  return value;
}

function cleanBy(by: unknown): string {
  if (typeof by !== "string" || !by.trim() || by.length > 200) throw new QuotedJobError("A job needs who asked for it.", 400);
  return by;
}

/** A quote in credits, as whole tenths rounded up (the lib/runLimit.ts idiom: a price is never read below itself). */
function quoteTenths(input: QuoteInput): number {
  const q = input as Partial<Record<string, unknown>> | null;
  const keys = q && typeof q === "object" ? Object.keys(q) : [];
  if (q && keys.length === 1 && keys[0] === "credits" && typeof q.credits === "number" && Number.isFinite(q.credits) && q.credits >= 0)
    return ceilTenths(q.credits);
  throw new QuotedJobError("A job is written only with its quote, in credits.", 400);
}

/* Not exported: the store is reachable only through `quotedJobs()`, which always pairs db() with requireTenant().id
   (and, for the crossed-database tests alone, `jobStoreForTests`). The per-method tenant check below is a second layer. */
class JobStore {
  readonly #client: Client;
  readonly workspaceId: string;

  constructor(client: Client, workspaceId: string) {
    if (!workspaceId) throw new QuotedJobError("Jobs need a workspace.", 401);
    this.#client = client;
    this.workspaceId = workspaceId;
  }

  /** Every method starts here: the store answers only for the workspace in scope. */
  #scoped(): ViewOptions {
    const tenant = requireTenant();
    if (tenant.id !== this.workspaceId) throw new QuotedJobError(OTHER_SCOPE, 403);
    return { credits: creditsApply(tenant) };
  }

  /** Both tables. Safe on any database any number of times. */
  async ready(): Promise<void> {
    this.#scoped();
    let pending = boots.get(this.#client);
    if (!pending) {
      pending = this.#client.batch(QUOTED_JOBS_SCHEMA, "write").then(() => undefined).catch((error) => {
        boots.delete(this.#client);
        throw error;
      });
      boots.set(this.#client, pending);
    }
    await pending;
  }

  async #write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ready();
    const tx = await this.#client.transaction("write");
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

  /** `projects` is scoped by its database only; jobs of it held under another workspace's id mean this is not our database. */
  async #production(tx: Pick<Transaction, "execute">, productionId: string | null): Promise<void> {
    if (productionId === null) return;
    const row = (await tx.execute({ sql: "SELECT 1 FROM projects WHERE id=?", args: [productionId] })).rows[0];
    if (!row) throw new QuotedJobError(NOT_HERE, 404);
    const foreign = await tx.execute({
      sql: `SELECT 1 FROM quoted_jobs WHERE production_id=? AND workspace_id<>?
            UNION ALL SELECT 1 FROM agent_commands WHERE production_id=? AND workspace_id<>? LIMIT 1`,
      args: [productionId, this.workspaceId, productionId, this.workspaceId],
    });
    if (foreign.rows.length) throw new QuotedJobError(NOT_HERE, 404);
  }

  async #jobRow(tx: Pick<Transaction, "execute">, jobId: string): Promise<Row> {
    if (!ID.test(jobId)) throw new QuotedJobError(NO_JOB, 404);
    const row = (await tx.execute({ sql: `${JOB_READ} WHERE j.workspace_id=? AND j.id=?`, args: [this.workspaceId, jobId] })).rows[0];
    if (!row) throw new QuotedJobError(NO_JOB, 404);
    return row;
  }

  async #commandRow(tx: Pick<Transaction, "execute">, commandId: string): Promise<Row> {
    if (!ID.test(commandId)) throw new QuotedJobError(NO_COMMAND, 404);
    const row = (await tx.execute({ sql: `${COMMAND_READ} WHERE c.workspace_id=? AND c.id=?`, args: [this.workspaceId, commandId] })).rows[0];
    if (!row) throw new QuotedJobError(NO_COMMAND, 404);
    return row;
  }

  /* ── commands ─────────────────────────────────────────────────────── */

  /** One Agent instruction, with the total quoted for it. Writing it approves nothing and spends nothing. */
  async createCommand(input: NewCommand): Promise<PublicCommand> {
    const view = this.#scoped();
    const productionId = cleanId(input.productionId, "project");
    const stepId = cleanId(input.stepId, "step");
    const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
    if (!instruction || instruction.length > 4000) throw new QuotedJobError("An instruction is 1 to 4,000 characters.", 400);
    const tenths = quoteTenths(input.quote);
    const by = cleanBy(input.by);
    return this.#write(async (tx) => {
      await this.#production(tx, productionId);
      const commandId = newId("acmd");
      const at = now();
      await tx.execute({
        sql: `INSERT INTO agent_commands(workspace_id,id,production_id,step_id,instruction,quote_tenths,state,created_by,created_at,updated_at)
              VALUES(?,?,?,?,?,?,'quoted',?,?,?)`,
        args: [this.workspaceId, commandId, productionId, stepId, instruction, tenths, by, at, at],
      });
      return publicCommand(await this.#commandRow(tx, commandId), view);
    });
  }

  /**
   * Point a command at the approval a person gave. Approving spend is a person's alone (CLAUDE.md rules 11 and 14):
   * Atomik, an MCP client, an API token and any machine id are refused (assertPerson, then plan-approval.ts
   * isPersonApprover). The approval must be a `rig_plan_approvals` row of the same production, still open, given by a
   * person, whose total covers the command's quote.
   */
  async approveCommand(commandId: string, approvalRef: string, caller: Caller): Promise<PublicCommand> {
    const view = this.#scoped();
    assertPerson(caller);
    if (!isPersonApprover(caller.user?.id)) throw new PeopleOnlyError();
    const ref = cleanId(approvalRef, "approval");
    if (!ref) throw new QuotedJobError("An approval needs its record.", 400);
    return this.#write(async (tx) => {
      const row = await this.#commandRow(tx, commandId);
      if (row.state !== "quoted") throw new QuotedJobError("That instruction is not waiting for approval.", 409);
      const table = await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_plan_approvals'");
      const approval = table.rows.length
        ? (await tx.execute({ sql: "SELECT production_id, approved_by, total_tenths, expires_at, closed_at FROM rig_plan_approvals WHERE id=?", args: [ref] })).rows[0]
        : undefined;
      if (!approval || row.production_id === null || String(approval.production_id) !== String(row.production_id))
        throw new QuotedJobError(NO_APPROVAL, 404);
      if (!isPersonApprover(approval.approved_by)) throw new PeopleOnlyError();
      if (approval.closed_at !== null || Number(approval.expires_at) <= now()) throw new QuotedJobError("That approval is closed.", 409);
      if (Number(approval.total_tenths) < Number(row.quote_tenths)) throw new QuotedJobError("That approval does not cover this instruction's quote.", 409);
      await tx.execute({
        sql: "UPDATE agent_commands SET state='approved', approval_ref=?, updated_at=? WHERE workspace_id=? AND id=? AND state='quoted'",
        args: [ref, now(), this.workspaceId, commandId],
      });
      return publicCommand(await this.#commandRow(tx, commandId), view);
    });
  }

  /** Move a command on (never to `approved`: that is approveCommand, a person's). */
  async moveCommand(commandId: string, state: Exclude<CommandState, "quoted" | "approved">, opts: { runRef?: string } = {}): Promise<PublicCommand> {
    const view = this.#scoped();
    if (!COMMAND_STATES.includes(state) || state === ("approved" as CommandState) || state === ("quoted" as CommandState))
      throw new QuotedJobError("That is not a step an instruction can take.", 400);
    const runRef = cleanId(opts.runRef, "run");
    return this.#write(async (tx) => {
      const row = await this.#commandRow(tx, commandId);
      const from = String(row.state) as CommandState;
      if (!COMMAND_MOVES[from]?.includes(state)) throw new QuotedJobError(`An instruction that is ${from} cannot become ${state}.`, 409);
      await tx.execute({
        sql: "UPDATE agent_commands SET state=?, run_ref=COALESCE(run_ref,?), updated_at=? WHERE workspace_id=? AND id=? AND state=?",
        args: [state, runRef, now(), this.workspaceId, commandId, from],
      });
      return publicCommand(await this.#commandRow(tx, commandId), view);
    });
  }

  async getCommand(commandId: string): Promise<PublicCommand | null> {
    const view = this.#scoped();
    await this.ready();
    if (!ID.test(commandId)) return null;
    const row = (await this.#client.execute({ sql: `${COMMAND_READ} WHERE c.workspace_id=? AND c.id=?`, args: [this.workspaceId, commandId] })).rows[0];
    return row ? publicCommand(row, view) : null;
  }

  async listCommands(productionId: string, limit = 200): Promise<PublicCommand[]> {
    const view = this.#scoped();
    await this.ready();
    if (!ID.test(productionId)) return [];
    const rs = await this.#client.execute({
      sql: `${COMMAND_READ} WHERE c.workspace_id=? AND c.production_id=? ORDER BY c.created_at DESC, c.id LIMIT ?`,
      args: [this.workspaceId, productionId, Math.max(1, Math.min(1000, Math.floor(limit)))],
    });
    return rs.rows.map((row) => publicCommand(row, view));
  }

  /* ── jobs ─────────────────────────────────────────────────────────── */

  /**
   * One job, written with its quote before anything runs. Writing it reserves, meters and charges nothing. A job of an
   * instruction is written only once a person approved the instruction (approved or running), and only while the
   * instruction's jobs, this one included, fit inside the instruction's quote.
   */
  async createJob(input: NewJob): Promise<PublicJob> {
    const view = this.#scoped();
    if (!DECIDERS.includes(input.decider)) throw new QuotedJobError("A job is decided by the Agent or the Director.", 400);
    if (!PRODUCTS.includes(input.product)) throw new QuotedJobError("That is not a product a job makes.", 400);
    const productionId = cleanId(input.productionId, "project");
    const stepId = cleanId(input.stepId, "step");
    const nodeId = cleanId(input.nodeId, "card");
    const commandId = cleanId(input.commandId, "instruction");
    const meterId = cleanId(input.meterId, "meter");
    const takeId = cleanId(input.takeId, "take");
    const engine = input.engine === undefined || input.engine === null || input.engine === "" ? null : input.engine;
    if (engine !== null && (typeof engine !== "string" || !ENGINE.test(engine))) throw new QuotedJobError("That engine id is not valid.", 400);
    const sourceRef = input.sourceRef === undefined || input.sourceRef === null || input.sourceRef === "" ? null : input.sourceRef;
    if (sourceRef !== null && (typeof sourceRef !== "string" || !SOURCE_REF.test(sourceRef))) throw new QuotedJobError("That source is not valid.", 400);
    if (commandId && input.decider !== "agent") throw new QuotedJobError("Only an Agent job belongs to an instruction.", 400);
    const tenths = quoteTenths(input.quote);
    const by = cleanBy(input.by);
    return this.#write(async (tx) => {
      await this.#production(tx, productionId);
      if (commandId) {
        const command = await this.#commandRow(tx, commandId);
        if ((command.production_id ?? null) !== productionId) throw new QuotedJobError(NO_COMMAND, 404);
        if (command.state !== "approved" && command.state !== "running")
          throw new QuotedJobError("That instruction has not been approved by a person.", 409);
        if (Number(command.jobs_quote_tenths) + tenths > Number(command.quote_tenths))
          throw new QuotedJobError("This job does not fit inside the instruction's approved quote.", 409);
      }
      if (meterId) {
        const taken = await tx.execute({ sql: "SELECT 1 FROM quoted_jobs WHERE workspace_id=? AND meter_id=?", args: [this.workspaceId, meterId] });
        if (taken.rows.length) throw new QuotedJobError("That meter record already belongs to a job.", 409);
      }
      const jobId = newId("qjob");
      const at = now();
      await tx.execute({
        sql: `INSERT INTO quoted_jobs(workspace_id,id,production_id,step_id,node_id,command_id,decider,product,engine,quote_tenths,
                quoted_at,meter_id,take_id,source_ref,status,created_by,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
        args: [this.workspaceId, jobId, productionId, stepId, nodeId, commandId, input.decider, input.product, engine, tenths,
          at, meterId, takeId, sourceRef, by, at, at],
      });
      return publicJob(await this.#jobRow(tx, jobId), view);
    });
  }

  /** Set the meter record and the take, each once. */
  async attach(jobId: string, refs: { meterId?: string; takeId?: string }): Promise<PublicJob> {
    const view = this.#scoped();
    const meterId = cleanId(refs.meterId, "meter");
    const takeId = cleanId(refs.takeId, "take");
    return this.#write(async (tx) => {
      const row = await this.#jobRow(tx, jobId);
      const writes: InStatement[] = [];
      if (meterId && row.meter_id !== meterId) {
        if (row.meter_id) throw new QuotedJobError("That job already has its meter record.", 409);
        const taken = await tx.execute({ sql: "SELECT 1 FROM quoted_jobs WHERE workspace_id=? AND meter_id=?", args: [this.workspaceId, meterId] });
        if (taken.rows.length) throw new QuotedJobError("That meter record already belongs to a job.", 409);
        writes.push({ sql: "UPDATE quoted_jobs SET meter_id=?, updated_at=? WHERE workspace_id=? AND id=? AND meter_id IS NULL", args: [meterId, now(), this.workspaceId, jobId] });
      }
      if (takeId && row.take_id !== takeId) {
        if (row.take_id) throw new QuotedJobError("That job already has its take.", 409);
        writes.push({ sql: "UPDATE quoted_jobs SET take_id=?, updated_at=? WHERE workspace_id=? AND id=? AND take_id IS NULL", args: [takeId, now(), this.workspaceId, jobId] });
      }
      if (writes.length) await tx.batch(writes);
      return publicJob(await this.#jobRow(tx, jobId), view);
    });
  }

  async start(jobId: string): Promise<PublicJob> {
    return this.#move(jobId, "running");
  }

  /**
   * A job finished. A failed or cancelled job gets its refund status from the provider's outcome, written once by the
   * one mapping (refundStatusOf), and our own sentence for what happened. It changes no charge.
   */
  async finish(jobId: string, status: "done" | "failed" | "cancelled", outcome: ProviderOutcome | string | null = null): Promise<PublicJob> {
    if (!FINISHED.includes(status)) throw new QuotedJobError("A job finishes done, failed or cancelled.", 400);
    return this.#move(jobId, status, outcome);
  }

  async #move(jobId: string, status: JobStatus, outcome: ProviderOutcome | string | null = null): Promise<PublicJob> {
    const view = this.#scoped();
    return this.#write(async (tx) => {
      const row = await this.#jobRow(tx, jobId);
      const from = String(row.status) as JobStatus;
      if (!JOB_MOVES[from]?.includes(status)) throw new QuotedJobError(`A job that is ${from} cannot become ${status}.`, 409);
      const at = now();
      const ended = status === "failed" || status === "cancelled";
      const parsed = typeof outcome === "string" ? parseOutcome(outcome) : outcome ? parseOutcome(outcome) : null;
      const payer = parsed?.funding === "platform" ? "platform" : parsed?.funding === "own" ? "own" : null;
      /* Our words, never the vendor's: the failure's kind, through the one copy table (lib/errors.ts). */
      const error = !ended ? null : status === "cancelled" && (!parsed || parsed.kind === "unknown" || parsed.kind === "canceled") ? "Cancelled" : failureCopy(parsed?.kind ?? "unknown", payer).what;
      await tx.execute({
        sql: `UPDATE quoted_jobs SET status=?, refund_status=?, error_public=?, updated_at=?,
                started_at=CASE WHEN ?='running' THEN ? ELSE started_at END,
                finished_at=CASE WHEN ? IN ('done','failed','cancelled') THEN ? ELSE finished_at END
              WHERE workspace_id=? AND id=? AND status=?`,
        args: [status, ended ? refundStatusOf(parsed) : null, error, at, status, at, status, at, this.workspaceId, jobId, from],
      });
      return publicJob(await this.#jobRow(tx, jobId), view);
    });
  }

  /** One job of this workspace, or null: a job of another workspace reads exactly as one that does not exist. */
  async get(jobId: string): Promise<PublicJob | null> {
    const view = this.#scoped();
    const row = await this.#read(jobId);
    return row ? publicJob(row, view) : null;
  }

  async list(filter: JobFilter = {}): Promise<PublicJob[]> {
    const view = this.#scoped();
    return (await this.#rows(filter)).map((row) => publicJob(row, view));
  }

  /** The CSV of the jobs a filter names, through the serializer (Agent rows carry no engine). */
  async csv(filter: JobFilter = {}): Promise<string> {
    const view = this.#scoped();
    return jobCsv(await this.#rows(filter), view);
  }

  /** A failed or cancelled job's failure line, or null. */
  async errorLine(jobId: string) {
    const view = this.#scoped();
    const row = await this.#read(jobId);
    return row ? jobErrorLine(row, view) : null;
  }

  /** What Recreate starts from (an Agent job hands Director an empty engine). */
  async recipe(jobId: string): Promise<Recipe | null> {
    this.#scoped();
    const row = await this.#read(jobId);
    return row ? recreateRecipe(row) : null;
  }

  async #read(jobId: string): Promise<Row | null> {
    await this.ready();
    if (!ID.test(jobId)) return null;
    return (await this.#client.execute({ sql: `${JOB_READ} WHERE j.workspace_id=? AND j.id=?`, args: [this.workspaceId, jobId] })).rows[0] ?? null;
  }

  async #rows(filter: JobFilter): Promise<Row[]> {
    await this.ready();
    const where = ["j.workspace_id=?"];
    const args: (string | number)[] = [this.workspaceId];
    for (const [column, value] of [["production_id", filter.productionId], ["step_id", filter.stepId], ["command_id", filter.commandId]] as const) {
      if (value === undefined) continue;
      if (!ID.test(value)) return [];
      where.push(`j.${column}=?`);
      args.push(value);
    }
    args.push(Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 200))));
    return (await this.#client.execute({ sql: `${JOB_READ} WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC, j.id LIMIT ?`, args })).rows;
  }
}

export type QuotedJobStore = JobStore;

/**
 * The jobs store for the workspace in scope, or a 404 when v30 jobs are off for it (lib/quotedJobs/flag.ts). With the
 * flag off this refuses before touching the database, so no workspace database gains a table.
 */
export async function quotedJobs(): Promise<QuotedJobStore> {
  const workspace = requireTenant();
  if (!(await jobsOn(workspace))) throw new JobsOffError();
  await ready();
  return new JobStore(db(), workspace.id);
}

/**
 * TESTS ONLY. A store on any client for any workspace id, so the tests can point one at the wrong database and prove it
 * still reads and writes nothing there. No source file outside tests/, other than this one, may name it
 * (tests/unit/jobEngineGuard.spec.ts guards that).
 */
export function jobStoreForTests(client: Client, workspaceId: string): QuotedJobStore {
  return new JobStore(client, workspaceId);
}
