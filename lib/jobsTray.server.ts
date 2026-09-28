import { db } from "./db";
import { listGenerations, type Generation } from "./jobs";
import { creditsApply } from "./credits";
import { platformDb, platformReady } from "./platform";
import { currentTenant } from "./tenant";
import { CONSUMER_CAPACITY_WINDOW_MS, consumerJobsReady } from "./higgsfield-consumer/jobs";
import { mediaKindForRole } from "./higgsfield-consumer/catalogue";
import { shortName } from "./higgsfield-consumer/resume";
import { recreateBlock, recreatePreset, type GenPreset, type RecipeSource } from "./shell/recipe";
import { parseOutcome } from "./providerOutcome";
import {
  ENGINE_ACTIVE, ENGINE_SETTLED, TRAY_ACTIVE_POLL_S, TRAY_IDLE_POLL_S, TRAY_WINDOW_MS,
  accountTrayJob, changing, engineTrayJob, trayOrder, type AccountRow, type EngineMoney, type EngineRecreate, type TrayReply,
} from "./jobsTray";

/**
 * GET /api/jobs?view=tray: this person's own takes in flight and those that
 * settled in the last few hours, from both engines, in this workspace's
 * database only. Reads rows; never contacts a provider (the list route's own
 * reconciliation runs after the answer, as it does for every list read).
 *
 * Money is the ledger's (lib/usageLedger): a workspace on credits reads the
 * meter — what admission reserved when the take was approved, then what it
 * settled at, zero once a reservation is released — and nothing else, so no
 * dollar leaves this path for it. A workspace that pays its vendors reads its
 * own dollars. A held take carries the current release quote from the
 * generation response; a connected job uses the account's own credits as quoted.
 * The tray does not calculate a price.
 */
export async function trayJobs(userId: string, now = Date.now()): Promise<TrayReply> {
  const workspace = currentTenant()?.workspace;
  const inCredits = creditsApply(workspace);
  const since = now - TRAY_WINDOW_MS;
  const [running, finished, account] = await Promise.all([
    /* Only what this person set going here: not the starter production's demo takes, nor the connected account's filed originals (its own row stands for those). */
    listGenerations({ createdBy: userId, statuses: ENGINE_ACTIVE, ownRenders: true, limit: 30 }),
    listGenerations({ createdBy: userId, statuses: ENGINE_SETTLED, settledSince: since, ownRenders: true, limit: 20 }),
    /* The connected account's rows are a second read; if it fails, the engine's rows still show and the tray says so. */
    accountRows(userId, since, now).catch(() => null),
  ]);
  const engine = [...running, ...finished];
  const [drafts, money] = await Promise.all([draftsFor(userId, engine), ledgerFor(engine, inCredits, workspace?.id ?? null)]);
  const jobs = trayOrder([
    ...engine.map((g) => engineTrayJob(g, money.get(g.id) ?? { unit: inCredits ? "cr" : "usd", reserved: null, charged: null, needs: null },
      g.projectId ? drafts.get(g.projectId) ?? null : null, recreateFor(g))),
    ...(account ?? []).map((row) => accountTrayJob(row, accountRecipe(row))),
  ]);
  /* Often while something moves on its own; a held take (waiting on a person) or an unconfirmed job (on nobody) is read at the idle pace. */
  return { jobs, pollAfterSeconds: jobs.some(changing) ? TRAY_ACTIVE_POLL_S : TRAY_IDLE_POLL_S, ...(account ? {} : { partial: true }) };
}

const dollars = (...values: (number | null | undefined)[]) =>
  values.every((v) => v == null) ? null : values.reduce<number>((sum, v) => sum + (Number.isFinite(v) ? Number(v) : 0), 0);

/**
 * Each take's figures, off the ledger. Credits: the meter's row for the take
 * (this workspace's, by id) — its reservation while it runs, its bill once it
 * settles; only a take the platform's key paid for carries credits. Dollars:
 * the meter's estimate while it runs, the take's own recorded cost once it
 * settles (a missing recorded amount remains unknown). A ledger that
 * cannot be read leaves the figures blank, never guessed.
 */
async function ledgerFor(rows: Generation[], inCredits: boolean, workspaceId: string | null): Promise<Map<string, EngineMoney>> {
  const unit = inCredits ? "cr" : "usd";
  const out = new Map<string, EngineMoney>();
  if (!rows.length) return out;
  const metered = new Map<string, { status: string; credits: number; usd: number | null }>();
  if (workspaceId) {
    try {
      await platformReady();
      const ids = rows.map((g) => g.id);
      const rs = await platformDb().execute({
        sql: `SELECT id,status,engine_cost_usd,CASE WHEN paid_by_platform=1 THEN COALESCE(billed_credits,0) ELSE 0 END AS credits
              FROM meter_events WHERE workspace_id=? AND id IN (${ids.map(() => "?").join(",")})`,
        args: [workspaceId, ...ids],
      });
      for (const r of rs.rows) metered.set(String(r.id), { status: String(r.status), credits: Number(r.credits ?? 0), usd: r.engine_cost_usd == null ? null : Number(r.engine_cost_usd) });
    } catch { /* the rows still show, without a figure */ }
  }
  for (const g of rows) {
    const m = metered.get(g.id);
    const running = m?.status === "running";
    if (g.status === "held") {
      /* The generation response carries the current release quote in this workspace's unit.
         The tray uses that quote; a price that moves before Release is refused with the new figure. */
      const held = (g.params.held ?? {}) as { needs?: unknown; estUsd?: unknown };
      const figure = Number(inCredits ? held.needs : held.estUsd);
      out.set(g.id, { unit, reserved: null, charged: null, needs: Number.isFinite(figure) && figure > 0 ? (inCredits ? Math.ceil(figure) : figure) : null });
    } else if (!ENGINE_SETTLED.includes(g.status)) {
      out.set(g.id, { unit, reserved: running ? (inCredits ? m!.credits : m!.usd) : null, charged: null, needs: null });
    } else if (inCredits) {
      /* Settled on the meter: what it billed (0 is not billed). Still running there, or never metered: no figure is claimed. */
      out.set(g.id, { unit, reserved: null, charged: m && !running ? m.credits : null, needs: null });
    } else {
      /* A recorded refinement is not evidence of what the render charged. */
      const usd = g.costUsd == null ? null : dollars(g.costUsd, g.refineCostUsd);
      out.set(g.id, { unit, reserved: null, charged: usd, needs: null });
    }
  }
  return out;
}

/** Named the way the Library names it (the tray row's own name). */
const takeName = (g: Pick<Generation, "title" | "prompt">) => shortName((g.title ?? "").trim() || g.prompt || "", 60) || "Untitled take";

/** A failed or cancelled take's Recreate: Gen's recipe for it, exactly as the Library's Recreate builds it — or why Gen cannot make it. */
function recreateFor(g: Generation): EngineRecreate {
  if (g.status !== "failed" && g.status !== "cancelled") return null;
  const blocked = recreateBlock(g);
  return blocked ? { blocked } : { preset: recreatePreset(g, { name: takeName(g) }) };
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

type AccountRecord = AccountRow & { input: string | null };

/**
 * A failed connected Generate made again: the words, model and settings it was
 * sent with, and its references, as the account's own filed originals carry
 * them (lib/higgsfield-consumer/original-identity) — so Gen's recipe card says
 * the same thing for it as for a finished one. Other connected tools are made
 * again where they were made.
 */
function accountRecipe(row: AccountRecord): GenPreset | null {
  if (row.status !== "failed" || row.workflow !== "generation" || !row.modelId || !row.input) return null;
  let input: { type?: unknown; prompt?: unknown; parameters?: unknown; medias?: unknown };
  try { input = JSON.parse(row.input) as typeof input; } catch { return null; }
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) return null;
  const kind = input.type === "image" || input.type === "audio" ? input.type : input.type === "video" ? "video" : null;
  if (!kind) return null;
  const medias = Array.isArray(input.medias) ? input.medias : [];
  const references = medias.flatMap((m) => {
    const media = m as { role?: unknown; source?: unknown };
    return typeof media.role === "string" && media.source && typeof media.source === "object"
      ? [{ ...(media.source as Record<string, unknown>), role: media.role, kind: mediaKindForRole(media.role) }] : [];
  });
  const source: RecipeSource = {
    id: row.id, kind, model: row.modelId, prompt, provider: "higgsfield", task: "generate",
    params: {
      task: "connected-generation", outputType: kind, consumerCreditUnit: "higgsfield_credits",
      settings: input.parameters && typeof input.parameters === "object" ? input.parameters : {}, references,
    },
  };
  if (recreateBlock(source)) return null;
  return recreatePreset(source, { name: shortName(prompt, 60) });
}

/**
 * The connected account's jobs this person sent (a durable dispatch claim;
 * a quote never sent is not a job). Open ones while they can still hold a
 * slot, and anything that moved inside the window (a settled job's
 * updated_at is when it settled: nothing writes it after). Only the columns the tray
 * needs are read — never the receipt or the grant; of the payload, only the
 * request a failed Generate is made again from; of a failed job, what the
 * account said (lib/providerOutcome.ts), which the tray reads as a reason only.
 */
async function accountRows(userId: string, since: number, now: number): Promise<AccountRecord[]> {
  await consumerJobsReady();
  const rs = await db().execute({
    sql: `SELECT j.id, j.draft_id, j.workflow, j.status, j.quote_credits, j.failure_code, j.created_at, j.updated_at, j.released_at,
        j.provider_receipt IS NOT NULL AS has_receipt,
        SUBSTR(json_extract(j.payload_json,'$.input.prompt'),1,400) AS prompt,
        json_extract(j.payload_json,'$.model.id') AS model_id,
        json_extract(j.payload_json,'$.model.outputType') AS output_type,
        json_extract(j.payload_json,'$.tool.label') AS tool_label,
        CASE WHEN j.status='failed' AND j.workflow='generation' THEN json_extract(j.payload_json,'$.input') END AS input,
        CASE WHEN j.status='failed' THEN j.provider_outcome END AS provider_outcome,
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
      prompt: text(row.prompt), modelId: text(row.model_id), outputType: text(row.output_type), toolLabel: text(row.tool_label),
      originalId: text(row.original_id), originalKind: text(row.original_kind), projectName: text(row.project_name), input: text(row.input),
      outcome: row.provider_outcome == null ? null : parseOutcome(String(row.provider_outcome)),
    };
  });
}
