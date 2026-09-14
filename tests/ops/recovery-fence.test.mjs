import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import {
  RecoveryFence,
  RECOVERY_PROTOCOL,
} from "../../lib/recovery/control.mjs";
import {
  discoverRecoverySources,
  verifyLiveFence,
} from "../../scripts/ops/recovery-fence.mjs";
import {
  captureVerified,
  sourceFingerprint,
  assertNoActiveOrUncertain,
} from "../../scripts/ops/backup-automation.mjs";
const owner = "fixture-recovery-coordinator-0123456789";
const preconditions = {
  deployments: [{ id: "local", protocol: RECOVERY_PROTOCOL }],
  oldDeploymentsStopped: true,
  externalWritersExcluded: true,
  evidence:
    "Only these disposable fixture databases are used. No remote access is permitted.",
};
function seal(text, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(key).digest(),
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
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "particl-enforced-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    PLATFORM_DATABASE_URL: pathToFileURL(join(root, "platform.db")).href,
    KEYRING_SECRET: randomBytes(32).toString("hex"),
    PARTICL_BACKUP_KEY: randomBytes(32).toString("base64"),
  };
  env.TURSO_DATABASE_URL = env.PLATFORM_DATABASE_URL;
  const client = createClient({ url: env.PLATFORM_DATABASE_URL });
  t.after(() => client.close());
  await client.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT,db_token_enc TEXT,keys_enc TEXT,legacy INTEGER,deleted_at INTEGER,purged_at INTEGER);
 CREATE TABLE workspace_provisioning(workspace_id TEXT,db_name TEXT,db_url TEXT,db_token_enc TEXT,state TEXT);
 CREATE TABLE meter_events(status TEXT,billed_credits REAL);`);
  const urls = [];
  for (const id of ["active", "deleted", "pending", "purged"]) {
    const url = pathToFileURL(join(root, id + ".db")).href;
    urls.push(url);
    const db = createClient({ url });
    await db.executeMultiple(
      "CREATE TABLE fixture_data(value TEXT); INSERT INTO fixture_data VALUES('kept intact')",
    );
    db.close();
  }
  for (const [i, id] of ["active", "deleted", "purged"].entries())
    await client.execute({
      sql: "INSERT INTO workspaces VALUES(?,?,?,?,0,?,?)",
      args: [
        id,
        urls[id === "purged" ? 3 : i],
        seal("fixture-db-token", env.KEYRING_SECRET),
        seal('{"key":"fixture-value"}', env.KEYRING_SECRET),
        id === "deleted" ? 1 : null,
        id === "purged" ? 1 : null,
      ],
    });
  await client.execute({
    sql: "INSERT INTO workspace_provisioning VALUES('pending','pending-name',?,?,'pending')",
    args: [urls[2], seal("fixture-pending-token", env.KEYRING_SECRET)],
  });
  // Legacy shares the platform source and must not duplicate its snapshot.
  await client.execute({
    sql: "INSERT INTO workspaces VALUES('legacy',?,NULL,NULL,1,NULL,NULL)",
    args: ["(primary)"],
  });
  const media = {
    kind: "local",
    root: join(root, "media"),
    directories: ["uploads"],
  };
  await mkdir(join(media.root, "uploads"), { recursive: true });
  await writeFile(
    join(media.root, "uploads", "fixture.txt"),
    "private fixture",
  );
  return { root, env, client, media };
}
test("authoritative inventory includes active, pending and deleted-unpurged sources, deduplicates legacy and preserves original keyring", async (t) => {
  const f = await fixture(t),
    found = await discoverRecoverySources(f.client, f.env, f.media);
  assert.equal(found.config.databases.length, 4);
  assert.deepEqual(
    found.config.databases.flatMap((d) => d.workspaceIds).sort(),
    ["active", "deleted", "legacy", "pending"],
  );
  assert.equal(found.env.KEYRING_SECRET, f.env.KEYRING_SECRET);
  assert.equal(
    Object.values(found.env).filter((v) => v === "fixture-db-token").length,
    2,
  );
  await assert.rejects(
    discoverRecoverySources(
      f.client,
      { ...f.env, KEYRING_SECRET: "wrong-key" },
      f.media,
    ),
  );
  await f.client.execute(
    "INSERT INTO workspace_provisioning VALUES('ambiguous','created-but-lost-response',NULL,NULL,'pending')",
  );
  await assert.rejects(
    discoverRecoverySources(f.client, f.env, f.media),
    /pending database name/,
  );
});
test("real local enforced checkpoint creates encrypted archive and verifies restoration; resumed/forged receipts fail", async (t) => {
  const f = await fixture(t),
    fence = new RecoveryFence(f.client);
  const epoch = await fence.begin(owner, preconditions);
  const found = await discoverRecoverySources(f.client, f.env, f.media);
  found.env.PARTICL_BACKUP_KEY = f.env.PARTICL_BACKUP_KEY;
  await assertNoActiveOrUncertain(found.config, found.env);
  const receipt = await fence.seal(
    owner,
    epoch.epoch,
    sourceFingerprint(found.config),
    found.inventoryHash,
  );
  assert.equal(await verifyLiveFence(found.config, found.env, receipt), true);
  await assert.rejects(
    verifyLiveFence(found.config, found.env, {
      ...receipt,
      receiptId: "forged",
    }),
    /live enforced/,
  );
  const result = await captureVerified(found.config, join(f.root, "capture"), {
    env: found.env,
    quiescence: receipt,
  });
  assert.equal(result.verified.verified, true);
  assert.equal(result.verified.databases, 4);
  await fence.reopen(owner, epoch.epoch);
  await assert.rejects(
    verifyLiveFence(found.config, found.env, receipt),
    /live enforced/,
  );
});
test("legacy running job without an admission blocks sealing preflight and a boolean assertion cannot publish", async (t) => {
  const f = await fixture(t),
    found = await discoverRecoverySources(f.client, f.env, f.media);
  await f.client.execute("INSERT INTO meter_events VALUES('running',20)");
  await assert.rejects(
    assertNoActiveOrUncertain(found.config, found.env),
    /live or uncertain/,
  );
  const now = Date.now();
  const booleanAssertion = {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    sourceFingerprint: sourceFingerprint(found.config),
    mutationsPaused: true,
    workersPaused: true,
    uploadsPaused: true,
    provisioningPaused: true,
    purgePaused: true,
  };
  await assert.rejects(
    captureVerified(found.config, join(f.root, "forbidden"), {
      env: found.env,
      quiescence: booleanAssertion,
    }),
    /no such table|live enforced/,
  );
});
test("external registry mutation after receipt invalidates the complete source inventory", async (t) => {
  const f = await fixture(t),
    fence = new RecoveryFence(f.client),
    epoch = await fence.begin(owner, preconditions),
    found = await discoverRecoverySources(f.client, f.env, f.media);
  const receipt = await fence.seal(
    owner,
    epoch.epoch,
    sourceFingerprint(found.config),
    found.inventoryHash,
  );
  await f.client.execute(
    "UPDATE workspaces SET deleted_at=42 WHERE id='active'",
  );
  await assert.rejects(
    verifyLiveFence(found.config, found.env, receipt),
    /registry/,
  );
});

test("a substituted tenant URL is rejected even when the config keeps the same env variable names", async (t) => {
  const f = await fixture(t),
    fence = new RecoveryFence(f.client),
    epoch = await fence.begin(owner, preconditions),
    found = await discoverRecoverySources(f.client, f.env, f.media);
  const receipt = await fence.seal(
    owner,
    epoch.epoch,
    sourceFingerprint(found.config),
    found.inventoryHash,
  );
  await assert.rejects(
    verifyLiveFence(
      found.config,
      { ...found.env, RECOVERY_DB_1_URL: found.env.RECOVERY_DB_2_URL },
      receipt,
    ),
    /resolved database source/,
  );
});

test("unacknowledged tenant settlement blocks preflight until its receipt is durably complete", async (t) => {
  const f = await fixture(t),
    found = await discoverRecoverySources(f.client, f.env, f.media);
  await f.client.executeMultiple(
    "CREATE TABLE generation_settlements(id TEXT,settled_at INTEGER); INSERT INTO generation_settlements VALUES('terminal-paid-job',NULL)",
  );
  await assert.rejects(
    assertNoActiveOrUncertain(found.config, found.env),
    /live or uncertain/,
  );
  assert.equal(
    (await f.client.execute("SELECT settled_at FROM generation_settlements"))
      .rows[0].settled_at,
    null,
  );
  await f.client.execute("UPDATE generation_settlements SET settled_at=42");
  await assertNoActiveOrUncertain(found.config, found.env);
});

test("configured legacy primary is inventoried before legacy import and canonical aliases deduplicate", async (t) => {
  const f = await fixture(t);
  const primaryUrl = pathToFileURL(join(f.root, "unimported-primary.db")).href;
  const primary = createClient({ url: primaryUrl });
  t.after(() => primary.close());
  await primary.executeMultiple(
    "CREATE TABLE users(id TEXT); INSERT INTO users VALUES('legacy-owner')",
  );
  await f.client.execute("DELETE FROM workspaces WHERE legacy=1");
  const env = {
    ...f.env,
    TURSO_DATABASE_URL: primaryUrl,
    TURSO_AUTH_TOKEN: "fixture-primary-token",
  };
  const found = await discoverRecoverySources(f.client, env, f.media);
  const configured = found.config.databases.find(
    (row) => row.id === "configured-primary",
  );
  assert.ok(configured);
  assert.equal(found.env[configured.urlEnv], primaryUrl);
  assert.equal(found.env[configured.tokenEnv], "fixture-primary-token");
  assert.equal(found.config.databases.length, 5);
  const fence = new RecoveryFence(f.client),
    epoch = await fence.begin(owner, preconditions);
  const receipt = await fence.seal(
    owner,
    epoch.epoch,
    sourceFingerprint(found.config),
    found.inventoryHash,
  );
  const result = await captureVerified(
    found.config,
    join(f.root, "configured-primary-capture"),
    {
      env: { ...found.env, PARTICL_BACKUP_KEY: f.env.PARTICL_BACKUP_KEY },
      quiescence: receipt,
    },
  );
  assert.equal(result.verified.databases, 5);
  await f.client.execute({
    sql: "INSERT INTO workspaces VALUES('legacy',?,NULL,NULL,1,NULL,NULL)",
    args: ["(primary)"],
  });
  const imported = await discoverRecoverySources(f.client, env, f.media);
  assert.equal(imported.config.databases.length, 5);
  assert.deepEqual(
    imported.config.databases.find((row) => row.id === "configured-primary")
      .workspaceIds,
    ["legacy"],
  );
  const alias = await discoverRecoverySources(
    f.client,
    {
      ...env,
      TURSO_DATABASE_URL:
        "file:" + new URL(f.env.PLATFORM_DATABASE_URL).pathname,
    },
    f.media,
  );
  assert.equal(alias.config.databases.length, 4);
});
