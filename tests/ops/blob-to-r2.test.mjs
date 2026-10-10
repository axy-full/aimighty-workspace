import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  PROGRESS_FILE,
  copyBlobToR2,
  liveSourceInventory,
  livePlatformSpec,
  loadProgress,
  parseArguments,
  privateDirectory,
  targetKeys,
  verifyR2Only,
  writeReport,
} from "../../scripts/ops/blob-to-r2.mjs";

// In-process only: an S3-compatible fake behind the real @aws-sdk/client-s3
// command classes and an in-memory Blob SDK fake. No request leaves the process.

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const s3Error = (status, name) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const MiB = 1024 * 1024;
const PART = 5 * MiB;
const fast = { sleep: async () => {} };
const BLOB_ORIGIN = "https://fixture-store.private.blob.vercel-storage.com/";
const W = "ws/ws_fixture/";
const ENV = {
  BLOB_READ_WRITE_TOKEN: "fixture-blob-token-value",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "fixture-access-key-id",
  R2_SECRET_ACCESS_KEY: "fixture-secret-access-key-value",
  R2_BUCKET: "fixture-bucket",
};

async function collect(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** S3-compatible fake. faults: Map of "<Command>:<key>" -> list of statuses to throw first.
 * beforePut(key) runs before a PutObject/Complete is decided (to simulate a racing writer). */
function fakeR2(initial = new Map()) {
  const objects = new Map(),
    calls = [],
    faults = new Map(),
    uploads = new Map();
  const store = (key, body, contentType = "application/octet-stream", etag = md5(body), cacheControl) =>
    objects.set(key, { body, etag, contentType, cacheControl });
  for (const [key, body] of initial) store(key, body);
  const client = {
    objects,
    calls,
    faults,
    store,
    beforePut: () => {},
    destroy() {},
    async send(command) {
      const name = command.constructor.name,
        input = command.input;
      calls.push({ name, key: input.Key ?? null, ifNoneMatch: input.IfNoneMatch });
      assert.equal(input.Bucket, ENV.R2_BUCKET);
      const queued = faults.get(`${name}:${input.Key}`);
      if (queued?.length) throw s3Error(queued.shift(), "InjectedFault");
      if (name === "ListObjectsV2Command") {
        const keys = [...objects.keys()].sort(),
          offset = Number(input.ContinuationToken ?? 0),
          page = keys.slice(offset, offset + 2),
          more = offset + 2 < keys.length;
        return {
          Contents: page.map((Key) => ({ Key, Size: objects.get(Key).body.length, ETag: `"${objects.get(Key).etag}"` })),
          IsTruncated: more,
          ...(more ? { NextContinuationToken: String(offset + 2) } : {}),
        };
      }
      if (name === "GetObjectCommand") {
        const object = objects.get(input.Key);
        if (!object) throw s3Error(404, "NoSuchKey");
        return { Body: Readable.from([object.body]), ContentLength: object.body.length, ETag: `"${object.etag}"`, $metadata: { httpStatusCode: 200 } };
      }
      if (name === "PutObjectCommand") {
        client.beforePut(input.Key);
        if (input.IfNoneMatch === "*" && objects.has(input.Key)) throw s3Error(412, "PreconditionFailed");
        const body = await collect(input.Body);
        assert.equal(body.length, input.ContentLength);
        store(input.Key, body, input.ContentType, md5(body), input.CacheControl);
        return { ETag: `"${md5(body)}"` };
      }
      if (name === "CreateMultipartUploadCommand") {
        const id = `upload-${uploads.size}-${calls.length}`;
        uploads.set(id, { key: input.Key, parts: new Map(), contentType: input.ContentType, cacheControl: input.CacheControl });
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
        client.beforePut(upload.key);
        if (input.IfNoneMatch === "*" && objects.has(upload.key)) throw s3Error(412, "PreconditionFailed");
        const body = Buffer.concat(input.MultipartUpload.Parts.map((p) => upload.parts.get(p.PartNumber)));
        store(upload.key, body, upload.contentType, `${md5(body)}-${input.MultipartUpload.Parts.length}`, upload.cacheControl);
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
    assert.equal(settings.secretAccessKey, ENV.R2_SECRET_ACCESS_KEY);
    return client;
  };
  return client;
}

/** Blob SDK fake: objects keyed by pathname; `urls` overrides an object's URL;
 * `drops` makes the next N reads of a pathname break mid-stream. */
function fakeBlob(initial = new Map(), urls = new Map()) {
  const data = new Map(initial),
    drops = new Map(),
    reads = [];
  const urlOf = (pathname) => urls.get(pathname) ?? BLOB_ORIGIN + pathname.split("/").map(encodeURIComponent).join("/");
  return {
    data,
    drops,
    reads,
    async list({ cursor, token }) {
      assert.equal(token, ENV.BLOB_READ_WRITE_TOKEN);
      const entries = [...data.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        offset = Number(cursor ?? 0),
        page = entries.slice(offset, offset + 2);
      return {
        blobs: page.map(([pathname, body]) => ({ pathname, size: body.length, etag: `"blob-${sha(body)}"`, url: urlOf(pathname), uploadedAt: new Date(0) })),
        hasMore: offset + 2 < entries.length,
        cursor: String(offset + 2),
      };
    },
    async get(url, options) {
      assert.equal(options.access, "private");
      const pathname = [...data.keys()].find((p) => urlOf(p) === url);
      reads.push(pathname);
      const body = data.get(pathname);
      if (!body) return null;
      const dropping = drops.get(pathname) > 0;
      if (dropping) drops.set(pathname, drops.get(pathname) - 1);
      return {
        statusCode: 200,
        blob: { size: body.length, etag: `"blob-${sha(body)}"`, contentType: "image/png" },
        stream: new ReadableStream({
          start(controller) {
            if (dropping) {
              controller.enqueue(body.subarray(0, 3));
              controller.error(new Error("socket hang up"));
              return;
            }
            for (let i = 0; i < body.length; i += MiB) controller.enqueue(body.subarray(i, i + MiB));
            controller.close();
          },
        }),
      };
    },
  };
}

async function privateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "particl-blob-to-r2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const bytes = (label, size) => (size ? Buffer.alloc(size, label) : Buffer.from(`private ${label} bytes`));
const run = (dir, blob, r2, extra = {}) =>
  copyBlobToR2({ privateDir: dir, env: ENV, blobSdk: blob, r2Client: r2.factory, retryOptions: fast, partSize: PART, apply: true, ...extra });
const writes = (r2) => r2.calls.filter((c) => ["PutObjectCommand", "CreateMultipartUploadCommand", "UploadPartCommand", "CompleteMultipartUploadCommand"].includes(c.name));
const progressLines = async (dir) => (await readFile(join(dir, PROGRESS_FILE), "utf8")).trim().split("\n").map((l) => JSON.parse(l));

test("targetKeys follows the app's resolver: the pathname, plus the decoded URL path when it differs", () => {
  assert.deepEqual(targetKeys({ pathname: `${W}uploads/a b.png`, url: `${BLOB_ORIGIN}${W}uploads/a%20b.png` }), [`${W}uploads/a b.png`]);
  assert.deepEqual(targetKeys({ pathname: `${W}uploads/a b.png`, url: `${BLOB_ORIGIN}${W}uploads/a+b.png` }), [
    `${W}uploads/a b.png`,
    `${W}uploads/a+b.png`,
  ]);
  assert.throws(() => targetKeys({ pathname: "x", url: "https://elsewhere.example/x" }), /UNMAPPABLE_URL/);
  assert.throws(() => targetKeys({ pathname: "x", url: `${BLOB_ORIGIN}%E0%A4%A` }), /UNMAPPABLE_URL/);
  assert.throws(() => targetKeys({ pathname: "../x" }), /Unsafe/);
});

test("copy: every object lands at its resolver key, single and multipart, conditional, verified, recorded; output holds no names", async (t) => {
  const dir = await privateRoot(t);
  const big = bytes("m", 11 * MiB + 7);
  const blob = fakeBlob(
    new Map([
      [`${W}generations/old.png`, bytes("old render")],
      [`${W}uploads/Acme Merger Contract-Zz99.pdf`, bytes("named upload")],
      [`${W}uploads/plus name.png`, bytes("aliased")],
      [`${W}generations/master.mp4`, big],
    ]),
    new Map([[`${W}uploads/plus name.png`, `${BLOB_ORIGIN}${W}uploads/plus+name.png`]]),
  );
  const r2 = fakeR2(new Map([[`${W}generations/new.mp4`, bytes("new render")]]));
  const logged = [];
  const { counts, report } = await run(dir, blob, r2, { log: (v) => logged.push(JSON.stringify(v)), progressEveryMs: 0 });
  assert.equal(counts.blobObjects, 4);
  assert.equal(counts.keys, 5);
  assert.equal(counts.aliasKeys, 1);
  assert.equal(counts.copied, 5);
  assert.equal(counts.copiedBytes, big.length + bytes("old render").length + bytes("named upload").length + 2 * bytes("aliased").length);
  assert.equal(counts.conflicts + counts.failed, 0);
  for (const [pathname, body] of blob.data) assert.deepEqual(r2.objects.get(pathname).body, body);
  assert.deepEqual(r2.objects.get(`${W}uploads/plus+name.png`).body, bytes("aliased"));
  assert.deepEqual(r2.objects.get(`${W}generations/new.mp4`).body, bytes("new render"));
  assert.equal(r2.objects.get(`${W}generations/old.png`).contentType, "image/png");
  assert.equal(r2.objects.get(`${W}generations/old.png`).cacheControl, "private, max-age=31536000, immutable");
  // Every write was conditional; the multipart object went up in 5 MiB parts and was read back.
  for (const c of r2.calls.filter((c) => c.name === "PutObjectCommand" || c.name === "CompleteMultipartUploadCommand"))
    assert.equal(c.ifNoneMatch, "*");
  assert.equal(r2.calls.filter((c) => c.name === "UploadPartCommand").length, 3);
  assert.deepEqual(
    r2.calls.filter((c) => c.name === "GetObjectCommand").map((c) => c.key),
    [`${W}generations/master.mp4`],
  );
  const records = await progressLines(dir);
  assert.equal(records.length, 5);
  assert.equal(records.find((r) => r.key === `${W}generations/master.mp4`).sha256, sha(big));
  const info = await stat(join(dir, report));
  assert.equal(info.mode & 0o777, 0o600);
  for (const line of logged.concat(JSON.stringify(counts)))
    for (const leak of ["Acme", "Merger", "plus", "old.png", "ws_fixture", "vercel-storage", ENV.R2_SECRET_ACCESS_KEY, ENV.BLOB_READ_WRITE_TOKEN])
      assert.equal(line.includes(leak), false, leak);
  assert.ok(logged.length >= 1);
});

test("skip existing: same size is skipped without reading; --deep proves it by hash", async (t) => {
  const dir = await privateRoot(t);
  const blob = fakeBlob(new Map([[`${W}generations/old.png`, bytes("old render")], [`${W}uploads/u.png`, bytes("upload")]]));
  const r2 = fakeR2(new Map([[`${W}generations/old.png`, bytes("old render")]]));
  const { counts } = await run(dir, blob, r2);
  assert.equal(counts.presentSameSize, 1);
  assert.equal(counts.copied, 1);
  assert.deepEqual(blob.reads, [`${W}uploads/u.png`]);
  assert.equal(writes(r2).filter((c) => c.key === `${W}generations/old.png`).length, 0);
  const deep = await run(dir, blob, r2, { deep: true });
  assert.equal(deep.counts.verifiedEarlier, 1); // the upload, recorded by the first run
  assert.equal(deep.counts.presentVerified, 1); // old.png, now hashed on both sides
  assert.equal(writes(r2).length, 1);
  const third = await run(dir, blob, r2, { deep: true });
  assert.equal(third.counts.verifiedEarlier, 2);
});

test("conflict: a different R2 object is reported and never overwritten (size, content, or a racing writer)", async (t) => {
  const dir = await privateRoot(t);
  const blob = fakeBlob(
    new Map([
      [`${W}a.png`, bytes("blob a")],
      [`${W}b.png`, bytes("blob b")],
      [`${W}c.png`, bytes("blob c")],
    ]),
  );
  const r2 = fakeR2(
    new Map([
      [`${W}a.png`, bytes("a different, longer object")],
      [`${W}b.png`, bytes("blob X")], // same size, other bytes
    ]),
  );
  r2.beforePut = (key) => {
    if (key === `${W}c.png` && !r2.objects.has(key)) r2.store(key, bytes("raced"));
  };
  const { counts, report } = await run(dir, blob, r2, { deep: true });
  assert.equal(counts.conflicts, 3);
  assert.equal(counts.copied, 0);
  assert.deepEqual(r2.objects.get(`${W}a.png`).body, bytes("a different, longer object"));
  assert.deepEqual(r2.objects.get(`${W}b.png`).body, bytes("blob X"));
  assert.deepEqual(r2.objects.get(`${W}c.png`).body, bytes("raced"));
  const body = JSON.parse(await readFile(join(dir, report), "utf8"));
  assert.deepEqual(
    body.conflicts.map((c) => [c.key, c.reason]).sort(),
    [
      [`${W}a.png`, "size"],
      [`${W}b.png`, "content"],
      [`${W}c.png`, "content"],
    ],
  );
  await assert.rejects(readFile(join(dir, PROGRESS_FILE)), { code: "ENOENT" });
});

test("retry: a dropped Blob stream, an R2 500 and a failed part are retried; a lost PUT answer is recognised", async (t) => {
  const dir = await privateRoot(t);
  const big = bytes("p", 6 * MiB);
  const blob = fakeBlob(new Map([[`${W}a.png`, bytes("blob a")], [`${W}b.png`, bytes("blob b")], [`${W}big.mp4`, big], [`${W}d.png`, bytes("blob d")]]));
  blob.drops.set(`${W}a.png`, 1);
  const r2 = fakeR2();
  r2.faults.set(`PutObjectCommand:${W}b.png`, [500]);
  r2.faults.set(`UploadPartCommand:${W}big.mp4`, [503]);
  // The first PUT of d lands, but its answer is lost (a 502 after the write).
  const send = r2.send;
  let lost = false;
  r2.send = async (command) => {
    const out = await send(command);
    if (!lost && command.constructor.name === "PutObjectCommand" && command.input.Key === `${W}d.png`) {
      lost = true;
      throw s3Error(502, "BadGateway");
    }
    return out;
  };
  const { counts } = await run(dir, blob, r2);
  assert.equal(counts.copied, 4);
  assert.equal(counts.failed + counts.conflicts, 0);
  assert.equal(blob.reads.filter((p) => p === `${W}a.png`).length, 2);
  assert.equal(r2.calls.filter((c) => c.name === "PutObjectCommand" && c.key === `${W}b.png`).length, 2);
  assert.equal(r2.calls.filter((c) => c.name === "UploadPartCommand").length, 3);
  // d: second PUT got 412, the read-back matched the source hash, so it counts as copied.
  assert.equal(r2.calls.filter((c) => c.name === "PutObjectCommand" && c.key === `${W}d.png`).length, 2);
  for (const [pathname, body] of blob.data) assert.deepEqual(r2.objects.get(pathname).body, body);
});

test("a permanent failure is reported by key in the private report only, and the run continues", async (t) => {
  const dir = await privateRoot(t);
  const blob = fakeBlob(new Map([[`${W}gone.png`, bytes("gone")], [`${W}ok.png`, bytes("ok")]]));
  const get = blob.get;
  blob.get = async (url, options) => {
    if (url.endsWith("gone.png")) throw Object.assign(new Error(`denied ${url}`), { name: "BlobAccessError" });
    return get(url, options);
  };
  const r2 = fakeR2();
  const { counts, report } = await run(dir, blob, r2);
  assert.equal(counts.failed, 1);
  assert.equal(counts.copied, 1);
  const body = JSON.parse(await readFile(join(dir, report), "utf8"));
  assert.deepEqual(body.failures, [{ key: `${W}gone.png`, pathname: `${W}gone.png`, error: "SOURCE_REFUSED" }]);
});

test("resume: a second run skips what the progress file proves, tolerates a torn line, and refuses a held lock", async (t) => {
  const dir = await privateRoot(t);
  const blob = fakeBlob(new Map([1, 2, 3, 4].map((n) => [`${W}f${n}.png`, bytes(`file ${n}`)])));
  const r2 = fakeR2();
  const first = await run(dir, blob, r2, { limit: 2 });
  assert.equal(first.counts.copied, 2);
  await appendFile(join(dir, PROGRESS_FILE), '{"key":"torn');
  assert.equal((await loadProgress(dir)).size, 2);
  blob.reads.length = 0;
  const second = await run(dir, blob, r2);
  assert.equal(second.counts.verifiedEarlier, 2);
  assert.equal(second.counts.copied, 2);
  assert.deepEqual(blob.reads.sort(), [`${W}f3.png`, `${W}f4.png`]);
  // An object changed on R2 since it was recorded is no longer "verified earlier".
  r2.store(`${W}f1.png`, bytes("file 9"));
  const third = await run(dir, blob, r2);
  assert.equal(third.counts.verifiedEarlier, 3);
  assert.equal(third.counts.presentSameSize, 1);
  await writeFile(join(dir, "blob-to-r2.lock"), "1");
  await assert.rejects(run(dir, blob, r2), /Another run holds/);
});

test("dry run: counts, bytes, conflicts and an estimate, with no writes to R2", async (t) => {
  const dir = await privateRoot(t);
  const blob = fakeBlob(
    new Map([
      [`${W}same.png`, bytes("same")],
      [`${W}conflict.png`, bytes("blob side")],
      [`${W}new1.png`, bytes("new one")],
      [`${W}new2.mp4`, bytes("v", 2 * MiB)],
    ]),
  );
  const r2 = fakeR2(new Map([[`${W}same.png`, bytes("same")], [`${W}conflict.png`, bytes("other")]]));
  const before = new Map(r2.objects);
  const { counts, report } = await run(dir, blob, r2, { apply: false, probeBytes: 1 });
  assert.equal(writes(r2).length, 0);
  assert.equal(r2.calls.filter((c) => c.name === "GetObjectCommand").length, 0);
  assert.deepEqual(r2.objects, before);
  assert.equal(counts.mode, "dry-run");
  assert.equal(counts.toCopy, 2);
  assert.equal(counts.toCopyBytes, bytes("new one").length + 2 * MiB);
  assert.equal(counts.presentSameSize, 1);
  assert.equal(counts.conflicts, 1);
  assert.ok(counts.probe.bytes > 0 && typeof counts.probe.estimatedCopyMinutes === "number");
  assert.ok(report.startsWith("blob-to-r2-dry-run-"));
  await assert.rejects(readFile(join(dir, PROGRESS_FILE)), { code: "ENOENT" });
});

test("the private directory must be outside the checkout and owner-only; arguments need one mode", async (t) => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  await assert.rejects(privateDirectory(join(repo, "scripts")), /outside the repository/);
  const dir = await privateRoot(t);
  const { chmod } = await import("node:fs/promises");
  await chmod(dir, 0o755);
  await assert.rejects(privateDirectory(dir), /readable only by its owner/);
  assert.throws(() => parseArguments(["--private-dir", "/x"]), /exactly one of/);
  assert.throws(() => parseArguments(["--copy", "--dry-run"]), /exactly one of/);
  assert.deepEqual(
    { ...parseArguments(["--copy", "--private-dir", "/x", "--transfers", "8", "--deep"]) },
    { mode: "copy", privateDir: "/x", transfers: 8, limit: undefined, probeBytes: 64 * MiB, config: undefined, deep: true, readback: false, live: false },
  );
  assert.equal(parseArguments(["--verify", "--private-dir", "/x", "--live"]).live, true);
  assert.throws(() => parseArguments(["--verify", "--private-dir", "/x", "--live", "--config", "c.json"]), /either --live or --config/);
  assert.throws(() => parseArguments(["--copy", "--private-dir", "/x", "--live"]), /only with --verify/);
});

/* ── verify r2-only ──────────────────────────────────────────────────── */

async function databases(t, root) {
  const platformPath = join(root, "platform.db"),
    tenantPath = join(root, "tenant.db");
  const platform = createClient({ url: pathToFileURL(platformPath).href }),
    tenant = createClient({ url: pathToFileURL(tenantPath).href });
  await platform.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT,legacy INTEGER,purged_at INTEGER);`);
  await platform.execute({ sql: "INSERT INTO workspaces VALUES('ws_fixture',?,0,NULL)", args: [pathToFileURL(tenantPath).href] });
  await tenant.executeMultiple(`CREATE TABLE generations(id TEXT PRIMARY KEY,status TEXT,kind TEXT,stored_url TEXT,deleted INTEGER);
    CREATE TABLE uploads(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT);
    INSERT INTO generations VALUES('old','succeeded','image','${W}generations/old.png',0),('new','succeeded','video','x',0);
    INSERT INTO uploads VALUES('named','pdf','${BLOB_ORIGIN}${W}uploads/Acme%20Merger-Zz99.pdf'),
      ('bare','txt','${W}uploads/bare.txt'),('route','pdf','/api/uploads/route');`);
  platform.close();
  tenant.close();
  return {
    version: 1,
    databases: [
      { id: "platform", role: "platform", url: pathToFileURL(platformPath).href },
      { id: "tenant", role: "tenant", url: pathToFileURL(tenantPath).href, workspaceIds: ["ws_fixture"] },
    ],
  };
}
const allOnR2 = () =>
  new Map([
    [`${W}generations/old.png`, bytes("old")],
    [`${W}generations/new.mp4`, bytes("new")],
    [`${W}uploads/Acme Merger-Zz99.pdf`, bytes("named")],
    [`${W}uploads/bare.txt`, bytes("bare")],
    [`${W}uploads/route.pdf`, bytes("route")],
  ]);

test("verify: every referenced row resolves on R2 alone, and every Blob object is on R2", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(t, root);
  const dir = join(root, "private");
  const r2 = fakeR2(allOnR2());
  const blob = fakeBlob(new Map([[`${W}generations/old.png`, bytes("old")], [`${W}uploads/Acme Merger-Zz99.pdf`, bytes("named")]]));
  const result = await verifyR2Only({ privateDir: dir, config, env: ENV, r2Client: r2.factory, blobSdk: blob, retryOptions: fast });
  assert.deepEqual(result, { mode: "verify", ok: true, r2Objects: 5, references: 5, byStore: { r2: 5 }, blobObjects: 2, blobObjectsNotOnR2: 0 });
  assert.equal(writes(r2).length, 0);
  // Database snapshots are removed afterwards.
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("verify-")), []);
});

test("verify fails naming rows only: no Blob fallback, no file names in the result", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(t, root);
  const dir = join(root, "private");
  const objects = allOnR2();
  objects.delete(`${W}generations/old.png`);
  objects.delete(`${W}uploads/Acme Merger-Zz99.pdf`);
  const r2 = fakeR2(objects);
  const blob = fakeBlob(new Map([[`${W}generations/old.png`, bytes("old")], [`${W}uploads/Acme Merger-Zz99.pdf`, bytes("named")]]));
  const result = await verifyR2Only({ privateDir: dir, config, env: ENV, r2Client: r2.factory, blobSdk: blob, retryOptions: fast });
  assert.equal(result.ok, false);
  assert.match(result.missingReferences, /\(2\): tenant\/generations\/old, tenant\/uploads\/named$/);
  assert.equal(result.blobObjectsNotOnR2, 2);
  const printed = JSON.stringify(result);
  for (const leak of ["Acme", "Merger", "%20", "ws_fixture", "vercel-storage", ".png", ".pdf"]) assert.equal(printed.includes(leak), false, leak);
  const report = JSON.parse(await readFile(join(dir, result.report), "utf8"));
  assert.equal(report.blobObjectsNotOnR2.length, 2);
  // Without the Blob token, only the database coverage runs.
  const r2Only = { ...ENV };
  delete r2Only.BLOB_READ_WRITE_TOKEN;
  const noBlob = await verifyR2Only({ privateDir: dir, config, env: r2Only, r2Client: r2.factory, retryOptions: fast });
  assert.equal(noBlob.ok, false);
  assert.equal(noBlob.blobObjects, undefined);
  // A workspace without a database in the config is refused rather than silently skipped.
  await assert.rejects(
    verifyR2Only({ privateDir: dir, config: { ...config, databases: [config.databases[0]] }, env: ENV, r2Client: r2.factory, blobSdk: blob }),
    /missing from the --config \(or --live\) database list/,
  );
});

/* ── verify --live ───────────────────────────────────────────────────── */

const KEYRING = "fixture-keyring-secret-of-32-characters-at-least";
// The app's own format (lib/keyring.ts seal): v1.iv.tag.ct, base64url, AES-256-GCM under sha256(KEYRING_SECRET).
function seal(plain, secret = KEYRING) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
const TENANT_TOKEN = "fixture-tenant-token-value-AAA",
  PENDING_TOKEN = "fixture-pending-token-value-BBB";

/** Platform with a legacy workspace (its media in the platform database), a
 * tenant workspace with a sealed token, a purged one, and a pending
 * provisioned database. Returns the env the owner's file would provide. */
async function liveDatabases(root, { tokenSecret = KEYRING } = {}) {
  const href = (name) => pathToFileURL(join(root, name)).href;
  const platform = createClient({ url: href("platform.db") }),
    tenant = createClient({ url: href("tenant.db") }),
    pending = createClient({ url: href("pending.db") });
  await platform.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT NOT NULL,db_token_enc TEXT,legacy INTEGER NOT NULL DEFAULT 0,purged_at INTEGER);
    CREATE TABLE workspace_provisioning(request_id TEXT PRIMARY KEY,workspace_id TEXT,db_url TEXT,db_token_enc TEXT);
    CREATE TABLE uploads(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT);
    INSERT INTO uploads VALUES('legacyfile','txt','uploads/legacy.txt');`);
  await platform.execute({
    sql: `INSERT INTO workspaces VALUES('ws_legacy','unused',NULL,1,NULL),('ws_fixture',?,?,0,NULL),('ws_gone','libsql://gone.example',?,0,5)`,
    args: [href("tenant.db"), seal(TENANT_TOKEN, tokenSecret), seal("x", "another-secret")],
  });
  await platform.execute({
    sql: `INSERT INTO workspace_provisioning VALUES('r1','ws_pending',?,?),('r2','ws_waiting',NULL,NULL)`,
    args: [href("pending.db"), seal(PENDING_TOKEN, tokenSecret)],
  });
  await tenant.executeMultiple(`CREATE TABLE uploads(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT);
    INSERT INTO uploads VALUES('bare','txt','${W}uploads/bare.txt');`);
  await pending.executeMultiple(`CREATE TABLE uploads(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT);`);
  for (const db of [platform, tenant, pending]) db.close();
  return { ...ENV, PLATFORM_DATABASE_URL: href("platform.db"), TURSO_DATABASE_URL: href("platform.db"), KEYRING_SECRET: KEYRING };
}

test("verify --live: the inventory comes from the platform database, tokens opened in process only", async (t) => {
  const root = await privateRoot(t);
  const env = await liveDatabases(root);
  const dir = join(root, "private");
  // The inventory names variables only; values live in the returned env object.
  const spec = livePlatformSpec(env);
  assert.deepEqual(spec, { id: "platform", role: "platform", urlEnv: "PLATFORM_DATABASE_URL" });
  const built = await liveSourceInventory(join(root, "platform.db"), spec, env);
  assert.deepEqual(built.config, {
    version: 1,
    databases: [
      { id: "platform", role: "platform", urlEnv: "PLATFORM_DATABASE_URL", workspaceIds: ["ws_legacy"] },
      { id: "tenant-1", role: "tenant", urlEnv: "BLOB_TO_R2_LIVE_DB_1_URL", tokenEnv: "BLOB_TO_R2_LIVE_DB_1_TOKEN", workspaceIds: ["ws_fixture"] },
      { id: "tenant-2", role: "tenant", urlEnv: "BLOB_TO_R2_LIVE_DB_2_URL", tokenEnv: "BLOB_TO_R2_LIVE_DB_2_TOKEN", workspaceIds: ["ws_pending"] },
    ],
  });
  assert.equal(built.env.BLOB_TO_R2_LIVE_DB_1_TOKEN, TENANT_TOKEN);
  assert.equal(built.env.BLOB_TO_R2_LIVE_DB_2_TOKEN, PENDING_TOKEN);
  assert.equal(env.BLOB_TO_R2_LIVE_DB_1_TOKEN, undefined, "the caller's env is not changed");
  assert.deepEqual(built.counts, { databases: 3, legacyWorkspaces: 1, workspaces: 3 });
  const inventoryText = JSON.stringify(built.config) + JSON.stringify(built.counts);
  for (const leak of [TENANT_TOKEN, PENDING_TOKEN, "tenant.db", "pending.db", KEYRING]) assert.equal(inventoryText.includes(leak), false, leak);

  const r2 = fakeR2(new Map([[`uploads/legacy.txt`, bytes("legacy")], [`${W}uploads/bare.txt`, bytes("bare")]]));
  const result = await verifyR2Only({ privateDir: dir, live: true, env, r2Client: r2.factory, blobSdk: fakeBlob(new Map()), retryOptions: fast });
  assert.deepEqual(result, {
    mode: "verify",
    ok: true,
    live: { databases: 3, legacyWorkspaces: 1, workspaces: 3 },
    r2Objects: 2,
    references: 2,
    byStore: { r2: 2 },
    blobObjects: 0,
    blobObjectsNotOnR2: 0,
  });
  assert.equal(writes(r2).length, 0);
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("verify-")), []);
  const printed = JSON.stringify(result);
  for (const leak of [TENANT_TOKEN, PENDING_TOKEN, "tenant.db", "ws_fixture", "BLOB_TO_R2_LIVE"]) assert.equal(printed.includes(leak), false, leak);

  // A missing row on R2 is named by generated database id and row id only.
  r2.objects.delete(`${W}uploads/bare.txt`);
  const missing = await verifyR2Only({ privateDir: dir, live: true, env, r2Client: r2.factory, blobSdk: fakeBlob(new Map()), retryOptions: fast });
  assert.equal(missing.ok, false);
  assert.match(missing.missingReferences, /tenant-1\/uploads\/bare$/);

  // --live and --config are exclusive.
  await assert.rejects(verifyR2Only({ privateDir: dir, live: true, config: { version: 1, databases: [] }, env, r2Client: r2.factory }), /either --live or --config/);
});

test("verify --live refuses, naming only the workspace, when KEYRING_SECRET does not open a token; and refuses a separate legacy database", async (t) => {
  const root = await privateRoot(t);
  const env = await liveDatabases(root, { tokenSecret: "the-secret-the-deployment-really-used" });
  const dir = join(root, "private");
  const r2 = fakeR2();
  let message = "";
  await verifyR2Only({ privateDir: dir, live: true, env, r2Client: r2.factory, retryOptions: fast }).catch((error) => (message = error.message));
  assert.match(message, /^Cannot open the database token of workspace ws_fixture: KEYRING_SECRET does not match/);
  for (const leak of [TENANT_TOKEN, "tenant.db", KEYRING, "the-secret"]) assert.equal(message.includes(leak), false, leak);
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("verify-")), [], "snapshots removed after a refusal");

  const good = await liveDatabases(await privateRoot(t));
  await assert.rejects(
    verifyR2Only({ privateDir: dir, live: true, env: { ...good, KEYRING_SECRET: undefined }, r2Client: r2.factory }),
    /needs KEYRING_SECRET/,
  );
  await assert.rejects(
    verifyR2Only({ privateDir: dir, live: true, env: { ...good, TURSO_DATABASE_URL: "libsql://other.example" }, r2Client: r2.factory }),
    /Legacy workspaces live in TURSO_DATABASE_URL/,
  );
  const noPlatform = { ...good };
  delete noPlatform.PLATFORM_DATABASE_URL;
  delete noPlatform.TURSO_DATABASE_URL;
  await assert.rejects(verifyR2Only({ privateDir: dir, live: true, env: noPlatform, r2Client: r2.factory }), /needs PLATFORM_DATABASE_URL/);
});

test("verify --live: a database without workspaces, or a remote workspace without a token, is refused", async (t) => {
  const root = await privateRoot(t);
  const href = (name) => pathToFileURL(join(root, name)).href;
  const spec = { id: "platform", role: "platform", urlEnv: "PLATFORM_DATABASE_URL" };
  const empty = createClient({ url: href("empty.db") });
  await empty.execute("CREATE TABLE other(id TEXT)");
  empty.close();
  await assert.rejects(
    liveSourceInventory(join(root, "empty.db"), spec, { ...ENV, PLATFORM_DATABASE_URL: href("empty.db"), KEYRING_SECRET: KEYRING }),
    /no workspaces table/,
  );
  const bare = createClient({ url: href("bare.db") });
  await bare.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT NOT NULL,db_token_enc TEXT,legacy INTEGER NOT NULL DEFAULT 0,purged_at INTEGER);
    INSERT INTO workspaces VALUES('ws_tokenless','libsql://tokenless.example',NULL,0,NULL);`);
  bare.close();
  await assert.rejects(
    liveSourceInventory(join(root, "bare.db"), spec, { ...ENV, PLATFORM_DATABASE_URL: href("bare.db"), KEYRING_SECRET: KEYRING }),
    (error) => /ws_tokenless/.test(error.message) && !error.message.includes("tokenless.example"),
  );
});

test("two reports written in the same millisecond both land, each under its own name", async (t) => {
  const dir = await privateRoot(t);
  const RealDate = Date;
  const fixed = new RealDate("2026-10-10T12:00:00.000Z").getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  let names;
  try {
    names = await Promise.all([writeReport(dir, "copy", { run: 1 }), writeReport(dir, "copy", { run: 2 }), writeReport(dir, "copy", { run: 3 })]);
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.match(name, /^blob-to-r2-copy-2026-10-10T12-00-00-000Z(-\d+)?\.json$/);
  assert.deepEqual((await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")).run))).sort(), [1, 2, 3]);
});
