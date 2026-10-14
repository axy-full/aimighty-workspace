/**
 * The Vercel-out census (docs/plans/vercel-out.md section 3.2): what is stored where, before the Vercel account closes. READ ONLY: it lists R2 and Blob, snapshots
 * the databases (the same way blob-to-r2.mjs --verify does) and counts. It never writes, copies or deletes on either store.
 *
 * It prints COUNTS ONLY, by table and kind: how many referenced objects are on R2, on Blob only, or on neither (resolved the way the app resolves them with
 * STORAGE_BACKEND=r2 and the Blob token still set: R2 first, then Blob); how many Blob objects no row references (orphans: count and bytes); how many workspaces still
 * hold a gateway key id (for plan step A2); and how many 3D render jobs are not settled, by backend (for step A6). Never a key, a URL, a file name or a workspace
 * id on screen. Row ids for anything on neither store, and the keys of orphans, go only to a private report (mode 600) in --private-dir, which must be outside the
 * checkout and readable only by its owner.
 *
 *   node --env-file=/private/live.env scripts/ops/vercel-census.mjs --live --private-dir /private/vercel-census
 *   node scripts/ops/vercel-census.mjs --config SOURCE-INVENTORY.json --private-dir DIR     (the backup source inventory, docs/backup-restore.md)
 *
 * Credentials by the app's own names: BLOB_READ_WRITE_TOKEN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, optional R2_ENDPOINT; with --live
 * also PLATFORM_DATABASE_URL, PLATFORM_AUTH_TOKEN and KEYRING_SECRET (the deployment's own).
 */
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { OpsError, blobInventory, defaultR2Client, r2Inventory, r2Settings, retrying, verifyMediaReferences } from "./backup-lib.mjs";
import { BLOB_TOKEN_ENV, R2_ENV_NAMES, loadBlobSdk, privateDirectory, snapshotSources, usableInventory, writeReport } from "./blob-to-r2.mjs";

const fail = (message) => {
  throw new OpsError(message);
};
const r2Spec = (env) => ({ ...R2_ENV_NAMES, ...(env.R2_ENDPOINT ? { endpointEnv: "R2_ENDPOINT" } : {}) });
const USAGE = `Usage:
  node scripts/ops/vercel-census.mjs --live   --private-dir DIR   (databases read from the platform database)
  node scripts/ops/vercel-census.mjs --config SOURCE-INVENTORY.json --private-dir DIR`;

export function parseArguments(argv) {
  const options = { live: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") options.live = true;
    else if (arg === "--private-dir" || arg === "--config") {
      if (argv[i + 1] === undefined) fail(`${arg} needs a value.`);
      options[arg === "--config" ? "config" : "privateDir"] = argv[++i];
    } else fail(`Unknown argument ${arg.startsWith("--") ? arg : "(value)"}.`);
  }
  if (options.live === (options.config !== undefined)) fail("Choose exactly one of --live or --config.");
  return options;
}

const blank = () => ({ referenced: 0, onR2: 0, onBlobOnly: 0, onNeither: 0 });

/** Counts of rows in the workspace databases that name the plan's open questions. */
async function planCounts(databases) {
  const out = { workspacesWithGatewayKey: 0, astraJobsNotSettled: { vercel: 0, selfhost: 0, unreadable: 0 } };
  for (const source of databases) {
    const names = new Set(source.inventory.tables.map((t) => t.name));
    const db = createClient({ url: pathToFileURL(source.snapshot).href });
    try {
      if (names.has("workspaces")) {
        const columns = new Set((await db.execute("PRAGMA table_info(workspaces)")).rows.map((r) => String(r.name)));
        if (columns.has("gateway_key_id")) {
          const rows = (await db.execute("SELECT COUNT(*) AS n FROM workspaces WHERE gateway_key_id IS NOT NULL AND gateway_key_id <> ''")).rows;
          out.workspacesWithGatewayKey += Number(rows[0].n);
        }
      }
      if (names.has("astra_render_jobs"))
        for (const row of (await db.execute("SELECT source_json FROM astra_render_jobs WHERE settled=0")).rows) {
          // A job's backend is the one its recorded engine belongs to, exactly as the app reads it (lib/astra-blender/backend.ts astraBackendOfEngine): "selfhost-blender" is the self-hosted workers'; anything else, and rows from before the switch, were Vercel's.
          let engine;
          try {
            engine = JSON.parse(String(row.source_json))?.engine;
          } catch {
            out.astraJobsNotSettled.unreadable++;
            continue;
          }
          out.astraJobsNotSettled[engine === "selfhost-blender" ? "selfhost" : "vercel"]++;
        }
    } finally {
      db.close();
    }
  }
  return out;
}

export async function census({ privateDir, config, live = false, env = process.env, r2Client, blobSdk, retryOptions }) {
  if (live && config) fail("Use either --live or --config, not both.");
  if (!live && !usableInventory(config)) fail("--config must be a version 1 source inventory (docs/backup-restore.md) with one platform database and unique simple ids.");
  if (!env[BLOB_TOKEN_ENV]) fail(`MISSING_CONFIGURATION: ${BLOB_TOKEN_ENV} is not set (the census lists the Blob store).`);
  const dir = await privateDirectory(privateDir);
  const retry = retrying(retryOptions);
  const settings = r2Settings(r2Spec(env), env);
  const client = await (r2Client ?? defaultR2Client)(settings);
  const scratch = await mkdtemp(join(dir, "census-"));
  await chmod(scratch, 0o700);
  try {
    const { databases, liveCounts } = await snapshotSources({ live, config, env, scratch });
    const r2Entries = await r2Inventory(client, settings.bucket, retry);
    const blobEntries = (await blobInventory(env[BLOB_TOKEN_ENV], blobSdk ?? (await loadBlobSdk()))).map((e) => ({ store: "blob", ...e }));
    const byKind = {},
      neither = [],
      referencedKeys = new Set();
    const count = (name) => (byKind[name] ??= blank());
    // The app's own order with the token still set (dual): R2 first, then Blob at the same key or at the original URL.
    await verifyMediaReferences(databases, [...r2Entries, ...blobEntries], "dual", {
      extended: true,
      onReference(reference) {
        const c = count(`${reference.table}/${reference.kind}`);
        c.referenced++;
        if (reference.entry.store === "r2") c.onR2++;
        else c.onBlobOnly++;
        referencedKeys.add(reference.key ?? reference.entry.pathname);
        referencedKeys.add(reference.entry.pathname);
      },
      onMissing(reference) {
        const c = count(`${reference.table}/${reference.kind ?? "unknown"}`);
        c.referenced++;
        c.onNeither++;
        neither.push(`${reference.database}/${reference.table}/${reference.id}`);
      },
    });
    const orphans = blobEntries.filter((e) => !referencedKeys.has(e.pathname));
    const totals = Object.values(byKind).reduce((sum, c) => ({ referenced: sum.referenced + c.referenced, onR2: sum.onR2 + c.onR2, onBlobOnly: sum.onBlobOnly + c.onBlobOnly, onNeither: sum.onNeither + c.onNeither }), blank());
    const result = {
      mode: "census",
      ...(live ? { live: liveCounts } : {}),
      r2Objects: r2Entries.length,
      blobObjects: blobEntries.length,
      references: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => (a < b ? -1 : 1))),
      totals,
      blobOrphans: { objects: orphans.length, bytes: orphans.reduce((sum, e) => sum + e.size, 0) },
      ...(await planCounts(databases)),
    };
    if (neither.length || orphans.length)
      result.report = await writeReport(dir, "report", { at: new Date().toISOString(), onNeither: neither, blobOrphanKeys: orphans.map((e) => e.pathname) }, "vercel-census");
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    client.destroy?.();
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const options = parseArguments(argv);
    const config = options.live ? undefined : JSON.parse(await readFile(options.config, "utf8"));
    console.log(JSON.stringify(await census({ privateDir: options.privateDir, config, live: options.live, env })));
    return 0;
  } catch (error) {
    if (error instanceof OpsError) console.error(error.message);
    else console.error("The census stopped (an unexpected error). Nothing was written to either store; run it again.");
    if (error instanceof OpsError && /exactly one of|Unknown argument|needs a value/.test(error.message)) console.error(USAGE);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
