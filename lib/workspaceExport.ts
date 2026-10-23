import { db, ready, now } from "./db";
import { isSampleClipUrl, sampleClipNotice } from "./sampleClip";
import { requireTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";
import { creditsApply } from "./credits";
import { withoutVendorDollars } from "./analyticsRedact";
import { publicDirectParams } from "./directEnginePublic";
import { PipelineStore } from "./pipeline/store";
import { publicRun } from "./pipeline/public";
import type { CompiledPipeline } from "./pipeline/schema";
import { shownScenes, type Scene } from "./atomikDocs";
import { publicPlans } from "./workbench/public-plan";

// An allowlist keeps new credential/session tables out of customer exports.
/**
 * A Studio Atomik job as the export carries it: no thinking model and no effort, in the request or in its plan (Amendment (iii) §E:
 * never disclosed). The job row keeps them, for settlement and the platform admin.
 */
function exportedAtomikJob(row: Row): Row {
  const parse = (value: unknown): Record<string, unknown> | null => {
    try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null; } catch { return null; }
  };
  const request = parse(row.request_body), plan = row.result == null ? null : parse(row.result);
  if (request) { delete request.model; delete request.effort; }
  if (plan) {
    delete plan.effort; plan.model = "atomik";
    if (plan.referenceAdAnalysis && typeof plan.referenceAdAnalysis === "object") (plan.referenceAdAnalysis as Record<string, unknown>).model = "atomik";
  }
  return { ...row, ...(request ? { request_body: JSON.stringify(request) } : {}), ...(plan ? { result: JSON.stringify(plan) } : {}) };
}

/**
 * A meter line's provider outcome as the export carries it: for a credit workspace, no amount the provider billed (vendor dollars); for a
 * line of Atomik's thinking, no provider's own words (they can name the model) and no provider (Amendment (iii) §E). Unreadable: dropped.
 */
function exportedOutcome(raw: unknown, thinking: boolean, credits: boolean): string | null {
  try {
    const outcome = JSON.parse(String(raw)) as Record<string, unknown>;
    if (!outcome || typeof outcome !== "object") return null;
    if (credits && outcome.billing && typeof outcome.billing === "object") {
      const billing = { ...(outcome.billing as Record<string, unknown>) };
      delete billing.amount; delete billing.unit;
      outcome.billing = billing;
    }
    if (thinking) { outcome.message = null; outcome.provider = "atomik"; }
    return JSON.stringify(outcome);
  } catch { return null; }
}

/**
 * Atomik's writing as the export carries it (Amendment (iii) §E: never disclosed): an idea without the thinking model it was written with
 * or its effort, a treatment's scenes (and its kept drafts') saying "you" or "atomik", never the writer's model, and no effort, and a saved
 * project's Atomik plans without either. The rows keep what they stored.
 */
function exportedWriting(name: string, row: Row): Row {
  if (name === "ideas") { const { model: _model, effort: _effort, ...rest } = row; void _model; void _effort; return rest; }
  if ((name === "treatments" || name === "treatment_versions") && typeof row.scenes === "string") {
    try { return { ...row, scenes: JSON.stringify(shownScenes(JSON.parse(row.scenes) as Scene[])) }; } catch { return row; }
  }
  /* A saved project's Atomik plans, as readDraft reads them (lib/workbench/public-plan.ts). */
  if (name === "workbench_projects" && typeof row.body === "string") {
    try { const body = JSON.parse(row.body); return body && typeof body === "object" && "plans" in body ? { ...row, body: JSON.stringify({ ...body, plans: publicPlans(body.plans) }) } : row; } catch { return row; }
  }
  return row;
}

const SHARED_TABLES = [
  "projects",
  "productions",
  "boards",
  "shots",
  "topups",
  "uploads",
  "cast_members",
  "identities",
  "workspace_rules",
  "treatment_versions",
  "notes",
  "review_notes",
  "ideas",
  "treatments",
  "canvas_items",
  "shot_presets",
  "elements",
  "element_attributes",
  "attribute_versions",
  "bindings",
  "recipes",
  "recipe_stages",
  "runs",
  "stage_runs",
  "take_provenance",
  "take_ports",
  "workbench_bibles",
] as const;
type Row = Record<string, unknown>;
function parsed(value: unknown) {
  try {
    return JSON.parse(String(value ?? "{}"));
  } catch {
    return {};
  }
}
function generation(row: Row, creditWorkspace: boolean) {
  let params = parsed(row.params);
  if (params && typeof params === "object") {
    delete params.paidClaim;
    delete params.producedOutcome;
    delete params.soulReferenceId;
    delete params.soulCredentialFingerprint;
    delete params.soulVendorCostUsd;
    delete params.higgsfieldCredentialFingerprint;
    delete params.higgsfieldVendorCostUsd;
    delete params.higgsfieldStillHandle;
    delete params.higgsfieldStillPollUntil;
    delete params.higgsfieldVideoHandle;
    delete params.higgsfieldVideoPollUntil;
    delete params.higgsfieldVideoPollToken;
    delete params.genjutsuOriginal;
    params = publicDirectParams(params);
    /* The working figures in a take's params are what vendors charge (lib/jobs.ts rowToGeneration
       reads them the same way): a workspace billed in credits exports none of them. */
    if (creditWorkspace) {
      params = withoutVendorDollars(params) as Record<string, unknown>;
      if (row.kind === "audio") { delete params.estCredits; delete params.credits; delete params.tier; }
    }
  }
  /* An audio take's token count is the voice vendor's credits. */
  return { ...row, ...(creditWorkspace && row.kind === "audio" ? { total_tokens: null } : {}), params };
}

/** Tenant data plus the requesting owner's private work; never collaborators' private drafts. */
export async function workspaceExport(ownerId: string, ownerEmail: string) {
  await ready();
  await platformReady();
  const workspace = requireTenant();
  const creditWorkspace = creditsApply(workspace);
  const contents: Record<string, Row[]> = {};
  const tx = await db().transaction("read");
  try {
    const tables = new Set(
      (
        await tx.execute("SELECT name FROM sqlite_master WHERE type='table'")
      ).rows.map((row) => String(row.name)),
    );
    for (const name of SHARED_TABLES) {
      contents[name] = tables.has(name)
        ? (await tx.execute(`SELECT * FROM ${name}`)).rows.map((row) => exportedWriting(name, { ...row }))
        : [];
    }
    contents.users = (
      await tx.execute(
        "SELECT id,email,name,role,disabled,created_at,last_seen FROM users ORDER BY created_at",
      )
    ).rows.map((row) => ({ ...row }));
    contents.generations = (
      await tx.execute("SELECT * FROM generations ORDER BY created_at")
    ).rows.map((row) => generation(row, creditWorkspace));
    // Export reusable local bindings and source history, never provider handles
    // or account fingerprints. Respect the same private project boundary as the API.
    contents.soul_identities = tables.has("soul_identities") ? (await tx.execute({
      sql: `SELECT id,project_id,production_project_id,name,description,subject_type,references_json,status,cost_usd,error,created_at,updated_at
        FROM soul_identities WHERE purged_at IS NULL AND (owner=? OR production_project_id IS NULL OR production_project_id IN
          (SELECT json_extract(body,'$.productionProjectId') FROM workbench_projects WHERE owner=?))`,
      args: [ownerId, ownerId],
    })).rows.map(row => ({ ...row })) : [];
    if (creditWorkspace) {
      // Customer billing is in credits. Provider costs and rate cards belong
      // in the platform's books, not in a customer data download.
      contents.topups = [];
      for (const rows of Object.values(contents)) {
        for (const row of rows) {
          for (const key of Object.keys(row)) {
            if (key.endsWith("_usd") || key === "rate_usd_per_m")
              delete row[key];
          }
        }
      }
    }
    for (const name of [
      "workbench_projects",
      "workbench_edit_versions",
      "workbench_edit_sources",
      "workbench_shots",
      "workbench_media",
    ] as const) {
      contents[name] = tables.has(name)
        ? (
            await tx.execute({
              sql: `SELECT * FROM ${name} WHERE owner=?`,
              args: [ownerId],
            })
          ).rows.map((row) => exportedWriting(name, { ...row }))
        : [];
    }
    contents.workbench_atomik_jobs = tables.has("workbench_atomik_jobs")
      ? (
          await tx.execute({
            sql: `SELECT id,project_id,production_project_id,request_id,request_body,status,
        estimate_credits,credits,result,error,created_at,updated_at FROM workbench_atomik_jobs WHERE owner=?`,
            args: [ownerId],
          })
        ).rows.map((row) => exportedAtomikJob({ ...row }))
      : [];
    // Pipelines are creator-private, unlike legacy shared recipe/run rows.
    // Child attempts, quote summaries, selections and timelines are sanitized
    // through the same public view as their authenticated API.
    contents.pipeline_versions = [];
    contents.pipeline_runs = [];
    if (tables.has("pipeline_versions")) {
      const versions = await tx.execute({
        sql: "SELECT id,version,body,created_at FROM pipeline_versions WHERE workspace_id=? AND owner=? ORDER BY created_at,id,version",
        args: [workspace.id, ownerId],
      });
      contents.pipeline_versions = versions.rows.map((row) => {
        const compiled = JSON.parse(String(row.body)) as CompiledPipeline;
        return {
          id: String(row.id),
          version: Number(row.version),
          spec: compiled.spec,
          contextHash: compiled.contextHash,
          fingerprint: compiled.fingerprint,
          createdAt: Number(row.created_at),
        };
      });
    }
    if (tables.has("pipeline_runs")) {
      const pipeline = new PipelineStore(db(), workspace.id);
      const runs = await tx.execute({
        sql: "SELECT id FROM pipeline_runs WHERE workspace_id=? AND owner=? ORDER BY created_at,id",
        args: [workspace.id, ownerId],
      });
      for (const row of runs.rows)
        contents.pipeline_runs.push(
          publicRun(await pipeline.getRunSnapshot(tx, ownerId, String(row.id))),
        );
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
  for (const name of [
    "credit_grants",
    "meter_events",
    "topup_requests",
  ] as const) {
    contents[name] = (
      await platformDb().execute({
        sql: `SELECT * FROM ${name} WHERE workspace_id=? ORDER BY created_at`,
        args: [workspace.id],
      })
    ).rows.map((row) => {
      const exported: Row = { ...row };
      /* A line of Atomik's thinking names neither its model nor its vendor (Amendment (iii) §E); the platform's row keeps both. */
      if (name === "meter_events" && exported.kind === "text") { exported.model = "atomik"; exported.engine = "atomik"; }
      if (name === "meter_events" && creditWorkspace) {
        /* Vendor dollars reach no one but a platform admin: what the job cost the platform, and what it cost past what the workspace was billed. */
        delete exported.engine_cost_usd;
        delete exported.overrun_usd;
        delete exported.paid_by_platform;
      }
      if (name === "meter_events" && exported.provider_outcome != null) exported.provider_outcome = exportedOutcome(exported.provider_outcome, exported.kind === "text", creditWorkspace);
      return exported;
    });
  }
  if (creditWorkspace) {
    const billed = new Map(
      contents.meter_events.map((row) => [row.id, row.billed_credits]),
    );
    contents.generations = contents.generations.map((row) => ({
      ...row,
      billed_credits: billed.get(row.id) ?? null,
    }));
    contents.soul_identities = contents.soul_identities.map(row => ({ ...row, billed_credits: billed.get(row.id) ?? null }));
  }
  const sampleTakes = contents.generations.filter((row) => isSampleClipUrl(String(row.stored_url ?? ""))).map((row) => String(row.id));
  return {
    formatVersion: 2,
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    exportedAt: new Date(now()).toISOString(),
    exportedBy: ownerEmail,
    note: "Includes shared workspace records, published project bibles and your private drafts. Other collaborators' private drafts and credentials are excluded. Media bytes are downloaded separately from the master manifest; stored paths require authorized workspace access.",
    counts: Object.fromEntries(
      Object.entries(contents).map(([name, rows]) => [name, rows.length]),
    ),
    /* The starter's sample clip (Big Buck Bunny, CC BY 3.0) is in these takes: the credit goes with them (lib/sampleClip.ts). */
    ...(sampleTakes.length ? { credits: [sampleClipNotice(sampleTakes)] } : {}),
    ...contents,
  };
}
