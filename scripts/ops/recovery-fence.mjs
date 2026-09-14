#!/usr/bin/env node
import { createClient } from "@libsql/client";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RecoveryFence,
  RECOVERY_PROTOCOL,
} from "../../lib/recovery/control.mjs";
import { databaseIdentity, openKeyring, connection } from "./backup-lib.mjs";
import {
  assertNoActiveOrUncertain,
  sourceFingerprint,
} from "./backup-automation.mjs";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Complete authoritative inventory. Tombstones remain sources until purged;
 * unpublished provisioned DBs remain sources too. Never decrypt with a new key. */
export async function discoverRecoverySources(client, env, media) {
  if (!env.KEYRING_SECRET)
    throw new Error("The original keyring escrow is required.");
  const url = env.PLATFORM_DATABASE_URL ?? env.TURSO_DATABASE_URL;
  if (!url)
    throw new Error("An explicit platform database source is required.");
  const credentials = {
    KEYRING_SECRET: env.KEYRING_SECRET,
    RECOVERY_DB_0_URL: url,
    RECOVERY_DB_0_TOKEN: env.PLATFORM_AUTH_TOKEN ?? env.TURSO_AUTH_TOKEN ?? "",
  };
  if (env.TURSO_DATABASE_URL)
    credentials.TURSO_DATABASE_URL = env.TURSO_DATABASE_URL;
  if (env.TURSO_AUTH_TOKEN) credentials.TURSO_AUTH_TOKEN = env.TURSO_AUTH_TOKEN;
  const platformIdentity = await databaseIdentity(url);
  const byIdentity = new Map([
    [
      platformIdentity,
      {
        id: "platform",
        role: "platform",
        urlEnv: "RECOVERY_DB_0_URL",
        ...(credentials.RECOVERY_DB_0_TOKEN
          ? { tokenEnv: "RECOVERY_DB_0_TOKEN" }
          : {}),
        workspaceIds: [],
      },
    ],
  ]);
  const names = new Set(
    (
      await client.execute("SELECT name FROM sqlite_schema WHERE type='table'")
    ).rows.map((r) => String(r.name)),
  );
  if (!names.has("workspaces"))
    throw new Error("Platform workspace registry is missing.");
  const evidence = [];
  // The configured primary is a source even before importLegacy publishes its
  // workspace row. Restore must preserve that future dependency as well.
  if (env.TURSO_DATABASE_URL) {
    const identity = await databaseIdentity(env.TURSO_DATABASE_URL);
    if (!byIdentity.has(identity)) {
      const index = byIdentity.size;
      credentials[`RECOVERY_DB_${index}_URL`] = env.TURSO_DATABASE_URL;
      if (env.TURSO_AUTH_TOKEN)
        credentials[`RECOVERY_DB_${index}_TOKEN`] = env.TURSO_AUTH_TOKEN;
      byIdentity.set(identity, {
        id: "configured-primary",
        role: "tenant",
        urlEnv: `RECOVERY_DB_${index}_URL`,
        ...(env.TURSO_AUTH_TOKEN
          ? { tokenEnv: `RECOVERY_DB_${index}_TOKEN` }
          : {}),
        workspaceIds: [],
      });
    }
    evidence.push({
      table: "configuration",
      identity,
      source: "TURSO_DATABASE_URL",
    });
  }
  const workspaces = (
    await client.execute("SELECT * FROM workspaces ORDER BY id")
  ).rows;
  const purged = new Set(
    workspaces.filter((r) => r.purged_at != null).map((r) => String(r.id)),
  );
  for (const table of ["workspaces", "workspace_provisioning"]) {
    if (!names.has(table)) continue;
    const rows = (
      await client.execute(
        `SELECT * FROM ${table} ORDER BY ${table === "workspaces" ? "id" : "workspace_id"}`,
      )
    ).rows;
    for (const row of rows) {
      const id = String(table === "workspaces" ? row.id : row.workspace_id);
      if (row.purged_at != null || purged.has(id)) continue;
      if (!row.db_url) {
        // A deterministic name can exist remotely after a lost create response.
        // Even a pending row cannot be excluded merely because its URL is absent.
        if (row.db_name)
          throw new Error(
            "A pending database name has no recorded connection. Reconcile provisioning before creating a receipt.",
          );
        continue;
      }
      if (row.legacy && !env.TURSO_DATABASE_URL)
        throw new Error(
          "The original legacy primary database URL is required; its platform row may contain only a placeholder.",
        );
      const sourceUrl = row.legacy
          ? env.TURSO_DATABASE_URL
          : String(row.db_url),
        identity = await databaseIdentity(sourceUrl);
      const token = row.legacy
        ? (env.TURSO_AUTH_TOKEN ?? null)
        : row.db_token_enc
          ? openKeyring(row.db_token_enc, env.KEYRING_SECRET)
          : null;
      for (const [field, value] of Object.entries(row))
        if (field.endsWith("_enc") && value)
          openKeyring(value, env.KEYRING_SECRET);
      let spec = byIdentity.get(identity);
      if (!spec) {
        const index = byIdentity.size,
          urlEnv = `RECOVERY_DB_${index}_URL`,
          tokenEnv = `RECOVERY_DB_${index}_TOKEN`;
        credentials[urlEnv] = sourceUrl;
        if (token) credentials[tokenEnv] = token;
        spec = {
          id: `tenant-${index}`,
          role: "tenant",
          urlEnv,
          ...(token ? { tokenEnv } : {}),
          workspaceIds: [],
        };
        byIdentity.set(identity, spec);
      }
      if (!spec.workspaceIds.includes(id)) spec.workspaceIds.push(id);
      evidence.push({
        table,
        workspaceId: id,
        identity,
        deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
        state: row.state ?? "published",
      });
    }
  }
  for (const spec of byIdentity.values()) spec.workspaceIds.sort();
  if (!media || !["blob", "local"].includes(media.kind))
    throw new Error("Explicit complete media inventory is required.");
  if (media.kind === "local") {
    // Capture every application media directory, including partial upload chunks.
    media = {
      ...media,
      directories: [
        "generations",
        "uploads",
        "platform",
        "identities",
        "chunks",
      ],
    };
  }
  if (media.kind === "blob") {
    if (!media.tokenEnv || !env[media.tokenEnv])
      throw new Error("Private Blob store credential is missing.");
    credentials[media.tokenEnv] = env[media.tokenEnv];
  }
  return {
    config: {
      version: 1,
      label: "enforced-recovery-checkpoint",
      quiesced: true,
      databases: [...byIdentity.values()],
      media,
    },
    env: credentials,
    inventoryHash: digest({
      platformIdentity,
      databases: evidence,
      media,
      mediaCredential:
        media.kind === "blob" ? digest(env[media.tokenEnv]) : null,
    }),
  };
}
export async function verifyLiveFence(config, env, receipt) {
  const spec = config.databases.find((d) => d.role === "platform");
  if (!spec) throw new Error("Platform source is missing.");
  const client = createClient(connection(spec, env));
  try {
    // Verification is read-only. An old deployment with no fence schema fails.
    const row = (
      await client.execute("SELECT * FROM recovery_fence WHERE id=1")
    ).rows[0];
    if (
      !row ||
      receipt?.protocol !== RECOVERY_PROTOCOL ||
      row.protocol !== RECOVERY_PROTOCOL ||
      row.state !== "closed" ||
      Number(row.epoch) !== receipt.epoch ||
      row.receipt_id !== receipt.receiptId ||
      row.source_fingerprint !== sourceFingerprint(config) ||
      receipt.sourceFingerprint !== row.source_fingerprint ||
      row.inventory_hash !== receipt.inventoryHash ||
      Number(row.expires_at) <= Date.now() ||
      receipt.expiresAt <= Date.now() ||
      digest(JSON.parse(String(row.preconditions))) !==
        digest(receipt.preconditions)
    )
      throw new Error(
        "Backup requires a fresh live enforced fence matching this receipt and exact inventory.",
      );
    // Bind the actual resolved URLs and authoritative registry, not env variable names.
    const discovered = await discoverRecoverySources(
      client,
      {
        ...env,
        PLATFORM_DATABASE_URL: connection(spec, env).url,
        PLATFORM_AUTH_TOKEN: connection(spec, env).authToken,
      },
      config.media,
    );
    if (
      discovered.inventoryHash !== receipt.inventoryHash ||
      sourceFingerprint(discovered.config) !== sourceFingerprint(config)
    )
      throw new Error(
        "The live source registry or resolved database endpoints changed.",
      );
    for (const actual of config.databases) {
      const expected = discovered.config.databases.find(
        (source) => source.id === actual.id,
      );
      if (
        !expected ||
        (await databaseIdentity(connection(actual, env).url)) !==
          (await databaseIdentity(connection(expected, discovered.env).url))
      )
        throw new Error(
          "A resolved database source differs from the authoritative registry.",
        );
    }
    const pending = (
      await client.execute(
        "SELECT (SELECT COUNT(*) FROM recovery_activities WHERE state!='done') + (SELECT COUNT(*) FROM recovery_intents WHERE state!='resolved') AS n",
      )
    ).rows[0];
    if (Number(pending.n))
      throw new Error("An operation remains admitted or uncertain.");
    return true;
  } finally {
    client.close();
  }
}
async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
async function cli() {
  const [action, directory, argument] = process.argv.slice(2);
  if (
    !directory ||
    !["begin", "status", "renew", "seal", "resume"].includes(action)
  )
    throw new Error(
      "Usage: recovery-fence.mjs begin|status|renew|seal|resume PRIVATE_DIRECTORY [CONFIG_JSON]",
    );
  const folder = resolve(directory);
  const url =
    process.env.PLATFORM_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("Explicit platform credentials are required.");
  const client = createClient({
    url,
    authToken: process.env.PLATFORM_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
  });
  const fence = new RecoveryFence(client, "recovery-coordinator");
  try {
    if (action === "begin") {
      if (!argument)
        throw new Error(
          "Begin requires a JSON file containing deployment preconditions and complete media configuration.",
        );
      try {
        await lstat(folder);
        throw new Error("Choose a new private coordinator directory.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await mkdir(folder, { mode: 0o700, recursive: false });
      const input = JSON.parse(await readFile(argument, "utf8")),
        owner = randomBytes(32).toString("hex");
      // Escrow ownership BEFORE closing. A crash after close never loses the key.
      await privateJson(join(folder, "coordinator.json"), { owner, input });
      const lease = await fence.begin(owner, input.preconditions);
      await privateJson(join(folder, "epoch.json"), lease);
      process.stdout.write(
        JSON.stringify({ state: "draining", epoch: lease.epoch }) + "\n",
      );
      return;
    }
    const state = await fence.status();
    if (action === "status") {
      process.stdout.write(
        JSON.stringify({
          state: state.state,
          epoch: state.epoch,
          activities: state.activities,
          intents: state.intents,
        }) + "\n",
      );
      return;
    }
    const saved = JSON.parse(
      await readFile(join(folder, "coordinator.json"), "utf8"),
    );
    // Recover a begin response lost before epoch.json was persisted.
    if (state.owner !== saved.owner)
      throw new Error("This directory does not own the active recovery epoch.");
    const epoch = Number(state.epoch);
    if (action === "renew") {
      await fence.renew(saved.owner, epoch);
      process.stdout.write("Coordinator renewed; admission remains closed.\n");
      return;
    }
    if (action === "resume") {
      await fence.reopen(saved.owner, epoch);
      process.stdout.write(
        "Admission reopened; every earlier receipt is invalid.\n",
      );
      return;
    }
    if (state.activities.length || state.intents.length)
      throw new Error(
        "Admitted/uncertain operations remain. Drain or reconcile them before sealing.",
      );
    const discovered = await discoverRecoverySources(
      client,
      process.env,
      saved.input.media,
    );
    await assertNoActiveOrUncertain(discovered.config, discovered.env);
    const receipt = await fence.seal(
      saved.owner,
      epoch,
      sourceFingerprint(discovered.config),
      discovered.inventoryHash,
    );
    // Never overwrite an earlier receipt/source credential export.
    await privateJson(join(folder, "sources.json"), discovered.config);
    await privateJson(join(folder, "source-env.json"), discovered.env);
    await privateJson(join(folder, "receipt.json"), receipt);
    process.stdout.write(
      JSON.stringify({
        state: "closed",
        epoch,
        databases: discovered.config.databases.length,
        receipt: join(folder, "receipt.json"),
      }) + "\n",
    );
  } finally {
    client.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  cli().catch(() => {
    process.stderr.write(
      "Recovery command refused or interrupted. Admission is never automatically reopened. Inspect the private coordinator state and run status; no secret values were logged.\n",
    );
    process.exitCode = 1;
  });
