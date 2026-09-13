import { platformDb, platformReady, now, getWorkspace, engineOff } from "./platform";
import { currentTenant } from "./tenant";
import { billCreditsWith, multiplierFor, marginKeyOf, creditUsd } from "./creditTerms";
import type { Span } from "./concurrency";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";
import { providerOf } from "./models";
import { PROVIDERS, type ProviderId } from "./providers";
import { enginePausedMessage } from "./platformLayer";
import { marginPctOf } from "./adminView";

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
 * the workspace pays — whole credits at the engine's margin, or at cost for
 * a workspace flagged internal (§7A guardrail 6) — and only when the
 * platform's key paid the vendor. A workspace on its own key for that
 * vendor is metered at zero credits: the money was theirs.
 *
 * This is also where the engine kill switch is read (SOW v2 §9): a job that
 * would START on a provider the platform has switched off is refused here,
 * before its row exists, with one sentence every caller can show. The gate
 * lives where money starts, because a switch that only hid an engine from a
 * list while this still ran it would be a money bug. Completions are never
 * gated: a job already running must be able to end.
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
 * The provider a job's switch is keyed by: the MODEL's own vendor, and only
 * where the catalogue does not know the model (a voice, a text model, the
 * trainer) the ledger's engine, which for those is the same company.
 */
export function switchProviderOf(model: string | null | undefined, engine: string): string {
  return providerOf(model) ?? engine;
}

const providerLabel = (id: string): string => PROVIDERS.find((p) => p.id === id)?.label ?? id;

/**
 * Refuse to start a job on a switched-off provider: throws the one refusal
 * sentence (lib/platformLayer.ts enginePausedMessage), else returns. Read
 * from the platform layer, tenant-agnostic, cached ten seconds with the
 * rest of it. A layer that cannot be read does not refuse — the INSERT
 * that follows fails on the same database and refuses for it.
 */
export async function refuseIfPaused(model: string | null | undefined, engine: string): Promise<void> {
  const pid = switchProviderOf(model, engine);
  const gate = await engineOff(pid).catch(() => ({ off: false, reason: null as string | null }));
  if (gate.off) throw new Error(enginePausedMessage(providerLabel(pid), gate.reason));
}

/**
 * Write or update one event. A `critical` write (the default for a job
 * that is starting) throws when it cannot be recorded, because work the
 * platform cannot bill must not start; a completion is logged and left for
 * the next pass rather than failing a render that already exists.
 */
export async function meter(e: MeterEvent, opts: { critical?: boolean } = {}): Promise<void> {
  const critical = opts.critical ?? e.status === "running";
  const tenantWs = currentTenant()?.workspace ?? null;
  const workspaceId = e.workspaceId ?? tenantWs?.id;
  if (!workspaceId) return;
  /* The switch, only where a job starts: a switched-off engine refuses new
     work and lets running work finish. */
  if (e.status === "running") await refuseIfPaused(e.model, e.engine);
  const paid = paidByPlatform(vendorKeyNameFor(e.engine));
  const cost = typeof e.engineCostUsd === "number" && Number.isFinite(e.engineCostUsd) ? Math.max(0, e.engineCostUsd) : null;
  /* Whose multiplier: the tenant's flag when the row is the tenant's, else the
     workspace's own row — looked up only when there is something to bill. */
  let internal = false;
  if (cost != null && paid) {
    internal = tenantWs && tenantWs.id === workspaceId
      ? tenantWs.internal === true
      : (await getWorkspace(workspaceId).catch(() => null))?.internal === true;
  }
  const billed = cost == null ? null : paid ? billCreditsWith(cost, multiplierFor(marginKeyOf(e.kind, e.model), internal), creditUsd()) : 0;
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

/**
 * Every job's interval since a moment, for the concurrency sweep (§7).
 *
 * `updated_at` is the completion — the upsert moves it when a render
 * finishes — so `[created_at, updated_at)` is the job's life. A row still
 * `running` has not been moved yet, and its end is reported as null so the
 * sweep can count it up to now rather than reading it as instantaneous.
 *
 * Only the platform's own jobs: a workspace on its own keys queues against
 * its OWN provider limit, so counting it here would inflate the number this
 * exists to produce — the one taken to a provider to ask for more.
 */
export async function engineSpansSince(sinceMs: number): Promise<Span[]> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT engine, status, created_at, updated_at
            FROM meter_events
           WHERE created_at >= ? AND paid_by_platform = 1
           ORDER BY created_at`,
    args: [sinceMs],
  });
  return (rs.rows as unknown as Record<string, unknown>[]).map((r) => ({
    engine: String(r.engine ?? ""),
    startedAt: Number(r.created_at ?? 0),
    endedAt: String(r.status) === "running" ? null : Number(r.updated_at ?? 0),
  }));
}

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

/* ── the platform's own view (SOW v2 §7.13, board 12h) ──────────────────
   Two reads across every workspace, platform-paid rows only, the pricing
   view of margin (lib/adminView.ts marginPctOf — no funded fraction, since
   the question is whether the multiplier holds over cost). Rows still
   `running` are IN: their engine_cost_usd is the pre-flight estimate and
   their billed_credits the estimate's bill, so month-to-date and the 7-day
   figure are partly estimate until each job ends. Internal workspaces (§7A
   guardrail 6) are listed but kept OUT of every total, so the platform's
   numbers are never distorted by its own spend at cost. */

export type PlatformWorkspaceMeter = { engineCostUsd: number; billedCredits: number; jobs: number; failed: number; internal: boolean };
export type PlatformCycle = {
  engineCostUsd: number; billedCredits: number; marginPct: number | null;
  byWorkspace: Map<string, PlatformWorkspaceMeter>;
};

/** Since a moment (to another, default open): the platform's engine spend, what it billed, its margin, and each workspace's share — internal ones listed, excluded from the totals. */
export async function platformCycle(sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER): Promise<PlatformCycle> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT m.workspace_id, COALESCE(w.internal, 0) AS internal, COUNT(*) AS jobs, SUM(m.status = 'failed') AS failed,
                 COALESCE(SUM(COALESCE(m.engine_cost_usd, 0)), 0) AS cost,
                 COALESCE(SUM(COALESCE(m.billed_credits, 0)), 0) AS billed
            FROM meter_events m LEFT JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.paid_by_platform = 1 AND m.created_at >= ? AND m.created_at < ?
           GROUP BY m.workspace_id`,
    args: [sinceMs, untilMs],
  });
  const byWorkspace = new Map<string, PlatformWorkspaceMeter>();
  let engineCostUsd = 0; let billedCredits = 0;
  for (const r of rs.rows as unknown as Record<string, unknown>[]) {
    const row: PlatformWorkspaceMeter = {
      engineCostUsd: Number(r.cost ?? 0), billedCredits: Number(r.billed ?? 0),
      jobs: Number(r.jobs ?? 0), failed: Number(r.failed ?? 0), internal: Number(r.internal ?? 0) === 1,
    };
    byWorkspace.set(String(r.workspace_id), row);
    if (row.internal) continue;
    engineCostUsd += row.engineCostUsd; billedCredits += row.billedCredits;
  }
  return { engineCostUsd, billedCredits, marginPct: marginPctOf(billedCredits, engineCostUsd, creditUsd()), byWorkspace };
}

export type EngineMarginRow = { engineCostUsd: number; billedCredits: number; marginPct: number | null; jobs: number; failed: number };
export type EngineMargin = Record<ProviderId, EngineMarginRow>;

/**
 * Since a moment, per PROVIDER — the model's own vendor, joined in code
 * (lib/models.ts), never the ledger's `engine`, which is who was billed and
 * for a Google still can read `vercel`. The floor guard's figure (§7A):
 * platform-paid rows, internal workspaces out, running rows in as estimates
 * (see above). Every registered provider is present, at zero when idle.
 */
export async function engineMargin(sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER): Promise<EngineMargin> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT m.model, m.engine, COUNT(*) AS jobs, SUM(m.status = 'failed') AS failed,
                 COALESCE(SUM(COALESCE(m.engine_cost_usd, 0)), 0) AS cost,
                 COALESCE(SUM(COALESCE(m.billed_credits, 0)), 0) AS billed
            FROM meter_events m LEFT JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.paid_by_platform = 1 AND COALESCE(w.internal, 0) = 0 AND m.created_at >= ? AND m.created_at < ?
           GROUP BY m.model, m.engine`,
    args: [sinceMs, untilMs],
  });
  const out = Object.fromEntries(PROVIDERS.map((p) => [p.id, { engineCostUsd: 0, billedCredits: 0, marginPct: null, jobs: 0, failed: 0 }])) as EngineMargin;
  for (const r of rs.rows as unknown as Record<string, unknown>[]) {
    const pid = switchProviderOf(r.model == null ? null : String(r.model), String(r.engine ?? "")) as ProviderId;
    const row = out[pid];
    if (!row) continue; // a vendor this build has never heard of: not a switch, not a row
    row.engineCostUsd += Number(r.cost ?? 0); row.billedCredits += Number(r.billed ?? 0);
    row.jobs += Number(r.jobs ?? 0); row.failed += Number(r.failed ?? 0);
  }
  const per = creditUsd();
  for (const row of Object.values(out)) row.marginPct = marginPctOf(row.billedCredits, row.engineCostUsd, per);
  return out;
}

/**
 * Usage's breakdowns (SOW v2 §7.12, board 12f): what the one ledger billed a
 * workspace in a window — by model and kind, by day, by project, by person,
 * by shot. Five grouped reads, one source, so the headline, the bars and the
 * statement never disagree by a rounding.
 */
export type MeterBreakdown = {
  byModel: { model: string; kind: string; billedCredits: number }[];
  byDay: { day: number; billedCredits: number }[];
  byProject: { projectId: string | null; billedCredits: number }[];
  byPerson: { userId: string | null; kind: string; billedCredits: number }[];
  byShot: { shotId: string | null; billedCredits: number }[];
  /** Calendar months (UTC), the statement's own key, oldest first. */
  byMonth: { month: string; billedCredits: number }[];
};
export async function meterBreakdown(workspaceId: string, sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER): Promise<MeterBreakdown> {
  await platformReady();
  const where = `workspace_id = ? AND paid_by_platform = 1 AND created_at >= ? AND created_at < ?`;
  const args = [workspaceId, sinceMs, untilMs];
  const q = (sql: string) => platformDb().execute({ sql, args });
  const [m, d, p, u, s, mo] = await Promise.all([
    q(`SELECT model, kind, COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE ${where} GROUP BY model, kind ORDER BY n DESC`),
    q(`SELECT (created_at / 86400000) * 86400000 AS day, COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE ${where} GROUP BY day ORDER BY day`),
    q(`SELECT project_id, COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE ${where} GROUP BY project_id ORDER BY n DESC`),
    q(`SELECT created_by, kind, COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE ${where} GROUP BY created_by, kind ORDER BY n DESC`),
    q(`SELECT shot_id, COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE ${where} GROUP BY shot_id`),
    q(`SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month, COALESCE(SUM(COALESCE(billed_credits, 0)), 0) AS n FROM meter_events WHERE ${where} GROUP BY month ORDER BY month`),
  ]);
  const rows = (rs: { rows: unknown[] }) => rs.rows as Record<string, unknown>[];
  const idOrNull = (v: unknown) => (v == null || v === "" ? null : String(v));
  return {
    byModel: rows(m).map((r) => ({ model: String(r.model ?? ""), kind: String(r.kind ?? "video"), billedCredits: Number(r.n ?? 0) })),
    byDay: rows(d).map((r) => ({ day: Number(r.day ?? 0), billedCredits: Number(r.n ?? 0) })),
    byProject: rows(p).map((r) => ({ projectId: idOrNull(r.project_id), billedCredits: Number(r.n ?? 0) })),
    byPerson: rows(u).map((r) => ({ userId: idOrNull(r.created_by), kind: String(r.kind ?? "video"), billedCredits: Number(r.n ?? 0) })),
    byShot: rows(s).map((r) => ({ shotId: idOrNull(r.shot_id), billedCredits: Number(r.n ?? 0) })),
    byMonth: rows(mo).map((r) => ({ month: String(r.month ?? ""), billedCredits: Number(r.n ?? 0) })),
  };
}
