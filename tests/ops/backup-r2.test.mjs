import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  createBackup,
  restoreBackup,
  restoreR2,
  r2Settings,
} from "../../scripts/ops/backup-lib.mjs";
import { recoveryReport } from "../../scripts/ops/recovery-report.mjs";
import { prepareRestore } from "../../scripts/ops/prepare-restore.mjs";
import { downloadBundle, uploadBundle } from "../../scripts/ops/backup-automation.mjs";

// Everything here is in-process: an S3-compatible fake behind the real
// @aws-sdk/client-s3 command classes, and an in-memory Blob SDK fake. No
// request leaves the process.

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const s3Error = (status, name) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
async function collect(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** S3-compatible fake: ListObjectsV2 (paged), GetObject (If-Match), PutObject
 * (If-None-Match), multipart. `faults.get(key)` = number of reads that break
 * mid-stream, like a dropped connection. */
function fakeR2(initial = new Map(), { pageSize = 1 } = {}) {
  const objects = new Map(),
    calls = [],
    faults = new Map(),
    uploads = new Map();
  const store = (key, body, contentType = "application/octet-stream", etag = md5(body)) =>
    objects.set(key, { body, etag, contentType, modified: new Date(0) });
  for (const [key, body] of initial) store(key, body);
  const client = {
    objects,
    calls,
    faults,
    store,
    settings: null,
    destroyed: 0,
    destroy() {
      client.destroyed++;
    },
    async send(command) {
      const name = command.constructor.name,
        input = command.input;
      calls.push([name, input.Key ?? null]);
      assert.equal(input.Bucket, client.settings.bucket);
      if (name === "ListObjectsV2Command") {
        const keys = [...objects.keys()].sort(),
          offset = Number(input.ContinuationToken ?? 0),
          page = keys.slice(offset, offset + pageSize),
          more = offset + pageSize < keys.length;
        return {
          Contents: page.map((Key) => ({
            Key,
            Size: objects.get(Key).body.length,
            ETag: `"${objects.get(Key).etag}"`,
            LastModified: objects.get(Key).modified,
          })),
          IsTruncated: more,
          ...(more ? { NextContinuationToken: String(offset + pageSize) } : {}),
        };
      }
      if (name === "GetObjectCommand") {
        const object = objects.get(input.Key);
        if (!object) throw s3Error(404, "NoSuchKey");
        if (input.IfMatch && input.IfMatch.replace(/"/g, "") !== object.etag)
          throw s3Error(412, "PreconditionFailed");
        let Body = Readable.from([object.body]);
        if (faults.get(input.Key)) {
          faults.set(input.Key, faults.get(input.Key) - 1);
          Body = new Readable({
            read() {
              this.push(object.body.subarray(0, 1));
              this.destroy(new Error("socket hang up"));
            },
          });
        }
        return {
          Body,
          ContentLength: object.body.length,
          ETag: `"${object.etag}"`,
          ContentType: object.contentType,
          $metadata: { httpStatusCode: 200 },
        };
      }
      if (name === "PutObjectCommand") {
        if (input.IfNoneMatch === "*" && objects.has(input.Key))
          throw s3Error(412, "PreconditionFailed");
        const body = await collect(input.Body);
        assert.equal(body.length, input.ContentLength);
        store(input.Key, body, input.ContentType);
        return { ETag: `"${md5(body)}"` };
      }
      if (name === "CreateMultipartUploadCommand") {
        const id = `upload-${uploads.size}`;
        uploads.set(id, { key: input.Key, parts: new Map(), contentType: input.ContentType });
        return { UploadId: id };
      }
      if (name === "UploadPartCommand") {
        const body = await collect(input.Body);
        assert.equal(body.length, input.ContentLength);
        uploads.get(input.UploadId).parts.set(input.PartNumber, body);
        return { ETag: `"${md5(body)}"` };
      }
      if (name === "CompleteMultipartUploadCommand") {
        const upload = uploads.get(input.UploadId);
        if (input.IfNoneMatch === "*" && objects.has(upload.key))
          throw s3Error(412, "PreconditionFailed");
        const body = Buffer.concat(input.MultipartUpload.Parts.map((p) => upload.parts.get(p.PartNumber)));
        store(upload.key, body, upload.contentType, `${md5(body)}-${input.MultipartUpload.Parts.length}`);
        uploads.delete(input.UploadId);
        return {};
      }
      if (name === "AbortMultipartUploadCommand") {
        uploads.delete(input.UploadId);
        return {};
      }
      throw new Error(`Unexpected S3 command ${name}`);
    },
  };
  client.factory = (settings) => {
    client.settings = settings;
    return client;
  };
  return client;
}

const BLOB_ORIGIN = "https://fixture-store.private.blob.vercel-storage.com/";
function fakeBlob(initial = new Map()) {
  const data = new Map(initial);
  return {
    data,
    async list({ cursor }) {
      const entries = [...data.entries()].sort(),
        offset = Number(cursor ?? 0),
        page = entries.slice(offset, offset + 1);
      return {
        blobs: page.map(([pathname, body]) => ({
          pathname,
          size: body.length,
          etag: sha(body),
          url: BLOB_ORIGIN + pathname,
          uploadedAt: new Date(0),
        })),
        hasMore: offset + 1 < entries.length,
        cursor: String(offset + 1),
      };
    },
    async get(pathname) {
      const body = data.get(pathname);
      if (!body) return null;
      return {
        statusCode: 200,
        blob: { size: body.length, etag: sha(body), contentType: "image/png" },
        stream: new ReadableStream({
          start(c) {
            c.enqueue(body);
            c.close();
          },
        }),
      };
    },
  };
}

function seal(text, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), iv);
  const body = Buffer.concat([cipher.update(text), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

const R2_NAMES = {
  accountIdEnv: "FIXTURE_R2_ACCOUNT_ID",
  accessKeyIdEnv: "FIXTURE_R2_ACCESS_KEY_ID",
  secretAccessKeyEnv: "FIXTURE_R2_SECRET_ACCESS_KEY",
  bucketEnv: "FIXTURE_R2_BUCKET",
};
const W = "ws/ws_fixture/";

/** One platform database, one nonlegacy tenant whose rows reference:
 * an old render (Blob era), a new render (R2 era), an upload stored as an
 * absolute Blob URL that the migration copied to R2, an upload stored as an
 * absolute Blob URL that only Blob holds, and one stored as a bare key. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "particl-r2-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    PARTICL_BACKUP_KEY: randomBytes(32).toString("base64"),
    KEYRING_SECRET: randomBytes(32).toString("hex"),
    FIXTURE_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    FIXTURE_R2_ACCESS_KEY_ID: "fixture-access-key-id",
    FIXTURE_R2_SECRET_ACCESS_KEY: "fixture-secret-access-key-value",
    FIXTURE_R2_BUCKET: "fixture-source-bucket",
    FIXTURE_BLOB_TOKEN: "fixture-blob-token-value",
  };
  const platformPath = join(root, "platform.db"),
    tenantPath = join(root, "tenant.db");
  const platform = createClient({ url: pathToFileURL(platformPath).href }),
    tenant = createClient({ url: pathToFileURL(tenantPath).href });
  await platform.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT,db_token_enc TEXT,legacy INTEGER,deleted_at INTEGER,purged_at INTEGER);
    CREATE TABLE p_sessions(id TEXT PRIMARY KEY,account_id TEXT);
    INSERT INTO p_sessions VALUES('old-session','user-a');`);
  await platform.execute({
    sql: "INSERT INTO workspaces VALUES('ws_fixture',?,?,0,NULL,NULL)",
    args: [pathToFileURL(tenantPath).href, seal("fixture-tenant-token", env.KEYRING_SECRET)],
  });
  await tenant.executeMultiple(`CREATE TABLE generations(id TEXT PRIMARY KEY,status TEXT,kind TEXT,stored_url TEXT,deleted INTEGER);
    CREATE TABLE uploads(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT);
    INSERT INTO generations VALUES('old','succeeded','image','${W}generations/old.png',0),
      ('new','succeeded','video','${W}generations/new.mp4',0),
      ('mesh','succeeded','model','${W}generations/mesh.glb',0),
      ('failed','failed','video',NULL,0);
    INSERT INTO uploads VALUES('migrated','png','${BLOB_ORIGIN}${W}uploads/migrated-Ab12.png'),
      ('blobonly','png','${BLOB_ORIGIN}${W}uploads/blobonly-Cd34.png'),
      ('bare','txt','${W}uploads/bare.txt'),
      ('route','pdf','/api/uploads/route');`);
  platform.close();
  tenant.close();
  const bytes = (label) => Buffer.from(`private ${label} bytes`);
  return {
    root,
    env,
    bytes,
    platformPath,
    tenantPath,
    config: (media) => ({
      version: 1,
      label: "r2-fixture",
      quiesced: true,
      databases: [
        { id: "platform", role: "platform", url: pathToFileURL(platformPath).href },
        { id: "tenant", role: "tenant", url: pathToFileURL(tenantPath).href, workspaceIds: ["ws_fixture"] },
      ],
      media,
    }),
  };
}
/** The production split: new objects on R2, old ones on Blob, one migrated. */
function productionStores(f) {
  const r2 = fakeR2(
    new Map([
      [`${W}generations/new.mp4`, f.bytes("new render")],
      [`${W}generations/mesh.glb`, f.bytes("mesh")],
      [`${W}uploads/migrated-Ab12.png`, f.bytes("migrated upload")],
      [`${W}uploads/bare.txt`, f.bytes("bare")],
      [`${W}uploads/route.pdf`, f.bytes("route")],
    ]),
  );
  const blob = fakeBlob(
    new Map([
      [`${W}generations/old.png`, f.bytes("old render")],
      [`${W}uploads/migrated-Ab12.png`, f.bytes("migrated upload")],
      [`${W}uploads/blobonly-Cd34.png`, f.bytes("blob-only upload")],
    ]),
  );
  return { r2, blob };
}
const dual = { kind: "dual", r2: R2_NAMES, blob: { tokenEnv: "FIXTURE_BLOB_TOKEN" } };
const fast = { sleep: async () => {} };

test("r2-only capture paginates, retries a dropped stream, encrypts and restores; report proves coverage", async (t) => {
  const f = await fixture(t);
  const r2 = fakeR2(
    new Map([
      [`${W}generations/old.png`, f.bytes("old render")],
      [`${W}generations/new.mp4`, f.bytes("new render")],
      [`${W}generations/mesh.glb`, f.bytes("mesh")],
      // r2-only: an absolute Blob URL is read from R2 at its decoded pathname.
      [`${W}uploads/migrated-Ab12.png`, f.bytes("migrated upload")],
      [`${W}uploads/blobonly-Cd34.png`, f.bytes("blob-only upload")],
      [`${W}uploads/bare.txt`, f.bytes("bare")],
      [`${W}uploads/route.pdf`, f.bytes("route")],
    ]),
  );
  r2.faults.set(`${W}generations/new.mp4`, 1);
  const config = f.config({ kind: "r2", ...R2_NAMES });
  const bundle = join(f.root, "bundle"),
    restored = join(f.root, "restored");
  const result = await createBackup(config, bundle, { env: f.env, r2Client: r2.factory, retryOptions: fast });
  assert.equal(result.media, 7);
  // Credentials came from the named variables only; the config holds names.
  assert.deepEqual(r2.settings, {
    accountId: f.env.FIXTURE_R2_ACCOUNT_ID,
    accessKeyId: f.env.FIXTURE_R2_ACCESS_KEY_ID,
    secretAccessKey: f.env.FIXTURE_R2_SECRET_ACCESS_KEY,
    bucket: f.env.FIXTURE_R2_BUCKET,
    endpoint: `https://${f.env.FIXTURE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });
  assert.equal(JSON.stringify(config).includes(f.env.FIXTURE_R2_SECRET_ACCESS_KEY), false);
  assert.ok(r2.destroyed >= 1);
  // Paged one key at a time, twice (before and after), and the dropped read was retried.
  assert.equal(r2.calls.filter(([n]) => n === "ListObjectsV2Command").length, 14);
  assert.equal(r2.calls.filter(([n, k]) => n === "GetObjectCommand" && k === `${W}generations/new.mp4`).length, 2);
  for (const file of await readdir(bundle)) {
    const raw = await readFile(join(bundle, file));
    for (const plain of ["private new render bytes", f.env.FIXTURE_R2_SECRET_ACCESS_KEY, f.env.KEYRING_SECRET])
      assert.equal(raw.includes(Buffer.from(plain)), false);
  }
  assert.deepEqual(await restoreBackup(bundle, restored, { env: f.env }), {
    databases: 2,
    media: 7,
    mediaKind: "r2",
    mediaByStore: { r2: 7 },
    sealedValues: 1,
    verified: true,
  });
  assert.deepEqual(await readFile(join(restored, "media", W, "generations", "new.mp4")), f.bytes("new render"));
  const report = await recoveryReport(restored);
  assert.deepEqual(report.media, { kind: "r2", verified: true, references: 7, byStore: { r2: 7 }, objects: 7 });
  // The report checks the restored files themselves.
  await rm(join(restored, "media", W, "uploads", "bare.txt"));
  await rm(join(restored, "reconciliation-report.json"));
  await assert.rejects(recoveryReport(restored), /missing or changed in the offline directory \(1\): tenant\/uploads\/bare$/);
});

test("dual capture covers R2 and Blob together by the app's R2-first rule and restores both trees offline", async (t) => {
  const f = await fixture(t),
    { r2, blob } = productionStores(f);
  const bundle = join(f.root, "bundle"),
    restored = join(f.root, "restored");
  const result = await createBackup(f.config(dual), bundle, {
    env: f.env,
    r2Client: r2.factory,
    blobSdk: blob,
    retryOptions: fast,
  });
  assert.equal(result.media, 8); // 5 on R2 + 3 on Blob, the migrated copy in both
  await restoreBackup(bundle, restored, { env: f.env });
  assert.deepEqual(await readFile(join(restored, "media", "r2", W, "uploads", "migrated-Ab12.png")), f.bytes("migrated upload"));
  assert.deepEqual(await readFile(join(restored, "media", "blob", W, "uploads", "migrated-Ab12.png")), f.bytes("migrated upload"));
  assert.deepEqual(await readFile(join(restored, "media", "blob", W, "generations", "old.png")), f.bytes("old render"));
  const report = await recoveryReport(restored);
  // old.png and the Blob-only upload resolve on Blob; the migrated upload resolves on R2 first.
  assert.deepEqual(report.media, { kind: "dual", verified: true, references: 7, byStore: { blob: 2, r2: 5 }, objects: 8 });
  const inventory = JSON.parse(await readFile(join(restored, "inventory.json"), "utf8"));
  assert.equal(inventory.mediaKind, "dual");
  assert.deepEqual(inventory.mediaCoverage, { blob: 2, r2: 5 });
  assert.equal(JSON.stringify(inventory).includes(f.env.FIXTURE_BLOB_TOKEN), false);
  assert.equal(JSON.stringify(inventory).includes(f.env.FIXTURE_R2_SECRET_ACCESS_KEY), false);
});

test("a dual bundle with old Blob media goes to the private bucket and comes back restorable", async (t) => {
  const f = await fixture(t),
    { r2, blob } = productionStores(f);
  const bundle = join(f.root, "bundle");
  await createBackup(f.config(dual), bundle, { env: f.env, r2Client: r2.factory, blobSdk: blob, retryOptions: fast });
  const verified = await restoreBackup(bundle, join(f.root, "verification"), { env: f.env });
  // The counts the workflow summary and upload index report: Blob media is in.
  assert.equal(verified.mediaKind, "dual");
  assert.deepEqual(verified.mediaByStore, { r2: 5, blob: 3 });
  const target = fakeR2();
  target.settings = { bucket: "particl-backups" };
  const targetEnv = {
    BACKUP_TARGET_R2_ACCOUNT_ID: "fixtureaccount",
    BACKUP_TARGET_R2_ACCESS_KEY_ID: "fixture-target-key-id",
    BACKUP_TARGET_R2_SECRET_ACCESS_KEY: "fixture-target-secret",
    BACKUP_TARGET_R2_BUCKET: "particl-backups",
  };
  const summary = { verified: true, databases: verified.databases, media: verified.media, mediaKind: verified.mediaKind, mediaByStore: verified.mediaByStore };
  const uploaded = await uploadBundle(bundle, { env: targetEnv, client: target, runId: "123", summary, retryOptions: fast });
  // Only ciphertext reached the bucket: no media bytes, keyring or source credential.
  for (const [key, object] of target.objects) {
    assert.ok(key.startsWith(uploaded.prefix));
    for (const plain of ["private old render bytes", f.env.KEYRING_SECRET, f.env.FIXTURE_BLOB_TOKEN, f.env.FIXTURE_R2_SECRET_ACCESS_KEY])
      assert.equal(object.body.includes(Buffer.from(plain)), false);
  }
  const copy = join(f.root, "downloaded");
  assert.deepEqual((await downloadBundle(uploaded.prefix, copy, { env: targetEnv, client: target, retryOptions: fast })).summary, summary);
  const restored = join(f.root, "restored");
  await restoreBackup(copy, restored, { env: f.env });
  assert.deepEqual(await readFile(join(restored, "media", "blob", W, "generations", "old.png")), f.bytes("old render"));
  assert.deepEqual((await recoveryReport(restored)).media.byStore, { blob: 2, r2: 5 });
});

test("missing objects fail coverage naming each row, never a customer's file name; r2-only does not fall back to Blob", async (t) => {
  const f = await fixture(t),
    { r2, blob } = productionStores(f);
  r2.objects.delete(`${W}generations/new.mp4`);
  blob.data.delete(`${W}uploads/blobonly-Cd34.png`);
  // A browser-direct upload keeps the customer's own file name in its URL.
  const tenant = createClient({ url: pathToFileURL(f.tenantPath).href });
  await tenant.execute({
    sql: "INSERT INTO uploads VALUES('named','pdf',?)",
    args: [`${BLOB_ORIGIN}${W}uploads/Acme%20Merger%20Contract%20FINAL-Zz99.pdf`],
  });
  tenant.close();
  await assert.rejects(
    createBackup(f.config(dual), join(f.root, "missing"), { env: f.env, r2Client: r2.factory, blobSdk: blob, retryOptions: fast }),
    (error) => {
      assert.match(
        error.message,
        /referenced by a database is missing from the storage inventory \(3\): tenant\/generations\/new, tenant\/uploads\/blobonly, tenant\/uploads\/named$/,
      );
      for (const leak of ["Acme", "Merger", "Contract", "%20", "blobonly-Cd34", "ws/ws_fixture", "vercel-storage.com", ".png", ".pdf"])
        assert.equal(error.message.includes(leak), false, leak);
      return true;
    },
  );
  // The old render exists only on Blob: an R2-only capture is incomplete.
  const { r2: onlyR2 } = productionStores(f);
  await assert.rejects(
    createBackup(f.config({ kind: "r2", ...R2_NAMES }), join(f.root, "r2-only"), { env: f.env, r2Client: onlyR2.factory, retryOptions: fast }),
    /missing from the storage inventory \(3\): tenant\/generations\/old, tenant\/uploads\/blobonly, tenant\/uploads\/named$/,
  );
  await assert.rejects(readdir(join(f.root, "missing")), { code: "ENOENT" });
});

test("an object replaced after inventory, or bytes that contradict the ETag, never produce an archive", async (t) => {
  const f = await fixture(t);
  {
    const { r2, blob } = productionStores(f);
    const send = r2.send;
    r2.send = async (command) => {
      if (command.constructor.name === "GetObjectCommand" && command.input.Key === `${W}uploads/bare.txt`)
        r2.store(`${W}uploads/bare.txt`, Buffer.from("replaced bytes!"));
      return send(command);
    };
    await assert.rejects(
      createBackup(f.config(dual), join(f.root, "replaced"), { env: f.env, r2Client: r2.factory, blobSdk: blob, retryOptions: fast }),
      /R2 object changed or disappeared/,
    );
  }
  {
    const { r2, blob } = productionStores(f);
    const corrupt = r2.objects.get(`${W}uploads/bare.txt`);
    corrupt.body = Buffer.from("private BARE bytes"); // same length, listed ETag no longer matches
    await assert.rejects(
      createBackup(f.config(dual), join(f.root, "corrupt"), { env: f.env, r2Client: r2.factory, blobSdk: blob, retryOptions: fast }),
      /do not match its ETag/,
    );
  }
  await assert.rejects(readdir(join(f.root, "replaced")), { code: "ENOENT" });
  await assert.rejects(readdir(join(f.root, "corrupt")), { code: "ENOENT" });
});

test("R2 configuration takes environment variable names only and an https origin", async (t) => {
  const f = await fixture(t);
  assert.throws(() => r2Settings({ ...R2_NAMES, secretAccessKey: "inline" }, f.env), /named environment variables/);
  assert.throws(() => r2Settings({ ...R2_NAMES, bucketEnv: "lowercase" }, f.env), /bucketEnv/);
  assert.throws(() => r2Settings({ ...R2_NAMES, endpointEnv: "FIXTURE_R2_ENDPOINT" }, f.env), /missing/);
  for (const endpoint of ["http://insecure.example.invalid", "https://user:pass@host.example.invalid", "https://host.example.invalid/path"])
    assert.throws(() => r2Settings({ ...R2_NAMES, endpointEnv: "FIXTURE_R2_ENDPOINT" }, { ...f.env, FIXTURE_R2_ENDPOINT: endpoint }), /bare https origin/);
  assert.equal(
    r2Settings({ ...R2_NAMES, endpointEnv: "FIXTURE_R2_ENDPOINT" }, { ...f.env, FIXTURE_R2_ENDPOINT: "https://rehearsal.example.invalid/" }).endpoint,
    "https://rehearsal.example.invalid",
  );
  const { r2, blob } = productionStores(f);
  await assert.rejects(
    createBackup(f.config({ kind: "dual", r2: R2_NAMES, blob: { token: "inline" } }), join(f.root, "inline"), { env: f.env, r2Client: r2.factory, blobSdk: blob }),
    /tokenEnv/,
  );
  for (const inline of [{ secretAccessKey: "inline" }, { token: "inline" }, { bucketEnv: "FIXTURE_R2_BUCKET" }])
    await assert.rejects(
      createBackup(f.config({ ...dual, ...inline }), join(f.root, "top-level"), { env: f.env, r2Client: r2.factory, blobSdk: blob }),
      /under r2 and blob, never values/,
    );
  await assert.rejects(
    createBackup(f.config(dual), join(f.root, "absent"), { env: { ...f.env, FIXTURE_R2_SECRET_ACCESS_KEY: "" }, r2Client: r2.factory, blobSdk: blob }),
    /secret environment variable is missing/,
  );
  assert.equal(r2.settings, null); // refused before any client was built
});

test("restore round trip: dual archive into an empty R2 bucket, then prepare points media at R2 or at local disk", async (t) => {
  const f = await fixture(t),
    { r2, blob } = productionStores(f);
  const bundle = join(f.root, "bundle"),
    restored = join(f.root, "restored");
  await createBackup(f.config(dual), bundle, { env: f.env, r2Client: r2.factory, blobSdk: blob, retryOptions: fast });
  await restoreBackup(bundle, restored, { env: f.env });
  const targetEnv = { ...f.env, FIXTURE_R2_BUCKET: "fixture-restore-bucket" };
  const target = fakeR2();
  await assert.rejects(restoreR2(restored, R2_NAMES, { env: targetEnv, r2Client: target.factory }), /Confirm a dedicated empty/);
  const occupied = fakeR2(new Map([["already-here", Buffer.from("x")]]));
  await assert.rejects(
    restoreR2(restored, { ...R2_NAMES, confirmEmptyBucket: true }, { env: targetEnv, r2Client: occupied.factory }),
    /not empty/,
  );
  // A tiny part size sends the larger objects through the multipart path.
  assert.deepEqual(
    await restoreR2(restored, { ...R2_NAMES, confirmEmptyBucket: true }, { env: targetEnv, r2Client: target.factory, singleMax: 16, partSize: 8, retryOptions: fast }),
    { verified: true, media: 7, shadowedBlobCopies: 1 },
  );
  assert.equal(target.settings.bucket, "fixture-restore-bucket");
  assert.deepEqual(
    [...target.objects.keys()].sort(),
    [
      `${W}generations/mesh.glb`,
      `${W}generations/new.mp4`,
      `${W}generations/old.png`,
      `${W}uploads/bare.txt`,
      `${W}uploads/blobonly-Cd34.png`,
      `${W}uploads/migrated-Ab12.png`,
      `${W}uploads/route.pdf`,
    ],
  );
  assert.deepEqual(target.objects.get(`${W}generations/old.png`).body, f.bytes("old render"));
  assert.ok(target.calls.some(([n]) => n === "UploadPartCommand"));
  await assert.rejects(
    restoreR2(restored, { ...R2_NAMES, confirmEmptyBucket: true }, { env: targetEnv, r2Client: target.factory }),
    /not empty/,
  );

  const mapping = (media) => ({
    invalidateAccess: true,
    media,
    databases: [
      { id: "platform", dbName: "fixture-platform" },
      { id: "tenant", url: pathToFileURL(join(f.root, `new-tenant-${media.kind}.db`)).href },
    ],
  });
  const rows = async (dir) => {
    const db = createClient({ url: pathToFileURL(join(dir, "tenant.db")).href });
    try {
      return Object.fromEntries((await db.execute("SELECT id,stored_url FROM uploads")).rows.map((r) => [r.id, r.stored_url]));
    } finally {
      db.close();
    }
  };
  const toR2 = join(f.root, "prepared-r2");
  await prepareRestore(restored, mapping({ kind: "r2" }), toR2, { env: f.env });
  assert.deepEqual(await rows(toR2), {
    migrated: `${W}uploads/migrated-Ab12.png`,
    blobonly: `${W}uploads/blobonly-Cd34.png`,
    bare: `${W}uploads/bare.txt`,
    route: "/api/uploads/route",
  });
  const prepared = JSON.parse(await readFile(join(toR2, "preparation.json"), "utf8"));
  assert.deepEqual(prepared.media, { target: "r2", localObjects: 0, rewritten: 2 });
  // invalidateAccess still revokes restored sessions.
  assert.ok(prepared.changes.some((c) => c.table === "p_sessions" && c.action === "revoked-restored-access"));

  const toLocal = join(f.root, "prepared-local");
  await prepareRestore(restored, mapping({ kind: "local" }), toLocal, { env: f.env });
  assert.deepEqual(await rows(toLocal), {
    migrated: `${W}uploads/migrated.png`,
    blobonly: `${W}uploads/blobonly.png`,
    bare: `${W}uploads/bare.txt`,
    route: "/api/uploads/route",
  });
  // The app's local layout: .data/generations/<id>.<ext>, .data/uploads/<id>.<ext>.
  assert.deepEqual(await readFile(join(toLocal, "local-media", "generations", "old.png")), f.bytes("old render"));
  assert.deepEqual(await readFile(join(toLocal, "local-media", "generations", "mesh.glb")), f.bytes("mesh"));
  assert.deepEqual(await readFile(join(toLocal, "local-media", "uploads", "migrated.png")), f.bytes("migrated upload"));
  assert.deepEqual(await readFile(join(toLocal, "local-media", "uploads", "blobonly.png")), f.bytes("blob-only upload"));
  assert.equal((await readdir(join(toLocal, "local-media", "uploads"))).length, 4);

  // Prepare for R2 refuses without a verified restore record.
  const bare = join(f.root, "restored-again");
  await restoreBackup(bundle, bare, { env: f.env });
  await assert.rejects(prepareRestore(bare, mapping({ kind: "r2" }), join(f.root, "no-record"), { env: f.env }), /run restore-r2 first/);
});
