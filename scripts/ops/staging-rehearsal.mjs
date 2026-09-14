#!/usr/bin/env node
// Explicit opt-in remote rehearsal. Creates only uniquely named disposable
// databases in particl-staging and fixture objects in the named staging store.
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import * as blob from "@vercel/blob";
import {
  createBackup,
  restoreBackup,
  restoreBlobs,
  verifyDatabase,
} from "./backup-lib.mjs";
import { prepareRestore } from "./prepare-restore.mjs";
import { recoveryReport } from "./recovery-report.mjs";

const exec = promisify(execFile);
const [sourceEnvPath, blobEnvPath, targetBlobEnvPath, outputPath] =
  process.argv.slice(2);
if (
  !sourceEnvPath ||
  !blobEnvPath ||
  !targetBlobEnvPath ||
  !outputPath ||
  process.env.PARTICL_ALLOW_STAGING_REHEARSAL !== "1"
) {
  console.error(
    "Requires PARTICL_ALLOW_STAGING_REHEARSAL=1 and SOURCE_ENV STAGING_BLOB_ENV EMPTY_RESTORE_BLOB_ENV NEW_EVIDENCE_DIRECTORY. Read docs/backup-restore.md first.",
  );
  process.exit(2);
}
const root = await mkdtemp(join(tmpdir(), "particl-cloud-rehearsal-"));
const evidence = resolve(outputPath);
await mkdir(evidence, { mode: 0o700 });
const resources = [],
  ownedMedia = [],
  evidenceData = {
    startedAt: new Date().toISOString(),
    databases: [],
    checks: {},
    fixtureOnly: true,
  };
const cli = async (...args) =>
  (
    await exec(process.env.TURSO_CLI || "turso", args, {
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const name = (suffix) => `particl-staging-recovery-${nonce}-${suffix}`;
const nonce = Date.now().toString(36);
const env = {};
let sourceBlobToken, targetBlobToken;
function seal(plain) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(env.KEYRING_SECRET).digest(),
      iv,
    );
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}
async function importDb(id, path, readOnly = false) {
  const dbName = name(id);
  evidenceData.phase = `create-${id}`;
  await cli(
    "db",
    "create",
    dbName,
    "--from-file",
    path,
    "--group",
    "particl-staging",
    "--wait",
  );
  resources.push(dbName);
  await writeFile(
    join(evidence, "owned-resources.json"),
    JSON.stringify({ databases: resources, media: ownedMedia }, null, 2),
    { mode: 0o600 },
  );
  const url = await cli("db", "show", dbName, "--url");
  const token = await cli(
    "db",
    "tokens",
    "create",
    dbName,
    "--expiration",
    "7d",
    ...(readOnly ? ["--read-only"] : []),
  );
  return { url, token, dbName };
}
try {
  evidenceData.phase = "validate-staging-stores";
  const sourceEnv = parseEnv(await readFile(sourceEnvPath, "utf8"));
  env.KEYRING_SECRET = sourceEnv.KEYRING_SECRET;
  env.PARTICL_BACKUP_KEY = randomBytes(32).toString("base64");
  sourceBlobToken = parseEnv(
    await readFile(blobEnvPath, "utf8"),
  ).BLOB_READ_WRITE_TOKEN;
  targetBlobToken = parseEnv(
    await readFile(targetBlobEnvPath, "utf8"),
  ).BLOB_READ_WRITE_TOKEN;
  if (
    !sourceBlobToken ||
    !targetBlobToken ||
    sourceBlobToken === targetBlobToken ||
    sourceBlobToken.split("_")[3]?.toLowerCase() !==
      "vjzxspmvwgnw9y7q".toLowerCase()
  )
    throw new Error(
      "Explicit staging and distinct restore Blob tokens are required.",
    );
  if (
    (await blob.list({ token: sourceBlobToken, limit: 1 })).blobs.length ||
    (await blob.list({ token: targetBlobToken, limit: 1 })).blobs.length
  )
    throw new Error(
      "Both rehearsal Blob stores must be empty before fixture creation.",
    );
  env.SOURCE_BLOB_TOKEN = sourceBlobToken;
  env.TARGET_BLOB_TOKEN = targetBlobToken;
  const tenantPath = join(root, "tenant.db"),
    pPath = join(root, "platform.db");
  const t = createClient({ url: pathToFileURL(tenantPath).href });
  try {
    await t.executeMultiple(`CREATE TABLE private_drafts(id TEXT PRIMARY KEY, owner TEXT, state TEXT);
      CREATE TABLE published_bibles(id TEXT,revision INTEGER,body TEXT);
      CREATE TABLE shot_mappings(id TEXT,shot_id TEXT);
      CREATE TABLE generations(id TEXT,status TEXT,params TEXT,ark_task_id TEXT,cost_usd REAL);
      CREATE TABLE uploads(id TEXT,ext TEXT,stored_url TEXT);
      CREATE TABLE generation_requests(user_id TEXT,request_key TEXT,generation_id TEXT);
      CREATE TABLE payloads(id INTEGER PRIMARY KEY AUTOINCREMENT,bytes BLOB);
      INSERT INTO private_drafts VALUES('draft-a','fixture-owner','private alpha'),('draft-b','fixture-collaborator','private beta');
      INSERT INTO published_bibles VALUES('bible',3,'immutable fixture context');
      INSERT INTO shot_mappings VALUES('canvas-shot','production-shot');
      INSERT INTO generations VALUES('uncertain','failed','{"paidClaim":"fixture-permanent-claim"}',NULL,1.88),('known','running','{}','fixture-known-handle',1.88);
      INSERT INTO generation_requests VALUES('fixture-owner','fixture-request','uncertain');
      INSERT INTO payloads(bytes) VALUES(X'00ff0102');`);
    const path = `ws/ws_rehearsal/uploads/${nonce}.txt`;
    const upload = await blob.put(
      path,
      Buffer.from("Particl disposable private restore fixture."),
      {
        token: sourceBlobToken,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
      },
    );
    ownedMedia.push(path);
    await t.execute({
      sql: "INSERT INTO uploads VALUES(?,?,?)",
      args: [nonce, "txt", upload.url],
    });
  } finally {
    t.close();
  }
  const tenant = await importDb("src-t", tenantPath, true);
  env.SOURCE_TENANT_URL = tenant.url;
  env.SOURCE_TENANT_TOKEN = tenant.token;
  const p = createClient({ url: pathToFileURL(pPath).href });
  try {
    await p.executeMultiple(`CREATE TABLE accounts(id TEXT,email TEXT);
      CREATE TABLE workspaces(id TEXT,db_url TEXT,db_token_enc TEXT,db_name TEXT,keys_enc TEXT,legacy INTEGER,deleted_at INTEGER,purged_at INTEGER);
      CREATE TABLE memberships(workspace_id TEXT,account_id TEXT,role TEXT);
      CREATE TABLE p_sessions(id TEXT,account_id TEXT);
      CREATE TABLE meter_events(id TEXT,workspace_id TEXT,kind TEXT,status TEXT,billed_credits INTEGER);
      CREATE TABLE billing_lots(id TEXT,workspace_id TEXT,credits REAL,drawn REAL,expires_at INTEGER);
      CREATE TABLE billing_allocations(workspace_id TEXT,event_id TEXT,lot_id TEXT,credits REAL);
      INSERT INTO accounts VALUES('fixture-owner','fixture@example.invalid');
      INSERT INTO memberships VALUES('ws_rehearsal','fixture-owner','owner');
      INSERT INTO p_sessions VALUES('fixture-session','fixture-owner');
      INSERT INTO meter_events VALUES('uncertain','ws_rehearsal','video','failed',29);
      INSERT INTO billing_lots VALUES('fixture-lot','ws_rehearsal',250,29,1900000000000);
      INSERT INTO billing_allocations VALUES('ws_rehearsal','uncertain','fixture-lot',29);`);
    await p.execute({
      sql: "INSERT INTO workspaces VALUES(?,?,?,?,?,0,NULL,NULL)",
      args: [
        "ws_rehearsal",
        tenant.url,
        seal(tenant.token),
        tenant.dbName,
        seal('{"ark":"fixture-not-a-provider-key"}'),
      ],
    });
  } finally {
    p.close();
  }
  const platform = await importDb("src-p", pPath, true);
  env.SOURCE_PLATFORM_URL = platform.url;
  env.SOURCE_PLATFORM_TOKEN = platform.token;
  const config = {
    version: 1,
    label: "disposable-staging-rehearsal",
    quiesced: true,
    databases: [
      {
        id: "platform",
        role: "platform",
        urlEnv: "SOURCE_PLATFORM_URL",
        tokenEnv: "SOURCE_PLATFORM_TOKEN",
      },
      {
        id: "tenant",
        role: "tenant",
        workspaceIds: ["ws_rehearsal"],
        urlEnv: "SOURCE_TENANT_URL",
        tokenEnv: "SOURCE_TENANT_TOKEN",
      },
    ],
    media: { kind: "blob", tokenEnv: "SOURCE_BLOB_TOKEN" },
  };
  evidenceData.phase = "capture-synced-replicas-and-private-blob";
  evidenceData.checks.backup = await createBackup(
    config,
    join(root, "backup"),
    { env },
  );
  evidenceData.phase = "decrypt-and-verify-offline";
  evidenceData.checks.restore = await restoreBackup(
    join(root, "backup"),
    join(root, "restored"),
    { env },
  );
  evidenceData.checks.report = await recoveryReport(join(root, "restored"));
  evidenceData.phase = "restore-private-blob-readback";
  evidenceData.checks.privateBlob = await restoreBlobs(
    join(root, "restored"),
    { tokenEnv: "TARGET_BLOB_TOKEN", confirmEmptyPrivateStore: true },
    { env },
  );
  // Prepare once with temporary local endpoints to rewrite direct-upload URLs.
  await prepareRestore(
    join(root, "restored"),
    {
      invalidateAccess: true,
      databases: [
        { id: "platform", dbName: name("dst-p") },
        {
          id: "tenant",
          url: pathToFileURL(join(root, "offline-target.db")).href,
        },
      ],
    },
    join(root, "media-prepared"),
    { env },
  );
  const restoredTenant = await importDb(
    "dst-t",
    join(root, "media-prepared", "tenant.db"),
  );
  env.TARGET_TENANT_URL = restoredTenant.url;
  env.TARGET_TENANT_TOKEN = restoredTenant.token;
  evidenceData.phase = "verify-restored-tenant-sql";
  evidenceData.checks.tenantSql = await verifyDatabase(
    join(root, "media-prepared", "tenant.db"),
    { urlEnv: "TARGET_TENANT_URL", tokenEnv: "TARGET_TENANT_TOKEN" },
    { env },
  );
  await prepareRestore(
    join(root, "restored"),
    {
      invalidateAccess: true,
      databases: [
        { id: "platform", dbName: name("dst-p") },
        {
          id: "tenant",
          urlEnv: "TARGET_TENANT_URL",
          tokenEnv: "TARGET_TENANT_TOKEN",
          dbName: restoredTenant.dbName,
        },
      ],
    },
    join(root, "cloud-prepared"),
    { env },
  );
  const restoredPlatform = await importDb(
    "dst-p",
    join(root, "cloud-prepared", "platform.db"),
  );
  env.TARGET_PLATFORM_URL = restoredPlatform.url;
  env.TARGET_PLATFORM_TOKEN = restoredPlatform.token;
  evidenceData.phase = "verify-restored-platform-sql";
  evidenceData.checks.platformSql = await verifyDatabase(
    join(root, "cloud-prepared", "platform.db"),
    { urlEnv: "TARGET_PLATFORM_URL", tokenEnv: "TARGET_PLATFORM_TOKEN" },
    { env },
  );
  evidenceData.databases = [...resources];
  evidenceData.completedAt = new Date().toISOString();
  evidenceData.success = true;
} catch (error) {
  evidenceData.success = false;
  evidenceData.error =
    "Cloud fixture rehearsal failed. SDK/CLI errors withheld to avoid disclosing tokens. Owned disposable resources are listed for cleanup.";
  if (/^[A-Z][A-Z0-9_]{1,60}$/.test(String(error?.code)))
    evidenceData.errorCode = error.code;
  process.exitCode = 1;
} finally {
  // Only resources created and recorded by THIS invocation may be removed.
  const cleanup = [];
  for (const dbName of resources.reverse()) {
    try {
      await cli("db", "destroy", dbName, "--yes");
      cleanup.push({ database: dbName, removed: true });
    } catch {
      cleanup.push({ database: dbName, removed: false });
    }
  }
  for (const path of ownedMedia)
    for (const [name, token] of [
      ["source", sourceBlobToken],
      ["restore", targetBlobToken],
    ]) {
      try {
        await blob.del(path, { token });
        cleanup.push({ store: name, pathname: path, removed: true });
      } catch {
        cleanup.push({ store: name, pathname: path, removed: false });
      }
    }
  evidenceData.cleanup = cleanup;
  await writeFile(
    join(evidence, "rehearsal.json"),
    JSON.stringify(evidenceData, null, 2),
    { mode: 0o600 },
  );
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(evidenceData));
}
