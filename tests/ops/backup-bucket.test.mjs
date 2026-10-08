import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  FRESHNESS_MS,
  UPLOAD_INDEX,
  bucketFreshness,
  bundlePrefix,
  downloadBundle,
  targetSettings,
  uploadBundle,
  uploadSummary,
} from "../../scripts/ops/backup-automation.mjs";

// Everything here is in-process: an S3-compatible fake behind the real
// @aws-sdk/client-s3 command classes. No request leaves the process.

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
const at = Date.parse("2026-10-08T20:45:00Z");
const env = {
  BACKUP_TARGET_R2_ACCOUNT_ID: "fixtureaccount",
  BACKUP_TARGET_R2_ACCESS_KEY_ID: "fixture-key-id",
  BACKUP_TARGET_R2_SECRET_ACCESS_KEY: "fixture-secret",
  BACKUP_TARGET_R2_BUCKET: "particl-backups",
};
const retryOptions = { attempts: 3, baseMs: 0, sleep: async () => {} };

/** S3 fake: ListObjectsV2 (Prefix, Delimiter, paged), Get, Put (If-None-Match),
 * multipart. `corrupt` = keys whose stored bytes get flipped on write;
 * `clock` sets LastModified. */
function fakeBucket({ pageSize = 2 } = {}) {
  const objects = new Map(),
    calls = [],
    corrupt = new Set(),
    uploads = new Map();
  const bucket = {
    objects,
    calls,
    corrupt,
    clock: () => at,
    destroyed: 0,
    destroy() {
      bucket.destroyed++;
    },
    put(key, body, etag = md5(body)) {
      if (corrupt.has(key)) body = Buffer.concat([body.subarray(0, -1), Buffer.from([body.at(-1) ^ 1])]);
      objects.set(key, { body, etag, modified: new Date(bucket.clock()) });
    },
    async send(command) {
      const name = command.constructor.name,
        input = command.input;
      calls.push([name, input.Key ?? input.Prefix ?? null, input.IfNoneMatch ?? null]);
      assert.equal(input.Bucket, "particl-backups");
      if (name === "ListObjectsV2Command") {
        const prefix = input.Prefix ?? "",
          entries = [];
        const seen = new Set();
        for (const key of [...objects.keys()].sort()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const cut = input.Delimiter ? rest.indexOf(input.Delimiter) : -1;
          if (cut >= 0) {
            const common = prefix + rest.slice(0, cut + 1);
            if (!seen.has(common)) entries.push({ common }), seen.add(common);
          } else entries.push({ key });
        }
        const offset = Number(input.ContinuationToken ?? 0),
          page = entries.slice(offset, offset + pageSize),
          more = offset + pageSize < entries.length;
        return {
          Contents: page.filter((e) => e.key).map(({ key }) => ({
            Key: key,
            Size: objects.get(key).body.length,
            ETag: `"${objects.get(key).etag}"`,
            LastModified: objects.get(key).modified,
          })),
          CommonPrefixes: page.filter((e) => e.common).map(({ common }) => ({ Prefix: common })),
          IsTruncated: more,
          ...(more ? { NextContinuationToken: String(offset + pageSize) } : {}),
        };
      }
      if (name === "GetObjectCommand") {
        const object = objects.get(input.Key);
        if (!object) throw s3Error(404, "NoSuchKey");
        return {
          Body: Readable.from([object.body]),
          ContentLength: object.body.length,
          ETag: `"${object.etag}"`,
          LastModified: object.modified,
        };
      }
      if (name === "PutObjectCommand") {
        if (input.IfNoneMatch === "*" && objects.has(input.Key)) throw s3Error(412, "PreconditionFailed");
        const body = await collect(input.Body);
        assert.equal(body.length, input.ContentLength);
        bucket.put(input.Key, body);
        return { ETag: `"${md5(body)}"` };
      }
      if (name === "CreateMultipartUploadCommand") {
        const id = `upload-${uploads.size}`;
        uploads.set(id, { key: input.Key, parts: new Map() });
        return { UploadId: id };
      }
      if (name === "UploadPartCommand") {
        const body = await collect(input.Body);
        uploads.get(input.UploadId).parts.set(input.PartNumber, body);
        return { ETag: `"${md5(body)}"` };
      }
      if (name === "CompleteMultipartUploadCommand") {
        const upload = uploads.get(input.UploadId);
        if (input.IfNoneMatch === "*" && objects.has(upload.key)) throw s3Error(412, "PreconditionFailed");
        const body = Buffer.concat(input.MultipartUpload.Parts.map((p) => upload.parts.get(p.PartNumber)));
        bucket.put(upload.key, body, `${md5(body)}-${input.MultipartUpload.Parts.length}`);
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
  return bucket;
}

async function fixtureBundle(root, name = "bundle", extra = {}) {
  const dir = join(root, name);
  await mkdir(dir);
  const files = {
    "header.json": Buffer.from(JSON.stringify({ format: "particl-backup-v1", manifest: { bytes: 9 } })),
    "manifest.enc": Buffer.from("manifest-ciphertext"),
    "00000000.enc": Buffer.from("database-ciphertext"),
    "00000001.enc": Buffer.alloc(300, 7),
    ...extra,
  };
  for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body);
  return { dir, files };
}
const summary = { verified: true, databases: 2, media: 5, mediaKind: "dual", mediaByStore: { r2: 3, blob: 2 } };

test("bundle prefixes sort by UTC capture time and carry the run id", () => {
  assert.equal(bundlePrefix(at, 18234567890), "bundles/20261008T204500Z-18234567890/");
  assert.equal(bundlePrefix(at, "manual"), "bundles/20261008T204500Z-manual/");
  assert.throws(() => bundlePrefix(at, "../x"), /run ID/);
  assert.throws(() => bundlePrefix(at, undefined), /run ID/);
});

test("bucket credentials come only from the named variables; the endpoint is optional", async () => {
  const settings = await targetSettings(env);
  assert.equal(settings.bucket, "particl-backups");
  assert.equal(settings.endpoint, "https://fixtureaccount.r2.cloudflarestorage.com");
  assert.equal(
    (await targetSettings({ ...env, BACKUP_TARGET_R2_ENDPOINT: "https://fixtureaccount.eu.r2.cloudflarestorage.com/" })).endpoint,
    "https://fixtureaccount.eu.r2.cloudflarestorage.com",
  );
  for (const name of Object.keys(env)) {
    const partial = { ...env };
    delete partial[name];
    await assert.rejects(targetSettings(partial), /missing/);
  }
});

test("upload writes every file with If-None-Match, checks each by SHA-256 read-back, then writes the index last", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-bucket-upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dir, files } = await fixtureBundle(root);
  const bucket = fakeBucket();
  const result = await uploadBundle(dir, { env, client: bucket, now: () => at, runId: "4242", summary: JSON.stringify(summary), retryOptions, singleMax: 100, partSize: 64 });
  const prefix = "bundles/20261008T204500Z-4242/";
  assert.deepEqual(result, { uploaded: true, prefix, files: 4, bytes: Object.values(files).reduce((n, b) => n + b.length, 0), summary });
  for (const [name, body] of Object.entries(files)) assert.deepEqual(bucket.objects.get(prefix + name).body, body);
  // Every write is conditional; the 300-byte object went multipart (complete is conditional too).
  const writes = bucket.calls.filter(([name]) => name === "PutObjectCommand" || name === "CompleteMultipartUploadCommand");
  assert.equal(writes.length, 5);
  assert.ok(writes.every(([, , condition]) => condition === "*"));
  assert.ok(bucket.calls.some(([name, key]) => name === "UploadPartCommand" && key === prefix + "00000001.enc"));
  // Read back after each write; the index is the last write of all.
  for (const name of Object.keys(files)) assert.ok(bucket.calls.some(([call, key]) => call === "GetObjectCommand" && key === prefix + name));
  assert.equal(writes.at(-1)[1], prefix + UPLOAD_INDEX);
  const index = JSON.parse(bucket.objects.get(prefix + UPLOAD_INDEX).body);
  assert.equal(index.format, "particl-backup-upload-v1");
  assert.deepEqual(index.summary, summary);
  assert.deepEqual(
    index.files,
    Object.keys(files).sort().map((name) => ({ name, bytes: files[name].length, sha256: sha(files[name]) })),
  );
  assert.equal(bucket.destroyed, 0, "an injected client is the caller's to close");
});

test("an object that does not read back identically fails the upload and writes no index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-bucket-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dir } = await fixtureBundle(root);
  for (const singleMax of [1000, 100]) {
    const bucket = fakeBucket();
    bucket.corrupt.add("bundles/20261008T204500Z-7/00000001.enc");
    await assert.rejects(
      uploadBundle(dir, { env, client: bucket, now: () => at, runId: 7, retryOptions, singleMax, partSize: 64 }),
      /did not match its SHA-256/,
    );
    assert.equal([...bucket.objects.keys()].filter((k) => k.endsWith(UPLOAD_INDEX)).length, 0);
    await assert.rejects(bucketFreshness({ env, client: bucket, now: at, retryOptions }), /No complete/);
  }
});

test("upload never overwrites: an occupied prefix or an existing key is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-bucket-overwrite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dir } = await fixtureBundle(root);
  const prefix = "bundles/20261008T204500Z-9/";
  // Prefix already holds something: nothing is written at all.
  const occupied = fakeBucket();
  occupied.put(prefix + "00000000.enc", Buffer.from("earlier"));
  await assert.rejects(
    uploadBundle(dir, { env, client: occupied, now: () => at, runId: 9, retryOptions }),
    /already holds this bundle prefix/,
  );
  assert.deepEqual([...occupied.objects.keys()], [prefix + "00000000.enc"]);
  assert.deepEqual(occupied.objects.get(prefix + "00000000.enc").body, Buffer.from("earlier"));
  assert.ok(!occupied.calls.some(([name]) => name === "PutObjectCommand"));
  // A key that appears between the listing and the write: the conditional write refuses it.
  const raced = fakeBucket();
  const send = raced.send.bind(raced);
  raced.send = async (command) => {
    if (command.constructor.name === "PutObjectCommand" && command.input.Key === prefix + "header.json")
      raced.put(prefix + "header.json", Buffer.from("someone else"));
    return send(command);
  };
  await assert.rejects(
    uploadBundle(dir, { env, client: raced, now: () => at, runId: 9, retryOptions }),
    /already holds this key. No existing object will be overwritten/,
  );
  assert.deepEqual(raced.objects.get(prefix + "header.json").body, Buffer.from("someone else"));
  assert.ok(![...raced.objects.keys()].some((k) => k.endsWith(UPLOAD_INDEX)));
});

test("only a real encrypted bundle with verified counts is uploaded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-bucket-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bucket = fakeBucket();
  const stray = await fixtureBundle(root, "stray", { "recovery-secrets.json": Buffer.from("{}") });
  await assert.rejects(uploadBundle(stray.dir, { env, client: bucket, now: () => at, runId: 1, retryOptions }), /unexpected entry/);
  const plain = await fixtureBundle(root, "plain", { "header.json": Buffer.from("{}") });
  await assert.rejects(uploadBundle(plain.dir, { env, client: bucket, now: () => at, runId: 1, retryOptions }), /not an encrypted/);
  const good = await fixtureBundle(root, "good");
  await assert.rejects(
    uploadBundle(good.dir, { env, client: bucket, now: () => at, runId: 1, summary: { ...summary, label: "x", media: "5" }, retryOptions }),
    /verified counts/,
  );
  assert.throws(() => uploadSummary({ ...summary, mediaByStore: { "https://x": 1 } }), /verified counts/);
  assert.equal(bucket.objects.size, 0);
});

test("freshness reads the newest complete bundle from the bucket, skipping unfinished uploads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-bucket-fresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dir } = await fixtureBundle(root);
  const bucket = fakeBucket({ pageSize: 1 });
  await assert.rejects(bucketFreshness({ env, client: bucket, now: at, retryOptions }), /No complete/);
  await uploadBundle(dir, { env, client: bucket, now: () => at - 3600_000, runId: 1, summary, retryOptions });
  bucket.clock = () => at;
  await uploadBundle(dir, { env, client: bucket, now: () => at, runId: 2, summary, retryOptions });
  // A later, unfinished upload (no index) and an unrelated key are ignored.
  bucket.put("bundles/20261008T230000Z-3/00000000.enc", Buffer.from("partial"));
  bucket.put("notes/readme.txt", Buffer.from("x"));
  const fresh = await bucketFreshness({ env, client: bucket, now: at + 3600_000, retryOptions });
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.prefix, "bundles/20261008T204500Z-2/");
  assert.equal(fresh.ageHours, 1);
  assert.equal(fresh.incompleteNewer, 1);
  assert.deepEqual(fresh.summary, summary);
  await assert.rejects(bucketFreshness({ env, client: bucket, now: at + FRESHNESS_MS + 1, retryOptions }), /older than 26 hours/);
  // A complete bundle that lost an object is not counted as a backup.
  bucket.objects.delete("bundles/20261008T204500Z-2/00000000.enc");
  await assert.rejects(bucketFreshness({ env, client: bucket, now: at, retryOptions }), /missing objects/);
});

test("download fetches a complete bundle into a new directory and refuses a changed object", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-bucket-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dir, files } = await fixtureBundle(root);
  const bucket = fakeBucket();
  const { prefix } = await uploadBundle(dir, { env, client: bucket, now: () => at, runId: 5, summary, retryOptions });
  const got = await downloadBundle("latest", join(root, "copy"), { env, client: bucket, retryOptions });
  assert.equal(got.prefix, prefix);
  for (const [name, body] of Object.entries(files)) assert.deepEqual(await readFile(join(root, "copy", name)), body);
  assert.equal((await stat(join(root, "copy"))).mode & 0o777, 0o700);
  await assert.rejects(downloadBundle(prefix, join(root, "copy"), { env, client: bucket, retryOptions }), /already exists/);
  await assert.rejects(downloadBundle("bundles/../x/", join(root, "other"), { env, client: bucket, retryOptions }), /Name a bundle/);
  bucket.objects.get(prefix + "manifest.enc").body = Buffer.from("manifest-ciphertexT");
  await assert.rejects(downloadBundle(prefix, join(root, "bad"), { env, client: bucket, retryOptions }), /did not match/);
  await assert.rejects(stat(join(root, "bad")), { code: "ENOENT" });
});
