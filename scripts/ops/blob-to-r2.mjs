/**
 * Copy every Vercel Blob object to R2 before the Vercel account closes, at
 * the key the app's resolver reads (lib/storage/backend.ts resolveStored):
 *
 *   - a bare key in a row is read on R2 as-is (then Blob, while the token
 *     exists), so each object goes to its Blob pathname;
 *   - an absolute Blob URL in a row is read on R2 at
 *     decodeURIComponent(new URL(url).pathname.slice(1)); when that differs
 *     from the pathname the object is copied to both keys.
 *
 * Modes (exactly one):
 *   --dry-run   list both stores, count what would be copied (objects, bytes),
 *               what is already there and what conflicts; no writes to R2.
 *   --copy      stream each missing object to R2 with a conditional write
 *               (If-None-Match: *), verify it (ETag = MD5 for a single PUT,
 *               read-back SHA-256 otherwise), retry transient errors, and
 *               append a resume record to the progress file.
 *   --verify    every media row in the databases named by --config resolves on
 *               R2 alone (backup-lib verifyMediaReferences, kind "r2"); with
 *               BLOB_READ_WRITE_TOKEN set, also every Blob object is on R2.
 *               With --live instead of --config, the database list is read
 *               from the platform database itself (liveSourceInventory).
 *
 * Credentials come from the app's own variable names: BLOB_READ_WRITE_TOKEN,
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and
 * optional R2_ENDPOINT. The console shows counts only; keys (which can carry
 * a customer's file name) go only to report files in --private-dir.
 * Nothing is ever deleted or overwritten, on either store.
 */
import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  OpsError,
  blobInventory,
  connection,
  defaultR2Client,
  openKeyring,
  r2Inventory,
  r2Settings,
  retrying,
  safePath,
  snapshotDatabase,
  verifyMediaReferences,
} from "./backup-lib.mjs";

/** The app's variable names (lib/storage/backend.ts r2ConfigFromEnv). */
export const R2_ENV_NAMES = {
  accountIdEnv: "R2_ACCOUNT_ID",
  accessKeyIdEnv: "R2_ACCESS_KEY_ID",
  secretAccessKeyEnv: "R2_SECRET_ACCESS_KEY",
  bucketEnv: "R2_BUCKET",
};
export const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";
export const PROGRESS_FILE = "blob-to-r2-progress.jsonl";
const LOCK_FILE = "blob-to-r2.lock";
/** Objects up to one part go up as a single PUT; larger ones as multipart in
 * parts of this size. Memory per transfer stays at about one part. */
export const PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 10_000;
/** What lib/storage/r2.ts writes, so copied objects look like the app's own. */
const PRIVATE_CACHE_CONTROL = "private, max-age=31536000, immutable";
const BLOB_HOST = ".vercel-storage.com";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const fail = (code) => {
  throw new OpsError(code);
};
const s3sdk = () => import("@aws-sdk/client-s3");
const httpStatus = (error) => error?.$metadata?.httpStatusCode;
const unquote = (etag) => (typeof etag === "string" ? etag.replace(/^"|"$/g, "") : undefined);
const r2Spec = (env) => ({ ...R2_ENV_NAMES, ...(env.R2_ENDPOINT ? { endpointEnv: "R2_ENDPOINT" } : {}) });
const requireEnv = (env, name) => {
  if (!env[name]) fail(`MISSING_CONFIGURATION: ${name} is not set.`);
  return env[name];
};

/* ── Keys ──────────────────────────────────────────────────────────────── */

/** Every R2 key the app may look this Blob object up at. Throws OpsError for
 * a URL the resolver would refuse or could not decode. */
export function targetKeys(entry) {
  const keys = [safePath(entry.pathname)];
  if (entry.url) {
    let key;
    try {
      const url = new URL(entry.url);
      if (!url.hostname.toLowerCase().endsWith(BLOB_HOST)) throw new Error("host");
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      fail("UNMAPPABLE_URL");
    }
    if (key !== entry.pathname) keys.push(safePath(key));
  }
  return keys;
}

/* ── Private directory, progress and reports ───────────────────────────── */

export async function privateDirectory(path) {
  if (typeof path !== "string" || !path) fail("A private directory (--private-dir) is required.");
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const real = await realpath(absolute),
    root = await realpath(REPO_ROOT).catch(() => REPO_ROOT);
  if (real === root || real.startsWith(root + sep))
    fail("The private directory must be outside the repository checkout.");
  const info = await lstat(real);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    fail("The private directory must be a directory readable only by its owner (chmod 700).");
  return real;
}

/** Resume records: one JSON line per object verified on R2. A torn last line
 * (a crash mid-append) is ignored; the object is simply checked again. */
export async function loadProgress(dir) {
  const records = new Map();
  let text = "";
  try {
    text = await readFile(join(dir, PROGRESS_FILE), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // A torn last line must not swallow the next record appended after it.
  if (text && !text.endsWith("\n")) await appendFile(join(dir, PROGRESS_FILE), "\n");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.key === "string") records.set(record.key, record);
    } catch {
      /* torn line */
    }
  }
  return records;
}

async function writeReport(dir, mode, body) {
  const name = `blob-to-r2-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(join(dir, name), JSON.stringify(body, null, 2), { flag: "wx", mode: 0o600 });
  return name;
}

async function withLock(dir, work) {
  const lock = join(dir, LOCK_FILE);
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST")
      fail(`Another run holds ${LOCK_FILE} in the private directory. If no run is active, delete that file and start again.`);
    throw error;
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/* ── Stores ────────────────────────────────────────────────────────────── */

/** Blob errors that will not change on a retry. Everything else (network,
 * 5xx, rate limits) is retried by backup-lib's retrying(). */
const PERMANENT_BLOB_ERRORS = new Set([
  "BlobAccessError",
  "BlobNotFoundError",
  "BlobStoreNotFoundError",
  "BlobStoreSuspendedError",
  "BlobClientTokenExpiredError",
  "BlobPreconditionFailedError",
]);

/** One Blob object as a Node stream, checked against the listed size and ETag. */
async function openBlob(sdk, token, entry) {
  let result;
  try {
    result = await sdk.get(entry.url ?? entry.pathname, {
      token,
      access: entry.url && new URL(entry.url).hostname.includes(".public.blob.") ? "public" : "private",
      useCache: false,
      headers: { "Accept-Encoding": "identity" },
    });
  } catch (error) {
    if (PERMANENT_BLOB_ERRORS.has(error?.name)) fail("SOURCE_REFUSED");
    throw error;
  }
  if (!result || result.statusCode !== 200 || !result.stream) fail("SOURCE_MISSING");
  if (result.blob?.size !== entry.size || (entry.etag && result.blob?.etag !== entry.etag)) {
    await result.stream.cancel?.().catch(() => {});
    fail("SOURCE_CHANGED");
  }
  return { stream: Readable.fromWeb(result.stream), contentType: result.blob.contentType };
}

/** Yields the stream in buffers of exactly `size` bytes (the last may be
 * shorter), feeding every byte to `onBytes` first. */
async function* inParts(stream, size, onBytes) {
  let part = Buffer.allocUnsafe(size),
    filled = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    onBytes(chunk);
    for (let offset = 0; offset < chunk.length; ) {
      const take = Math.min(size - filled, chunk.length - offset);
      chunk.copy(part, filled, offset, offset + take);
      offset += take;
      filled += take;
      if (filled === size) {
        yield part;
        part = Buffer.allocUnsafe(size);
        filled = 0;
      }
    }
  }
  if (filled) yield part.subarray(0, filled);
}

function digests(expectedSize) {
  const sha = createHash("sha256"),
    md5 = createHash("md5");
  const state = {
    bytes: 0,
    update(chunk) {
      state.bytes += chunk.length;
      if (state.bytes > expectedSize) fail("SOURCE_CHANGED");
      sha.update(chunk);
      md5.update(chunk);
    },
    finish() {
      if (state.bytes !== expectedSize) fail("SOURCE_CHANGED");
      return { bytes: state.bytes, sha256: sha.digest("hex"), md5: md5.digest("hex") };
    },
  };
  return state;
}

/** SHA-256 of a whole Blob object, streamed (memory: one chunk). */
async function hashSource(blob, entry, retry) {
  return retry(async () => {
    const { stream } = await blob.open(entry);
    const state = digests(entry.size);
    try {
      for await (const chunk of stream) state.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } finally {
      stream.destroy();
    }
    return state.finish();
  });
}

/** SHA-256, size and ETag of what R2 holds at `key`, streamed. */
async function readBack(r2, key, retry) {
  const { GetObjectCommand } = await s3sdk();
  return retry(async () => {
    let out;
    try {
      out = await r2.client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
    } catch (error) {
      if (httpStatus(error) === 404) fail("DESTINATION_MISSING");
      throw error;
    }
    if (!out?.Body) fail("DESTINATION_MISSING");
    const body = typeof out.Body.transformToWebStream === "function" ? Readable.fromWeb(out.Body.transformToWebStream()) : out.Body;
    const sha = createHash("sha256");
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      sha.update(chunk);
    }
    return { bytes, sha256: sha.digest("hex"), etag: unquote(out.ETag) };
  });
}

/**
 * One conditional write of a Blob object to R2. The whole object is retried
 * (fresh source stream) on a transient fault; multipart parts are buffered,
 * so each part is also retried on its own. A 412 means R2 already holds the
 * key: nothing was written ({ written: false }) and the caller compares.
 */
async function putObject(r2, blob, entry, key, retry, partSize) {
  const s3 = await s3sdk();
  const base = { Bucket: r2.bucket, Key: key };
  return retry(async (attempt) => {
    const { stream, contentType } = await blob.open(entry);
    const meta = { ...(contentType ? { ContentType: contentType } : {}), CacheControl: PRIVATE_CACHE_CONTROL };
    const state = digests(entry.size);
    const parts = inParts(stream, partSize, (chunk) => state.update(chunk));
    let uploadId;
    try {
      if (entry.size <= partSize) {
        let body = Buffer.alloc(0);
        for await (const part of parts) body = part;
        const sums = state.finish();
        let out;
        try {
          out = await r2.client.send(new s3.PutObjectCommand({ ...base, Body: body, ContentLength: body.length, IfNoneMatch: "*", ...meta }));
        } catch (error) {
          // On a retry, a 412 can be the earlier attempt's write landing; the caller's compare decides.
          if (httpStatus(error) === 412) return { written: false, attempt };
          throw error;
        }
        return { written: true, multipart: false, etag: unquote(out?.ETag), ...sums };
      }
      const created = await r2.client.send(new s3.CreateMultipartUploadCommand({ ...base, ...meta }));
      uploadId = created?.UploadId;
      if (!uploadId) fail("R2 did not acknowledge the multipart upload.");
      const done = [];
      for await (const part of parts) {
        if (done.length >= MAX_PARTS) fail("OBJECT_TOO_LARGE");
        const PartNumber = done.length + 1,
          md5 = createHash("md5").update(part).digest("hex");
        const out = await retry(() =>
          r2.client.send(new s3.UploadPartCommand({ ...base, UploadId: uploadId, PartNumber, Body: part, ContentLength: part.length })),
        );
        // A single part's ETag is its MD5: the part arrived intact.
        if (unquote(out?.ETag) !== md5) fail("PART_MISMATCH");
        done.push({ PartNumber, ETag: out.ETag });
      }
      const sums = state.finish();
      try {
        await r2.client.send(
          new s3.CompleteMultipartUploadCommand({ ...base, UploadId: uploadId, MultipartUpload: { Parts: done }, IfNoneMatch: "*" }),
        );
      } catch (error) {
        if (httpStatus(error) === 412) {
          await abortUpload(r2, s3, base, uploadId);
          return { written: false, attempt };
        }
        throw error;
      }
      uploadId = undefined;
      return { written: true, multipart: true, ...sums };
    } catch (error) {
      if (uploadId) await abortUpload(r2, s3, base, uploadId);
      throw error;
    } finally {
      stream.destroy();
    }
  });
}

async function abortUpload(r2, s3, base, UploadId) {
  await r2.client.send(new s3.AbortMultipartUploadCommand({ ...base, UploadId })).catch(() => {});
}

/** A failure as a bounded, non-identifying code: storage errors can carry signed URLs. */
function errorCode(error) {
  if (error instanceof OpsError) return error.message.split(":")[0];
  const status = httpStatus(error) ?? error?.status;
  return `${error?.name ?? "Error"}${typeof status === "number" ? ` ${status}` : ""}`;
}

/* ── Dry run and copy ──────────────────────────────────────────────────── */

async function openStores({ env, blobSdk, r2Client }) {
  const token = requireEnv(env, BLOB_TOKEN_ENV);
  const settings = r2Settings(r2Spec(env), env);
  const sdk = blobSdk ?? (await import("@vercel/blob"));
  const client = await (r2Client ?? defaultR2Client)(settings);
  return {
    blob: { token, sdk, open: (entry) => openBlob(sdk, token, entry) },
    r2: { client, bucket: settings.bucket },
  };
}

/**
 * --dry-run (apply false) or --copy (apply true). Returns { counts, report }
 * where report names the private report file.
 */
export async function copyBlobToR2({
  privateDir,
  env = process.env,
  apply = false,
  deep = false,
  readback = false,
  transfers = 4,
  limit,
  probeBytes = 0,
  partSize = PART_SIZE,
  blobSdk,
  r2Client,
  retryOptions,
  log = () => {},
  progressEveryMs = 15_000,
}) {
  if (!Number.isInteger(transfers) || transfers < 1 || transfers > 16) fail("--transfers must be 1 to 16.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) fail("--limit must be a positive whole number.");
  if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024) fail("Part size must be at least 5 MiB.");
  const dir = await privateDirectory(privateDir);
  return withLock(dir, async () => {
    const { blob, r2 } = await openStores({ env, blobSdk, r2Client });
    const retry = retrying(retryOptions);
    try {
      const started = Date.now();
      const listed = await blobInventory(blob.token, blob.sdk);
      const blobListMs = Date.now() - started;
      const onR2 = new Map((await r2Inventory(r2.client, r2.bucket, retry)).map((e) => [e.pathname, e]));
      const progress = await loadProgress(dir);
      const entries = limit ? listed.slice(0, limit) : listed;
      const counts = {
        mode: apply ? "copy" : "dry-run",
        blobObjects: listed.length,
        blobBytes: listed.reduce((sum, e) => sum + e.size, 0),
        considered: entries.length,
        r2ObjectsBefore: onR2.size,
        keys: 0,
        aliasKeys: 0,
        verifiedEarlier: 0,
        presentSameSize: 0,
        presentVerified: 0,
        toCopy: 0,
        toCopyBytes: 0,
        copied: 0,
        copiedBytes: 0,
        conflicts: 0,
        failed: 0,
      };
      const conflicts = [],
        failures = [],
        pending = [];
      let appendChain = Promise.resolve();
      const record = (value) => {
        const line = JSON.stringify({ ...value, at: new Date().toISOString() }) + "\n";
        appendChain = appendChain.then(() => appendFile(join(dir, PROGRESS_FILE), line, { mode: 0o600 }));
        return appendChain;
      };
      const conflict = (entry, key, reason, r2Size) => {
        counts.conflicts++;
        conflicts.push({ key, pathname: entry.pathname, reason, blobSize: entry.size, ...(r2Size !== undefined ? { r2Size } : {}) });
      };

      async function handle(entry, key) {
        const present = onR2.get(key),
          earlier = progress.get(key);
        if (
          present &&
          earlier &&
          present.size === entry.size &&
          earlier.size === entry.size &&
          earlier.blobEtag === (entry.etag ?? null) &&
          earlier.r2Etag === (present.etag ?? null)
        ) {
          counts.verifiedEarlier++;
          return;
        }
        if (present && present.size !== entry.size) return conflict(entry, key, "size", present.size);
        if (present && !(deep && apply)) {
          counts.presentSameSize++;
          return;
        }
        if (present) {
          const [source, target] = [await hashSource(blob, entry, retry), await readBack(r2, key, retry)];
          if (target.bytes !== entry.size || target.sha256 !== source.sha256) return conflict(entry, key, "content");
          counts.presentVerified++;
          await record({ key, pathname: entry.pathname, size: entry.size, blobEtag: entry.etag ?? null, r2Etag: target.etag ?? null, sha256: source.sha256 });
          return;
        }
        if (!apply) {
          counts.toCopy++;
          counts.toCopyBytes += entry.size;
          pending.push(entry);
          return;
        }
        const put = await putObject(r2, blob, entry, key, retry, partSize);
        let verified;
        if (put.written && !put.multipart && !readback && put.etag && put.etag === put.md5) {
          // A single PUT's ETag is R2's MD5 of the bytes it stored.
          verified = { sha256: put.sha256, etag: put.etag };
        } else {
          const target = await readBack(r2, key, retry);
          const source = put.written ? put : await hashSource(blob, entry, retry);
          if (target.bytes !== entry.size || target.sha256 !== source.sha256) {
            if (put.written) fail("VERIFY_MISMATCH");
            return conflict(entry, key, put.attempt > 1 ? "content-after-retry" : "content");
          }
          verified = { sha256: source.sha256, etag: target.etag };
        }
        if (put.written || put.attempt > 1) {
          counts.copied++;
          counts.copiedBytes += entry.size;
        } else counts.presentVerified++; // written by someone else between listing and copy
        await record({ key, pathname: entry.pathname, size: entry.size, blobEtag: entry.etag ?? null, r2Etag: verified.etag ?? null, sha256: verified.sha256 });
      }

      let next = 0,
        lastLog = Date.now();
      const worker = async () => {
        while (next < entries.length) {
          const entry = entries[next++];
          let keys;
          try {
            keys = targetKeys(entry);
          } catch (error) {
            counts.failed++;
            failures.push({ pathname: entry.pathname, error: errorCode(error) });
            continue;
          }
          counts.keys += keys.length;
          counts.aliasKeys += keys.length - 1;
          for (const key of keys) {
            try {
              await handle(entry, key);
            } catch (error) {
              counts.failed++;
              failures.push({ key, pathname: entry.pathname, error: errorCode(error) });
            }
          }
          if (Date.now() - lastLog >= progressEveryMs) {
            lastLog = Date.now();
            log({ ...counts, done: next });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(transfers, entries.length || 1) }, worker));
      await appendChain;

      // Dry run: time a bounded read of objects still to copy, to estimate the copy.
      let probe;
      if (!apply && probeBytes > 0 && pending.length) {
        const t0 = Date.now();
        let bytes = 0;
        for (const entry of pending) {
          if (bytes >= probeBytes) break;
          try {
            bytes += (await hashSource(blob, entry, retry)).bytes;
          } catch {
            /* the copy will report it */
          }
        }
        const seconds = Math.max((Date.now() - t0) / 1000, 0.001);
        probe = {
          bytes,
          seconds: Math.round(seconds * 10) / 10,
          mibPerSecond: Math.round((bytes / 1048576 / seconds) * 100) / 100,
          ...(bytes ? { estimatedCopyMinutes: Math.ceil((counts.toCopyBytes / (bytes / seconds)) * 2 / 60) } : {}),
        };
      }
      const summary = { ...counts, blobListSeconds: Math.round(blobListMs / 100) / 10, ...(probe ? { probe } : {}) };
      const report = await writeReport(dir, counts.mode, {
        at: new Date().toISOString(),
        ...summary,
        conflicts,
        failures,
      });
      return { counts: summary, report };
    } finally {
      r2.client.destroy?.();
    }
  });
}

/* ── Verify r2-only ────────────────────────────────────────────────────── */

/** Every live workspace has a database in the config, so no media rows are
 * skipped. The workspace part of backup-lib verifyPlatformCoverage, without
 * opening sealed values (no KEYRING_SECRET needed). */
async function checkWorkspaceSources(databases) {
  const platform = databases.find((d) => d.role === "platform");
  const db = createClient({ url: pathToFileURL(platform.snapshot).href, intMode: "bigint" });
  try {
    const names = new Set(platform.inventory.tables.map((t) => t.name));
    for (const table of ["workspaces", "workspace_provisioning"]) {
      if (!names.has(table)) continue;
      for (const row of (await db.execute(`SELECT * FROM "${table}"`)).rows) {
        if (row.purged_at != null || (table === "workspace_provisioning" && !row.db_url)) continue;
        const id = table === "workspaces" ? row.id : row.workspace_id;
        const source = databases.find((d) => d.workspaceIds.includes(id));
        if (!source) fail("A workspace or pending provisioned database is missing from the --config (or --live) database list.");
        if (!row.legacy && row.db_url !== source.sourceUrl) fail("Workspace database source does not match its platform record.");
      }
    }
  } finally {
    db.close();
  }
}

/* ── Live source inventory ─────────────────────────────────────────────── */

/** The platform database as the app opens it (lib/platform.ts platformDb). */
export function livePlatformSpec(env = process.env) {
  const urlEnv = env.PLATFORM_DATABASE_URL ? "PLATFORM_DATABASE_URL" : "TURSO_DATABASE_URL";
  if (!env[urlEnv]) fail("MISSING_CONFIGURATION: --live needs PLATFORM_DATABASE_URL (or TURSO_DATABASE_URL) in the environment.");
  const tokenEnv = env.PLATFORM_AUTH_TOKEN ? "PLATFORM_AUTH_TOKEN" : env.TURSO_AUTH_TOKEN ? "TURSO_AUTH_TOKEN" : undefined;
  return { id: "platform", role: "platform", urlEnv, ...(tokenEnv ? { tokenEnv } : {}) };
}

/**
 * The version-1 source inventory (docs/backup-restore.md), built from a
 * snapshot of the platform database instead of a hand-written file: the
 * platform entry carries every legacy workspace (the app keeps those in
 * TURSO_DATABASE_URL, which must be the platform database here); every other
 * database URL in workspaces / workspace_provisioning becomes one tenant entry
 * with its workspace ids. Tenant URLs and opened tokens go only into the
 * returned in-process env object, under generated names; the inventory itself
 * holds names, never values. Covers exactly the rows checkWorkspaceSources
 * requires. Returns { config, env, counts }.
 */
export async function liveSourceInventory(platformSnapshot, platformSpec, env = process.env) {
  const db = createClient({ url: pathToFileURL(platformSnapshot).href, intMode: "bigint" });
  const legacyIds = [],
    tenants = new Map(); // db_url -> { workspaceIds, token }
  try {
    const names = new Set(
      (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name)),
    );
    for (const table of ["workspaces", "workspace_provisioning"]) {
      if (!names.has(table)) continue;
      for (const row of (await db.execute(`SELECT * FROM "${table}"`)).rows) {
        if (row.purged_at != null || (table === "workspace_provisioning" && !row.db_url)) continue;
        const id = String(table === "workspaces" ? row.id : row.workspace_id);
        if (table === "workspaces" && Number(row.legacy ?? 0) === 1) {
          if (!legacyIds.includes(id)) legacyIds.push(id);
          continue;
        }
        if (!row.db_url) fail(`Workspace ${id} has no database URL in its platform record.`);
        const url = String(row.db_url);
        const tenant = tenants.get(url) ?? { workspaceIds: [], token: undefined };
        tenants.set(url, tenant);
        if (!tenant.workspaceIds.includes(id)) tenant.workspaceIds.push(id);
        if (row.db_token_enc == null || row.db_token_enc === "") continue;
        if (!env.KEYRING_SECRET)
          fail("MISSING_CONFIGURATION: --live needs KEYRING_SECRET (the deployment's own) to open workspace database tokens.");
        let token;
        try {
          token = openKeyring(String(row.db_token_enc), env.KEYRING_SECRET);
        } catch {
          // The cause can carry nothing useful and must not carry the value.
          token = undefined;
        }
        if (!token)
          fail(
            `Cannot open the database token of workspace ${id}: KEYRING_SECRET does not match the one that sealed it (or the stored value is damaged).`,
          );
        tenant.token ??= token;
      }
    }
  } finally {
    db.close();
  }
  if (legacyIds.length && env.TURSO_DATABASE_URL !== env[platformSpec.urlEnv])
    fail("Legacy workspaces live in TURSO_DATABASE_URL, which is not the platform database here. --live cannot cover them; use --config.");
  const liveEnv = { ...env },
    databases = [{ ...platformSpec, workspaceIds: legacyIds }];
  let n = 0;
  for (const [url, tenant] of tenants) {
    n++;
    const urlEnv = `BLOB_TO_R2_LIVE_DB_${n}_URL`,
      tokenEnv = `BLOB_TO_R2_LIVE_DB_${n}_TOKEN`;
    liveEnv[urlEnv] = url;
    if (tenant.token) liveEnv[tokenEnv] = tenant.token;
    databases.push({ id: `tenant-${n}`, role: "tenant", urlEnv, ...(tenant.token ? { tokenEnv } : {}), workspaceIds: tenant.workspaceIds });
  }
  return {
    config: { version: 1, databases },
    env: liveEnv,
    counts: { databases: databases.length, legacyWorkspaces: legacyIds.length, workspaces: databases.reduce((sum, d) => sum + d.workspaceIds.length, 0) },
  };
}

/* ── Verify ────────────────────────────────────────────────────────────── */

const validInventory = (config) =>
  config?.version === 1 &&
  Array.isArray(config.databases) &&
  config.databases.filter((d) => d.role === "platform").length === 1 &&
  new Set(config.databases.map((d) => d.id)).size === config.databases.length &&
  !config.databases.some((d) => !/^[a-zA-Z0-9_-]{1,80}$/.test(d.id ?? ""));

export async function verifyR2Only({ privateDir, config, live = false, env = process.env, r2Client, blobSdk, retryOptions }) {
  if (live && config) fail("Use either --live or --config, not both.");
  if (!live && !validInventory(config))
    fail("--config must be a version 1 source inventory (docs/backup-restore.md) with one platform database and unique simple ids.");
  const platformSpec = live ? livePlatformSpec(env) : undefined;
  const dir = await privateDirectory(privateDir);
  const retry = retrying(retryOptions);
  const settings = r2Settings(r2Spec(env), env);
  const client = await (r2Client ?? defaultR2Client)(settings);
  const scratch = await mkdtemp(join(dir, "verify-"));
  await chmod(scratch, 0o700);
  try {
    const databases = [];
    let liveCounts;
    if (live) {
      // One read-only snapshot of the platform database serves both the
      // inventory and the checks below, so they see the same rows.
      const source = connection(platformSpec, env),
        snapshot = join(scratch, "platform.db");
      const inventory = await snapshotDatabase(source, snapshot, scratch);
      const built = await liveSourceInventory(snapshot, platformSpec, env);
      if (!validInventory(built.config)) fail("The live source inventory is not valid.");
      ({ config, env } = built);
      liveCounts = built.counts;
      databases.push({ id: "platform", role: "platform", workspaceIds: config.databases[0].workspaceIds, sourceUrl: source.url, snapshot, inventory });
    }
    for (const spec of live ? config.databases.slice(1) : config.databases) {
      const source = connection(spec, env),
        snapshot = join(scratch, `${spec.id}.db`);
      databases.push({
        id: spec.id,
        role: spec.role,
        workspaceIds: spec.workspaceIds ?? [],
        sourceUrl: source.url,
        snapshot,
        inventory: await snapshotDatabase(source, snapshot, scratch),
      });
    }
    await checkWorkspaceSources(databases);
    const r2Entries = await r2Inventory(client, settings.bucket, retry);
    const result = { mode: "verify", ok: true, ...(live ? { live: liveCounts } : {}), r2Objects: r2Entries.length };
    try {
      Object.assign(result, await verifyMediaReferences(databases, r2Entries, "r2"));
    } catch (error) {
      if (!(error instanceof OpsError)) throw error;
      // backup-lib names missing rows as database/table/row id only.
      result.ok = false;
      result.missingReferences = error.message;
    }
    if (env[BLOB_TOKEN_ENV]) {
      const onR2 = new Map(r2Entries.map((e) => [e.pathname, e]));
      const listed = await blobInventory(env[BLOB_TOKEN_ENV], blobSdk ?? (await import("@vercel/blob")));
      const missing = [];
      for (const entry of listed) {
        let keys;
        try {
          keys = targetKeys(entry);
        } catch {
          keys = [entry.pathname, null];
        }
        if (keys.some((key) => key === null || onR2.get(key)?.size !== entry.size)) missing.push(entry.pathname);
      }
      result.blobObjects = listed.length;
      result.blobObjectsNotOnR2 = missing.length;
      if (missing.length) {
        result.ok = false;
        result.report = await writeReport(dir, "verify", { at: new Date().toISOString(), blobObjectsNotOnR2: missing });
      }
    }
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    client.destroy?.();
  }
}

/* ── Command line ──────────────────────────────────────────────────────── */

const USAGE = `Usage (run with the production variable names in the environment):
  node scripts/ops/blob-to-r2.mjs --dry-run --private-dir DIR [--probe-mib 64] [--limit N]
  node scripts/ops/blob-to-r2.mjs --copy    --private-dir DIR [--transfers 4] [--deep] [--readback] [--limit N]
  node scripts/ops/blob-to-r2.mjs --verify  --private-dir DIR --config SOURCE-INVENTORY.json
  node scripts/ops/blob-to-r2.mjs --verify  --private-dir DIR --live   (databases read from the platform database; needs PLATFORM_DATABASE_URL, PLATFORM_AUTH_TOKEN, KEYRING_SECRET)`;

export function parseArguments(argv) {
  const options = { flags: new Set() };
  const valued = new Set(["--private-dir", "--transfers", "--limit", "--probe-mib", "--config"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.has(arg)) {
      if (argv[i + 1] === undefined) fail(`${arg} needs a value.`);
      options[arg.slice(2)] = argv[++i];
    } else if (["--dry-run", "--copy", "--verify", "--deep", "--readback", "--live"].includes(arg)) options.flags.add(arg);
    else fail(`Unknown argument ${arg.startsWith("--") ? arg : "(value)"}.`);
  }
  const modes = ["--dry-run", "--copy", "--verify"].filter((m) => options.flags.has(m));
  if (modes.length !== 1) fail("Choose exactly one of --dry-run, --copy or --verify.");
  if (options.flags.has("--live") && !options.flags.has("--verify")) fail("--live works only with --verify.");
  if (options.flags.has("--live") && options.config !== undefined) fail("Use either --live or --config, not both.");
  const number = (name) => (options[name] === undefined ? undefined : Number(options[name]));
  return {
    mode: modes[0].slice(2),
    privateDir: options["private-dir"],
    transfers: number("transfers") ?? 4,
    limit: number("limit"),
    probeBytes: Math.round((number("probe-mib") ?? 64) * 1024 * 1024),
    config: options.config,
    deep: options.flags.has("--deep"),
    readback: options.flags.has("--readback"),
    live: options.flags.has("--live"),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const print = (value) => console.log(JSON.stringify(value));
  try {
    const options = parseArguments(argv);
    if (options.mode === "verify") {
      if (!options.config && !options.live)
        fail("--verify needs --live (databases from the platform database) or --config (the backup source inventory, docs/backup-restore.md).");
      const config = options.live ? undefined : JSON.parse(await readFile(options.config, "utf8"));
      const result = await verifyR2Only({ privateDir: options.privateDir, config, live: options.live, env });
      print(result);
      return result.ok ? 0 : 1;
    }
    const { counts, report } = await copyBlobToR2({ ...options, apply: options.mode === "copy", env, log: print });
    print({ ...counts, report });
    return counts.failed || counts.conflicts ? 1 : 0;
  } catch (error) {
    if (error instanceof OpsError) console.error(error.message);
    else console.error(`Blob to R2 stopped (${errorCode(error)}). Nothing was deleted or overwritten; rerun to resume.`);
    if (error instanceof OpsError && /exactly one of|Unknown argument|needs a value|--live/.test(error.message)) console.error(USAGE);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
