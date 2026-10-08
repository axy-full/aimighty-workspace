/**
 * Which saved values still name a model id Particl dropped on 8 October 2026
 * (lib/modelAliases.ts). Read-only, counts only:
 *
 *   node --env-file=<prod env> scripts/ops/model-references.mjs
 *
 * The platform database and every workspace database are found the way
 * `blob-to-r2.mjs --verify --live` finds them (liveSourceInventory: the
 * platform database's workspace records, tokens opened with KEYRING_SECRET in
 * process only). Each database is copied to a private snapshot first
 * (backup-lib snapshotDatabase) and only the snapshot is queried; the
 * snapshots are deleted at the end. Nothing is written to any database.
 *
 * It prints one JSON object: per dropped id and per place (table.column, or a
 * settings key) the number of rows naming it, and per database the workspace
 * ids it holds. It never prints a value, a prompt, a name or an email.
 *
 * Nothing here needs to be moved by hand: the app reads every one of these as
 * the id's alias (lib/modelAliases.ts). The counts say how much still relies
 * on that. Places marked "history" record what ran (ledgers, past jobs) and are
 * never read again to choose a model.
 *
 * Needs PLATFORM_DATABASE_URL (or TURSO_DATABASE_URL), PLATFORM_AUTH_TOKEN for
 * a remote one, and KEYRING_SECRET when a workspace database is remote.
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { OpsError, connection, snapshotDatabase } from "./backup-lib.mjs";
import { livePlatformSpec, liveSourceInventory } from "./blob-to-r2.mjs";

/** The keys of lib/modelAliases.ts MODEL_ALIASES (tests/unit/modelAliases.spec.ts keeps them equal). */
export const DROPPED_MODEL_IDS = [
  "anthropic/claude-opus-4.8-fast",
  "anthropic/claude-opus-5-fast",
  "anthropic/claude-3-haiku",
  "openai/gpt-5-pro",
  "openai/gpt-5.2-pro",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.5-pro",
  "openai/gpt-oss-20b",
  "openai/o3-pro",
];

/**
 * Where a model id is saved. `use` is "choice" when the app reads it again to
 * choose the model for a new call, "history" when it only records what ran.
 * A row counts when the column equals the id or holds it as a JSON string.
 * `group` splits a place by a column whose values are the app's own names.
 */
export const PLACES = [
  // The platform database only.
  { scope: "platform", table: "platform_layer", column: "value", where: "key = 'models'", use: "choice", label: "platform_layer[models].text" },
  { scope: "platform", table: "meter_events", column: "model", use: "history" },
  // Every workspace database (and the platform database, for legacy workspaces).
  { scope: "workspace", table: "settings", column: "value", group: "key", use: "choice" },
  { scope: "workspace", table: "atomik_chats", column: "model", where: "deleted = 0", use: "choice" },
  { scope: "workspace", table: "ideas", column: "model", use: "choice" },
  { scope: "workspace", table: "rig_agent_runs", column: "model", use: "choice" },
  { scope: "workspace", table: "crew_sessions", column: "model", use: "choice" },
  { scope: "workspace", table: "shot_presets", column: "spec", use: "choice" },
  { scope: "workspace", table: "boards", column: "nodes", use: "choice" },
  { scope: "workspace", table: "workbench_team_canvas", column: "body", use: "choice" },
  { scope: "workspace", table: "pipeline_versions", column: "body", use: "choice" },
  { scope: "workspace", table: "atomik_skill_versions", column: "template", use: "choice" },
  { scope: "workspace", table: "workbench_projects", column: "body", use: "history", label: "workbench_projects.body (plans[].model)" },
  { scope: "workspace", table: "atomik_messages", column: "model", use: "history" },
  { scope: "workspace", table: "atomik_spend", column: "model", use: "history" },
  { scope: "workspace", table: "paid_text_jobs", column: "model", use: "history" },
  { scope: "workspace", table: "workbench_atomik_jobs", column: "model", use: "history" },
  { scope: "workspace", table: "workbench_development_jobs", column: "request_body", use: "history" },
  { scope: "workspace", table: "take_verifications", column: "judge_model", use: "history" },
  { scope: "workspace", table: "generations", column: "refine_model", use: "history" },
];

/** A settings key is printed only when it looks like one of the app's own names. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const quote = (name) => `"${name.replace(/"/g, '""')}"`;
const placeName = (place, group) =>
  group !== undefined ? `${place.table}[${SAFE_NAME.test(group) ? group : "other key"}]` : place.label ?? `${place.table}.${place.column}`;

/** Rows per dropped id and place in one snapshot. Only counts leave this function. */
export async function countReferences(snapshotPath, scope) {
  const db = createClient({ url: pathToFileURL(snapshotPath).href, intMode: "number" });
  const found = [];
  try {
    const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name)));
    for (const place of PLACES) {
      if (!scope.includes(place.scope) || !tables.has(place.table)) continue;
      const columns = new Set((await db.execute(`PRAGMA table_info(${quote(place.table)})`)).rows.map((r) => String(r.name)));
      if (!columns.has(place.column) || (place.group && !columns.has(place.group))) continue;
      for (const id of DROPPED_MODEL_IDS) {
        const col = quote(place.column);
        const match = `(${col} = ? OR instr(${col}, ?) > 0)${place.where ? ` AND (${place.where})` : ""}`;
        const sql = place.group
          ? `SELECT ${quote(place.group)} AS g, COUNT(*) AS n FROM ${quote(place.table)} WHERE ${match} GROUP BY ${quote(place.group)}`
          : `SELECT COUNT(*) AS n FROM ${quote(place.table)} WHERE ${match}`;
        for (const row of (await db.execute({ sql, args: [id, JSON.stringify(id)] })).rows) {
          const n = Number(row.n);
          if (n > 0) found.push({ place: placeName(place, place.group ? String(row.g) : undefined), use: place.use, model: id, rows: n });
        }
      }
    }
  } finally {
    db.close();
  }
  return found;
}

/** The whole report, from the environment the app runs with. */
export async function modelReferences(env = process.env) {
  const platformSpec = livePlatformSpec(env);
  const scratch = await mkdtemp(join(tmpdir(), "model-references-"));
  await chmod(scratch, 0o700);
  try {
    const platformSnapshot = join(scratch, "platform.db");
    await snapshotDatabase(connection(platformSpec, env), platformSnapshot, scratch);
    const built = await liveSourceInventory(platformSnapshot, platformSpec, env);
    const databases = [];
    for (const spec of built.config.databases) {
      let snapshot = platformSnapshot;
      if (spec.role !== "platform") {
        snapshot = join(scratch, `${spec.id}.db`);
        await snapshotDatabase(connection(spec, built.env), snapshot, scratch);
      }
      const scope = spec.role === "platform" ? ["platform", ...(spec.workspaceIds.length ? ["workspace"] : [])] : ["workspace"];
      databases.push({ database: spec.id, workspaceIds: [...spec.workspaceIds], found: await countReferences(snapshot, scope) });
    }
    const byModel = Object.fromEntries(DROPPED_MODEL_IDS.map((id) => [id, 0]));
    const byPlace = {};
    for (const d of databases)
      for (const f of d.found) {
        byModel[f.model] += f.rows;
        byPlace[f.place] = { use: f.use, rows: (byPlace[f.place]?.rows ?? 0) + f.rows };
      }
    const choices = Object.values(byPlace).filter((p) => p.use === "choice").reduce((sum, p) => sum + p.rows, 0);
    return {
      mode: "model-references",
      readOnly: true,
      databases: databases.length,
      workspaces: built.counts.workspaces,
      savedChoices: choices,
      byModel,
      byPlace,
      perDatabase: databases.filter((d) => d.found.length),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function main(env = process.env) {
  try {
    console.log(JSON.stringify(await modelReferences(env), null, 2));
    return 0;
  } catch (error) {
    // An OpsError names a workspace id or a variable at most; anything else could carry a value, so only its kind is shown.
    console.error(error instanceof OpsError ? error.message : `model-references stopped (${error?.code ?? error?.name ?? "error"}). Nothing was written.`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
