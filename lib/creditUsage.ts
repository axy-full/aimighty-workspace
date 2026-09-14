import { db, ready } from "./db";
import { requireTenant } from "./tenant";
import { platformDb } from "./platform";
import { billingStateFor } from "./billingLedger";
import { modelLabel } from "./models";
import { PROVIDERS } from "./providers";

type Row = Record<string, unknown>;
const charge =
  "CASE WHEN paid_by_platform=1 THEN COALESCE(billed_credits,0) ELSE 0 END";
const amount = (r: Row) => ({
  n: Number(r.n ?? 0),
  credits: Number(r.credits ?? 0),
  spend: Number(r.credits ?? 0),
});
const vendors = () =>
  PROVIDERS.map((p) => ({
    id: p.id,
    label: p.id === "google" ? "Google Gemini" : p.label,
  }));

/** Credits are the public accounting unit. Never read a vendor balance or
 * recompute customer charges from a generation's internal provider cost.
 * `spend` is a credit-valued compatibility alias for the existing chart bars. */
export async function creditUsageSummary() {
  const ws = requireTenant();
  const state = await billingStateFor(ws.id);
  const rows = await platformDb().execute({
    sql: `SELECT SUM(status='running') AS pending,SUM(CASE WHEN kind='text' THEN ${charge} ELSE 0 END) AS prompt_credits FROM meter_events WHERE workspace_id=?`,
    args: [ws.id],
  });
  return {
    unit: "credits" as const,
    pending: Number(rows.rows[0]?.pending ?? 0),
    spentCredits: state.credits.used,
    promptSpendCredits: Number(rows.rows[0]?.prompt_credits ?? 0),
    credits: {
      granted: state.credits.granted,
      used: state.credits.used,
      balance: state.credits.balance,
    },
    vendors: vendors(),
  };
}

function visibleParams(raw: unknown): Record<string, string | number> {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(raw ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>;
  } catch {}
  const result: Record<string, string | number> = {};
  for (const key of ["resolution", "ratio"])
    if (typeof value[key] === "string" && String(value[key]).length <= 40)
      result[key] = String(value[key]);
  for (const key of ["duration", "steps"])
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      result[key] = Number(value[key]);
  return result;
}

export async function creditUsage() {
  await ready();
  const ws = requireTenant(),
    summary = await creditUsageSummary(),
    p = platformDb();
  const [
    totals,
    models,
    projects,
    people,
    months,
    recent,
    projectNames,
    personNames,
    stages,
  ] = await Promise.all([
    p.execute({
      sql: `SELECT COUNT(*) AS n,SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed,SUM(kind='text') AS prompts FROM meter_events WHERE workspace_id=?`,
      args: [ws.id],
    }),
    p.execute({
      sql: `SELECT model,engine,kind,SUM(status='succeeded') AS n,SUM(${charge}) AS credits FROM meter_events WHERE workspace_id=? GROUP BY model,engine,kind HAVING credits>0 OR n>0 ORDER BY credits DESC`,
      args: [ws.id],
    }),
    p.execute({
      sql: `SELECT project_id,SUM(status='succeeded') AS n,SUM(${charge}) AS credits FROM meter_events WHERE workspace_id=? GROUP BY project_id HAVING credits>0 OR n>0 ORDER BY credits DESC`,
      args: [ws.id],
    }),
    p.execute({
      sql: `SELECT created_by,SUM(status='succeeded') AS n,SUM(${charge}) AS credits FROM meter_events WHERE workspace_id=? GROUP BY created_by HAVING credits>0 OR n>0 ORDER BY credits DESC`,
      args: [ws.id],
    }),
    p.execute({
      sql: `SELECT strftime('%Y-%m',datetime(created_at/1000,'unixepoch')) AS month,SUM(status='succeeded') AS n,SUM(${charge}) AS credits FROM meter_events WHERE workspace_id=? GROUP BY month HAVING credits>0 OR n>0 ORDER BY month DESC LIMIT 12`,
      args: [ws.id],
    }),
    p.execute({
      sql: `SELECT id,model,engine,kind,status,${charge} AS credits,created_at FROM meter_events WHERE workspace_id=? AND (status='succeeded' OR (status='failed' AND ${charge}>0)) ORDER BY created_at DESC,id DESC LIMIT 60`,
      args: [ws.id],
    }),
    db().execute("SELECT id,name FROM projects"),
    db().execute("SELECT id,name FROM users"),
    db().execute(
      "SELECT kind,queue_ms,refine_ms,submit_ms,engine_ms,notice_ms,store_ms,duration_ms+COALESCE(refine_ms,0) AS wait_ms FROM generations WHERE status='succeeded' AND deleted=0 AND (engine_ms IS NOT NULL OR store_ms IS NOT NULL OR refine_ms IS NOT NULL) ORDER BY created_at DESC LIMIT 400",
    ),
  ]);
  const projectLabel = new Map(
    projectNames.rows.map((r) => [String(r.id), String(r.name)]),
  );
  const personLabel = new Map(
    personNames.rows.map((r) => [String(r.id), String(r.name)]),
  );
  const ids = recent.rows.map((r) => String(r.id));
  // Whitelist metadata from this tenant. Never serialize a generation row or
  // its parameters wholesale: paidClaim and producedOutcome contain internals.
  const descriptions = ids.length
    ? (
        await db().execute({
          sql: `SELECT id,title,prompt,params FROM generations WHERE id IN (${ids.map(() => "?").join(",")})`,
          args: ids,
        })
      ).rows
    : [];
  const descriptionsById = new Map(descriptions.map((r) => [String(r.id), r]));
  const median = (rows: Row[], key: string) => {
    const values = rows
      .map((r) => r[key])
      .filter((v) => v != null)
      .map(Number)
      .sort((a, b) => a - b);
    return values.length
      ? Math.round(values[Math.floor(values.length / 2)])
      : null;
  };
  const timing = ["video", "image", "audio"]
    .map((kind) => {
      const rows = stages.rows.filter((r) => r.kind === kind);
      return {
        kind,
        n: rows.length,
        totalMs: median(rows, "wait_ms"),
        queueMs: median(rows, "queue_ms"),
        refineMs: median(rows, "refine_ms"),
        submitMs: median(rows, "submit_ms"),
        engineMs: median(rows, "engine_ms"),
        noticeMs: median(rows, "notice_ms"),
        storeMs: median(rows, "store_ms"),
      };
    })
    .filter((t) => t.n > 0);
  const t = totals.rows[0];
  return {
    ...summary,
    totalGenerations: Number(t.n ?? 0),
    succeeded: Number(t.succeeded ?? 0),
    failed: Number(t.failed ?? 0),
    promptCount: Number(t.prompts ?? 0),
    storage: null,
    timing,
    refines: [],
    byModel: models.rows.map((r) => ({
      model: String(r.model),
      label: modelLabel(String(r.model)),
      provider: String(r.engine),
      kind: String(r.kind),
      ...amount(r),
      promptSpend: r.kind === "text" ? Number(r.credits) : 0,
    })),
    byProject: projects.rows.map((r) => ({
      name:
        r.project_id == null
          ? "Unfiled"
          : (projectLabel.get(String(r.project_id)) ?? "Deleted production"),
      ...amount(r),
    })),
    byPerson: people.rows.map((r) => ({
      name: personLabel.get(String(r.created_by)) ?? "Unknown",
      ...amount(r),
    })),
    byMonth: months.rows.map((r) => ({ month: String(r.month), ...amount(r) })),
    recent: recent.rows.map((r) => {
      const detail = descriptionsById.get(String(r.id));
      return {
        id: String(r.id),
        model: String(r.model),
        label: modelLabel(String(r.model)),
        provider: String(r.engine),
        kind: String(r.kind),
        status: String(r.status),
        title: detail?.title
          ? String(detail.title)
          : r.kind === "text"
            ? "Atomik text"
            : r.kind === "training"
              ? "Identity training"
              : null,
        prompt: detail ? String(detail.prompt ?? "") : "",
        credits: Number(r.credits),
        params: detail ? visibleParams(detail.params) : {},
        createdAt: Number(r.created_at),
        refineLabel: null,
      };
    }),
  };
}
