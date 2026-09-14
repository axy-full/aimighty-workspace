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
function safePath(value) {
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

async function encryptStream(input, output, key, aad) {
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

async function verifyMediaReferences(databases, entries, kind) {
  const paths = new Set(entries.map((e) => e.pathname));
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
  const need = (path) => {
    if (!paths.has(path))
      fail(
        "Media referenced by a database is missing from the storage inventory.",
      );
    references++;
  };
  for (const source of databases) {
    const names = new Set(source.inventory.tables.map((t) => t.name));
    const workspace = workspaces.find((w) =>
      source.workspaceIds.includes(w.id),
    );
    const prefix =
      kind === "blob" && workspace && !workspace.legacy
        ? `ws/${workspace.id}/`
        : "";
    const db = createClient({ url: pathToFileURL(source.snapshot).href });
    try {
      if (names.has("platform_assets"))
        for (const row of (await db.execute("SELECT path FROM platform_assets"))
          .rows)
          need(row.path);
      if (names.has("generations"))
        for (const row of (
          await db.execute("SELECT * FROM generations WHERE status='succeeded'")
        ).rows) {
          if (!row.stored_url || row.deleted) continue;
          const ext =
            row.kind === "image" ? "png" : row.kind === "audio" ? "mp3" : "mp4";
          need(`${prefix}generations/${row.id}.${ext}`);
        }
      for (const table of ["uploads", "workbench_media"]) {
        if (!names.has(table)) continue;
        for (const row of (await db.execute(`SELECT * FROM ${q(table)}`))
          .rows) {
          if (kind === "blob" && /^https?:/.test(row.stored_url)) {
            const entry = entries.find((e) => e.url === row.stored_url);
            if (!entry)
              fail(
                "Media referenced by an absolute URL is outside this private store inventory.",
              );
            need(entry.pathname);
          } else need(`${prefix}uploads/${row.id}.${row.ext}`);
        }
      }
    } finally {
      db.close();
    }
  }
  return references;
}

export async function createBackup(
  config,
  destination,
  { env = process.env, blobSdk } = {},
) {
  await absent(destination);
  const key = backupKey(env),
    keyring = secret("KEYRING_SECRET", env);
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
    async function add(input, path, extra = {}) {
      const object = String(files.length).padStart(8, "0") + ".enc";
      const meta = await encryptStream(
        input,
        join(bundle, object),
        key,
        `${FORMAT}:${object}:${path}`,
      );
      files.push({ object, path, ...extra, ...meta });
    }
    for (const db of databases)
      await add(createReadStream(db.snapshot), `databases/${db.id}.db`, {
        kind: "database",
        databaseId: db.id,
      });
    const media = config.media;
    if (!media || !["local", "blob"].includes(media.kind))
      fail("An explicit local media root or private Blob store is required.");
    const sdk =
      media.kind === "blob"
        ? (blobSdk ?? (await import("@vercel/blob")))
        : null;
    const token = sdk ? secret(media.tokenEnv, env) : null;
    const root = media.kind === "local" ? resolve(media.root) : null;
    if (
      root &&
      (resolve(destination) === root ||
        resolve(destination).startsWith(root + sep))
    )
      fail("Backup destination cannot be inside its media source.");
    const mediaBefore = sdk
      ? await blobInventory(token, sdk)
      : await localMedia(root, media.directories);
    const mediaReferences = await verifyMediaReferences(
      databases,
      mediaBefore,
      media.kind,
    );
    for (const entry of mediaBefore) {
      let input, contentType;
      if (sdk) {
        const result = await sdk.get(entry.pathname, {
          token,
          access: "private",
          useCache: false,
        });
        if (
          !result ||
          result.statusCode !== 200 ||
          result.blob.size !== entry.size ||
          (entry.etag && result.blob.etag !== entry.etag)
        )
          fail("Private Blob changed or disappeared during backup.");
        input = Readable.fromWeb(result.stream);
        contentType = result.blob.contentType;
      } else input = createReadStream(join(root, entry.pathname));
      await add(input, `media/${entry.pathname}`, {
        kind: "media",
        pathname: entry.pathname,
        originalUrl: entry.url,
        contentType,
      });
      if (files.at(-1).bytes !== entry.size)
        fail("Media size changed during backup.");
    }
    const mediaAfter = sdk
      ? await blobInventory(token, sdk)
      : await localMedia(root, media.directories);
    if (json(mediaBefore) !== json(mediaAfter))
      fail("Media inventory changed; quiesce writers and repeat the backup.");
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
      media: mediaBefore.length,
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
