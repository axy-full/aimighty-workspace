import { db } from "./db";
import { listGenerations, type Generation } from "./jobs";
import { creditsApply } from "./credits";
import { billCredits, marginKeyOf } from "./creditTerms";
import { estimateForRow } from "./jobCost";
import { heldNeeds, type HeldInfo } from "./held";
import { currentTenant } from "./tenant";
import { CONSUMER_CAPACITY_WINDOW_MS, consumerJobsReady } from "./higgsfield-consumer/jobs";
import {
  ENGINE_ACTIVE, ENGINE_SETTLED, TRAY_ACTIVE_POLL_S, TRAY_IDLE_POLL_S, TRAY_WINDOW_MS,
  accountTrayJob, active, engineTrayJob, trayOrder, type AccountRow, type EnginePricing, type TrayReply,
} from "./jobsTray";

/**
 * GET /api/jobs?view=tray: this person's own takes in flight and those
 * finished in the last few hours, from both engines, in this workspace's
 * database only. Reads rows; never contacts a provider (the list route's own
 * reconciliation runs after the answer, as it does for every list read).
 *
 * The price is the one the person approved: what a finished take was billed,
 * what a held one needs, and — in flight — the same estimate the quote on the
 * button was taken from, rounded to credits here so the rate never leaves
 * the server. A workspace on its own keys sees its own dollars instead.
 */
export async function trayJobs(userId: string, now = Date.now()): Promise<TrayReply> {
  const inCredits = creditsApply(currentTenant()?.workspace);
  const since = now - TRAY_WINDOW_MS;
  const [running, settled, account] = await Promise.all([
    listGenerations({ createdBy: userId, statuses: ENGINE_ACTIVE, limit: 30 }),
    listGenerations({ createdBy: userId, statuses: ENGINE_SETTLED, updatedSince: since, limit: 20 }),
    /* The connected account's rows are a second read; if it fails, the engine's rows still show and the tray says so. */
    accountRows(userId, since, now).catch(() => null),
  ]);
  /* A connected original is filed as a take of its own (gen_hfc_…); the account's row stands for it. */
  const engine = [...running, ...settled].filter((g) => !g.id.startsWith("gen_hfc_"));
  const drafts = await draftsFor(userId, engine);
  const jobs = trayOrder([
    ...engine.map((g) => engineTrayJob(g, pricing(g, inCredits), g.projectId ? drafts.get(g.projectId) ?? null : null)),
    ...(account ?? []).map(accountTrayJob),
  ]);
  return { jobs, pollAfterSeconds: jobs.some(active) ? TRAY_ACTIVE_POLL_S : TRAY_IDLE_POLL_S, ...(account ? {} : { partial: true }) };
}

function pricing(g: Generation, inCredits: boolean): EnginePricing {
  const unit = inCredits ? "cr" : "usd";
  if (ENGINE_SETTLED.includes(g.status)) return { unit, inFlight: null, heldNeeds: null };
  const usd = estimateForRow({ status: g.status, params: g.params, kind: g.kind, model: g.model });
  const inFlight = usd == null ? null : inCredits ? billCredits(usd, marginKeyOf(g.kind, g.model)) : usd;
  /* What the release is measured against now, the same figure a refused Release names (lib/held heldNeeds). */
  const needs = g.status === "held" && inCredits ? heldNeeds(g.params.held as Partial<HeldInfo> | undefined, g.kind, g.model) || null : null;
  return { unit, inFlight, heldNeeds: needs };
}

/** Which of this person's projects each take's production is open in, so Open in Takes lands there. */
async function draftsFor(userId: string, rows: Generation[]): Promise<Map<string, string>> {
  const productions = [...new Set(rows.map((g) => g.projectId).filter((id): id is string => Boolean(id)))].slice(0, 20);
  const out = new Map<string, string>();
  if (!productions.length) return out;
  try {
    const rs = await db().execute({
      sql: `SELECT project_id, json_extract(body,'$.productionProjectId') AS production FROM workbench_projects
        WHERE owner=? AND json_extract(body,'$.productionProjectId') IN (${productions.map(() => "?").join(",")})
        ORDER BY updated_at DESC`,
      args: [userId, ...productions],
    });
    for (const row of rs.rows) {
      const production = String(row.production ?? "");
      if (production && !out.has(production)) out.set(production, String(row.project_id));
    }
  } catch { /* the rows still show; Open in Takes then opens the project in view */ }
  return out;
}

/**
 * The connected account's jobs this person sent (a durable dispatch claim;
 * a quote never sent is not a job). Open ones while they can still hold a
 * slot, and anything settled inside the window. Only the columns the tray
 * needs are read — never the payload, the receipt or the grant.
 */
async function accountRows(userId: string, since: number, now: number): Promise<AccountRow[]> {
  await consumerJobsReady();
  const rs = await db().execute({
    sql: `SELECT j.id, j.draft_id, j.workflow, j.status, j.quote_credits, j.failure_code, j.created_at, j.updated_at, j.released_at,
        j.provider_receipt IS NOT NULL AS has_receipt,
        SUBSTR(json_extract(j.payload_json,'$.input.prompt'),1,400) AS prompt,
        json_extract(j.payload_json,'$.composer') AS composer,
        json_extract(j.payload_json,'$.model.id') AS model_id,
        json_extract(j.payload_json,'$.model.outputType') AS output_type,
        json_extract(j.payload_json,'$.tool.label') AS tool_label,
        json_extract(j.result_manifest,'$.original.generationId') AS original_id,
        json_extract(j.result_manifest,'$.original.kind') AS original_kind,
        SUBSTR(p.name,1,200) AS project_name
      FROM higgsfield_consumer_jobs j
      LEFT JOIN workbench_projects p ON p.owner=j.user_id AND p.project_id=j.draft_id
      WHERE j.user_id=? AND j.dispatch_claim_hash IS NOT NULL AND j.status<>'quoted'
        AND ((j.status IN ('dispatching','accepted','uncertain') AND j.released_at IS NULL AND j.created_at > ?) OR j.updated_at >= ?)
      ORDER BY j.created_at DESC, j.id DESC LIMIT 25`,
    args: [userId, now - CONSUMER_CAPACITY_WINDOW_MS, since],
  });
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return rs.rows.map((row) => {
    const status = String(row.status);
    const createdAt = Number(row.created_at);
    return {
      id: String(row.id), draftId: String(row.draft_id), workflow: String(row.workflow), status,
      quoteCredits: Number(row.quote_credits ?? 0), failureCode: text(row.failure_code),
      createdAt, updatedAt: Number(row.updated_at), hasReceipt: Boolean(Number(row.has_receipt)),
      /* lib/higgsfield-consumer/jobs consumerJobSetAside: open, but set aside or past the capacity window. */
      setAside: ["dispatching", "accepted", "uncertain"].includes(status) && (row.released_at != null || createdAt <= now - CONSUMER_CAPACITY_WINDOW_MS),
      prompt: text(row.prompt), composer: text(row.composer), modelId: text(row.model_id), outputType: text(row.output_type),
      toolLabel: text(row.tool_label), originalId: text(row.original_id), originalKind: text(row.original_kind), projectName: text(row.project_name),
    };
  });
}
