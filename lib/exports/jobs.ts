import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { db } from "../db";
import { requireTenant } from "../tenant";
import { checkQuota } from "../limits";
import { storeUpload } from "../storage";
import { workbenchTransaction } from "../workbench/records";
import { EVENTS } from "../dispatch";
import { liveSlots } from "../worker-slots";
import { toTimeline, ExportTooLong } from "../../remotion/src/lib/timeline";
import { validateProps } from "../../remotion/src/lib/validate";
import type { CompositionId } from "../../remotion/src/lib/types";
import {
  EXPORT_PRICE_LABEL,
  ExportError,
  NOTHING_BILLED,
  isTerminal,
  type ExportJob,
  type ExportOutput,
  type ExportRequest,
  type ExportStatus,
} from "./contract";
import { bindMedia, createMediaResolver, loadMedia, mediaStillReachable, type BoundMedia, type ExportViewer, type MediaLoader, type MediaResolver } from "./inputs";
import { exportLimits, exportWorkerSlots, type ExportLimits } from "./limits";
import { exportsOnHere } from "./access";
import {
  ExportWorkerBusyError,
  ExportWorkerRefusedError,
  openExportSession,
  stopExportSession,
  type ExportSession,
  type ExportWorkerDeps,
} from "./worker";

/**
 * The durable export job, in the workspace's own database.
 *
 *   queued -> rendering -> saving -> ready | failed | cancelled
 *
 * FREE to customers, and written down as such here: this file never reserves, charges, refunds or meters credits,
 * and writes no billing row of any kind. A paid step an export depends on (a take being made, a voice-over) goes
 * through its own price, approval and admission path BEFORE the export is requested; an export of a take that is
 * still being made is refused. A job that does not complete says "Nothing billed."
 *
 * Every row carries `workspace_id` and every query filters on it (the database is per workspace as well). Outputs are
 * stored with `storeUpload`, which prefixes every path with the workspace. Duplicate requests (same `requestId`) return
 * the same job; duplicate delivery of the run event cannot start a second run (the queued -> rendering claim is one
 * conditional update).
 */

export type ExportDeps = {
  /** The gate: by default exports on for this workspace (lib/exports/access.ts). A test may stand in. */
  enabled?: () => boolean | Promise<boolean>;
  limits?: () => ExportLimits;
  /** Builds the resolver for the caller; the real one reads the caller's reach (tests substitute it). */
  resolver?: (viewer: ExportViewer) => MediaResolver;
  loader?: MediaLoader;
  /** Whether the job's owner can still reach a file when the job runs. */
  reach?: (ownerId: string, media: BoundMedia) => Promise<boolean>;
  worker?: ExportWorkerDeps;
  clock?: () => number;
};

const initialized = new WeakMap<Client, Promise<void>>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const gate = async (deps: ExportDeps) => {
  if (!(await (deps.enabled ?? exportsOnHere)())) throw new ExportError("Not found.", 404);
};

export async function exportJobsReady() {
  const client = db();
  if (!initialized.has(client)) {
    initialized.set(
      client,
      client
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS export_jobs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 owner TEXT NOT NULL,
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 composition TEXT NOT NULL,
 spec_json TEXT NOT NULL,
 status TEXT NOT NULL,
 runtime_id TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 1,
 retry_times TEXT NOT NULL DEFAULT '[]',
 error TEXT,
 outputs_json TEXT NOT NULL DEFAULT '[]',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 claimed_at INTEGER,
 finished_at INTEGER,
 UNIQUE(workspace_id, owner, request_id)
)`,
            `CREATE INDEX IF NOT EXISTS export_jobs_queue ON export_jobs(workspace_id, status, created_at)`,
          ],
          "write",
        )
        .then(() => undefined)
        .catch((error) => {
          initialized.delete(client);
          throw error;
        }),
    );
  }
  await initialized.get(client);
}

type Row = {
  id: string;
  workspace_id: string;
  owner: string;
  request_id: string;
  fingerprint: string;
  composition: string;
  spec_json: string;
  status: ExportStatus;
  runtime_id: string | null;
  cancel_requested: number;
  attempts: number;
  error: string | null;
  outputs_json: string;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
};

type StoredSpec = { composition: CompositionId; props: Record<string, unknown>; media: BoundMedia[] };

const workspaceId = () => requireTenant().id;

async function record(id: string): Promise<Row | null> {
  await exportJobsReady();
  return ((await db().execute({ sql: "SELECT * FROM export_jobs WHERE id=? AND workspace_id=?", args: [id, workspaceId()] })).rows[0] as unknown as Row) ?? null;
}

/** Exports ahead of a queued one: running here, this workspace's earlier queued ones, and exports running for others. */
async function aheadOf(row: Row): Promise<number> {
  const mine = Number(
    (
      await db().execute({
        sql: `SELECT COUNT(*) AS n FROM export_jobs WHERE workspace_id=? AND id<>? AND (status IN ('rendering','saving') OR (status='queued' AND created_at<?))`,
        args: [row.workspace_id, row.id, row.created_at],
      })
    ).rows[0]?.n ?? 0,
  );
  let elsewhere = 0;
  try {
    elsewhere = (await liveSlots()).filter((slot) => slot.kind === EVENTS.exportRender && slot.workspaceId !== row.workspace_id).length;
  } catch {
    /* the platform database cannot answer: the position counts this workspace only */
  }
  return mine + elsewhere;
}

export function queueLine(ahead: number): string {
  return ahead === 0 ? "Export queued — you are next" : `Export queued — ${ahead} ahead of you`;
}

async function publicJob(row: Row): Promise<ExportJob> {
  const ahead = row.status === "queued" ? await aheadOf(row) : null;
  return {
    id: row.id,
    requestId: row.request_id,
    composition: row.composition as ExportJob["composition"],
    status: row.status,
    ahead,
    queueLine: ahead === null ? null : queueLine(ahead),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    error: row.error,
    price: { credits: 0, label: EXPORT_PRICE_LABEL },
    outputs: JSON.parse(row.outputs_json) as ExportOutput[],
  };
}

/* ---- the fair share ---- */

/**
 * Starts in the last hour for this workspace: every export admitted, and every retry (a retry is a start). Returns the
 * count and the oldest start, so a refusal can say when the hour frees up.
 */
async function hourUsage(ex: { execute: Client["execute"] }, wsId: string, since: number): Promise<{ n: number; first: number | null }> {
  const row = (
    await ex.execute({
      sql: `WITH starts(t) AS (
              SELECT created_at FROM export_jobs WHERE workspace_id=?
              UNION ALL
              SELECT CAST(e.value AS INTEGER) FROM export_jobs j, json_each(j.retry_times) e WHERE j.workspace_id=?
            ) SELECT COUNT(*) AS n, MIN(t) AS first FROM starts WHERE t>=?`,
      args: [wsId, wsId, since],
    })
  ).rows[0];
  return { n: Number(row?.n ?? 0), first: row?.first == null ? null : Number(row.first) };
}

function hourRefusal(limits: ExportLimits, usage: { first: number | null }, at: number): ExportError {
  const wait = Math.max(60, Math.ceil(((usage.first ?? at) + 3_600_000 - at) / 1000));
  return new ExportError(`This workspace has started ${limits.maxPerHourPerWorkspace} exports in the last hour. Try again in ${Math.ceil(wait / 60)} minutes. Nothing was started or billed.`, 429, wait);
}

/* ---- requesting ---- */

/**
 * Admit one export request: 0 cr, no billing rows. Refused (and nothing written) when the switch is off, when the
 * request does not pass the template's rules, when a take it names is not ready, when the workspace has started its
 * hourly share, or when storage is full. The same `requestId` with the same request returns the same job.
 */
export async function createExport(
  input: ExportRequest,
  viewer: ExportViewer,
  deps: ExportDeps = {},
): Promise<{ job: ExportJob; scheduled: boolean; duplicate: boolean }> {
  await gate(deps);
  await exportJobsReady();
  const clock = deps.clock ?? Date.now;
  const limits = (deps.limits ?? exportLimits)();
  const wsId = workspaceId();
  const owner = viewer.id;
  const fingerprint = hash({ composition: input.composition, props: input.props });

  const find = async () =>
    (await db().execute({ sql: "SELECT * FROM export_jobs WHERE workspace_id=? AND owner=? AND request_id=?", args: [wsId, owner, input.requestId] })).rows[0] as unknown as Row | undefined;
  const prior = await find();
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new ExportError("This request id is already used by a different export.", 409);
    return { job: await publicJob(prior), scheduled: prior.status === "queued", duplicate: true };
  }

  // A cheap read first, before any file is opened or inspected; the count inside the write below is the authoritative one.
  const early = await hourUsage(db(), wsId, clock() - 3_600_000);
  if (early.n >= limits.maxPerHourPerWorkspace) throw hourRefusal(limits, early, clock());

  const bound = await bindMedia(input.composition, input.props, (deps.resolver ?? ((who: ExportViewer) => createMediaResolver(who)))(viewer));
  const checked = validateProps(input.composition, bound.props);
  if (!checked.ok) throw new ExportError(`The export request is not valid. ${checked.errors.slice(0, 4).join(" ")}`.slice(0, 600), 400);
  let seconds: number;
  try {
    const timeline = toTimeline(input.composition, checked.value as never);
    seconds = timeline.durationInFrames / timeline.fps;
  } catch (error) {
    if (error instanceof ExportTooLong) throw new ExportError(`${error.message} Make it shorter.`, 413);
    throw new ExportError(error instanceof Error ? error.message : "The export request is not valid.", 400);
  }
  const spec: StoredSpec = { composition: input.composition, props: checked.value as unknown as Record<string, unknown>, media: bound.media };

  // Storage: an export's file is about 1 to 3 MB a second at 1080p; ask for room for 4.
  const room = await checkQuota(Math.ceil(Math.max(seconds, 5) * 4 * 1024 * 1024));
  if (!room.allow) throw new ExportError(room.error ?? "This workspace has no room left for the export.", 507);

  const id = `export_${randomUUID().replaceAll("-", "")}`;
  const at = clock();
  const created = await workbenchTransaction(async (tx) => {
    const duplicate = (await tx.execute({ sql: "SELECT * FROM export_jobs WHERE workspace_id=? AND owner=? AND request_id=?", args: [wsId, owner, input.requestId] })).rows[0] as unknown as Row | undefined;
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new ExportError("This request id is already used by a different export.", 409);
      return { row: duplicate, duplicate: true };
    }
    // The fair share: this workspace's starts in the last hour, counted where the row is written.
    const usage = await hourUsage(tx, wsId, at - 3_600_000);
    if (usage.n >= limits.maxPerHourPerWorkspace) throw hourRefusal(limits, usage, at);
    await tx.execute({
      sql: `INSERT INTO export_jobs(id,workspace_id,owner,request_id,fingerprint,composition,spec_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, 'queued',?,?)`,
      args: [id, wsId, owner, input.requestId, fingerprint, input.composition, JSON.stringify(spec), at, at],
    });
    return { row: null, duplicate: false };
  });
  if (created.duplicate && created.row) return { job: await publicJob(created.row), scheduled: created.row.status === "queued", duplicate: true };
  return { job: await publicJob((await record(id))!), scheduled: true, duplicate: false };
}

export async function getExport(owner: string, id: string, deps: ExportDeps = {}): Promise<ExportJob> {
  await gate(deps);
  const row = await record(id);
  if (!row || row.owner !== owner) throw new ExportError("That export was not found.", 404);
  return publicJob(row);
}

export async function listExports(owner: string, deps: ExportDeps = {}, limit = 25): Promise<ExportJob[]> {
  await gate(deps);
  await exportJobsReady();
  const rows = (
    await db().execute({ sql: "SELECT * FROM export_jobs WHERE workspace_id=? AND owner=? ORDER BY created_at DESC LIMIT ?", args: [workspaceId(), owner, Math.max(1, Math.min(limit, 100))] })
  ).rows as unknown as Row[];
  return Promise.all(rows.map(publicJob));
}

/* ---- ending a job ---- */

const BUSY_MESSAGE = "Every export worker is busy. This export starts when one is free. Nothing is billed.";
export const EXPORT_BUSY_BACKOFF_MS = 15_000;
const CANCELLED = `Cancelled. ${NOTHING_BILLED}`;
const failure = (reason: string) => `${reason} ${NOTHING_BILLED}`;

async function end(row: Row, status: "failed" | "cancelled", message: string, clock: () => number): Promise<void> {
  await db().execute({
    sql: "UPDATE export_jobs SET status=?, error=?, finished_at=?, updated_at=? WHERE id=? AND workspace_id=? AND status NOT IN ('ready','failed','cancelled')",
    args: [status, message, clock(), clock(), row.id, row.workspace_id],
  });
}

export async function cancelExport(owner: string, id: string, deps: ExportDeps = {}): Promise<ExportJob> {
  await gate(deps);
  const clock = deps.clock ?? Date.now;
  const row = await record(id);
  if (!row || row.owner !== owner) throw new ExportError("That export was not found.", 404);
  if (isTerminal(row.status)) return publicJob(row);
  if (row.status === "queued") {
    await end(row, "cancelled", CANCELLED, clock);
  } else {
    // Rendering or saving: the run stops at its next check, and its worker session is ended now.
    await db().execute({ sql: "UPDATE export_jobs SET cancel_requested=1, updated_at=? WHERE id=? AND workspace_id=?", args: [clock(), row.id, row.workspace_id] });
    if (row.runtime_id) await stopExportSession(row.runtime_id, deps.worker);
  }
  return publicJob((await record(id))!);
}

/** A failed export goes back to the queue, at most twice more, under the same request. Nothing was billed, so nothing is asked again. */
export const EXPORT_MAX_ATTEMPTS = 3;
export async function retryExport(owner: string, id: string, deps: ExportDeps = {}): Promise<ExportJob> {
  await gate(deps);
  const clock = deps.clock ?? Date.now;
  const row = await record(id);
  if (!row || row.owner !== owner) throw new ExportError("That export was not found.", 404);
  if (row.status !== "failed") throw new ExportError("Only an export that failed can be retried.", 409);
  if (Number(row.attempts) >= EXPORT_MAX_ATTEMPTS) throw new ExportError("This export has been tried three times. Start a new one.", 409);
  const limits = (deps.limits ?? exportLimits)();
  const at = clock();
  // A retry is a start: it counts against the workspace's hour like a new export, and is refused the same way.
  await workbenchTransaction(async (tx) => {
    const usage = await hourUsage(tx, row.workspace_id, at - 3_600_000);
    if (usage.n >= limits.maxPerHourPerWorkspace) throw hourRefusal(limits, usage, at);
    await tx.execute({
      sql: "UPDATE export_jobs SET status='queued', error=NULL, runtime_id=NULL, claimed_at=NULL, finished_at=NULL, cancel_requested=0, attempts=attempts+1, retry_times=json_insert(retry_times,'$[#]',?), outputs_json='[]', updated_at=? WHERE id=? AND workspace_id=? AND status='failed'",
      args: [at, at, row.id, row.workspace_id],
    });
  });
  return publicJob((await record(id))!);
}

/* ---- running ---- */

/** What a failed run says: our own file names are never shown, and no reason is longer than a sentence or two. */
export function customerReason(raw: string): string {
  const named = raw
    .replace(/input\/m\d+\.\w+/g, "A clip")
    .replace(/input\/logo\d+\.\w+/g, "The logo")
    .replace(/input\/music\d+\.\w+/g, "The music")
    .replace(/input\/[\w./-]+/g, "A file");
  return named.replace(/\s+/g, " ").trim().slice(0, 300);
}

function reasonOf(exitCode: number, timedOut: boolean, resultJson: string | null): string {
  if (timedOut) return "The export took longer than allowed.";
  let errors: string[] = [];
  try {
    const parsed = JSON.parse(resultJson ?? "null") as { errors?: unknown } | null;
    if (parsed && Array.isArray(parsed.errors)) errors = parsed.errors.filter((e): e is string => typeof e === "string").slice(0, 3);
  } catch {
    /* no readable result: the generic line below */
  }
  const detail = errors.length ? ` ${customerReason(errors.join(" "))}` : "";
  if (exitCode === 3) return `A file in the export is not what the request says it is.${detail}`;
  if (exitCode === 2) return `The export request was not valid.${detail}`;
  return `The export could not be rendered.${detail}`;
}

/**
 * Runs a queued export once. Answers "busy" when it went back to the queue because every worker was busy, and
 * "waiting" when this workspace already has its share running; either way nothing started and nothing is billed.
 */
export async function runExport(id: string, deps: ExportDeps = {}): Promise<"busy" | "waiting" | undefined> {
  if (!(await (deps.enabled ?? exportsOnHere)())) return undefined;
  const clock = deps.clock ?? Date.now;
  const limits = (deps.limits ?? exportLimits)();
  const row = await record(id);
  if (!row || row.status !== "queued") return undefined;
  if (row.cancel_requested) {
    await end(row, "cancelled", CANCELLED, clock);
    return undefined;
  }
  if (clock() - Number(row.created_at) >= limits.queueExpiryMs) {
    await end(row, "failed", failure("This export did not start in time."), clock);
    return undefined;
  }
  if (row.error === BUSY_MESSAGE && clock() - Number(row.updated_at) < EXPORT_BUSY_BACKOFF_MS) return "busy";

  const name = `remotion-export-${randomUUID()}`;
  // The claim and the fair share are one statement: queued -> rendering only while this workspace has fewer than its share running.
  const claimed = await db().execute({
    sql: `UPDATE export_jobs SET status='rendering', runtime_id=?, claimed_at=?, error=NULL, updated_at=?
          WHERE id=? AND workspace_id=? AND status='queued' AND cancel_requested=0
            AND (SELECT COUNT(*) FROM export_jobs WHERE workspace_id=? AND status IN ('rendering','saving')) < ?`,
    args: [name, clock(), clock(), id, row.workspace_id, row.workspace_id, limits.maxRunningPerWorkspace],
  });
  if (!claimed.rowsAffected) {
    const now = await record(id);
    return now?.status === "queued" && !now.cancel_requested ? "waiting" : undefined;
  }

  let session: ExportSession | null = null;
  try {
    const spec = JSON.parse(row.spec_json) as StoredSpec;
    const cancelled = async () => Boolean((await record(id))?.cancel_requested);
    // The request bound its media earlier: ask again, as the job's owner, before anything leaves the workspace.
    for (const media of spec.media) {
      if (!(await (deps.reach ?? mediaStillReachable)(row.owner, media))) {
        await end((await record(id))!, "failed", failure("A file in the export is not available any more."), clock);
        return undefined;
      }
    }
    try {
      session = await openExportSession(name, deps.worker);
    } catch (error) {
      if (error instanceof ExportWorkerBusyError) {
        // Nothing started: back to the queue, charged nothing, unless it has waited too long.
        await db().execute({ sql: "UPDATE export_jobs SET status='queued', runtime_id=NULL, claimed_at=NULL, error=?, updated_at=? WHERE id=? AND workspace_id=? AND status='rendering'", args: [BUSY_MESSAGE, clock(), id, row.workspace_id] });
        return "busy";
      }
      if (error instanceof ExportWorkerRefusedError) {
        await end((await record(id))!, "failed", failure("The export workers are not available right now."), clock);
        return undefined;
      }
      throw error;
    }
    const outputSpec = { version: 1, composition: spec.composition, props: spec.props, output: { video: true } };
    await session.putFile("spec.json", JSON.stringify(outputSpec));
    for (const media of spec.media) {
      if (await cancelled()) break;
      const bytes = await (deps.loader ?? loadMedia)(media);
      await session.putFile(`input/${media.file}`, bytes);
    }
    if (await cancelled()) {
      await end((await record(id))!, "cancelled", CANCELLED, clock);
      return undefined;
    }
    const reply = await session.run(limits.runTimeoutMs);
    if (await cancelled()) {
      await end((await record(id))!, "cancelled", CANCELLED, clock);
      return undefined;
    }
    if (reply.exitCode !== 0) {
      const result = await session.readOutput("result.json").catch(() => null);
      await end((await record(id))!, "failed", failure(reasonOf(reply.exitCode, reply.timedOut, result ? result.toString("utf8") : null)), clock);
      return undefined;
    }
    // Saving: read the file off the worker and store it under this workspace's own prefix.
    await db().execute({ sql: "UPDATE export_jobs SET status='saving', updated_at=? WHERE id=? AND workspace_id=? AND status='rendering'", args: [clock(), id, row.workspace_id] });
    const video = await session.readOutput("export.mp4");
    if (!video || video.length < 16) {
      await end((await record(id))!, "failed", failure("The export finished without a file."), clock);
      return undefined;
    }
    const output = await saveOutput(row, video, clock);
    await db().execute({
      sql: "UPDATE export_jobs SET status='ready', outputs_json=?, error=NULL, finished_at=?, updated_at=? WHERE id=? AND workspace_id=? AND status='saving'",
      args: [JSON.stringify([output]), clock(), clock(), id, row.workspace_id],
    });
  } catch (error) {
    const current = await record(id);
    if (current && !isTerminal(current.status)) {
      const reason = error instanceof ExportError ? error.message : "The export could not be completed.";
      await end(current, current.cancel_requested ? "cancelled" : "failed", current.cancel_requested ? CANCELLED : failure(reason), clock);
    }
  } finally {
    await session?.stop().catch(() => {});
  }
  return undefined;
}

async function saveOutput(row: Row, video: Buffer, clock: () => number): Promise<ExportOutput> {
  const uploadId = `${row.id}_video`;
  const stored = await storeUpload(uploadId, "mp4", video, "video/mp4");
  const filename = `export-${row.id.slice(7, 15)}.mp4`;
  await db().execute({
    sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at,uploader_id) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,NULL,?,?) ON CONFLICT(id) DO NOTHING`,
    args: [uploadId, filename, "video/mp4", "mp4", video.length, stored.sha256, stored.url, "video", clock(), row.owner],
  });
  return { kind: "video", uploadId, url: `/api/uploads/${uploadId}`, filename, mime: "video/mp4", bytes: video.length };
}

/* ---- recovery ---- */

/** Past this from its claim a run is over, whatever it was doing: the run call's own limit and time to save. */
export const exportRunCeilingMs = (limits: ExportLimits) => limits.runTimeoutMs + 150_000;

export async function pendingExports(limit = 4, deps: ExportDeps = {}) {
  if (!(await (deps.enabled ?? exportsOnHere)())) return [];
  await exportJobsReady();
  return (
    await db().execute({
      sql: "SELECT id,status,claimed_at,error,updated_at,runtime_id,created_at FROM export_jobs WHERE workspace_id=? AND status IN ('queued','rendering','saving') ORDER BY created_at LIMIT ?",
      args: [workspaceId(), Math.max(1, Math.min(limit, 20))],
    })
  ).rows as unknown as Pick<Row, "id" | "status" | "claimed_at" | "error" | "updated_at" | "runtime_id" | "created_at">[];
}

/**
 * The cron's pass over one workspace: hand queued exports to the worker route (or run them here when there is no
 * queue), and end a run that outlived its ceiling (its worker session is stopped; nothing is billed).
 */
export async function recoverExports(
  options: { limit?: number; deadlineAt?: number } = {},
  deps: ExportDeps & { enqueue?: (jobId: string) => Promise<boolean>; run?: typeof runExport } = {},
) {
  const clock = deps.clock ?? Date.now;
  const limits = (deps.limits ?? exportLimits)();
  const jobs = await pendingExports(options.limit ?? 4, deps);
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  let attempted = 0, failed = 0, deferred = 0;
  for (const job of jobs) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try {
      if (job.status === "queued") {
        if (job.error === BUSY_MESSAGE && clock() - Number(job.updated_at) < EXPORT_BUSY_BACKOFF_MS) continue;
        const enqueue = deps.enqueue ?? (async (id: string) => (await import("./dispatch")).enqueueExport(id));
        if (await enqueue(job.id)) continue;
        // No queue to hand it to: run it here, with a run time that fits the rest of this pass (at least a minute of it).
        const room = deadlineAt - clock() - 20_000;
        if (room >= 60_000) await (deps.run ?? runExport)(job.id, { ...deps, limits: () => ({ ...limits, runTimeoutMs: Math.min(limits.runTimeoutMs, room) }) });
        else deferred++;
        continue;
      }
      if (job.claimed_at != null && clock() - Number(job.claimed_at) > exportRunCeilingMs(limits)) {
        const row = await record(job.id);
        if (row) {
          await end(row, "failed", failure("The export did not finish."), clock);
          if (row.runtime_id) await stopExportSession(row.runtime_id, deps.worker);
        }
      }
    } catch {
      failed++;
    }
  }
  return { attempted, failed, deferred };
}

/** Platform-wide slots for the worker route: one export per configured worker. */
export const exportPlatformSlots = () => exportWorkerSlots();
