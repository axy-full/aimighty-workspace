import { db, ready, now } from "./db";
import { requireTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";
import { creditsApply } from "./credits";
import { withoutVendorDollars } from "./analyticsRedact";
import { PipelineStore } from "./pipeline/store";
import { publicRun } from "./pipeline/public";
import type { CompiledPipeline } from "./pipeline/schema";
import { exportableBoards, isDraftProject, type Person } from "./draftProject";
import { exportableUploads } from "./uploadAccess";

// An allowlist keeps new credential/session tables out of customer exports.
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
export async function workspaceExport(ownerId: string, ownerEmail: string, person: Person | null = null) {
  await ready();
  /* Private boards: another member's go through the audited read, once per board, before the read transaction opens (lib/draftProject.ts › exportableBoards). */
  const boards = await exportableBoards(person);
  await platformReady();
  const workspace = requireTenant();
  const creditWorkspace = creditsApply(workspace);
  const contents: Record<string, Row[]> = {};
  const hiddenShotIds = new Set<string>();
  const tx = await db().transaction("read");
  try {
    const tables = new Set(
      (
        await tx.execute("SELECT name FROM sqlite_master WHERE type='table'")
      ).rows.map((row) => String(row.name)),
    );
    /* Which board a row belongs to, for every table that holds one (below), so that a private board the person may not take out leaves NOTHING behind: its name, shots, canvas, notes and
       provenance go with its takes. Rows tied by an id of another table (a take, an element, a recipe, a run, a production) are tied through that table's own project. */
    const owners = async (sql: string) => new Map((await tx.execute(sql)).rows.map((row) => [String(row.id), row.project_id == null ? null : String(row.project_id)]));
    const hiddenBoard = (id: string | null | undefined) => Boolean(boards) && isDraftProject(id ?? null) && !boards!.has(String(id));
    const via = boards ? {
      take: await owners("SELECT id, project_id FROM generations WHERE project_id GLOB 'prj_wb_*'"),
      element: tables.has("elements") ? await owners("SELECT id, project_id FROM elements WHERE project_id GLOB 'prj_wb_*'") : new Map<string, string | null>(),
      recipe: tables.has("recipes") ? await owners("SELECT id, project_id FROM recipes WHERE project_id GLOB 'prj_wb_*'") : new Map<string, string | null>(),
      run: tables.has("runs") ? await owners("SELECT id, project_id FROM runs WHERE project_id GLOB 'prj_wb_*'") : new Map<string, string | null>(),
      shot: tables.has("shots") ? await owners("SELECT id, project_id FROM shots WHERE project_id GLOB 'prj_wb_*'") : new Map<string, string | null>(),
      production: tables.has("projects") ? await owners("SELECT production_id AS id, id AS project_id FROM projects WHERE production_id IS NOT NULL AND id GLOB 'prj_wb_*'") : new Map<string, string | null>(),
    } : null;
    /* Table -> how its rows name their board. A table not here is not tied to a board (workspace-wide records: top-ups, rules, uploads, presets of no project). */
    const boardOf: Record<string, (row: Row) => (string | null | undefined)[]> = {
      projects: (r) => [String(r.id)], productions: (r) => [via!.production.get(String(r.id))],
      boards: (r) => [r.project_id as string], shots: (r) => [r.project_id as string], cast_members: (r) => [r.project_id as string], identities: (r) => [r.project_id as string],
      treatment_versions: (r) => [r.project_id as string], ideas: (r) => [r.project_id as string], treatments: (r) => [r.project_id as string], canvas_items: (r) => [r.project_id as string],
      shot_presets: (r) => [r.project_id as string], elements: (r) => [r.project_id as string], bindings: (r) => [r.project_id as string, via!.shot.get(String(r.shot_id))],
      recipes: (r) => [r.project_id as string], runs: (r) => [r.project_id as string], workbench_bibles: (r) => [r.project_id as string],
      element_attributes: (r) => [via!.element.get(String(r.element_id))], attribute_versions: (r) => [via!.element.get(String(r.element_id)), via!.take.get(String(r.gen_id))],
      recipe_stages: (r) => [via!.recipe.get(String(r.recipe_id))], stage_runs: (r) => [via!.run.get(String(r.run_id))],
      take_provenance: (r) => [via!.take.get(String(r.take_id)), via!.shot.get(String(r.shot_id))], take_ports: (r) => [via!.take.get(String(r.take_id)), via!.element.get(String(r.element_id))],
      notes: (r) => [via!.take.get(String(r.gen_id))], review_notes: (r) => [via!.take.get(String(r.gen_id))],
    };
    /* Ids of takes and shots of a private board that stays out: a row that stays (it is workspace-wide, or of an ordinary production) must not name one. */
    const hiddenTake = (id: unknown) => Boolean(via) && typeof id === "string" && hiddenBoard(via!.take.get(id));
    const hiddenShot = (id: unknown) => Boolean(via) && typeof id === "string" && hiddenBoard(via!.shot.get(id));
    if (via) for (const [id, board] of via.shot) if (hiddenBoard(board)) hiddenShotIds.add(id);
    /* The columns that only name another record, by table: shot_presets.cover_gen_id and elements.from_gen_id name a take, elements.from_shot_id a shot, canvas_items.ref_id a take or a shot
       (a preset of no project, or a card of an ordinary production, stays: its reference alone is emptied). */
    const reference: Record<string, (row: Row) => void> = {
      shot_presets: (r) => { if (hiddenTake(r.cover_gen_id)) r.cover_gen_id = null; },
      elements: (r) => { if (hiddenTake(r.from_gen_id)) r.from_gen_id = null; if (hiddenShot(r.from_shot_id)) r.from_shot_id = null; },
      canvas_items: (r) => { if (hiddenTake(r.ref_id) || hiddenShot(r.ref_id)) r.ref_id = null; },
    };
    for (const name of SHARED_TABLES) {
      const rows = tables.has(name) ? (await tx.execute(`SELECT * FROM ${name}`)).rows.map((row) => ({ ...row })) : [];
      const tie = boards ? boardOf[name] : undefined;
      const kept = tie ? rows.filter((row) => !tie(row).some((id) => hiddenBoard(id))) : rows;
      if (reference[name]) for (const row of kept) reference[name](row);
      contents[name] = kept;
    }
    contents.users = (
      await tx.execute(
        "SELECT id,email,name,role,disabled,created_at,last_seen FROM users ORDER BY created_at",
      )
    ).rows.map((row) => ({ ...row }));
    contents.generations = (
      await tx.execute("SELECT * FROM generations ORDER BY created_at")
    ).rows.filter((row) => !boards || !isDraftProject(row.project_id as string | null) || boards.has(String(row.project_id))).map((row) => generation(row, creditWorkspace));
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
          ).rows.map((row) => ({ ...row }))
        : [];
    }
    contents.workbench_atomik_jobs = tables.has("workbench_atomik_jobs")
      ? (
          await tx.execute({
            sql: `SELECT id,project_id,production_project_id,request_id,request_body,model,status,
        estimate_credits,credits,result,error,created_at,updated_at FROM workbench_atomik_jobs WHERE owner=?`,
            args: [ownerId],
          })
        ).rows.map((row) => ({ ...row }))
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
  /* An upload: this person's to take (they may open it) or used by a private board that goes out in this export; one used only by a board whose line was not written, or by a draft that
     never became a board, stays. Asked once the read transaction is closed (it needs the database for the uses it scans). */
  if (boards && person) {
    const allowed = await exportableUploads(contents.uploads.map((row) => String(row.id)), person, [...boards]);
    contents.uploads = contents.uploads.filter((row) => allowed.has(String(row.id)));
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
      /* The meter is the workspace's billing, so its rows stay; one that names a private board that stays out loses the name of the board and shot (its id is the take's, which is also its charge). */
      if (name === "meter_events" && boards) {
        if (isDraftProject(exported.project_id as string | null) && !boards.has(String(exported.project_id))) exported.project_id = null;
        if (hiddenShotIds.has(String(exported.shot_id))) exported.shot_id = null;
      }
      if (name === "meter_events" && creditWorkspace) {
        delete exported.engine_cost_usd;
        delete exported.paid_by_platform;
      }
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
  return {
    formatVersion: 2,
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    exportedAt: new Date(now()).toISOString(),
    exportedBy: ownerEmail,
    note: "Includes the workspace's records, published project bibles and your own drafts. Another member's private board's records and takes are included for an admin and counted in its maker's history; their drafts and soul identities stay theirs. Credentials are excluded. Media bytes are downloaded separately from the master manifest; stored paths require authorized workspace access.",
    counts: Object.fromEntries(
      Object.entries(contents).map(([name, rows]) => [name, rows.length]),
    ),
    ...contents,
  };
}
