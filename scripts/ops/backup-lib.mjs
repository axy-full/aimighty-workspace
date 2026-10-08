import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "@libsql/client";
import { OpsError } from "./ops-error.mjs";
export { OpsError } from "./ops-error.mjs";

const FORMAT = "particl-backup-v1";
const q = (name) => '"' + name.replaceAll('"', '""') + '"';
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = (value) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? { integer: v.toString() } : v),
    2,
  );
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const fail = (message) => {
  throw new OpsError(message);
};

export function secret(name, env = process.env) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name ?? "") || !env[name])
    fail("A required secret environment variable is missing.");
  return env[name];
}
export function backupKey(env = process.env) {
  const value = secret("PARTICL_BACKUP_KEY", env);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    fail("PARTICL_BACKUP_KEY must be canonical base64 for 32 random bytes.");
  return key;
}
export function openKeyring(value, keyring) {
  const [version, iv, tag, body, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !body || extra)
    fail("Invalid sealed keyring value.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(keyring).digest(),
    Buffer.from(iv, "base64url"),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    cipher.update(Buffer.from(body, "base64url")),
    cipher.final(),
  ]).toString("utf8");
}
export function safePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.split("/").some((s) => !s || s === "." || s === "..")
  )
    fail("Unsafe archive path.");
  return value;
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  fail("Destination already exists; restore and backup never overwrite it.");
}
async function privateFile(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { flag: "wx", mode: 0o600 });
}
async function privateTemp(destination) {
  const parent = dirname(resolve(destination));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(parent, ".particl-ops-"));
  await chmod(path, 0o700);
  return path;
}
function localPath(url) {
  if (!url.startsWith("file:")) fail("Expected a local SQLite database.");
  const path = url.startsWith("file://")
    ? fileURLToPath(url)
    : decodeURIComponent(url.slice(5));
  if (!path || path.includes("?") || path === ":memory:")
    fail("A named local SQLite file is required.");
  return resolve(path);
}
export function connection(spec, env = process.env) {
  const url = spec.urlEnv ? secret(spec.urlEnv, env) : spec.url;
  if (typeof url !== "string")
    fail("Every database requires urlEnv or a local file URL.");
  if (!spec.urlEnv && !url.startsWith("file:"))
    fail(
      "Remote database URLs must come from the explicitly named environment variable.",
    );
  if (!/^(file:|libsql:\/\/|https:\/\/)/.test(url))
    fail("Unsupported database URL.");
  if (
    !url.startsWith("file:") &&
    (new URL(url).username || new URL(url).password)
  )
    fail(
      "Database URL credentials must use a separate secret environment variable.",
    );
  return {
    url,
    ...(spec.tokenEnv ? { authToken: secret(spec.tokenEnv, env) } : {}),
    intMode: "bigint",
  };
}

export async function databaseIdentity(url) {
  if (url.startsWith("file:")) {
    let path = localPath(url);
    const tail = [];
    while (true) {
      try {
        return "file:" + join(await realpath(path), ...tail.reverse());
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (dirname(path) === path) fail("Cannot resolve database path.");
      tail.push(basename(path));
      path = dirname(path);
    }
  }
  const parsed = new URL(url);
  return (
    "turso:" +
    parsed.hostname.toLowerCase() +
    ":" +
    (parsed.port || "443") +
    parsed.pathname.replace(/\/+$/, "")
  );
}

export async function databaseInventory(client) {
  const schema = (
    await client.execute(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
  ).rows.map((r) => ({
    type: r.type,
    name: r.name,
    table: r.tbl_name,
    sql: r.sql,
  }));
  const tables = [];
  const tableSchema = schema.filter((s) => s.type === "table");
  if (
    (
      await client.execute(
        "SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'",
      )
    ).rows.length
  )
    tableSchema.push({ name: "sqlite_sequence" });
  for (const item of tableSchema) {
    const hashes = [];
    const columns = (
      await client.execute(`PRAGMA table_xinfo(${q(item.name)})`)
    ).rows.map((r) => r.name);
    for (let offset = 0; ; offset += 500) {
      const rows = (
        await client.execute(
          `SELECT * FROM ${q(item.name)} LIMIT 500 OFFSET ${offset}`,
        )
      ).rows;
      for (const row of rows)
        hashes.push(
          digest(
            json(
              columns.map((c) =>
                row[c] instanceof ArrayBuffer
                  ? { blob: Buffer.from(row[c]).toString("base64") }
                  : row[c],
              ),
            ),
          ),
        );
      if (rows.length < 500) break;
    }
    hashes.sort();
    tables.push({
      name: item.name,
      rows: hashes.length,
      sha256: digest(hashes.join("")),
    });
  }
  const integrity = (await client.execute("PRAGMA integrity_check")).rows;
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
    fail("SQLite integrity check failed.");
  // Preserve and report any historical FK violations instead of pretending a
  // backup repaired them. Restore compares these with the original inventory.
  const foreignKeys = (
    await client.execute("PRAGMA foreign_key_check")
  ).rows.map((r) => Array.from(r));
  const userVersion = Number(
    (await client.execute("PRAGMA user_version")).rows[0].user_version,
  );
  return { schema, tables, foreignKeys, userVersion };
}

export async function snapshotDatabase(config, destination, scratch) {
  let source = config.url;
  if (source.startsWith("file:")) {
    const info = await lstat(localPath(source));
    if (!info.isFile() || info.isSymbolicLink())
      fail("Database source must be a regular file.");
  } else {
    const replicaPath = join(scratch, randomUUID() + ".db");
    const replica = createClient({
      url: pathToFileURL(replicaPath).href,
      syncUrl: source,
      authToken: config.authToken,
    });
    try {
      await replica.sync();
    } finally {
      replica.close();
    }
    // Never VACUUM through a replication client: it could forward writes.
    source = pathToFileURL(replicaPath).href;
  }
  const db = createClient({ url: source, intMode: "bigint" });
  try {
    await db.execute({ sql: "VACUUM INTO ?", args: [destination] });
  } finally {
    db.close();
  }
  await chmod(destination, 0o600);
  const snapshot = createClient({
    url: pathToFileURL(destination).href,
    intMode: "bigint",
  });
  try {
    return await databaseInventory(snapshot);
  } finally {
    snapshot.close();
  }
}

async function encryptStream(input, output, key, aad, via = []) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const hash = createHash("sha256");
  let bytes = 0;
  const measure = new Transform({
    transform(chunk, _, next) {
      hash.update(chunk);
      bytes += chunk.length;
      next(null, chunk);
    },
  });
  await pipeline(
    input,
    ...via,
    measure,
    cipher,
    createWriteStream(output, { flags: "wx", mode: 0o600 }),
  );
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    sha256: hash.digest("hex"),
    bytes,
  };
}
async function decryptFile(input, output, key, meta, aad) {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(meta.iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(meta.tag, "base64"));
  cipher.setAAD(Buffer.from(aad));
  const hash = createHash("sha256");
  let bytes = 0;
  const measure = new Transform({
    transform(chunk, _, next) {
      hash.update(chunk);
      bytes += chunk.length;
      next(null, chunk);
    },
  });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await pipeline(
    createReadStream(input),
    cipher,
    measure,
    createWriteStream(output, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== meta.bytes || hash.digest("hex") !== meta.sha256)
    fail("Restored object digest mismatch.");
}
async function localMedia(root, directories) {
  const entries = [];
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name),
        relative = safePath(prefix + name),
        s = await lstat(file);
      if (s.isSymbolicLink()) fail("Media symlinks are refused.");
      if (s.isDirectory()) await walk(file, relative + "/");
      else if (s.isFile())
        entries.push({ pathname: relative, size: s.size, modified: s.mtimeMs });
      else fail("Media source contains a non-regular file.");
    }
  }
  if (!(await lstat(root)).isDirectory())
    fail("Media source must be a directory.");
  if (directories) {
    for (const directory of [...directories].sort()) {
      if (
        ![
          "generations",
          "uploads",
          "platform",
          "identities",
          "chunks",
        ].includes(directory)
      )
        fail("Invalid local media directory.");
      const path = join(root, directory);
      try {
        if (!(await lstat(path)).isDirectory())
          fail("Media source must be a directory.");
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      await walk(path, directory + "/");
    }
  } else await walk(root);
  return entries;
}
export async function blobInventory(token, sdk) {
  const entries = [];
  let cursor;
  do {
    const page = await sdk.list({
      token,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const b of page.blobs)
      entries.push({
        pathname: safePath(b.pathname),
        size: b.size,
        etag: b.etag,
        url: b.url,
        uploadedAt: new Date(b.uploadedAt).toISOString(),
      });
    if (page.hasMore && (!page.cursor || page.cursor === cursor))
      fail("Blob pagination did not advance.");
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
  if (new Set(entries.map((e) => e.pathname)).size !== entries.length)
    fail("Duplicate media path.");
  return entries;
}
/* ── Media configuration ───────────────────────────────────────────────
 * Every credential and location is an environment-variable NAME in the
 * config, never a value, exactly like blob's tokenEnv. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const R2_NAMES = ["accountIdEnv", "accessKeyIdEnv", "secretAccessKeyEnv", "bucketEnv"];
const R2_VALUE_FIELDS = ["accountId", "accessKeyId", "secretAccessKey", "bucket", "endpoint", "token"];
export const MEDIA_KINDS = ["local", "blob", "r2", "dual"];

function checkR2Spec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    fail("R2 media requires accountIdEnv, accessKeyIdEnv, secretAccessKeyEnv and bucketEnv.");
  if (R2_VALUE_FIELDS.some((field) => field in spec))
    fail("R2 credentials and locations must be named environment variables, never values in configuration.");
  for (const field of R2_NAMES)
    if (!ENV_NAME.test(spec[field] ?? ""))
      fail("R2 media requires accountIdEnv, accessKeyIdEnv, secretAccessKeyEnv and bucketEnv.");
  if (spec.endpointEnv !== undefined && !ENV_NAME.test(spec.endpointEnv))
    fail("R2 endpointEnv must name an environment variable.");
}
function checkBlobSpec(spec) {
  if (!spec || typeof spec !== "object" || !ENV_NAME.test(spec.tokenEnv ?? ""))
    fail("Private Blob media requires tokenEnv.");
  if ("token" in spec) fail("The Blob token must be a named environment variable.");
}
/** Shape check only (no values read). Returns the env var names the media
 * configuration depends on, so callers can export exactly those. */
export function mediaEnvNames(media) {
  if (!media || !MEDIA_KINDS.includes(media.kind))
    fail("An explicit local media root, private Blob store, R2 bucket or dual R2+Blob store is required.");
  const r2Names = (spec) => [...R2_NAMES.map((n) => spec[n]), ...(spec.endpointEnv ? [spec.endpointEnv] : [])];
  if (media.kind === "local") return [];
  if (media.kind === "blob") {
    checkBlobSpec(media);
    return [media.tokenEnv];
  }
  if (media.kind === "r2") {
    checkR2Spec(media);
    return r2Names(media);
  }
  if ([...R2_VALUE_FIELDS, ...R2_NAMES, "endpointEnv", "tokenEnv"].some((field) => field in media))
    fail("Dual media takes its R2 and Blob variable names under r2 and blob, never values in configuration.");
  checkR2Spec(media.r2);
  checkBlobSpec(media.blob);
  return [...r2Names(media.r2), media.blob.tokenEnv];
}

/** Resolves R2 names to values, the same way lib/storage/backend.ts reads
 * R2_* (endpoint defaults to https://<account>.r2.cloudflarestorage.com). */
export function r2Settings(spec, env = process.env) {
  checkR2Spec(spec);
  const accountId = secret(spec.accountIdEnv, env),
    bucket = secret(spec.bucketEnv, env);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(accountId)) fail("Invalid R2 account ID.");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) fail("Invalid R2 bucket name.");
  const endpoint = (
    spec.endpointEnv ? secret(spec.endpointEnv, env) : `https://${accountId}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail("Invalid R2 endpoint.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/"))
    fail("The R2 endpoint must be a bare https origin without credentials.");
  return {
    accountId,
    accessKeyId: secret(spec.accessKeyIdEnv, env),
    secretAccessKey: secret(spec.secretAccessKeyEnv, env),
    bucket,
    endpoint: parsed.origin,
  };
}
const s3sdk = () => import("@aws-sdk/client-s3");
/** The app's R2 client settings (lib/storage/r2.ts): path-style, region auto,
 * no SDK retries (ours restart a whole object), checksums only when required. */
export async function defaultR2Client(settings) {
  const { S3Client } = await s3sdk();
  return new S3Client({
    region: "auto",
    endpoint: settings.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
const httpStatus = (error) => error?.$metadata?.httpStatusCode;
const unquote = (etag) => (typeof etag === "string" ? etag.replace(/^"|"$/g, "") : undefined);
/** Integrity failures (OpsError) and definite 4xx answers are never retried;
 * network faults, broken streams, 408/429 and 5xx are. */
function transient(error) {
  if (error instanceof OpsError) return false;
  const status = httpStatus(error);
  if (status == null) return true;
  return status >= 500 || status === 429 || status === 408;
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
export function retrying({ attempts = 4, baseMs = 500, sleep = wait } = {}) {
  return async (operation) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt >= attempts || !transient(error)) throw error;
        await sleep(baseMs * 2 ** (attempt - 1));
      }
    }
  };
}
export function nodeStream(body) {
  if (body instanceof Readable) return body;
  if (typeof body?.transformToWebStream === "function") return Readable.fromWeb(body.transformToWebStream());
  if (typeof body?.getReader === "function") return Readable.fromWeb(body);
  return Readable.from(body);
}
export async function r2Inventory(client, bucket, retry = retrying()) {
  const { ListObjectsV2Command } = await s3sdk();
  const entries = [];
  let token;
  do {
    const page = await retry(() =>
      client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) })),
    );
    for (const item of page?.Contents ?? []) {
      if (typeof item.Key !== "string" || !Number.isSafeInteger(item.Size) || item.Size < 0)
        fail("R2 returned an invalid object listing.");
      entries.push({
        store: "r2",
        pathname: safePath(item.Key),
        size: item.Size,
        etag: unquote(item.ETag),
        uploadedAt: item.LastModified ? new Date(item.LastModified).toISOString() : null,
      });
    }
    if (page?.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token))
      fail("R2 pagination did not advance.");
    token = page?.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
  if (new Set(entries.map((e) => e.pathname)).size !== entries.length) fail("Duplicate media path.");
  return entries;
}
const PLAIN_MD5 = /^[0-9a-f]{32}$/i;
/** One R2 object as a stream, pinned to the listed ETag (If-Match), so an
 * object replaced after the inventory fails instead of mixing versions. */
async function openR2Object(client, bucket, entry) {
  const { GetObjectCommand } = await s3sdk();
  let out;
  try {
    out = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: entry.pathname, ...(entry.etag ? { IfMatch: `"${entry.etag}"` } : {}) }),
    );
  } catch (error) {
    if ([404, 412].includes(httpStatus(error))) fail("R2 object changed or disappeared during backup.");
    throw error;
  }
  if (!out?.Body || out.ContentLength !== entry.size || (entry.etag && unquote(out.ETag) !== entry.etag)) {
    out?.Body?.destroy?.();
    fail("R2 object changed or disappeared during backup.");
  }
  // A single-part R2 ETag is the object's MD5: check the bytes against it.
  const expectMd5 = PLAIN_MD5.test(entry.etag ?? "") ? entry.etag.toLowerCase() : null;
  const md5 = createHash("md5");
  return {
    input: nodeStream(out.Body),
    via: [
      new Transform({
        transform(chunk, _, next) {
          md5.update(chunk);
          next(null, chunk);
        },
      }),
    ],
    contentType: out.ContentType,
    check() {
      if (expectMd5 && md5.digest("hex") !== expectMd5) fail("R2 object bytes do not match its ETag.");
    },
  };
}
async function openBlobObject(sdk, token, entry) {
  const result = await sdk.get(entry.pathname, { token, access: "private", useCache: false });
  if (
    !result ||
    result.statusCode !== 200 ||
    result.blob.size !== entry.size ||
    (entry.etag && result.blob.etag !== entry.etag)
  )
    fail("Private Blob changed or disappeared during backup.");
  return { input: Readable.fromWeb(result.stream), contentType: result.blob.contentType };
}

/** The media stores a config captures. Dual = the production layout under
 * STORAGE_BACKEND=r2 with BLOB_READ_WRITE_TOKEN kept: R2 first, Blob fallback. */
async function mediaStores(media, env, destination, { blobSdk, r2Client } = {}) {
  mediaEnvNames(media);
  const stores = [];
  const blobSpec = media.kind === "blob" ? media : media.kind === "dual" ? media.blob : null;
  const r2Spec = media.kind === "r2" ? media : media.kind === "dual" ? media.r2 : null;
  if (r2Spec) {
    const settings = r2Settings(r2Spec, env);
    const client = await (r2Client ?? defaultR2Client)(settings);
    stores.push({
      store: "r2",
      remote: true,
      inventory: (retry) => r2Inventory(client, settings.bucket, retry),
      open: (entry) => openR2Object(client, settings.bucket, entry),
      close: () => client.destroy?.(),
    });
  }
  if (blobSpec) {
    const sdk = blobSdk ?? (await import("@vercel/blob"));
    const token = secret(blobSpec.tokenEnv, env);
    stores.push({
      store: "blob",
      remote: true,
      inventory: async () => (await blobInventory(token, sdk)).map((e) => ({ store: "blob", ...e })),
      open: (entry) => openBlobObject(sdk, token, entry),
    });
  }
  if (media.kind === "local") {
    if (typeof media.root !== "string" || !media.root) fail("Local media requires an explicit root.");
    const root = resolve(media.root);
    if (resolve(destination) === root || resolve(destination).startsWith(root + sep))
      fail("Backup destination cannot be inside its media source.");
    stores.push({
      store: "local",
      remote: false,
      inventory: async () => (await localMedia(root, media.directories)).map((e) => ({ store: "local", ...e })),
      open: async (entry) => ({ input: createReadStream(join(root, entry.pathname)) }),
    });
  }
  return stores;
}
/** Archive path of a media object. Single-store layouts keep media/<key>;
 * dual keeps both stores apart because a migrated key exists in each. */
const mediaArchivePath = (kind, entry) =>
  kind === "dual" ? `media/${entry.store}/${entry.pathname}` : `media/${entry.pathname}`;

/** Media entries as recorded in a manifest (or a restored inventory.json). */
export function manifestMediaEntries(manifest) {
  return manifest.files
    .filter((f) => f.kind === "media")
    .map((f) => ({
      store: f.store ?? manifest.mediaKind,
      pathname: safePath(f.pathname),
      url: f.originalUrl,
      path: safePath(f.path),
      bytes: f.bytes,
      sha256: f.sha256,
      contentType: f.contentType,
    }));
}

export async function verifyPlatformCoverage(databases, keyring) {
  const platform = databases.find((d) => d.role === "platform");
  const db = createClient({
    url: pathToFileURL(platform.snapshot).href,
    intMode: "bigint",
  });
  let sealedValues = 0;
  try {
    const names = new Set(platform.inventory.tables.map((t) => t.name));
    for (const table of names) {
      const fields = (await db.execute(`PRAGMA table_info(${q(table)})`)).rows
        .filter((r) => String(r.name).endsWith("_enc"))
        .map((r) => r.name);
      for (const field of fields)
        for (const row of (
          await db.execute(
            `SELECT ${q(field)} AS value FROM ${q(table)} WHERE ${q(field)} IS NOT NULL AND ${q(field)}<>''`,
          )
        ).rows) {
          openKeyring(row.value, keyring);
          sealedValues++;
        }
    }
    for (const table of ["workspaces", "workspace_provisioning"]) {
      if (!names.has(table)) continue;
      for (const row of (await db.execute(`SELECT * FROM ${q(table)}`)).rows) {
        if (
          row.purged_at != null ||
          (table === "workspace_provisioning" && !row.db_url)
        )
          continue;
        const workspaceId = table === "workspaces" ? row.id : row.workspace_id;
        const source = databases.find((d) =>
          d.workspaceIds.includes(workspaceId),
        );
        if (!source)
          fail(
            "A workspace or pending provisioned database is missing from the explicit source inventory.",
          );
        if (!row.legacy && row.db_url !== source.sourceUrl)
          fail("Workspace database source does not match its platform record.");
      }
    }
  } finally {
    db.close();
  }
  return sealedValues;
}

const BLOB_HOST = ".vercel-storage.com";
const GENERATION_EXT = { image: "png", audio: "mp3", model: "glb" };
const outside = () =>
  fail("Media referenced by an absolute URL is outside this private store inventory.");

/** How lib/storage resolves a stored value to an object, per media kind.
 * blob: keys and URLs on the Blob store. r2: keys on R2; an absolute Blob URL
 * is read from R2 at its decoded pathname (no fallback without a Blob token).
 * dual (STORAGE_BACKEND=r2 with the Blob token kept): R2 first, then Blob at
 * the same key, or at the original URL for an absolute Blob URL. */
export function mediaResolver(entries, kind) {
  if (!MEDIA_KINDS.includes(kind)) fail("Unknown media kind in the inventory.");
  const stores = { local: new Map(), blob: new Map(), r2: new Map() },
    blobUrls = new Map();
  for (const entry of entries) {
    const store = stores[entry.store];
    if (!store || store.has(entry.pathname)) fail("Duplicate or unknown media store entry.");
    store.set(entry.pathname, entry);
    if (entry.store === "blob" && entry.url) blobUrls.set(entry.url, entry);
  }
  return {
    cloud: kind !== "local",
    key(key) {
      if (kind === "dual") return stores.r2.get(key) ?? stores.blob.get(key) ?? null;
      return stores[kind].get(key) ?? null;
    },
    /** { key, entry } for an absolute URL; unknown hosts are refused like the app does. */
    url(stored) {
      let parsed, key;
      try {
        parsed = new URL(stored);
        key = decodeURIComponent(parsed.pathname.slice(1));
      } catch {
        outside();
      }
      if (kind === "blob") return { key, entry: blobUrls.get(stored) ?? outside() };
      if (!parsed.hostname.toLowerCase().endsWith(BLOB_HOST)) outside();
      const entry = stores.r2.get(key) ?? (kind === "dual" ? blobUrls.get(stored) : null) ?? null;
      return { key, entry };
    },
  };
}

/** Every object a database row points at must resolve, by the app's rule,
 * to an object in the captured inventory. Missing objects are named by
 * database/table/row only: a key or URL can carry a customer's file name. onReference receives each
 * resolved reference, for restore/report/prepare. */
export async function verifyMediaReferences(databases, entries, kind, { onReference } = {}) {
  const resolver = mediaResolver(entries, kind);
  const platform = databases.find((d) => d.role === "platform");
  const p = createClient({ url: pathToFileURL(platform.snapshot).href });
  let workspaces;
  try {
    workspaces = platform.inventory.tables.some((t) => t.name === "workspaces")
      ? (await p.execute("SELECT * FROM workspaces")).rows
      : [];
  } finally {
    p.close();
  }
  let references = 0;
  const byStore = {},
    missing = [];
  const found = (reference, entry) => {
    if (!entry) {
      missing.push(`${reference.database}/${reference.table}/${reference.id}`);
      return;
    }
    references++;
    byStore[entry.store] = (byStore[entry.store] ?? 0) + 1;
    onReference?.({ ...reference, entry });
  };
  for (const source of databases) {
    const names = new Set(source.inventory.tables.map((t) => t.name));
    const workspace = workspaces.find((w) =>
      source.workspaceIds.includes(w.id),
    );
    // Local disk keeps its own flat layout; cloud keys carry the workspace prefix.
    const prefix =
      resolver.cloud && workspace && !workspace.legacy
        ? `ws/${workspace.id}/`
        : "";
    const db = createClient({ url: pathToFileURL(source.snapshot).href });
    try {
      if (names.has("platform_assets"))
        for (const row of (await db.execute("SELECT path FROM platform_assets"))
          .rows) {
          const key = String(row.path);
          found({ database: source.id, table: "platform_assets", id: key, key, localPath: key }, resolver.key(key));
        }
      if (names.has("generations"))
        for (const row of (
          await db.execute("SELECT * FROM generations WHERE status='succeeded'")
        ).rows) {
          if (!row.stored_url || row.deleted) continue;
          const file = `generations/${row.id}.${GENERATION_EXT[row.kind] ?? "mp4"}`;
          found({ database: source.id, table: "generations", id: String(row.id), key: prefix + file, localPath: file }, resolver.key(prefix + file));
        }
      for (const table of ["uploads", "workbench_media"]) {
        if (!names.has(table)) continue;
        for (const row of (await db.execute(`SELECT * FROM ${q(table)}`))
          .rows) {
          const file = `uploads/${row.id}.${row.ext}`,
            deterministic = prefix + file,
            stored = row.stored_url == null ? "" : String(row.stored_url);
          const reference = { database: source.id, table, id: String(row.id), localPath: file, deterministic };
          if (resolver.cloud && /^https?:/.test(stored)) {
            const { key, entry } = resolver.url(stored);
            found({ ...reference, key, absolute: stored }, entry);
          } else if (resolver.cloud && stored && !stored.startsWith("/api/")) {
            // A bare stored key is read as-is by the app (resolveStored).
            found({ ...reference, key: stored }, resolver.key(stored));
          } else found({ ...reference, key: deterministic }, resolver.key(deterministic));
        }
      }
    } finally {
      db.close();
    }
  }
  if (missing.length)
    fail(
      `Media referenced by a database is missing from the storage inventory (${missing.length}): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", ..." : ""}`,
    );
  return { references, byStore };
}

export async function createBackup(
  config,
  destination,
  { env = process.env, blobSdk, r2Client, retryOptions } = {},
) {
  await absent(destination);
  const key = backupKey(env),
    keyring = secret("KEYRING_SECRET", env);
  mediaEnvNames(config.media);
  if (
    config.version !== 1 ||
    config.quiesced !== true ||
    !config.label ||
    !Array.isArray(config.databases) ||
    config.databases.filter((d) => d.role === "platform").length !== 1
  )
    fail(
      "A version 1 source inventory with one platform database and quiesced=true is required.",
    );
  if (
    new Set(config.databases.map((d) => d.id)).size !==
      config.databases.length ||
    config.databases.some((d) => !/^[a-zA-Z0-9_-]{1,80}$/.test(d.id))
  )
    fail("Database IDs must be unique simple names.");
  const scratch = await privateTemp(destination),
    bundle = join(scratch, "bundle");
  await mkdir(bundle, { mode: 0o700 });
  try {
    const databases = [];
    for (const spec of config.databases) {
      const configDb = connection(spec, env),
        snapshot = join(scratch, spec.id + ".db");
      const inventory = await snapshotDatabase(configDb, snapshot, scratch);
      databases.push({
        id: spec.id,
        role: spec.role,
        workspaceIds: spec.workspaceIds ?? [],
        sourceUrl: configDb.url,
        snapshot,
        inventory,
      });
    }
    const sealedValues = await verifyPlatformCoverage(databases, keyring);
    const files = [];
    const retry = retrying(retryOptions);
    /** open() yields { input, contentType?, check? }. Cloud media is retried
     * whole: a failed attempt's partial ciphertext is removed and the object
     * is fetched again from the start (memory stays one stream chunk). */
    async function add(open, path, extra = {}, { retried = false, size } = {}) {
      const object = String(files.length).padStart(8, "0") + ".enc",
        output = join(bundle, object);
      const attempt = async () => {
        await rm(output, { force: true });
        const { input, via, contentType, check } = await open();
        const meta = await encryptStream(input, output, key, `${FORMAT}:${object}:${path}`, via);
        if (size !== undefined && meta.bytes !== size) fail("Media size changed during backup.");
        check?.();
        return { ...(contentType ? { contentType } : {}), ...meta };
      };
      const meta = retried ? await retry(attempt) : await attempt();
      files.push({ object, path, ...extra, ...meta });
    }
    for (const db of databases)
      await add(async () => ({ input: createReadStream(db.snapshot) }), `databases/${db.id}.db`, {
        kind: "database",
        databaseId: db.id,
      });
    const media = config.media;
    const stores = await mediaStores(media, env, destination, { blobSdk, r2Client });
    let mediaReferences, mediaCoverage, mediaCount;
    try {
      const inventory = async () => {
        const entries = [];
        for (const store of stores) entries.push(...(await store.inventory(retry)));
        return entries;
      };
      const mediaBefore = await inventory();
      const coverage = await verifyMediaReferences(databases, mediaBefore, media.kind);
      const byStore = new Map(stores.map((s) => [s.store, s]));
      for (const entry of mediaBefore) {
        const store = byStore.get(entry.store);
        await add(() => store.open(entry), mediaArchivePath(media.kind, entry), {
          kind: "media",
          store: entry.store,
          pathname: entry.pathname,
          originalUrl: entry.url,
        }, { retried: store.remote, size: entry.size });
      }
      const mediaAfter = await inventory();
      if (json(mediaBefore) !== json(mediaAfter))
        fail("Media inventory changed; quiesce writers and repeat the backup.");
      mediaReferences = coverage.references;
      mediaCoverage = coverage.byStore;
      mediaCount = mediaBefore.length;
    } finally {
      for (const store of stores) store.close?.();
    }
    const createdAt = new Date().toISOString();
    const manifest = {
      format: FORMAT,
      createdAt,
      label: config.label,
      sourceCommit: config.sourceCommit ?? null,
      quiesced: true,
      keyringSecret: keyring,
      sealedValues,
      mediaReferences,
      mediaCoverage,
      mediaKind: media.kind,
      databases: databases.map((d) => ({
        id: d.id,
        role: d.role,
        workspaceIds: d.workspaceIds,
        sourceUrl: d.sourceUrl,
        inventory: d.inventory,
      })),
      files,
    };
    const manifestMeta = await encryptStream(
      Readable.from([Buffer.from(json(manifest))]),
      join(bundle, "manifest.enc"),
      key,
      `${FORMAT}:manifest`,
    );
    await privateFile(
      join(bundle, "header.json"),
      json({ format: FORMAT, manifest: manifestMeta }),
    );
    await rename(bundle, resolve(destination));
    return {
      databases: databases.length,
      media: mediaCount,
      sealedValues,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      createdAt,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function loadManifest(bundle, key, scratch) {
  const header = await readJson(join(bundle, "header.json"));
  if (header.format !== FORMAT || header.manifest.bytes > 64 * 1024 * 1024)
    fail("Unsupported or oversized backup manifest.");
  const path = join(scratch, "manifest.json");
  await decryptFile(
    join(bundle, "manifest.enc"),
    path,
    key,
    header.manifest,
    `${FORMAT}:manifest`,
  );
  const manifest = await readJson(path);
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files))
    fail("Invalid backup manifest.");
  const paths = new Set(),
    objects = new Set();
  for (const f of manifest.files) {
    safePath(f.path);
    if (
      !/^(databases\/[a-zA-Z0-9_-]+\.db|media\/.+)$/.test(f.path) ||
      !/^\d{8}\.enc$/.test(f.object) ||
      paths.has(f.path) ||
      objects.has(f.object)
    )
      fail("Invalid or repeated backup object.");
    paths.add(f.path);
    objects.add(f.object);
    const info = await lstat(join(bundle, f.object));
    if (!info.isFile() || info.isSymbolicLink())
      fail("Archive objects must be regular files.");
  }
  return manifest;
}
export async function restoreBackup(
  bundle,
  destination,
  { env = process.env } = {},
) {
  await absent(destination);
  const key = backupKey(env),
    scratch = await privateTemp(destination),
    output = join(scratch, "restored");
  await mkdir(output, { mode: 0o700 });
  try {
    const manifest = await loadManifest(resolve(bundle), key, scratch);
    for (const f of manifest.files)
      await decryptFile(
        join(bundle, f.object),
        join(output, f.path),
        key,
        f,
        `${FORMAT}:${f.object}:${f.path}`,
      );
    for (const d of manifest.databases) {
      const path = join(output, "databases", safePath(d.id) + ".db");
      const client = createClient({
        url: pathToFileURL(path).href,
        intMode: "bigint",
      });
      try {
        if (json(await databaseInventory(client)) !== json(d.inventory))
          fail("Restored SQLite contents differ from the backup inventory.");
      } finally {
        client.close();
      }
    }
    const sealedValues = await verifyPlatformCoverage(
      manifest.databases.map((d) => ({
        ...d,
        snapshot: join(output, "databases", d.id + ".db"),
      })),
      manifest.keyringSecret,
    );
    // Every referenced object resolves (by the app's rule) to a restored,
    // digest-checked file. Older manifests without a media kind predate this.
    if (manifest.mediaKind)
      await verifyMediaReferences(
        manifest.databases.map((d) => ({ ...d, snapshot: join(output, "databases", d.id + ".db") })),
        manifestMediaEntries(manifest),
        manifest.mediaKind,
      );
    await privateFile(
      join(output, "recovery-secrets.json"),
      json({ KEYRING_SECRET: manifest.keyringSecret }),
    );
    const safeManifest = { ...manifest };
    delete safeManifest.keyringSecret;
    await privateFile(join(output, "inventory.json"), json(safeManifest));
    await privateFile(
      join(output, "OFFLINE-RESTORE.txt"),
      "Do not start the application against these unchanged snapshots. They retain original database URLs, credentials, sessions, tombstones and paid-job claims. Follow docs/backup-restore.md before any network connection.\n",
    );
    await rename(output, resolve(destination));
    return {
      databases: manifest.databases.length,
      media: manifest.files.filter((f) => f.kind === "media").length,
      mediaKind: manifest.mediaKind ?? null,
      // Object counts per store (r2, blob, local): no key, URL or name.
      mediaByStore: manifest.files
        .filter((f) => f.kind === "media")
        .reduce((counts, f) => ({ ...counts, [f.store ?? "unknown"]: (counts[f.store ?? "unknown"] ?? 0) + 1 }), {}),
      sealedValues,
      verified: true,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyDatabase(
  snapshot,
  targetSpec,
  { env = process.env } = {},
) {
  const local = createClient({
      url: pathToFileURL(resolve(snapshot)).href,
      intMode: "bigint",
    }),
    remote = createClient(connection(targetSpec, env));
  try {
    const before = await databaseInventory(local),
      after = await databaseInventory(remote);
    if (json(before) !== json(after))
      fail("Target database does not match the restored snapshot.");
    return {
      verified: true,
      tables: before.tables.length,
      rows: before.tables.reduce((n, t) => n + t.rows, 0),
    };
  } finally {
    local.close();
    remote.close();
  }
}

export async function restoreBlobs(
  restored,
  spec,
  { env = process.env, blobSdk } = {},
) {
  if (spec.confirmEmptyPrivateStore !== true)
    fail(
      "Confirm a dedicated empty private restore store in the target config.",
    );
  const sdk = blobSdk ?? (await import("@vercel/blob")),
    token = secret(spec.tokenEnv, env);
  if ((await blobInventory(token, sdk)).length)
    fail(
      "Blob restore target is not empty. No existing object will be overwritten.",
    );
  const inventory = await readJson(join(restored, "inventory.json"));
  if (inventory.mediaKind !== "blob")
    fail("Only a private Blob backup has cloud-compatible media pathnames.");
  let verified = 0;
  const urls = [];
  for (const f of inventory.files.filter((f) => f.kind === "media")) {
    safePath(f.path);
    safePath(f.pathname);
    const source = join(restored, f.path);
    const measure = createHash("sha256");
    for await (const chunk of createReadStream(source)) measure.update(chunk);
    if (
      measure.digest("hex") !== f.sha256 ||
      (await stat(source)).size !== f.bytes
    )
      fail("Local restored media changed before cloud upload.");
    const put = await sdk.put(f.pathname, createReadStream(source), {
      token,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      multipart: true,
      ...(f.contentType ? { contentType: f.contentType } : {}),
    });
    const result = await sdk.get(f.pathname, {
      token,
      access: "private",
      useCache: false,
    });
    if (!result || result.statusCode !== 200)
      fail("Restored Blob cannot be read back.");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of Readable.fromWeb(result.stream)) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== f.bytes || hash.digest("hex") !== f.sha256)
      fail("Restored Blob readback did not match.");
    urls.push({
      pathname: f.pathname,
      originalUrl: f.originalUrl,
      url: put?.url,
    });
    verified++;
  }
  if ((await blobInventory(token, sdk)).length !== verified)
    fail("Blob target inventory changed during restore.");
  await privateFile(join(restored, "blob-restore-urls.json"), json(urls));
  return { verified: true, media: verified };
}

export async function fileDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
const R2_SINGLE_PUT_MAX = 100 * 1024 * 1024,
  R2_RESTORE_PART = 64 * 1024 * 1024;
/** Conditional (If-None-Match: *) write of one local file. A 412 on a
 * retry means an earlier attempt landed; the caller's readback digest
 * decides. `what` names the target in the refusal message. */
export async function putR2File(client, bucket, key, file, entry, retry, { singleMax = R2_SINGLE_PUT_MAX, partSize = R2_RESTORE_PART, what = "R2 restore target" } = {}) {
  const s3 = await s3sdk();
  const taken = () => fail(`${what} already holds this key. No existing object will be overwritten.`);
  const contentType = entry.contentType ? { ContentType: entry.contentType } : {};
  if (entry.bytes <= singleMax) {
    await retry(async (attempt) => {
      try {
        await client.send(
          new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: entry.bytes, IfNoneMatch: "*", ...contentType }),
        );
      } catch (error) {
        if (httpStatus(error) === 412 && attempt > 1) return;
        if (httpStatus(error) === 412) taken();
        throw error;
      }
    });
    return;
  }
  const created = await retry(() => client.send(new s3.CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ...contentType })));
  const uploadId = created?.UploadId;
  if (!uploadId) fail("R2 did not acknowledge the multipart restore upload.");
  try {
    const parts = [];
    for (let start = 0, number = 1; start < entry.bytes; start += partSize, number++) {
      const end = Math.min(entry.bytes, start + partSize) - 1;
      const out = await retry(() =>
        client.send(
          new s3.UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: createReadStream(file, { start, end }), ContentLength: end - start + 1 }),
        ),
      );
      if (!out?.ETag) fail("R2 did not acknowledge a restored part.");
      parts.push({ PartNumber: number, ETag: out.ETag });
    }
    // A dropped completion is retried. On a retry, 412 (the key now exists)
    // or 404 (the upload id is already consumed) means an earlier attempt
    // may have landed: the caller's read-back digest decides.
    await retry(async (attempt) => {
      try {
        await client.send(
          new s3.CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts }, IfNoneMatch: "*" }),
        );
      } catch (error) {
        if (attempt > 1 && [404, 412].includes(httpStatus(error))) return;
        throw error;
      }
    });
  } catch (error) {
    await client.send(new s3.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
    if (httpStatus(error) === 412) taken();
    throw error;
  }
}

/** Reads one stored object back in full and returns its SHA-256 and size. */
export async function r2ObjectDigest(client, bucket, key, retry = retrying(), missing = "R2 object cannot be read back.") {
  const { GetObjectCommand } = await s3sdk();
  return retry(async () => {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out?.Body) fail(missing);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of nodeStream(out.Body)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { sha256: hash.digest("hex"), bytes };
  });
}
/** Uploads a verified offline restore into a NEW, EMPTY R2 bucket, with the
 * keys the app reads: R2 objects at their key and Blob objects at their
 * pathname (a Blob copy shadowed by an R2 object of the same key is not read
 * by the app and is not uploaded). Every object is read back and checked by
 * SHA-256 and size. Writes r2-restore-keys.json for prepare. */
export async function restoreR2(
  restored,
  spec,
  { env = process.env, r2Client, retryOptions, singleMax = R2_SINGLE_PUT_MAX, partSize = R2_RESTORE_PART } = {},
) {
  if (spec?.confirmEmptyBucket !== true)
    fail("Confirm a dedicated empty private restore bucket in the target config.");
  const settings = r2Settings(spec, env);
  const inventory = await readJson(join(restored, "inventory.json"));
  if (!["blob", "r2", "dual"].includes(inventory.mediaKind))
    fail("Only a Blob, R2 or dual backup has cloud-compatible media keys.");
  const retry = retrying(retryOptions);
  const client = await (r2Client ?? defaultR2Client)(settings);
  try {
    if ((await r2Inventory(client, settings.bucket, retry)).length)
      fail("R2 restore target is not empty. No existing object will be overwritten.");
    const entries = manifestMediaEntries(inventory);
    const r2Keys = new Set(entries.filter((e) => e.store === "r2").map((e) => e.pathname));
    const plan = [];
    let shadowed = 0;
    for (const entry of entries) {
      if (entry.store === "blob") {
        if (entry.url) {
          let key;
          try {
            key = decodeURIComponent(new URL(entry.url).pathname.slice(1));
          } catch {
            key = null;
          }
          if (key !== entry.pathname)
            fail("A Blob URL does not match its pathname; it cannot be mapped to an R2 key.");
        }
        if (r2Keys.has(entry.pathname)) {
          shadowed++;
          continue;
        }
      } else if (entry.store !== "r2") fail("Local media has no cloud key layout.");
      plan.push(entry);
    }
    const record = [];
    for (const entry of plan) {
      const source = join(restored, entry.path);
      const local = await fileDigest(source);
      if (local.sha256 !== entry.sha256 || local.bytes !== entry.bytes)
        fail("Local restored media changed before cloud upload.");
      await putR2File(client, settings.bucket, entry.pathname, source, entry, retry, { singleMax, partSize });
      const readback = await r2ObjectDigest(client, settings.bucket, entry.pathname, retry, "Restored R2 object cannot be read back.");
      if (readback.bytes !== entry.bytes || readback.sha256 !== entry.sha256)
        fail("Restored R2 readback did not match.");
      record.push({
        key: entry.pathname,
        store: entry.store,
        pathname: entry.pathname,
        originalUrl: entry.url ?? null,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    }
    if ((await r2Inventory(client, settings.bucket, retry)).length !== record.length)
      fail("R2 target inventory changed during restore.");
    await privateFile(join(restored, "r2-restore-keys.json"), json(record));
    return { verified: true, media: record.length, shadowedBlobCopies: shadowed };
  } finally {
    client.destroy?.();
  }
}
