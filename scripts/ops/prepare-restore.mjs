import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  connection,
  databaseIdentity,
  databaseInventory,
  verifyPlatformCoverage,
  json,
} from "./backup-lib.mjs";

function seal(text, keyring) {
  if (!text) return null;
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(keyring).digest(),
      iv,
    );
  const body = Buffer.concat([cipher.update(text), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/** Prepares NEW offline database copies for different infrastructure. Originals
 * remain exact forensic snapshots. This function never contacts any URL. */
export async function prepareRestore(
  restored,
  mapping,
  destination,
  { env = process.env } = {},
) {
  await readFile(join(restored, "OFFLINE-RESTORE.txt"));
  try {
    await lstat(destination);
    throw new Error("Destination already exists.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (mapping.invalidateAccess !== true || !Array.isArray(mapping.databases))
    throw new Error(
      "Explicit invalidateAccess=true and complete target database mapping are required.",
    );
  const inventory = JSON.parse(
    await readFile(join(restored, "inventory.json"), "utf8"),
  );
  const keyring = JSON.parse(
    await readFile(join(restored, "recovery-secrets.json"), "utf8"),
  ).KEYRING_SECRET;
  if (!keyring) throw new Error("Original keyring escrow is missing.");
  if (inventory.databases.some((d) => !/^[a-zA-Z0-9_-]{1,80}$/.test(d.id)))
    throw new Error("Unsafe database ID.");
  await verifyPlatformCoverage(
    inventory.databases.map((d) => ({
      ...d,
      snapshot: join(restored, "databases", d.id + ".db"),
    })),
    keyring,
  );
  const targets = new Map();
  const sourceIdentities = new Set(
    await Promise.all(
      inventory.databases.map((d) => databaseIdentity(d.sourceUrl)),
    ),
  );
  const targetIdentities = new Set();
  for (const source of inventory.databases) {
    const specs = mapping.databases.filter((d) => d.id === source.id);
    if (specs.length !== 1)
      throw new Error(
        "Every backed-up database requires exactly one target mapping.",
      );
    const spec = specs[0];
    // The platform's own endpoint/token is deployment configuration, never a
    // platform row. Its new name can be planned before scoped tokens exist.
    if (
      source.role === "platform" &&
      !spec.url &&
      !spec.urlEnv &&
      /^[a-z0-9-]+$/.test(spec.dbName ?? "")
    ) {
      targets.set(source.id, { url: null, dbName: spec.dbName });
      continue;
    }
    const config = connection(spec, env);
    const identity = await databaseIdentity(config.url);
    if (sourceIdentities.has(identity))
      throw new Error("Restore target cannot be the original source database.");
    if (targetIdentities.has(identity))
      throw new Error("Target databases must be distinct.");
    targetIdentities.add(identity);
    if (
      !config.url.startsWith("file:") &&
      (!spec.tokenEnv || !/^[a-z0-9-]+$/.test(spec.dbName ?? ""))
    )
      throw new Error(
        "Remote target requires a new database token and exact database name.",
      );
    targets.set(source.id, { ...config, dbName: spec.dbName ?? null });
  }
  const urlsToMap = [...targets.values()]
    .filter((t) => t.url)
    .map((t) => t.url);
  if (new Set(urlsToMap).size !== urlsToMap.length)
    throw new Error("Target databases must be distinct.");
  let urls = [];
  try {
    urls = JSON.parse(
      await readFile(join(restored, "blob-restore-urls.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const urlMap = new Map(
    urls
      .filter((u) => u.originalUrl && u.url)
      .map((u) => [u.originalUrl, u.url]),
  );
  await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(
    join(dirname(resolve(destination)), ".particl-prepare-"),
  );
  const databases = [],
    changes = [];
  try {
    for (const source of inventory.databases) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(source.id))
        throw new Error("Unsafe database ID.");
      const file = join(scratch, source.id + ".db");
      await copyFile(join(restored, "databases", source.id + ".db"), file);
      const db = createClient({
        url: pathToFileURL(file).href,
        intMode: "bigint",
      });
      try {
        const original = await databaseInventory(db);
        if (json(original) !== json(source.inventory))
          throw new Error("Restored snapshot changed before preparation.");
        const names = new Set(original.tables.map((t) => t.name));
        const tx = await db.transaction("write");
        try {
          if (source.role === "platform") {
            for (const table of ["workspaces", "workspace_provisioning"]) {
              if (!names.has(table)) continue;
              const fields = new Set(
                (await tx.execute(`PRAGMA table_info(${table})`)).rows.map(
                  (r) => r.name,
                ),
              );
              for (const row of (await tx.execute(`SELECT * FROM ${table}`))
                .rows) {
                if (
                  row.purged_at != null ||
                  (table === "workspace_provisioning" && !row.db_url)
                )
                  continue;
                const id = table === "workspaces" ? row.id : row.workspace_id;
                const owner = inventory.databases.find((d) =>
                  d.workspaceIds.includes(id),
                );
                if (!owner)
                  throw new Error(
                    "Workspace is absent from the target mapping.",
                  );
                const target = targets.get(owner.id),
                  sets = ["db_url=?"],
                  args = [target.url];
                if (!target.url) {
                  if (table !== "workspaces" || !row.legacy)
                    throw new Error(
                      "A nonlegacy workspace requires an explicit target URL and token.",
                    );
                  changes.push({
                    database: source.id,
                    table,
                    id,
                    action: "legacy-deployment-env-required",
                  });
                  continue;
                }
                if (fields.has("db_token_enc")) {
                  sets.push("db_token_enc=?");
                  args.push(seal(target.authToken, keyring));
                }
                if (fields.has("db_name")) {
                  sets.push("db_name=?");
                  args.push(target.dbName);
                }
                await tx.execute({
                  sql: `UPDATE ${table} SET ${sets.join(",")} WHERE ${table === "workspaces" ? "id" : "workspace_id"}=?`,
                  args: [...args, id],
                });
                changes.push({
                  database: source.id,
                  table,
                  id,
                  action: "remapped-database",
                });
              }
            }
          }
          // Old bearer sessions, review links, password reset tokens and OAuth
          // grants must not become valid again because an older backup retained
          // them. Restored consumer connections require fresh authorization.
          for (const table of [
            "p_sessions",
            "sessions",
            "api_tokens",
            "p_shares",
            "password_resets",
            "higgsfield_consumer_connections",
            "higgsfield_consumer_authorizations",
          ]) {
            if (!names.has(table)) continue;
            const result = await tx.execute(`DELETE FROM ${table}`);
            changes.push({
              database: source.id,
              table,
              action: "revoked-restored-access",
              rows: result.rowsAffected,
            });
          }
          if (names.has("higgsfield_consumer_jobs")) {
            // Genjutsu import receipts are preserved with their permanent
            // claims. Revoking OAuth above changes the grant fingerprint, so
            // neither ready nor ambiguous imports authorize a replay after
            // restore. They never contain a signed URL or credential.
            // An older quoted snapshot cannot prove that admission never
            // happened after capture. Never make it dispatchable on restore.
            // Preserve every immutable fingerprint, original quote, dispatch
            // claim and known provider UUID for operator reconciliation.
            const quarantined = await tx.execute({
              sql: `UPDATE higgsfield_consumer_jobs SET status='uncertain',updated_at=?
                WHERE status IN ('quoted','dispatching')
                OR (status='accepted' AND provider_job_id IS NULL)`,
              args: [Date.now()],
            });
            changes.push({
              database: source.id,
              table: "higgsfield_consumer_jobs",
              action: "quarantined-restored-consumer-admissions",
              rows: quarantined.rowsAffected,
            });
            // Poll claims authorize GET/collection only. The old process must
            // not complete through its stale lease on these new copies.
            const released = await tx.execute(`UPDATE higgsfield_consumer_jobs
              SET poll_lease_hash=NULL,poll_lease_until=NULL
              WHERE poll_lease_hash IS NOT NULL OR poll_lease_until IS NOT NULL`);
            changes.push({
              database: source.id,
              table: "higgsfield_consumer_jobs",
              action: "invalidated-restored-consumer-poll-leases",
              rows: released.rowsAffected,
            });
          }
          for (const table of ["uploads", "workbench_media"]) {
            if (!names.has(table)) continue;
            for (const row of (
              await tx.execute(`SELECT id,stored_url FROM ${table}`)
            ).rows) {
              if (!/^https?:/.test(row.stored_url)) continue;
              const replacement = urlMap.get(row.stored_url);
              if (!replacement)
                throw new Error(
                  "An absolute media URL has no verified new-store mapping; restore Blob first.",
                );
              await tx.execute({
                sql: `UPDATE ${table} SET stored_url=? WHERE id=?`,
                args: [replacement, row.id],
              });
              changes.push({
                database: source.id,
                table,
                id: row.id,
                action: "remapped-private-blob",
              });
            }
          }
          await tx.commit();
        } catch (e) {
          if (!tx.closed) await tx.rollback();
          throw e;
        } finally {
          tx.close();
        }
        databases.push({
          id: source.id,
          targetUrl: targets.get(source.id).url,
          inventory: await databaseInventory(db),
        });
      } finally {
        db.close();
      }
    }
    await writeFile(
      join(scratch, "preparation.json"),
      json({
        databases,
        changes,
        sourceBackup: inventory.createdAt,
        stillOffline: true,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      join(scratch, "OFFLINE-RESTORE.txt"),
      "Prepared copies only. Import into the named NEW databases, verify each full digest, then complete the recovery runbook before deployment. Original keyring required.\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(scratch, resolve(destination));
    return {
      databases: databases.length,
      changes: changes.length,
      stillOffline: true,
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
