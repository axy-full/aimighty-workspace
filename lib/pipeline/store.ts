import { randomUUID } from "node:crypto";
import type { Client, Transaction, Row } from "@libsql/client";
import { db } from "../db";
import { validateMediaSources } from "../mediaMutation";
import { requireTenant } from "../tenant";
import { workbenchReady } from "../workbench/records";
import {
  compilePipeline,
  pipelineHash,
  type PublishedPipelineContext,
} from "./compile";
import {
  PIPELINE_LIMITS,
  PipelineError,
  type CompiledPipeline,
  type CompiledStage,
  type MediaKind,
  type MediaSource,
  type OutputRef,
  type PipelineAttempt,
  type PipelineAttemptState,
  type PipelineRunState,
  type PipelineSelection,
  type PreparedStageAdmission,
} from "./schema";

export type PipelineVersion = {
  id: string;
  version: number;
  owner: string;
  compiled: CompiledPipeline;
  createdAt: number;
};
export type PipelineQuote = {
  id: string;
  stageId: string;
  baseRevision: number;
  inputHash: string;
  fingerprint: string;
  units: { unit: number; number: number; prepared: PreparedStageAdmission }[];
  estimatedCredits: number;
  price: number;
  currency: "cr" | "usd";
  expiresAt: number;
  approvedAt: number | null;
};
export type PipelineRun = {
  id: string;
  owner: string;
  pipelineId: string;
  pipelineVersion: number;
  revision: number;
  state: PipelineRunState;
  compiled: CompiledPipeline;
  attempts: PipelineAttempt[];
  quotes: PipelineQuote[];
  selections: PipelineSelection[];
  assemblies: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
export type PipelineLease = {
  runId: string;
  token: string;
  epoch: number;
  until: number;
};
export type PipelineWake = {
  runId: string;
  token: string;
  sequence: number;
  until: number;
};
export type ResolvedStageInputs = {
  references: (MediaSource & { role: string; bindingHash: string })[];
  inputHash: string;
};
const boots = new WeakMap<Client, Promise<void>>();
const terminal = new Set<PipelineAttemptState>([
  "succeeded",
  "failed",
  "refused",
]);
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const conflict = () =>
  new PipelineError(
    "This run changed. Reload its current state before approving or editing it.",
    409,
    "pipeline_conflict",
  );

/** Additive tables leave historical recipe/run APIs unchanged. New rows are
 * explicitly workspace scoped even though each tenant already has its own DB. */
export class PipelineStore {
  constructor(
    private client: Client,
    readonly workspaceId: string,
  ) {
    if (!workspaceId)
      throw new PipelineError("A pipeline needs a workspace.", 401);
  }
  async ready() {
    if (!boots.has(this.client))
      boots.set(
        this.client,
        this.client
          .batch(
            [
              `CREATE TABLE IF NOT EXISTS pipeline_versions(workspace_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,owner TEXT NOT NULL,project_id TEXT NOT NULL,bible_version INTEGER NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,id,version))`,
              `CREATE TABLE IF NOT EXISTS pipeline_runs(workspace_id TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,pipeline_id TEXT NOT NULL,pipeline_version INTEGER NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,assemblies TEXT NOT NULL DEFAULT '{}',lease_token TEXT,lease_epoch INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,id))`,
              `CREATE INDEX IF NOT EXISTS idx_pipeline_owner ON pipeline_runs(workspace_id,owner,created_at)`,
              `CREATE TABLE IF NOT EXISTS pipeline_quotes(workspace_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,stage_id TEXT NOT NULL,base_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,expires_at INTEGER NOT NULL,approved_at INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,id))`,
              `CREATE TABLE IF NOT EXISTS pipeline_attempts(workspace_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,stage_id TEXT NOT NULL,unit INTEGER NOT NULL,number INTEGER NOT NULL,request_key TEXT NOT NULL,prepared TEXT NOT NULL,state TEXT NOT NULL,generation_id TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,run_id,stage_id,unit,number),UNIQUE(workspace_id,request_key))`,
              `CREATE INDEX IF NOT EXISTS idx_pipeline_attempts_run ON pipeline_attempts(workspace_id,run_id)`,
              `CREATE TABLE IF NOT EXISTS pipeline_selections(workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,stage_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,run_id,stage_id,revision))`,
              `CREATE TABLE IF NOT EXISTS pipeline_wakeups(workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,due_at INTEGER NOT NULL,sequence INTEGER NOT NULL DEFAULT 1,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,run_id))`,
              `CREATE INDEX IF NOT EXISTS idx_pipeline_wake_due ON pipeline_wakeups(workspace_id,due_at,lease_until)`,
            ],
            "write",
          )
          .then(() => undefined)
          .catch((error) => {
            boots.delete(this.client);
            throw error;
          }),
      );
    await boots.get(this.client);
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
  private async version(
    tx: Client | Transaction,
    owner: string,
    id: string,
    version: number,
  ): Promise<PipelineVersion> {
    if (!owner) throw new PipelineError("Sign in to open a pipeline.", 401);
    const row = (
      await tx.execute({
        sql: "SELECT * FROM pipeline_versions WHERE workspace_id=? AND owner=? AND id=? AND version=?",
        args: [this.workspaceId, owner, id, version],
      })
    ).rows[0];
    if (!row) throw new PipelineError("Pipeline version not found.", 404);
    return {
      id,
      version,
      owner,
      compiled: json(row.body),
      createdAt: Number(row.created_at),
    };
  }
  async saveVersion(
    owner: string,
    input: unknown,
    expectedVersion: number,
    existingId?: string,
    at = Date.now(),
  ): Promise<PipelineVersion> {
    if (
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 0 ||
      (!existingId && expectedVersion !== 0)
    )
      throw conflict();
    return this.write(async (tx) => {
      const id = existingId ?? "pipe_" + randomUUID().replaceAll("-", "");
      const latest = (
        await tx.execute({
          sql: "SELECT owner,version FROM pipeline_versions WHERE workspace_id=? AND id=? ORDER BY version DESC LIMIT 1",
          args: [this.workspaceId, id],
        })
      ).rows[0];
      if (
        (latest && latest.owner !== owner) ||
        Number(latest?.version ?? 0) !== expectedVersion
      )
        throw conflict();
      const selector = (
        input as { context?: { projectId?: unknown; bibleVersion?: unknown } }
      )?.context;
      if (
        typeof selector?.projectId !== "string" ||
        !Number.isInteger(selector.bibleVersion)
      )
        throw new PipelineError(
          "Choose an existing published production version.",
        );
      const publication = (
        await tx.execute({
          sql: "SELECT b.body FROM workbench_bibles b JOIN projects p ON p.id=b.project_id WHERE b.project_id=? AND b.version=?",
          args: [selector.projectId, Number(selector.bibleVersion)],
        })
      ).rows[0];
      if (!publication)
        throw new PipelineError(
          "Publish the intended production context first. Private drafts are never published by a pipeline.",
          409,
        );
      const compiled = compilePipeline(input, {
        projectId: selector.projectId,
        version: Number(selector.bibleVersion),
        body: json<PublishedPipelineContext["body"]>(publication.body),
      });
      for (const stage of compiled.stages)
        for (const reference of stage.inputs)
          if (reference.source === "asset")
            await this.media(tx, reference.media);
      const version = expectedVersion + 1;
      await tx.execute({
        sql: "INSERT INTO pipeline_versions(workspace_id,id,version,owner,project_id,bible_version,body,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        args: [
          this.workspaceId,
          id,
          version,
          owner,
          compiled.spec.context.projectId,
          compiled.spec.context.bibleVersion,
          JSON.stringify(compiled),
          compiled.fingerprint,
          at,
        ],
      });
      return { id, version, owner, compiled, createdAt: at };
    });
  }
  async getVersion(owner: string, id: string, version: number) {
    await this.ready();
    return this.version(this.client, owner, id, version);
  }
  async createRun(
    owner: string,
    pipelineId: string,
    version: number,
    at = Date.now(),
  ) {
    return this.write(async (tx) => {
      await this.version(tx, owner, pipelineId, version);
      const id = "prun_" + randomUUID().replaceAll("-", "");
      await tx.execute({
        sql: "INSERT INTO pipeline_runs(workspace_id,id,owner,pipeline_id,pipeline_version,state,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?)",
        args: [this.workspaceId, id, owner, pipelineId, version, at, at],
      });
      return this.run(tx, id, owner);
    });
  }
  private async run(
    tx: Client | Transaction,
    id: string,
    owner?: string,
  ): Promise<PipelineRun> {
    const row = (
      await tx.execute({
        sql:
          "SELECT * FROM pipeline_runs WHERE workspace_id=? AND id=?" +
          (owner ? " AND owner=?" : ""),
        args: [this.workspaceId, id, ...(owner ? [owner] : [])],
      })
    ).rows[0];
    if (!row) throw new PipelineError("Run not found.", 404);
    const version = await this.version(
      tx,
      String(row.owner),
      String(row.pipeline_id),
      Number(row.pipeline_version),
    );
    const attempts = (
      await tx.execute({
        sql: "SELECT * FROM pipeline_attempts WHERE workspace_id=? AND run_id=? ORDER BY stage_id,unit,number",
        args: [this.workspaceId, id],
      })
    ).rows.map(attemptFrom);
    const quotes = (
      await tx.execute({
        sql: "SELECT * FROM pipeline_quotes WHERE workspace_id=? AND run_id=? ORDER BY created_at,id",
        args: [this.workspaceId, id],
      })
    ).rows.map(quoteFrom);
    const selections = new Map<string, PipelineSelection>();
    for (const selected of (
      await tx.execute({
        sql: "SELECT stage_id,body FROM pipeline_selections WHERE workspace_id=? AND run_id=? ORDER BY revision",
        args: [this.workspaceId, id],
      })
    ).rows)
      selections.set(String(selected.stage_id), json(selected.body));
    return {
      id,
      owner: String(row.owner),
      pipelineId: version.id,
      pipelineVersion: version.version,
      revision: Number(row.revision),
      state: String(row.state) as PipelineRunState,
      compiled: version.compiled,
      attempts,
      quotes,
      selections: [...selections.values()],
      assemblies: json(row.assemblies),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  async getRun(owner: string, id: string) {
    if (!owner) throw new PipelineError("Sign in to open a pipeline.", 401);
    await this.ready();
    return this.run(this.client, id, owner);
  }
  /** Reuse the caller's consistent export transaction; never open a second
   * connection while the local read snapshot is held. */
  async getRunSnapshot(tx: Transaction, owner: string, id: string) {
    if (!owner) throw new PipelineError("Sign in to export a pipeline.", 401);
    return this.run(tx, id, owner);
  }
  async getWorkerRun(id: string) {
    await this.ready();
    return this.run(this.client, id);
  }
  async listRuns(owner: string, projectId?: string) {
    await this.ready();
    const rows = (
      await this.client.execute({
        sql: `SELECT r.id FROM pipeline_runs r JOIN pipeline_versions v ON v.workspace_id=r.workspace_id AND v.id=r.pipeline_id AND v.version=r.pipeline_version WHERE r.workspace_id=? AND r.owner=?${projectId ? " AND v.project_id=?" : ""} ORDER BY r.created_at DESC LIMIT 50`,
        args: [this.workspaceId, owner, ...(projectId ? [projectId] : [])],
      })
    ).rows;
    const runs: PipelineRun[] = [];
    for (const row of rows) runs.push(await this.getRun(owner, String(row.id)));
    return runs;
  }
  private async media(
    tx: Client | Transaction,
    source: MediaSource,
  ): Promise<MediaSource & { bindingHash: string }> {
    const row = (
      await tx.execute({
        sql:
          source.source === "upload"
            ? "SELECT id,kind,sha256,stored_url,bytes,duration_s FROM uploads WHERE id=?"
            : "SELECT id,kind,status,stored_url,bytes,params FROM generations WHERE id=? AND deleted=0",
        args: [source.id],
      })
    ).rows[0];
    if (
      !row ||
      !row.stored_url ||
      (source.source === "generation" && row.status !== "succeeded")
    )
      throw new PipelineError(
        "A pipeline source is not available as a completed stored file.",
        409,
      );
    const kind =
      String(row.kind) === "file" && source.kind === "audio"
        ? "audio"
        : String(row.kind);
    if (kind !== source.kind)
      throw new PipelineError("A pipeline source changed media kind.", 409);
    return {
      ...source,
      ...(row.sha256 ? { sha256: String(row.sha256) } : {}),
      bindingHash: pipelineHash({
        id: source.id,
        source: source.source,
        kind,
        sha256: row.sha256 ?? null,
        stored: row.stored_url,
        bytes: row.bytes,
        params: row.params ?? null,
      }),
    };
  }
  private async resolved(
    tx: Client | Transaction,
    run: PipelineRun,
    stage: CompiledStage,
  ): Promise<ResolvedStageInputs> {
    const references: ResolvedStageInputs["references"] = [];
    for (const input of stage.inputs) {
      let source: MediaSource;
      if (input.source === "asset") source = input.media;
      else {
        const ref = resolveOutput(run, input);
        source = { source: "generation", id: ref.generationId, kind: ref.kind };
      }
      references.push({ ...(await this.media(tx, source)), role: input.role });
    }
    return {
      references,
      inputHash: pipelineHash({
        pipeline: run.compiled.fingerprint,
        stage: stage.definition,
        prompt: stage.prompt,
        references,
      }),
    };
  }
  async stageInputs(owner: string, runId: string, stageId: string) {
    await this.ready();
    const run = await this.run(this.client, runId, owner);
    return this.resolved(this.client, run, stageOf(run, stageId));
  }
  async quoteStage(
    owner: string,
    runId: string,
    expectedRevision: number,
    stageId: string,
    inputHash: string,
    units: { unit: number; prepared: PreparedStageAdmission }[],
    at = Date.now(),
  ): Promise<PipelineQuote> {
    return this.write(async (tx) => {
      const run = await this.run(tx, runId, owner);
      this.checkRevision(run, expectedRevision);
      if (["cancelled", "succeeded"].includes(run.state))
        throw new PipelineError(
          "Start a new run for a completed or cancelled pipeline.",
          409,
        );
      const stage = stageOf(run, stageId),
        definition = stage.definition;
      if (!("units" in definition))
        throw new PipelineError("This stage does not need a paid quote.");
      if ((await this.resolved(tx, run, stage)).inputHash !== inputHash)
        throw new PipelineError(
          "The resolved inputs changed. Request a fresh quote.",
          409,
        );
      if (
        !units.length ||
        units.length > definition.units ||
        new Set(units.map((unit) => unit.unit)).size !== units.length
      )
        throw new PipelineError("Quote each chosen unit exactly once.");
      for (const unit of units) await validateMediaSources(tx, unit.prepared);
      const quoted = units.map(({ unit, prepared }) => {
        if (!Number.isInteger(unit) || unit < 0 || unit >= definition.units)
          throw new PipelineError("Unknown stage unit.");
        const latest = latestAttempt(run, stageId, unit);
        if (latest && !["failed", "refused"].includes(latest.state))
          throw new PipelineError(
            "Recover the existing attempt; an unresolved or completed unit cannot be silently replaced.",
            409,
          );
        const number = (latest?.number ?? 0) + 1;
        if (number > PIPELINE_LIMITS.attemptsPerUnit)
          throw new PipelineError(
            "Start a new run after twenty attempts on a unit.",
            409,
          );
        if (
          prepared.version !== 1 ||
          prepared.workspaceId !== this.workspaceId ||
          prepared.actorId !== owner ||
          prepared.kind !== definition.kind ||
          prepared.request.projectId !== run.compiled.spec.context.projectId ||
          !/^[a-f0-9]{64}$/.test(prepared.quote.fingerprint) ||
          !Number.isInteger(prepared.quote.estimatedCredits) ||
          prepared.quote.estimatedCredits < 0 ||
          !Number.isFinite(prepared.quote.price) ||
          prepared.quote.price < 0 ||
          !["cr", "usd"].includes(prepared.quote.unit)
        )
          throw new PipelineError("Invalid server admission quote.");
        return { unit, number, prepared };
      });
      if (new Set(quoted.map((unit) => unit.prepared.quote.unit)).size !== 1)
        throw new PipelineError("A stage quote must use one billing unit.");
      const id = "pquote_" + randomUUID().replaceAll("-", ""),
        revision = run.revision + 1;
      const quote: PipelineQuote = {
        id,
        stageId,
        baseRevision: revision,
        inputHash,
        fingerprint: pipelineHash({
          pipeline: run.compiled.fingerprint,
          stageId,
          inputHash,
          units: quoted,
        }),
        units: quoted,
        estimatedCredits: quoted.reduce(
          (sum, unit) => sum + unit.prepared.quote.estimatedCredits,
          0,
        ),
        price: quoted.reduce((sum, unit) => sum + unit.prepared.quote.price, 0),
        currency: quoted[0].prepared.quote.unit,
        expiresAt: at + 10 * 60_000,
        approvedAt: null,
      };
      await tx.execute({
        sql: "INSERT INTO pipeline_quotes(workspace_id,id,run_id,stage_id,base_revision,input_hash,fingerprint,body,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        args: [
          this.workspaceId,
          id,
          runId,
          stageId,
          revision,
          inputHash,
          quote.fingerprint,
          JSON.stringify(quote),
          quote.expiresAt,
          at,
        ],
      });
      await this.bump(
        tx,
        run,
        run.state === "paused" ? "paused" : "awaiting_approval",
        at,
      );
      return quote;
    });
  }
  async approveQuote(
    owner: string,
    runId: string,
    expectedRevision: number,
    quoteId: string,
    fingerprint: string,
    at = Date.now(),
  ) {
    return this.write(async (tx) => {
      const run = await this.run(tx, runId, owner),
        quote = run.quotes.find((item) => item.id === quoteId);
      if (!quote || quote.fingerprint !== fingerprint)
        throw new PipelineError(
          "The displayed quote no longer matches this approval.",
          409,
        );
      if (quote.approvedAt !== null) return run; // Lost approval response replays the existing attempts.
      this.checkRevision(run, expectedRevision);
      if (
        quote.baseRevision !== run.revision ||
        quote.expiresAt <= at ||
        ["succeeded", "cancelled"].includes(run.state)
      )
        throw new PipelineError(
          "This quote expired or the run changed. Request a fresh quote.",
          409,
        );
      if (
        (await this.resolved(tx, run, stageOf(run, quote.stageId)))
          .inputHash !== quote.inputHash
      )
        throw new PipelineError(
          "A source changed after quoting. Review a fresh quote.",
          409,
        );
      for (const unit of quote.units) {
        const latest = latestAttempt(run, quote.stageId, unit.unit);
        if (
          (latest?.number ?? 0) + 1 !== unit.number ||
          (latest && !["failed", "refused"].includes(latest.state))
        )
          throw conflict();
        const id = "ptry_" + randomUUID().replaceAll("-", ""),
          requestKey =
            "pipeline." +
            pipelineHash([
              this.workspaceId,
              owner,
              runId,
              quote.stageId,
              unit.unit,
              unit.number,
            ]);
        await tx.execute({
          sql: "INSERT INTO pipeline_attempts(workspace_id,id,run_id,stage_id,unit,number,request_key,prepared,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)",
          args: [
            this.workspaceId,
            id,
            runId,
            quote.stageId,
            unit.unit,
            unit.number,
            requestKey,
            JSON.stringify(unit.prepared),
            at,
            at,
          ],
        });
      }
      await tx.execute({
        sql: "UPDATE pipeline_quotes SET approved_at=? WHERE workspace_id=? AND id=? AND approved_at IS NULL",
        args: [at, this.workspaceId, quote.id],
      });
      await this.bump(
        tx,
        run,
        run.state === "paused" ? "paused" : "running",
        at,
      );
      await this.wake(tx, runId, at);
      return this.run(tx, runId, owner);
    });
  }
  private checkRevision(run: PipelineRun, expected: number) {
    if (!Number.isInteger(expected) || run.revision !== expected)
      throw conflict();
  }
  private async bump(
    tx: Transaction,
    run: PipelineRun,
    state: PipelineRunState,
    at: number,
  ) {
    const result = await tx.execute({
      sql: "UPDATE pipeline_runs SET state=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?",
      args: [state, at, this.workspaceId, run.id, run.revision],
    });
    if (!result.rowsAffected) throw conflict();
  }
  async setState(
    owner: string,
    runId: string,
    revision: number,
    state: "paused" | "running" | "cancelled",
    at = Date.now(),
  ) {
    return this.write(async (tx) => {
      const run = await this.run(tx, runId, owner);
      this.checkRevision(run, revision);
      if (["cancelled", "succeeded"].includes(run.state))
        throw new PipelineError("This run is finished.", 409);
      if (
        state === "running" &&
        run.state !== "paused" &&
        !run.attempts.some((attempt) =>
          ["queued", "submitting", "running", "uncertain"].includes(
            attempt.state,
          ),
        )
      )
        throw new PipelineError(
          "Review a quoted stage before resuming new work.",
          409,
        );
      await this.bump(tx, run, state, at);
      if (state === "running") await this.wake(tx, runId, at);
      return this.run(tx, runId, owner);
    });
  }
  async select(
    owner: string,
    runId: string,
    revision: number,
    stageId: string,
    candidate: OutputRef,
    generationId: string,
    at = Date.now(),
  ) {
    return this.write(async (tx) => {
      const run = await this.run(tx, runId, owner);
      this.checkRevision(run, revision);
      if (["cancelled", "succeeded"].includes(run.state))
        throw new PipelineError(
          "This run is finished. Start a new run to change a selection.",
          409,
        );
      const stage = stageOf(run, stageId).definition;
      if (
        stage.kind !== "review" ||
        !stage.candidates.some(
          (ref) =>
            ref.stageId === candidate.stageId && ref.unit === candidate.unit,
        )
      )
        throw new PipelineError("Choose a candidate from this review stage.");
      const attempt = run.attempts.find(
        (attempt) =>
          attempt.stageId === candidate.stageId &&
          attempt.unit === candidate.unit &&
          attempt.generationId === generationId &&
          attempt.state === "succeeded",
      );
      if (!attempt)
        throw new PipelineError(
          "Only a completed candidate can be selected.",
          409,
        );
      if (
        run.attempts.some((attempt) =>
          downstream(run, stageId).has(attempt.stageId),
        )
      )
        throw new PipelineError(
          "Downstream work already uses this selection. Start a new run to change it.",
          409,
        );
      const selection: PipelineSelection = {
        stageId,
        candidate,
        generationId,
        kind: attempt.prepared.kind,
        selectedBy: owner,
        selectedAt: at,
      };
      await this.media(tx, {
        source: "generation",
        id: generationId,
        kind: selection.kind,
      });
      await tx.execute({
        sql: "INSERT INTO pipeline_selections(workspace_id,run_id,stage_id,revision,body,created_at) VALUES(?,?,?,?,?,?)",
        args: [
          this.workspaceId,
          runId,
          stageId,
          revision + 1,
          JSON.stringify(selection),
          at,
        ],
      });
      await this.bump(tx, run, run.state === "paused" ? "paused" : "draft", at);
      await this.wake(tx, runId, at);
      return this.run(tx, runId, owner);
    });
  }
  async claimRun(
    runId: string,
    at = Date.now(),
    leaseMs = 30_000,
  ): Promise<PipelineLease | null> {
    await this.ready();
    const token = randomUUID(),
      until = at + Math.max(1000, Math.min(leaseMs, 300_000));
    const result = await this.client.execute({
      sql: "UPDATE pipeline_runs SET lease_token=?,lease_epoch=lease_epoch+1,lease_until=? WHERE workspace_id=? AND id=? AND lease_until<=? AND state NOT IN ('succeeded','cancelled') RETURNING lease_epoch",
      args: [token, until, this.workspaceId, runId, at],
    });
    return result.rows.length
      ? { runId, token, epoch: Number(result.rows[0].lease_epoch), until }
      : null;
  }
  private async assertLease(
    tx: Client | Transaction,
    lease: PipelineLease,
    at: number,
  ) {
    if (
      !(
        await tx.execute({
          sql: "SELECT 1 FROM pipeline_runs WHERE workspace_id=? AND id=? AND lease_token=? AND lease_epoch=? AND lease_until>?",
          args: [this.workspaceId, lease.runId, lease.token, lease.epoch, at],
        })
      ).rows.length
    )
      throw new PipelineError(
        "Pipeline worker lease was lost.",
        409,
        "pipeline_lease_lost",
      );
  }
  async releaseRun(lease: PipelineLease) {
    await this.client.execute({
      sql: "UPDATE pipeline_runs SET lease_until=0,lease_token=NULL WHERE workspace_id=? AND id=? AND lease_token=? AND lease_epoch=?",
      args: [this.workspaceId, lease.runId, lease.token, lease.epoch],
    });
  }
  async renewRun(
    lease: PipelineLease,
    at = Date.now(),
    leaseMs = 60_000,
  ): Promise<PipelineLease> {
    const until = at + Math.max(1000, Math.min(leaseMs, 300_000));
    const changed = await this.client.execute({
      sql: "UPDATE pipeline_runs SET lease_until=? WHERE workspace_id=? AND id=? AND lease_token=? AND lease_epoch=? AND lease_until>?",
      args: [
        until,
        this.workspaceId,
        lease.runId,
        lease.token,
        lease.epoch,
        at,
      ],
    });
    if (!changed.rowsAffected)
      throw new PipelineError(
        "Pipeline worker lease was lost.",
        409,
        "pipeline_lease_lost",
      );
    return { ...lease, until };
  }
  /** Pure edit decisions become an immutable timeline manifest. Encoding still
   * happens through the existing browser exporter; this is not a movie file. */
  async assemble(lease: PipelineLease, at = Date.now()) {
    return this.write(async (tx) => {
      await this.assertLease(tx, lease, at);
      const run = await this.run(tx, lease.runId);
      if (["paused", "cancelled"].includes(run.state)) return run;
      const assemblies = { ...run.assemblies };
      for (const stage of run.compiled.stages) {
        const definition = stage.definition;
        if (definition.kind !== "assembly" || assemblies[definition.id])
          continue;
        try {
          let timelineFrame = 0;
          const clips = [];
          for (const clip of definition.clips) {
            const output = resolveOutput(run, clip);
            const media = await this.media(tx, {
              source: "generation",
              id: output.generationId,
              kind: output.kind,
            });
            clips.push({
              ...clip,
              ...output,
              timelineFrame,
              bindingHash: media.bindingHash,
            });
            timelineFrame += clip.durationFrames;
          }
          let soundtrack = null;
          if (definition.soundtrack) {
            const output = resolveOutput(run, definition.soundtrack);
            const media = await this.media(tx, {
              source: "generation",
              id: output.generationId,
              kind: "audio",
            });
            soundtrack = { ...output, bindingHash: media.bindingHash };
          }
          assemblies[definition.id] = {
            version: 1,
            kind: "timeline-manifest",
            fps: definition.fps,
            aspect: definition.aspect,
            totalFrames: timelineFrame,
            clips,
            soundtrack,
            createdAt: at,
          };
        } catch (error) {
          if (
            error instanceof PipelineError &&
            error.code === "pipeline_inputs_waiting"
          )
            continue;
          throw error;
        }
      }
      const nextState = run.quotes.some(
        (q) =>
          q.approvedAt === null &&
          q.baseRevision === run.revision &&
          q.expiresAt > at,
      )
        ? "awaiting_approval"
        : deriveRunState({ ...run, assemblies });
      if (
        JSON.stringify(assemblies) !== JSON.stringify(run.assemblies) ||
        nextState !== run.state
      ) {
        await tx.execute({
          sql: "UPDATE pipeline_runs SET assemblies=? WHERE workspace_id=? AND id=?",
          args: [JSON.stringify(assemblies), this.workspaceId, run.id],
        });
        await this.bump(tx, run, nextState, at);
      }
      return this.run(tx, run.id);
    });
  }
  async beginAttempt(
    lease: PipelineLease,
    attemptId: string,
    at = Date.now(),
  ): Promise<PipelineAttempt | null> {
    return this.write(async (tx) => {
      await this.assertLease(tx, lease, at);
      const run = await this.run(tx, lease.runId),
        attempt = run.attempts.find((item) => item.id === attemptId);
      if (!attempt || terminal.has(attempt.state) || run.state === "cancelled")
        return null;
      if (run.state === "paused") return null;
      if (attempt.state === "queued") {
        await tx.execute({
          sql: "UPDATE pipeline_attempts SET state='submitting',updated_at=? WHERE workspace_id=? AND id=? AND state='queued'",
          args: [at, this.workspaceId, attemptId],
        });
        await this.bump(tx, run, run.state, at);
      }
      return {
        ...attempt,
        state: attempt.state === "queued" ? "submitting" : attempt.state,
        updatedAt: at,
      };
    });
  }
  /** Known job IDs remain attached even on a failed provider result. A 5xx
   * without an ID stays uncertain and can only recover this same request key. */
  async recordAdmission(
    lease: PipelineLease,
    attemptId: string,
    reply: {
      status: number;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    },
    at = Date.now(),
  ) {
    return this.write(async (tx) => {
      await this.assertLease(tx, lease, at);
      const run = await this.run(tx, lease.runId),
        attempt = run.attempts.find((item) => item.id === attemptId);
      if (!attempt) throw new PipelineError("Attempt not found.", 404);
      if (terminal.has(attempt.state)) return run;
      let generationId = attempt.generationId,
        state: PipelineAttemptState = "uncertain",
        error =
          typeof reply.body.error === "string"
            ? reply.body.error.slice(0, 2000)
            : null;
      if (typeof reply.body.id === "string") {
        if (generationId && generationId !== reply.body.id)
          throw new PipelineError(
            "Admission returned a different generation for the same attempt.",
            409,
          );
        generationId = reply.body.id;
        const row = (
          await tx.execute({
            sql: "SELECT status,created_by,project_id,kind,error FROM generations WHERE id=? AND deleted=0",
            args: [generationId],
          })
        ).rows[0];
        if (
          !row ||
          row.created_by !== run.owner ||
          row.project_id !== run.compiled.spec.context.projectId ||
          row.kind !== attempt.prepared.kind
        )
          throw new PipelineError(
            "The admitted generation does not match this run.",
            409,
          );
        state =
          row.status === "succeeded"
            ? "succeeded"
            : ["failed", "cancelled"].includes(String(row.status))
              ? "failed"
              : "running";
        error = row.error
          ? String(row.error)
          : row.status === "cancelled"
            ? "The generation was cancelled. Review a new quote to try again."
            : error;
        if (state === "succeeded")
          await this.media(tx, {
            source: "generation",
            id: generationId,
            kind: attempt.prepared.kind,
          });
      } else if (
        reply.status >= 400 &&
        reply.status < 500 &&
        reply.body.pending !== true &&
        new Headers(reply.headers).get("Idempotency-Status") === "complete"
      )
        state = "refused";
      await tx.execute({
        sql: "UPDATE pipeline_attempts SET state=?,generation_id=?,error=?,updated_at=? WHERE workspace_id=? AND id=?",
        args: [state, generationId, error, at, this.workspaceId, attemptId],
      });
      const next = {
        ...run,
        attempts: run.attempts.map((item) =>
          item.id === attemptId
            ? { ...item, state, generationId, error }
            : item,
        ),
      };
      await this.bump(
        tx,
        run,
        run.state === "paused" ? "paused" : deriveRunState(next),
        at,
      );
      if (!["succeeded", "failed", "refused"].includes(state))
        await this.wake(tx, run.id, at + 5000);
      return this.run(tx, run.id);
    });
  }
  private async wake(tx: Client | Transaction, runId: string, dueAt: number) {
    await tx.execute({
      sql: "INSERT INTO pipeline_wakeups(workspace_id,run_id,due_at) VALUES(?,?,?) ON CONFLICT(workspace_id,run_id) DO UPDATE SET due_at=MIN(pipeline_wakeups.due_at,excluded.due_at),sequence=pipeline_wakeups.sequence+1",
      args: [this.workspaceId, runId, dueAt],
    });
  }
  async scheduleWake(runId: string, dueAt = Date.now()) {
    await this.ready();
    await this.run(this.client, runId);
    await this.wake(this.client, runId, dueAt);
  }
  async claimWake(
    at = Date.now(),
    leaseMs = 30_000,
  ): Promise<PipelineWake | null> {
    return this.write(async (tx) => {
      const row = (
        await tx.execute({
          sql: "SELECT run_id,sequence FROM pipeline_wakeups WHERE workspace_id=? AND due_at<=? AND lease_until<=? ORDER BY due_at,run_id LIMIT 1",
          args: [this.workspaceId, at, at],
        })
      ).rows[0];
      if (!row) return null;
      const token = randomUUID(),
        until = at + Math.max(1000, Math.min(leaseMs, 300_000));
      await tx.execute({
        sql: "UPDATE pipeline_wakeups SET lease_token=?,lease_until=?,due_at=? WHERE workspace_id=? AND run_id=? AND sequence=?",
        args: [
          token,
          until,
          until,
          this.workspaceId,
          String(row.run_id),
          Number(row.sequence),
        ],
      });
      return {
        runId: String(row.run_id),
        token,
        sequence: Number(row.sequence),
        until,
      };
    });
  }
  async acknowledgeWake(wake: PipelineWake, nextAt?: number) {
    return this.write(async (tx) => {
      const row = (
        await tx.execute({
          sql: "SELECT sequence FROM pipeline_wakeups WHERE workspace_id=? AND run_id=? AND lease_token=?",
          args: [this.workspaceId, wake.runId, wake.token],
        })
      ).rows[0];
      if (!row) return;
      if (Number(row.sequence) === wake.sequence && nextAt === undefined)
        await tx.execute({
          sql: "DELETE FROM pipeline_wakeups WHERE workspace_id=? AND run_id=? AND lease_token=? AND sequence=?",
          args: [this.workspaceId, wake.runId, wake.token, wake.sequence],
        });
      else
        await tx.execute({
          sql: "UPDATE pipeline_wakeups SET lease_token=NULL,lease_until=0,due_at=CASE WHEN sequence=? THEN ? ELSE CASE WHEN ? IS NULL THEN due_at ELSE MIN(due_at,?) END END WHERE workspace_id=? AND run_id=? AND lease_token=?",
          args: [
            wake.sequence,
            nextAt ?? 0,
            nextAt ?? null,
            nextAt ?? null,
            this.workspaceId,
            wake.runId,
            wake.token,
          ],
        });
    });
  }
}

function attemptFrom(row: Row): PipelineAttempt {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: String(row.stage_id),
    unit: Number(row.unit),
    number: Number(row.number),
    requestKey: String(row.request_key),
    prepared: json(row.prepared),
    state: String(row.state) as PipelineAttemptState,
    generationId: row.generation_id === null ? null : String(row.generation_id),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
function quoteFrom(row: Row): PipelineQuote {
  return {
    ...json<PipelineQuote>(row.body),
    approvedAt: row.approved_at === null ? null : Number(row.approved_at),
  };
}
export function stageOf(run: PipelineRun, id: string) {
  const stage = run.compiled.stages.find((stage) => stage.definition.id === id);
  if (!stage) throw new PipelineError("Stage not found.", 404);
  return stage;
}
export function latestAttempt(run: PipelineRun, stageId: string, unit: number) {
  return run.attempts
    .filter((attempt) => attempt.stageId === stageId && attempt.unit === unit)
    .sort((a, b) => b.number - a.number)[0];
}
export function resolveOutput(
  run: PipelineRun,
  reference: OutputRef,
): { generationId: string; kind: MediaKind } {
  const stage = stageOf(run, reference.stageId);
  if (stage.definition.kind === "review") {
    const selection = run.selections.find(
      (selection) => selection.stageId === reference.stageId,
    );
    if (!selection)
      throw new PipelineError(
        "Select a completed take in the preceding review stage first.",
        409,
        "pipeline_inputs_waiting",
      );
    return { generationId: selection.generationId, kind: selection.kind };
  }
  const attempt = latestAttempt(run, reference.stageId, reference.unit);
  if (!attempt?.generationId || attempt.state !== "succeeded")
    throw new PipelineError(
      "Wait for the referenced stage output before quoting this stage.",
      409,
      "pipeline_inputs_waiting",
    );
  return { generationId: attempt.generationId, kind: attempt.prepared.kind };
}
function downstream(run: PipelineRun, stageId: string) {
  const found = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of run.compiled.stages)
      if (
        !found.has(stage.definition.id) &&
        stage.dependencies.some((id) => id === stageId || found.has(id))
      ) {
        found.add(stage.definition.id);
        changed = true;
      }
  }
  return found;
}
export function deriveRunState(run: PipelineRun): PipelineRunState {
  if (["paused", "cancelled"].includes(run.state)) return run.state;
  const latest = run.compiled.stages.flatMap((stage) =>
    "units" in stage.definition
      ? Array.from({ length: stage.definition.units }, (_, unit) =>
          latestAttempt(run, stage.definition.id, unit),
        ).filter((attempt): attempt is PipelineAttempt => Boolean(attempt))
      : [],
  );
  if (
    latest.some((attempt) =>
      ["queued", "submitting", "running"].includes(attempt.state),
    )
  )
    return "running";
  if (
    latest.some((attempt) =>
      ["uncertain", "failed", "refused"].includes(attempt.state),
    )
  )
    return "blocked";
  const complete = run.compiled.stages.every((stage) => {
    if (stage.definition.kind === "review")
      return run.selections.some(
        (selection) => selection.stageId === stage.definition.id,
      );
    if (stage.definition.kind === "assembly")
      return Boolean(run.assemblies[stage.definition.id]);
    return Array.from(
      { length: stage.definition.units },
      (_, unit) =>
        latestAttempt(run, stage.definition.id, unit)?.state === "succeeded",
    ).every(Boolean);
  });
  if (complete) return "succeeded";
  if (
    run.compiled.stages.some(
      (stage) =>
        stage.definition.kind === "review" &&
        !run.selections.some(
          (selection) => selection.stageId === stage.definition.id,
        ) &&
        stage.definition.candidates.some(
          (candidate) =>
            latestAttempt(run, candidate.stageId, candidate.unit)?.state ===
            "succeeded",
        ),
    )
  )
    return "needs_review";
  return "draft";
}
export async function pipelineStore() {
  await workbenchReady();
  return new PipelineStore(db(), requireTenant().id);
}
