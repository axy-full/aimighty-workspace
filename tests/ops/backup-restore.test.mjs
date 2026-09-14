import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  backupKey,
  createBackup,
  restoreBackup,
  restoreBlobs,
  verifyDatabase,
  openKeyring,
  databaseIdentity,
} from "../../scripts/ops/backup-lib.mjs";
import { recoveryReport } from "../../scripts/ops/recovery-report.mjs";
import { prepareRestore } from "../../scripts/ops/prepare-restore.mjs";

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
  const root = await mkdtemp(join(tmpdir(), "particl-restore-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    PARTICL_BACKUP_KEY: randomBytes(32).toString("base64"),
    KEYRING_SECRET: randomBytes(32).toString("hex"),
  };
  const platformPath = join(root, "platform.db"),
    tenantPath = join(root, "tenant.db");
  const platform = createClient({ url: pathToFileURL(platformPath).href }),
    tenant = createClient({ url: pathToFileURL(tenantPath).href });
  await platform.executeMultiple(`CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT,password_hash TEXT);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT,db_token_enc TEXT,keys_enc TEXT,legacy INTEGER,deleted_at INTEGER,purged_at INTEGER);
    CREATE TABLE memberships(workspace_id TEXT,account_id TEXT,role TEXT);
    CREATE TABLE p_sessions(id TEXT PRIMARY KEY,account_id TEXT);
    CREATE TABLE workspace_provisioning(request_id TEXT,workspace_id TEXT,db_url TEXT,state TEXT);
    CREATE TABLE meter_events(id TEXT,workspace_id TEXT,kind TEXT,status TEXT,billed_credits INTEGER);
    CREATE TABLE billing_lots(id TEXT PRIMARY KEY,workspace_id TEXT,credits REAL,drawn REAL,expires_at INTEGER);
    CREATE TABLE billing_allocations(workspace_id TEXT,event_id TEXT,lot_id TEXT,credits REAL);
    INSERT INTO accounts VALUES('user-a','fixture-a@example.invalid','fixture-hash'),('user-b','fixture-b@example.invalid','fixture-hash');
    INSERT INTO memberships VALUES('ws_fixture','user-a','owner'),('ws_fixture','user-b','member');
    INSERT INTO p_sessions VALUES('fixture-session','user-a');
    INSERT INTO meter_events VALUES('uncertain','ws_fixture','video','failed',29);
    INSERT INTO billing_lots VALUES('fixture-lot','ws_fixture',250,29,1900000000000);
    INSERT INTO billing_allocations VALUES('ws_fixture','uncertain','fixture-lot',29);`);
  await platform.execute({
    sql: "INSERT INTO workspaces VALUES(?,?,?,?,0,NULL,NULL)",
    args: [
      "ws_fixture",
      pathToFileURL(tenantPath).href,
      seal("fixture-tenant-token", env.KEYRING_SECRET),
      seal('{"ark":"fixture-provider-key"}', env.KEYRING_SECRET),
    ],
  });
  await tenant.executeMultiple(`PRAGMA journal_mode=WAL;
    CREATE TABLE private_drafts(id TEXT PRIMARY KEY,owner TEXT,state TEXT);
    CREATE TABLE published_bibles(id TEXT PRIMARY KEY,revision INTEGER,body TEXT);
    CREATE TABLE shot_mappings(id TEXT PRIMARY KEY,shot_id TEXT);
    CREATE TABLE payloads(id INTEGER PRIMARY KEY AUTOINCREMENT,bytes BLOB,value REAL);
    CREATE INDEX owner_idx ON private_drafts(owner);
    CREATE TABLE generations(id TEXT PRIMARY KEY,status TEXT,params TEXT,ark_task_id TEXT,cost_usd REAL);
    CREATE TABLE generation_requests(user_id TEXT,request_key TEXT,fingerprint TEXT,generation_id TEXT);
    CREATE TABLE workbench_atomik_jobs(id TEXT,status TEXT,provider_response TEXT,estimate_usd REAL,cost_usd REAL);
    CREATE TABLE identity_training_runs(id TEXT,status TEXT,request_id TEXT,cost_usd REAL);
    INSERT INTO private_drafts VALUES('draft-a','user-a','private alpha'),('draft-b','user-b','private beta');
    INSERT INTO published_bibles VALUES('bible-a',3,'immutable context');
    INSERT INTO shot_mappings VALUES('canvas-shot','production-shot');
    INSERT INTO payloads(bytes,value) VALUES(X'00ff0102',1.25);
    INSERT INTO generations VALUES('uncertain','failed','{"paidClaim":"permanent-claim"}',NULL,1.88),('known','running','{}','fixture-provider-handle',1.88),('held','held','{}',NULL,0);
    INSERT INTO generation_requests VALUES('user-a','request-a','immutable-fingerprint','uncertain');
    INSERT INTO workbench_atomik_jobs VALUES('text-a','running',NULL,0.25,0.25);
    INSERT INTO identity_training_runs VALUES('train-a','running','fixture-training-handle',3.60);`);
  platform.close();
  t.after(() => tenant.close()); // Leave committed WAL source open during snapshot.
  const media = join(root, "media");
  await mkdir(join(media, "generations"), { recursive: true });
  await mkdir(join(media, "uploads"));
  await writeFile(
    join(media, "generations", "take.png"),
    Buffer.from([0, 1, 2, 254, 255]),
  );
  await writeFile(
    join(media, "uploads", "script.txt"),
    "fixture script private",
  );
  return {
    root,
    env,
    tenant,
    platformPath,
    tenantPath,
    media,
    config: {
      version: 1,
      label: "disposable-fixture",
      quiesced: true,
      databases: [
        {
          id: "platform",
          role: "platform",
          url: pathToFileURL(platformPath).href,
        },
        {
          id: "tenant",
          role: "tenant",
          url: pathToFileURL(tenantPath).href,
          workspaceIds: ["ws_fixture"],
        },
      ],
      media: { kind: "local", root: media },
    },
  };
}

test("full encrypted WAL snapshot restores private drafts, mappings, ledger, claims, binary values and keyring", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored");
  const result = await createBackup(f.config, bundle, { env: f.env });
  assert.deepEqual(
    {
      databases: result.databases,
      media: result.media,
      sealedValues: result.sealedValues,
    },
    { databases: 2, media: 2, sealedValues: 2 },
  );
  for (const file of await readdir(bundle)) {
    const bytes = await readFile(join(bundle, file));
    for (const plain of [
      f.env.KEYRING_SECRET,
      "private alpha",
      "fixture-a@example.invalid",
      "fixture script private",
    ])
      assert.equal(bytes.includes(Buffer.from(plain)), false);
    assert.equal((await stat(join(bundle, file))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(bundle)).mode & 0o777, 0o700);
  assert.deepEqual(await restoreBackup(bundle, restored, { env: f.env }), {
    databases: 2,
    media: 2,
    sealedValues: 2,
    verified: true,
  });
  for (const id of ["platform", "tenant"])
    assert.equal(
      (
        await verifyDatabase(
          join(restored, "databases", id + ".db"),
          f.config.databases.find((d) => d.id === id),
        )
      ).verified,
      true,
    );
  const keys = JSON.parse(
    await readFile(join(restored, "recovery-secrets.json"), "utf8"),
  );
  assert.equal(keys.KEYRING_SECRET, f.env.KEYRING_SECRET);
  const restoredDb = createClient({
    url: pathToFileURL(join(restored, "databases", "platform.db")).href,
  });
  try {
    assert.equal(
      openKeyring(
        (await restoredDb.execute("SELECT db_token_enc FROM workspaces"))
          .rows[0].db_token_enc,
        keys.KEYRING_SECRET,
      ),
      "fixture-tenant-token",
    );
  } finally {
    restoredDb.close();
  }
  assert.deepEqual(
    await readFile(join(restored, "media", "generations", "take.png")),
    Buffer.from([0, 1, 2, 254, 255]),
  );
  assert.deepEqual(await recoveryReport(restored), {
    actions: 5,
    tombstones: 0,
    meters: 1,
  });
  const report = JSON.parse(
    await readFile(join(restored, "reconciliation-report.json"), "utf8"),
  );
  assert.equal(
    report.actions.find((a) => a.id === "uncertain").disposition,
    "uncertain-provider-outcome-never-resubmit",
  );
  assert.equal(
    report.actions.find((a) => a.id === "known").handle,
    "fixture-provider-handle",
  );
  assert.equal(
    report.actions.find((a) => a.id === "held").disposition,
    "held-review-before-release",
  );
  assert.equal(report.meters[0].billedCredits, 29);
  // Read-only report leaves every row and ledger balance untouched.
  assert.equal(
    (
      await verifyDatabase(
        join(restored, "databases", "tenant.db"),
        f.config.databases[1],
      )
    ).verified,
    true,
  );
});

test("wrong backup key, changed ciphertext and missing objects never publish a restore directory", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup");
  await createBackup(f.config, bundle, { env: f.env });
  const wrong = {
    ...f.env,
    PARTICL_BACKUP_KEY: randomBytes(32).toString("base64"),
  };
  await assert.rejects(
    restoreBackup(bundle, join(f.root, "wrong"), { env: wrong }),
  );
  await assert.rejects(stat(join(f.root, "wrong")), { code: "ENOENT" });
  const object = join(bundle, "00000000.enc"),
    original = await readFile(object),
    changed = Buffer.from(original);
  changed[0] ^= 1;
  await writeFile(object, changed);
  await assert.rejects(
    restoreBackup(bundle, join(f.root, "corrupt"), { env: f.env }),
  );
  await assert.rejects(stat(join(f.root, "corrupt")), { code: "ENOENT" });
  await rm(object);
  await assert.rejects(
    restoreBackup(bundle, join(f.root, "missing"), { env: f.env }),
  );
});

test("keyring mismatch, missing tenant inventory and non-quiesced sources fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createBackup(f.config, join(f.root, "wrong-keyring"), {
      env: { ...f.env, KEYRING_SECRET: "wrong" },
    }),
  );
  await assert.rejects(
    createBackup(
      { ...f.config, databases: [f.config.databases[0]] },
      join(f.root, "incomplete"),
      { env: f.env },
    ),
    /missing/,
  );
  await assert.rejects(
    createBackup({ ...f.config, quiesced: false }, join(f.root, "active"), {
      env: f.env,
    }),
    /quiesced/,
  );
  assert.throws(
    () => backupKey({ PARTICL_BACKUP_KEY: "short" }),
    /32 random bytes/,
  );
});

test("backup and restore never overwrite; symlink media cannot escape the source root", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup");
  await createBackup(f.config, bundle, { env: f.env });
  await assert.rejects(
    createBackup(f.config, bundle, { env: f.env }),
    /already exists/,
  );
  await assert.rejects(
    restoreBackup(bundle, f.media, { env: f.env }),
    /already exists/,
  );
  await symlink(f.platformPath, join(f.media, "escape.db"));
  await assert.rejects(
    createBackup(f.config, join(f.root, "symlink"), { env: f.env }),
    /symlinks/,
  );
});

function fakeBlob(initial = new Map()) {
  const data = new Map(initial),
    calls = [];
  return {
    data,
    calls,
    async list(options) {
      calls.push(["list", options]);
      const entries = [...data.entries()].sort();
      const offset = Number(options.cursor ?? 0);
      const entriesPage = entries.slice(offset, offset + 1);
      return {
        blobs: entriesPage.map(([pathname, body]) => ({
          pathname,
          size: body.length,
          etag: createHash("sha256").update(body).digest("hex"),
          uploadedAt: new Date(0),
        })),
        hasMore: offset + 1 < entries.length,
        cursor: String(offset + 1),
      };
    },
    async get(path, options) {
      calls.push(["get", options]);
      const body = data.get(path);
      return body
        ? {
            statusCode: 200,
            blob: {
              size: body.length,
              etag: createHash("sha256").update(body).digest("hex"),
              contentType: "application/octet-stream",
            },
            stream: new ReadableStream({
              start(c) {
                c.enqueue(body);
                c.close();
              },
            }),
          }
        : null;
    },
    async put(path, stream, options) {
      calls.push(["put", options]);
      assert.equal(options.access, "private");
      assert.equal(options.allowOverwrite, false);
      assert.equal(data.has(path), false);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      data.set(path, Buffer.concat(chunks));
    },
  };
}
test("paginated private Blob capture and empty-store restore preserve paths and readback hashes", async (t) => {
  const f = await fixture(t),
    source = fakeBlob(
      new Map([
        ["ws/ws_fixture/generations/take.png", Buffer.from([0, 255])],
        ["platform/logo.svg", Buffer.from("fixture-logo")],
      ]),
    );
  f.env.FIXTURE_BLOB_TOKEN = "fixture-only";
  f.config.media = { kind: "blob", tokenEnv: "FIXTURE_BLOB_TOKEN" };
  const bundle = join(f.root, "blob-backup"),
    restored = join(f.root, "blob-restored");
  await createBackup(f.config, bundle, { env: f.env, blobSdk: source });
  await restoreBackup(bundle, restored, { env: f.env });
  const target = fakeBlob();
  assert.deepEqual(
    await restoreBlobs(
      restored,
      { tokenEnv: "FIXTURE_BLOB_TOKEN", confirmEmptyPrivateStore: true },
      { env: f.env, blobSdk: target },
    ),
    { verified: true, media: 2 },
  );
  assert.deepEqual(target.data, source.data);
  for (const [method, options] of [...source.calls, ...target.calls]) {
    assert.equal(options.token, "fixture-only");
    if (method === "get") {
      assert.equal(options.access, "private");
      assert.equal(options.useCache, false);
    }
  }
  await assert.rejects(
    restoreBlobs(
      restored,
      { tokenEnv: "FIXTURE_BLOB_TOKEN", confirmEmptyPrivateStore: true },
      { env: f.env, blobSdk: target },
    ),
    /not empty/,
  );
});

test("unsafe Blob path and changed source inventory cannot create a successful archive", async (t) => {
  const f = await fixture(t);
  f.env.FIXTURE_BLOB_TOKEN = "fixture-only";
  f.config.media = { kind: "blob", tokenEnv: "FIXTURE_BLOB_TOKEN" };
  const traversal = fakeBlob(new Map([["../outside", Buffer.from("no")]]));
  await assert.rejects(
    createBackup(f.config, join(f.root, "traversal"), {
      env: f.env,
      blobSdk: traversal,
    }),
    /Unsafe/,
  );
  const changing = fakeBlob(new Map([["media.png", Buffer.from("before")]]));
  const originalGet = changing.get;
  changing.get = async (...args) => {
    const result = await originalGet(...args);
    changing.data.set("new.png", Buffer.from("added"));
    return result;
  };
  await assert.rejects(
    createBackup(f.config, join(f.root, "changing"), {
      env: f.env,
      blobSdk: changing,
    }),
    /changed/,
  );
});

test("full SQL verification detects row changes even when table counts are identical", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored");
  await createBackup(f.config, bundle, { env: f.env });
  await restoreBackup(bundle, restored, { env: f.env });
  await f.tenant.execute(
    "UPDATE private_drafts SET state='changed' WHERE id='draft-a'",
  );
  await assert.rejects(
    verifyDatabase(
      join(restored, "databases", "tenant.db"),
      f.config.databases[1],
    ),
    /does not match/,
  );
});

test("prepared copies remap tenant credentials and revoke old access without changing originals or paid records", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored"),
    prepared = join(f.root, "prepared");
  await createBackup(f.config, bundle, { env: f.env });
  await restoreBackup(bundle, restored, { env: f.env });
  const mappings = {
    invalidateAccess: true,
    databases: [
      {
        id: "platform",
        url: pathToFileURL(join(f.root, "new-platform.db")).href,
      },
      { id: "tenant", url: pathToFileURL(join(f.root, "new-tenant.db")).href },
    ],
  };
  const before = await readFile(join(restored, "databases", "platform.db"));
  assert.equal(
    (await prepareRestore(restored, mappings, prepared)).stillOffline,
    true,
  );
  assert.deepEqual(
    await readFile(join(restored, "databases", "platform.db")),
    before,
  );
  const p = createClient({
    url: pathToFileURL(join(prepared, "platform.db")).href,
  });
  try {
    assert.equal(
      (await p.execute("SELECT db_url FROM workspaces")).rows[0].db_url,
      mappings.databases[1].url,
    );
    assert.equal(
      (await p.execute("SELECT COUNT(*) AS n FROM p_sessions")).rows[0].n,
      0,
    );
    assert.equal(
      (await p.execute("SELECT billed_credits FROM meter_events")).rows[0]
        .billed_credits,
      29,
    );
    assert.equal(
      (await p.execute("SELECT credits FROM billing_allocations")).rows[0]
        .credits,
      29,
    );
  } finally {
    p.close();
  }
  assert.equal(
    (await verifyDatabase(join(prepared, "tenant.db"), f.config.databases[1]))
      .verified,
    true,
  );
  await assert.rejects(
    prepareRestore(
      restored,
      { ...mappings, databases: f.config.databases },
      join(f.root, "original-target"),
    ),
    /original source/,
  );
});

test("missing referenced media blocks backup and database-only files are excluded from local media directories", async (t) => {
  const f = await fixture(t);
  await f.tenant.executeMultiple(
    "CREATE TABLE uploads(id TEXT,ext TEXT,stored_url TEXT); INSERT INTO uploads VALUES('script','txt','/api/uploads/script');",
  );
  f.config.media.directories = ["uploads", "generations", "platform"];
  await writeFile(
    join(f.media, "should-not-copy.db"),
    "fixture db outside the media directories",
  );
  const result = await createBackup(f.config, join(f.root, "with-reference"), {
    env: f.env,
  });
  assert.equal(result.media, 2);
  await rm(join(f.media, "uploads", "script.txt"));
  await assert.rejects(
    createBackup(f.config, join(f.root, "missing-media"), { env: f.env }),
    /referenced.*missing/,
  );
});

test("restore mapping rejects another original database and canonical file or protocol aliases", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored");
  await createBackup(f.config, bundle, { env: f.env });
  await restoreBackup(bundle, restored, { env: f.env });
  const mapping = {
    invalidateAccess: true,
    databases: [
      { id: "platform", dbName: "new-platform" },
      { id: "tenant", url: pathToFileURL(f.platformPath).href },
    ],
  };
  await assert.rejects(
    prepareRestore(restored, mapping, join(f.root, "cross-source")),
    /original source/,
  );
  mapping.databases[1].url = "file:" + f.tenantPath;
  await assert.rejects(
    prepareRestore(restored, mapping, join(f.root, "alias-source")),
    /original source/,
  );
  assert.equal(
    await databaseIdentity("libsql://example.turso.io"),
    await databaseIdentity("https://example.turso.io:443/"),
  );
});

test("preparation rejects dangling destinations and damaged keyring escrow before resealing", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored");
  await createBackup(f.config, bundle, { env: f.env });
  await restoreBackup(bundle, restored, { env: f.env });
  const mapping = {
    invalidateAccess: true,
    databases: [
      { id: "platform", dbName: "new-platform" },
      { id: "tenant", url: pathToFileURL(join(f.root, "new-tenant.db")).href },
    ],
  };
  const dangling = join(f.root, "dangling");
  await symlink(join(f.root, "absent-directory"), dangling);
  await assert.rejects(
    prepareRestore(restored, mapping, dangling),
    /already exists/,
  );
  await writeFile(
    join(restored, "recovery-secrets.json"),
    JSON.stringify({ KEYRING_SECRET: "damaged-keyring" }),
  );
  await assert.rejects(
    prepareRestore(restored, mapping, join(f.root, "bad-keyring")),
  );
  await assert.rejects(stat(join(f.root, "bad-keyring")), { code: "ENOENT" });
});

test("reconciliation includes explicit uncertain text/training and legacy identity records", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored");
  await f.tenant
    .executeMultiple(`CREATE TABLE paid_text_jobs(id TEXT,status TEXT,response_json TEXT,estimate_usd REAL,cost_usd REAL);
    CREATE TABLE identities(id TEXT,status TEXT,request_id TEXT,training_run_id TEXT,cost_usd REAL);
    INSERT INTO paid_text_jobs VALUES('uncertain-text','uncertain',NULL,0.35,0.35);
    INSERT INTO identity_training_runs VALUES('uncertain-train','uncertain',NULL,3.6);
    INSERT INTO identities VALUES('legacy-identity','training','legacy-handle',NULL,3.6);`);
  await createBackup(f.config, bundle, { env: f.env });
  await restoreBackup(bundle, restored, { env: f.env });
  await recoveryReport(restored);
  const report = JSON.parse(
    await readFile(join(restored, "reconciliation-report.json"), "utf8"),
  );
  for (const id of ["uncertain-text", "uncertain-train"])
    assert.equal(
      report.actions.find((a) => a.id === id).disposition,
      "uncertain-provider-outcome-never-resubmit",
    );
  assert.equal(
    report.actions.find((a) => a.id === "legacy-identity").handle,
    "legacy-handle",
  );
});

test("purged resources need no live database, while unlisted pending databases prevent incomplete recovery", async (t) => {
  const f = await fixture(t),
    bundle = join(f.root, "backup"),
    restored = join(f.root, "restored");
  const p = createClient({ url: pathToFileURL(f.platformPath).href });
  try {
    await p.execute(
      "INSERT INTO workspaces VALUES('ws_purged','file:/nonexistent-purged.db',NULL,NULL,0,1000,2000)",
    );
    await createBackup(f.config, bundle, { env: f.env });
    await restoreBackup(bundle, restored, { env: f.env });
    await recoveryReport(restored);
    const report = JSON.parse(
      await readFile(join(restored, "reconciliation-report.json"), "utf8"),
    );
    assert.deepEqual(report.tombstones, [
      { workspaceId: "ws_purged", deletedAt: 1000, purgedAt: 2000 },
    ]);
    await p.execute(
      "INSERT INTO workspace_provisioning VALUES('pending-request','ws_pending','file:/missing-pending.db','failed')",
    );
    await assert.rejects(
      createBackup(f.config, join(f.root, "missing-pending"), { env: f.env }),
      /pending provisioned database is missing/,
    );
  } finally {
    p.close();
  }
});
