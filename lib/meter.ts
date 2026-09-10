import { platformDb, platformReady, now } from "./platform";
import { currentTenant } from "./tenant";
import { billCredits, marginKeyOf } from "./creditTerms";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";

/**
 * The metering layer. Every engine call, whatever the vendor, is written
 * here — once when the work starts (status running, the estimate) and once
 * when it ends (the actual cost, succeeded or failed). One row per unit of
 * work, keyed by the thing it produced: a generation, an identity, a
 * message, a spend row. Writing the same id again updates the row, so the
 * poll that finishes a render and the cron that rescues it cannot bill it
 * twice.
 *
 * The rows live in the platform record with a workspace_id, because this is
 * the one place the platform reads across workspaces: balances, statements,
 * engine health, margin. The workspace's own tables keep the product data.
 *
 * `engine_cost_usd` is what the vendor charged; `billed_credits` is what
 * the workspace pays — whole credits at the engine's margin — and only when
 * the platform's key paid the vendor. A workspace on its own key for that
 * vendor is metered at zero credits: the money was theirs.
 */
export type MeterKind = "video" | "image" | "audio" | "training" | "text";
export type MeterStatus = "running" | "succeeded" | "failed";
export type MeterEvent = {
  id: string;
  kind: MeterKind;
  /** Who billed: a provider id (byteplus, google, vercel, fal, elevenlabs). */
  engine: string;
  model: string;
  status: MeterStatus;
  /** Vendor cost in dollars; null means "unchanged" on an update. */
  engineCostUsd?: number | null;
  projectId?: string | null;
  shotId?: string | null;
  durationMs?: number | null;
  createdBy?: string | null;
  /** Defaults to the current tenant's workspace. */
  workspaceId?: string;
};


/**
 * Write or update one event. A `critical` write (the default for a job
 * that is starting) throws when it cannot be recorded, because work the
 * platform cannot bill must not start; a completion is logged and left for
 * the next pass rather than failing a render that already exists.
 */
export async function meter(e: MeterEvent, opts: { critical?: boolean } = {}): Promise<void> {
  const critical = opts.critical ?? e.status === "running";
  const workspaceId = e.workspaceId ?? currentTenant()?.workspace?.id;
  if (!workspaceId) return;
  const paid = paidByPlatform(vendorKeyNameFor(e.engine));
  const cost = typeof e.engineCostUsd === "number" && Number.isFinite(e.engineCostUsd) ? Math.max(0, e.engineCostUsd) : null;
  const billed = cost == null ? null : paid ? billCredits(cost, marginKeyOf(e.kind, e.model)) : 0;
  const ts = now();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await platformReady();
      await platformDb().execute({
        sql: `INSERT INTO meter_events
                (id, workspace_id, project_id, shot_id, kind, engine, model, status,
                 engine_cost_usd, billed_credits, paid_by_platform, duration_ms, created_by, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                engine_cost_usd = COALESCE(excluded.engine_cost_usd, meter_events.engine_cost_usd),
                billed_credits = COALESCE(excluded.billed_credits, meter_events.billed_credits),
                paid_by_platform = excluded.paid_by_platform,
                project_id = COALESCE(excluded.project_id, meter_events.project_id),
                shot_id = COALESCE(excluded.shot_id, meter_events.shot_id),
                duration_ms = COALESCE(excluded.duration_ms, meter_events.duration_ms),
                created_by = COALESCE(excluded.created_by, meter_events.created_by),
                updated_at = excluded.updated_at`,
        args: [e.id, workspaceId, e.projectId ?? null, e.shotId ?? null, e.kind, e.engine, e.model, e.status,
               cost, billed, paid ? 1 : 0, e.durationMs ?? null, e.createdBy ?? null, ts, ts],
      });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(`meter: ${e.kind} ${e.id} (${e.status}) not written —`, (lastErr as Error)?.message);
  if (critical) throw new Error("The platform could not record this job, so it was not started. Try again in a moment.");
}

/** Credits the platform has billed a workspace, all time. */
export async function creditsUsed(workspaceId: string): Promise<number> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE workspace_id = ? AND paid_by_platform = 1`,
    args: [workspaceId],
  });
  return Number((rs.rows[0] as Record<string, unknown>)?.n ?? 0);
}

export type MeterSummary = {
  jobs: number; failed: number; running: number;
  engineCostUsd: number; billedCredits: number;
  byEngine: { engine: string; jobs: number; failed: number; engineCostUsd: number; billedCredits: number }[];
};

/** What a workspace has run since a moment — the admin's view, and the statement's. */
export async function meterSummary(workspaceId: string, sinceMs = 0): Promise<MeterSummary> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT engine, COUNT(*) AS jobs,
                 SUM(status = 'failed') AS failed, SUM(status = 'running') AS running,
                 COALESCE(SUM(COALESCE(engine_cost_usd, 0)), 0) AS cost,
                 COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS billed
          FROM meter_events WHERE workspace_id = ? AND created_at >= ? GROUP BY engine ORDER BY billed DESC`,
    args: [workspaceId, sinceMs],
  });
  const byEngine = (rs.rows as Record<string, unknown>[]).map((r) => ({
    engine: String(r.engine), jobs: Number(r.jobs ?? 0), failed: Number(r.failed ?? 0),
    engineCostUsd: Number(r.cost ?? 0), billedCredits: Number(r.billed ?? 0),
  }));
  const running = (rs.rows as Record<string, unknown>[]).reduce((a, r) => a + Number(r.running ?? 0), 0);
  return {
    jobs: byEngine.reduce((a, r) => a + r.jobs, 0),
    failed: byEngine.reduce((a, r) => a + r.failed, 0),
    running,
    engineCostUsd: byEngine.reduce((a, r) => a + r.engineCostUsd, 0),
    billedCredits: byEngine.reduce((a, r) => a + r.billedCredits, 0),
    byEngine,
  };
}

/**
 * The platform's margin on what it billed: credits at the rate, less what the
 * engines charged — and only the share of those credits somebody paid for.
 *
 * `funded` is `fundedFraction(paid, free)` for the workspace. Without it this
 * priced EVERY spent credit at the full rate, including the welcome grant, so
 * a workspace burning free credits reported its whole balance as revenue: 250
 * welcome credits read as $25 the platform never took. §7A's bonus credits
 * would have made that up to a fifth of every pack.
 *
 * Required rather than defaulted to 1, because a caller that forgets it gets
 * the old wrong number back silently.
 */
export const marginUsd = (billedCredits: number, engineCostUsd: number, perCredit: number, funded: number): number =>
  billedCredits * perCredit * funded - engineCostUsd;

export type WorkspaceMeter = { jobs: number; failed: number; running: number; engineCostUsd: number; billedCredits: number };

/** Since a moment, per workspace: the platform's own spend and what it billed for it. */
export async function meterByWorkspace(sinceMs: number): Promise<Map<string, WorkspaceMeter>> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT workspace_id, COUNT(*) AS jobs, SUM(status = 'failed') AS failed, SUM(status = 'running') AS running,
                 COALESCE(SUM(CASE WHEN paid_by_platform = 1 THEN COALESCE(engine_cost_usd, 0) ELSE 0 END), 0) AS cost,
                 COALESCE(SUM(CASE WHEN paid_by_platform = 1 THEN COALESCE(billed_credits, 0) ELSE 0 END), 0) AS billed
          FROM meter_events WHERE created_at >= ? GROUP BY workspace_id`,
    args: [sinceMs],
  });
  const out = new Map<string, WorkspaceMeter>();
  for (const r of rs.rows as unknown as Record<string, unknown>[]) {
    out.set(String(r.workspace_id), {
      jobs: Number(r.jobs ?? 0), failed: Number(r.failed ?? 0), running: Number(r.running ?? 0),
      engineCostUsd: Number(r.cost ?? 0), billedCredits: Number(r.billed ?? 0),
    });
  }
  return out;
}

export type EngineHealthRow = {
  engine: string; model: string; jobs: number; failed: number; running: number;
  failRate: number; avgMs: number | null; maxMs: number | null; engineCostUsd: number;
};

/** Since a moment, per engine and model, across every workspace: what ran, what failed, how long it took. */
export async function engineHealth(sinceMs: number): Promise<EngineHealthRow[]> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT engine, model, COUNT(*) AS jobs, SUM(status = 'failed') AS failed, SUM(status = 'running') AS running,
                 AVG(CASE WHEN status = 'succeeded' THEN duration_ms END) AS avg_ms,
                 MAX(CASE WHEN status = 'succeeded' THEN duration_ms END) AS max_ms,
                 COALESCE(SUM(COALESCE(engine_cost_usd, 0)), 0) AS cost
          FROM meter_events WHERE created_at >= ? GROUP BY engine, model ORDER BY jobs DESC`,
    args: [sinceMs],
  });
  return (rs.rows as unknown as Record<string, unknown>[]).map((r) => {
    const jobs = Number(r.jobs ?? 0); const failed = Number(r.failed ?? 0);
    return {
      engine: String(r.engine), model: String(r.model), jobs, failed, running: Number(r.running ?? 0),
      failRate: jobs ? failed / jobs : 0,
      avgMs: r.avg_ms == null ? null : Number(r.avg_ms), maxMs: r.max_ms == null ? null : Number(r.max_ms),
      engineCostUsd: Number(r.cost ?? 0),
    };
  });
}
