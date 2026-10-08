import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, appendFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { OpsError } from "./ops-error.mjs";

export const FRESHNESS_MS = 26 * 60 * 60 * 1000;
export function sourceFingerprint(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
export function assertQuiescence(config, value, at = Date.now()) {
  const enforced = value?.protocol === "particl-recovery-fence-v1";
  const issued = enforced ? value.issuedAt : Date.parse(value?.issuedAt),
    expires = enforced ? value.expiresAt : Date.parse(value?.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > at + 60_000 ||
    issued < at - 2 * 60 * 60_000 ||
    expires <= at ||
    expires - issued > 2 * 60 * 60_000
  )
    throw new OpsError(
      "A fresh quiescence confirmation, valid for no more than two hours, is required.",
    );
  if (
    value.sourceFingerprint !== sourceFingerprint(config) ||
    (!enforced && (value.mutationsPaused !== true ||
    value.workersPaused !== true ||
    value.uploadsPaused !== true ||
    value.provisioningPaused !== true ||
    value.purgePaused !== true))
  )
    throw new OpsError(
      "Quiescence must cover these exact sources and every mutating service.",
    );
}

/** Read-only, no app imports: this cannot release held jobs or reconcile by
 * submitting a provider request. The operator's maintenance fence must remain
 * enforced; these checks alone cannot prevent a later writer starting. */
export async function assertNoActiveOrUncertain(config, env) {
  const { createClient } = await import("@libsql/client");
  const { connection } = await import("./backup-lib.mjs");
  for (const spec of config.databases) {
    const db = createClient(connection(spec, env));
    try {
      const names = new Set(
        (
          await db.execute("SELECT name FROM sqlite_schema WHERE type='table'")
        ).rows.map((r) => r.name),
      );
      const blocked = () => {
        throw new OpsError(
          "Backup refused: live or uncertain work requires reconciliation before capture.",
        );
      };
      for (const table of [
        "generations",
        "paid_text_jobs",
        "workbench_atomik_jobs",
        "workbench_development_jobs",
        "identity_training_runs",
      ]) {
        if (!names.has(table)) continue;
        if (
          (
            await db.execute(
              `SELECT 1 FROM ${table} WHERE status IN ('queued','running','processing','submitting','uncertain') LIMIT 1`,
            )
          ).rows.length
        )
          blocked();
        if (table === "generations") {
          for (const row of (
            await db.execute(
              "SELECT params,cost_usd FROM generations WHERE status='failed'",
            )
          ).rows) {
            let params;
            try {
              params = JSON.parse(row.params);
            } catch {
              blocked();
            }
            if (
              params?.paidClaim &&
              (row.cost_usd == null || Number(row.cost_usd) > 0)
            )
              blocked();
          }
        }
      }
      // Native Blender renders settle independently of their status word: an
      // unsettled row may still hold a compute reservation, a claimed VM or
      // an uncollected receipt, none of which a checkpoint may hide.
      if (names.has("astra_render_jobs") &&
          (await db.execute("SELECT 1 FROM astra_render_jobs WHERE COALESCE(settled,0)=0 LIMIT 1")).rows.length) blocked();
      // Consumer jobs use Higgsfield credits and their own status vocabulary.
      // A dispatch claim, accepted remote job or uncertain admission must not
      // disappear behind a successful scheduled checkpoint.
      if (names.has("higgsfield_consumer_jobs") &&
          (await db.execute("SELECT 1 FROM higgsfield_consumer_jobs WHERE status IS NULL OR status NOT IN ('quoted','failed','completed') LIMIT 1")).rows.length) blocked();
      // Media import happens before a quote exists. Its permanent claim must
      // remain visible even when no generation could yet have been admitted.
      if (names.has("higgsfield_consumer_media_imports") &&
          (await db.execute("SELECT 1 FROM higgsfield_consumer_media_imports WHERE state IS NULL OR state<>'ready' OR media_id IS NULL LIMIT 1")).rows.length) blocked();
      // Collection has an independent lease and reserved-byte receipt. A
      // terminal provider job does not prove its private storage write settled.
      if (names.has("consumer_video_originals") && (await db.execute({
        sql: "SELECT 1 FROM consumer_video_originals WHERE COALESCE(state,'preparing')<>'stored' AND (COALESCE(bytes,0)>0 OR COALESCE(lease_until,0)>?) LIMIT 1",
        args: [Date.now()],
      })).rows.length) blocked();
      if (names.has("workbench_development_jobs") &&
          (await db.execute("SELECT 1 FROM workbench_development_jobs WHERE settled=0 LIMIT 1")).rows.length) blocked();
      // Queued phases may remain on a terminal failed workflow. Only started
      // or uncertain attempts require reconciliation independently of its job.
      if (names.has("workbench_development_steps") &&
          (await db.execute("SELECT 1 FROM workbench_development_steps WHERE status IN ('running','uncertain') LIMIT 1")).rows.length) blocked();
      if (
        names.has("generation_settlements") &&
        (await db.execute("SELECT 1 FROM generation_settlements WHERE settled_at IS NULL LIMIT 1")).rows.length
      ) blocked();
      if (names.has("soul_identities") &&
          (await db.execute("SELECT 1 FROM soul_identities WHERE purged_at IS NULL AND (settled_at IS NULL OR status NOT IN ('ready','failed')) LIMIT 1")).rows.length) blocked();
      if (names.has("higgsfield_generation_receipts") &&
          (await db.execute("SELECT 1 FROM higgsfield_generation_receipts WHERE settled_at IS NULL LIMIT 1")).rows.length) blocked();
      if (names.has("soul_training_receipts") &&
          (await db.execute("SELECT 1 FROM soul_training_receipts WHERE settled_at IS NULL OR provider_status NOT IN ('completed','failed') LIMIT 1")).rows.length) blocked();
      if (
        names.has("identities") &&
        (
          await db.execute(
            "SELECT 1 FROM identities WHERE status='training' LIMIT 1",
          )
        ).rows.length
      )
        blocked();
      if (
        names.has("meter_events") &&
        (
          await db.execute(
            names.has("soul_training_receipts")
              ? `SELECT 1 FROM meter_events m WHERE status='running' OR (status='failed' AND billed_credits>0 AND NOT (m.kind='training' AND m.engine='higgsfield' AND (EXISTS(SELECT 1 FROM soul_training_receipts r WHERE r.id=m.id AND r.workspace_id=m.workspace_id AND r.provider_status='failed' AND r.settled_at IS NOT NULL) ${names.has('recovery_intents') ? "OR EXISTS(SELECT 1 FROM recovery_intents i WHERE i.id=m.id AND i.workspace_id=m.workspace_id AND i.kind='training' AND i.state='resolved')" : ""}))) LIMIT 1`
              : "SELECT 1 FROM meter_events WHERE status='running' OR (status='failed' AND billed_credits>0) LIMIT 1",
          )
        ).rows.length
      )
        blocked();
      if (
        names.has("workspace_provisioning") &&
        (
          await db.execute(
            "SELECT 1 FROM workspace_provisioning WHERE state='provisioning' LIMIT 1",
          )
        ).rows.length
      )
        blocked();
      if (
        names.has("workspace_purges") &&
        (
          await db.execute(
            "SELECT 1 FROM workspace_purges WHERE lease IS NOT NULL LIMIT 1",
          )
        ).rows.length
      )
        blocked();
    } finally {
      db.close();
    }
  }
}

/* ── Private backup bucket ──────────────────────────────────────────────
 * A verified bundle is copied to a private R2 bucket under
 * bundles/<UTC timestamp>-<run id>/ with conditional writes only
 * (If-None-Match: *): code never overwrites or deletes anything there.
 * Retention is the bucket's own lifecycle rule. Every object is read back
 * and checked by SHA-256 and size; upload-index.json is written last, so
 * its presence marks a complete upload. Credentials come from these
 * variable NAMES (values are never in configuration or arguments). */
export const TARGET_ENV = Object.freeze({
  accountIdEnv: "BACKUP_TARGET_R2_ACCOUNT_ID",
  accessKeyIdEnv: "BACKUP_TARGET_R2_ACCESS_KEY_ID",
  secretAccessKeyEnv: "BACKUP_TARGET_R2_SECRET_ACCESS_KEY",
  bucketEnv: "BACKUP_TARGET_R2_BUCKET",
});
export const TARGET_ENDPOINT_ENV = "BACKUP_TARGET_R2_ENDPOINT";
export const BUNDLE_ROOT = "bundles/";
export const UPLOAD_INDEX = "upload-index.json";
const UPLOAD_FORMAT = "particl-backup-upload-v1";
const BUNDLE_FILE = /^(header\.json|manifest\.enc|\d{8}\.enc)$/;
const BUNDLE_PREFIX = /^bundles\/\d{8}T\d{6}Z-(\d{1,20}|manual)\/$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INDEX_MAX_BYTES = 16 * 1024 * 1024;
const UPLOAD_WIDTH = 4;
/** Newest prefixes inspected for an index before freshness gives up. */
const FRESHNESS_SCAN = 10;
const lib = () => import("./backup-lib.mjs");
const s3sdk = () => import("@aws-sdk/client-s3");
const httpStatus = (error) => error?.$metadata?.httpStatusCode;
const fail = (message) => {
  throw new OpsError(message);
};

export async function targetSettings(env = process.env) {
  const { r2Settings } = await lib();
  return r2Settings(
    {
      ...TARGET_ENV,
      ...(env[TARGET_ENDPOINT_ENV] ? { endpointEnv: TARGET_ENDPOINT_ENV } : {}),
    },
    env,
  );
}
/** bundles/20261008T203000Z-<run id>/ : sorts by capture time. */
export function bundlePrefix(at, runId) {
  const id = String(runId ?? "");
  if (!/^(\d{1,20}|manual)$/.test(id))
    fail("A numeric run ID (or manual) is required for the bundle prefix.");
  const stamp = new Date(at)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `${BUNDLE_ROOT}${stamp}-${id}/`;
}
/** The capture summary kept with an upload: verified counts only. */
export function uploadSummary(value) {
  if (value == null || value === "") return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    parsed = null;
  }
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  const stores = parsed?.mediaByStore ?? {};
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.verified !== true ||
    !count(parsed.databases) ||
    !count(parsed.media) ||
    (parsed.mediaKind != null &&
      !["local", "blob", "r2", "dual"].includes(parsed.mediaKind)) ||
    !stores ||
    typeof stores !== "object" ||
    Array.isArray(stores) ||
    Object.entries(stores).some(
      ([store, n]) => !["r2", "blob", "local", "unknown"].includes(store) || !count(n),
    )
  )
    fail("The capture summary must hold only verified counts.");
  return {
    verified: true,
    databases: parsed.databases,
    media: parsed.media,
    mediaKind: parsed.mediaKind ?? null,
    mediaByStore: { ...stores },
  };
}
async function localBundle(bundle) {
  let entries;
  try {
    entries = await readdir(bundle, { withFileTypes: true });
  } catch {
    fail("The verified bundle directory cannot be read.");
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isFile() || !BUNDLE_FILE.test(entry.name))
      fail(
        "The bundle holds an unexpected entry; only header.json, manifest.enc and numbered .enc objects are uploaded.",
      );
    names.push(entry.name);
  }
  if (!names.includes("header.json") || !names.includes("manifest.enc"))
    fail("Incomplete bundle: header.json and manifest.enc are required.");
  let header;
  try {
    header = JSON.parse(await readFile(join(bundle, "header.json"), "utf8"));
  } catch {
    header = null;
  }
  if (header?.format !== "particl-backup-v1")
    fail("The directory is not an encrypted particl-backup-v1 bundle.");
  names.sort();
  const { fileDigest } = await lib();
  const files = [];
  for (const name of names)
    files.push({ name, ...(await fileDigest(join(bundle, name))) });
  return files;
}
/** Bounded, paginated listing. With a delimiter, also the common prefixes. */
async function listing(client, bucket, prefix, retry, delimiter) {
  const { ListObjectsV2Command } = await s3sdk();
  const objects = [],
    prefixes = [];
  let token;
  for (let page = 0; page < 1000; page++) {
    const out = await retry(() =>
      client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(delimiter ? { Delimiter: delimiter } : {}),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      ),
    );
    for (const item of out?.Contents ?? []) {
      if (typeof item.Key !== "string" || !Number.isSafeInteger(item.Size) || item.Size < 0)
        fail("The backup bucket returned an invalid object listing.");
      objects.push({ key: item.Key, size: item.Size });
    }
    for (const item of out?.CommonPrefixes ?? [])
      if (typeof item.Prefix === "string") prefixes.push(item.Prefix);
    if (!out?.IsTruncated) return { objects, prefixes };
    if (!out.NextContinuationToken || out.NextContinuationToken === token)
      fail("Backup bucket pagination did not advance.");
    token = out.NextContinuationToken;
  }
  fail("The backup bucket listing exceeded its bound.");
}
/** Exactly these files (plus the index) at exactly these sizes. */
function sameFiles(listed, prefix, files, { withIndex }) {
  const want = new Map(files.map((f) => [prefix + f.name, f.bytes]));
  const rest = listed.filter((o) => !(withIndex && o.key === prefix + UPLOAD_INDEX));
  return (
    rest.length === want.size &&
    listed.length === rest.length + (withIndex ? 1 : 0) &&
    rest.every((o) => want.get(o.key) === o.size)
  );
}
async function pool(items, width, run) {
  let next = 0,
    failed = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await run(item);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (failed) throw failed;
}
async function readIndex(client, bucket, prefix, retry) {
  const { GetObjectCommand } = await s3sdk();
  const { nodeStream } = await lib();
  let out;
  try {
    out = await retry(() =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + UPLOAD_INDEX })),
    );
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
  if (!out?.Body || !(Number(out.ContentLength) <= INDEX_MAX_BYTES)) {
    out?.Body?.destroy?.();
    fail("Invalid backup upload index.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of nodeStream(out.Body)) {
    size += chunk.length;
    if (size > INDEX_MAX_BYTES) fail("Invalid backup upload index.");
    chunks.push(Buffer.from(chunk));
  }
  let index;
  try {
    index = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    index = null;
  }
  const names = new Set();
  if (
    index?.format !== UPLOAD_FORMAT ||
    index.prefix !== prefix ||
    !Array.isArray(index.files) ||
    index.files.some(
      (f) =>
        !BUNDLE_FILE.test(f?.name ?? "") ||
        names.has(f.name) ||
        !names.add(f.name) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0 ||
        !SHA256.test(f.sha256 ?? ""),
    ) ||
    !names.has("header.json") ||
    !names.has("manifest.enc")
  )
    fail("Invalid backup upload index.");
  const modified = out.LastModified ? new Date(out.LastModified).getTime() : NaN;
  return { index, modified };
}
/** The newest prefix holding a valid index whose objects are all listed at
 * their recorded sizes. Newer incomplete uploads (no index) are skipped. */
async function latestComplete(client, bucket, retry) {
  const { prefixes } = await listing(client, bucket, BUNDLE_ROOT, retry, "/");
  const candidates = prefixes.filter((p) => BUNDLE_PREFIX.test(p)).sort().reverse();
  let skipped = 0;
  for (const prefix of candidates.slice(0, FRESHNESS_SCAN)) {
    const found = await readIndex(client, bucket, prefix, retry);
    if (!found) {
      skipped++;
      continue;
    }
    const listed = (await listing(client, bucket, prefix, retry)).objects;
    if (!sameFiles(listed, prefix, found.index.files, { withIndex: true }))
      fail("The newest complete backup bundle is missing objects or their sizes changed.");
    return { prefix, ...found, skipped };
  }
  fail("No complete verified encrypted backup exists in the backup bucket.");
}
async function targetClient(env, client) {
  const settings = await targetSettings(env);
  if (client) return { settings, s3: client, close: () => {} };
  const { defaultR2Client } = await lib();
  const s3 = await defaultR2Client(settings);
  return { settings, s3, close: () => s3.destroy?.() };
}

/** Copies a VERIFIED bundle to bundles/<UTC timestamp>-<run id>/. Refuses a
 * prefix that already holds anything; never overwrites; checks every object
 * by read-back SHA-256 and size, then the listing, then writes the index. */
export async function uploadBundle(
  bundle,
  { env = process.env, client, now = Date.now, runId, summary = null, retryOptions, singleMax, partSize } = {},
) {
  const files = await localBundle(bundle);
  const kept = uploadSummary(summary);
  const { retrying, putR2File, r2ObjectDigest } = await lib();
  const retry = retrying(retryOptions);
  const { settings, s3, close } = await targetClient(env, client);
  const bucket = settings.bucket,
    at = now(),
    prefix = bundlePrefix(at, runId),
    what = "The backup bucket";
  try {
    if ((await listing(s3, bucket, prefix, retry)).objects.length)
      fail("The backup bucket already holds this bundle prefix. Nothing is overwritten.");
    await pool(files, UPLOAD_WIDTH, async (file) => {
      const key = prefix + file.name;
      await putR2File(
        s3,
        bucket,
        key,
        join(bundle, file.name),
        {
          bytes: file.bytes,
          contentType: file.name.endsWith(".json") ? "application/json" : "application/octet-stream",
        },
        retry,
        { what, ...(singleMax ? { singleMax } : {}), ...(partSize ? { partSize } : {}) },
      );
      const back = await r2ObjectDigest(s3, bucket, key, retry, "An uploaded backup object cannot be read back.");
      if (back.sha256 !== file.sha256 || back.bytes !== file.bytes)
        fail("An uploaded backup object did not match its SHA-256 on read-back.");
    });
    if (!sameFiles((await listing(s3, bucket, prefix, retry)).objects, prefix, files, { withIndex: false }))
      fail("The uploaded bundle listing differs from the local bundle.");
    const index = {
      format: UPLOAD_FORMAT,
      prefix,
      uploadedAt: new Date(at).toISOString(),
      runId: String(runId),
      ...(kept ? { summary: kept } : {}),
      files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    };
    const body = Buffer.from(JSON.stringify(index, null, 2) + "\n");
    const { PutObjectCommand } = await s3sdk();
    await retry(async (attempt) => {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: prefix + UPLOAD_INDEX,
            Body: body,
            ContentLength: body.length,
            ContentType: "application/json",
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        // A 412 on a retry means an earlier attempt landed; read-back decides.
        if (httpStatus(error) === 412 && attempt > 1) return;
        if (httpStatus(error) === 412)
          fail("The backup bucket already holds this upload index. Nothing is overwritten.");
        throw error;
      }
    });
    const back = await r2ObjectDigest(s3, bucket, prefix + UPLOAD_INDEX, retry, "The upload index cannot be read back.");
    if (back.sha256 !== createHash("sha256").update(body).digest("hex") || back.bytes !== body.length)
      fail("The upload index did not match on read-back.");
    return {
      uploaded: true,
      prefix,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      ...(kept ? { summary: kept } : {}),
    };
  } finally {
    close();
  }
}

/** Hourly check: the newest complete bundle in the bucket (by the index's
 * server-side upload time) is no older than 26 hours. */
export async function bucketFreshness({ env = process.env, client, now = Date.now(), retryOptions } = {}) {
  const { retrying } = await lib();
  const retry = retrying(retryOptions);
  const { settings, s3, close } = await targetClient(env, client);
  try {
    const latest = await latestComplete(s3, settings.bucket, retry);
    if (!Number.isFinite(latest.modified) || latest.modified > now + 5 * 60_000)
      fail("The newest backup upload has no valid upload time.");
    const ageMs = Math.max(0, now - latest.modified);
    if (ageMs > FRESHNESS_MS)
      fail("The latest verified encrypted backup is older than 26 hours.");
    return {
      fresh: true,
      prefix: latest.prefix,
      latestAt: new Date(latest.modified).toISOString(),
      ageHours: Math.round(ageMs / 36000) / 100,
      files: latest.index.files.length,
      bytes: latest.index.files.reduce((n, f) => n + f.bytes, 0),
      incompleteNewer: latest.skipped,
      ...(latest.index.summary ? { summary: latest.index.summary } : {}),
    };
  } finally {
    close();
  }
}

/** Fetches one complete bundle (or "latest") into a NEW private directory,
 * checking every file against the index's SHA-256 and size. The result is
 * the encrypted bundle that `backup-restore.mjs restore` takes. */
export async function downloadBundle(which, destination, { env = process.env, client, retryOptions } = {}) {
  const { retrying, nodeStream } = await lib();
  const { GetObjectCommand } = await s3sdk();
  const retry = retrying(retryOptions);
  const { settings, s3, close } = await targetClient(env, client);
  const bucket = settings.bucket;
  let created = false;
  try {
    let prefix, index;
    if (which === "latest") ({ prefix, index } = await latestComplete(s3, bucket, retry));
    else {
      prefix = String(which ?? "").replace(/\/?$/, "/");
      if (!BUNDLE_PREFIX.test(prefix)) fail("Name a bundle as bundles/<UTC timestamp>-<run id>/ or latest.");
      const found = await readIndex(s3, bucket, prefix, retry);
      if (!found) fail("That bundle has no upload index; it is not a complete upload.");
      index = found.index;
    }
    try {
      await mkdir(destination, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") fail("Destination already exists; download never overwrites it.");
      throw error;
    }
    created = true;
    for (const file of index.files) {
      const path = join(destination, file.name);
      await retry(async () => {
        await rm(path, { force: true });
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + file.name }));
        if (!out?.Body) fail("A bundle object cannot be read.");
        const hash = createHash("sha256");
        let bytes = 0;
        await pipeline(
          nodeStream(out.Body),
          new Transform({
            transform(chunk, _, next) {
              hash.update(chunk);
              bytes += chunk.length;
              next(null, chunk);
            },
          }),
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
        );
        if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
          fail("A downloaded bundle object did not match its recorded SHA-256.");
      });
    }
    return {
      downloaded: true,
      prefix,
      files: index.files.length,
      bytes: index.files.reduce((n, f) => n + f.bytes, 0),
      ...(index.summary ? { summary: index.summary } : {}),
    };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    close();
  }
}

export async function captureVerified(
  config,
  destination,
  {
    env,
    quiescence,
    now = () => Date.now(),
    capture,
    restore,
    preflight = assertNoActiveOrUncertain,
    verifyFence = async (config, env, receipt) => (await import("./recovery-fence.mjs")).verifyLiveFence(config, env, receipt),
  } = {},
) {
  assertQuiescence(config, quiescence, now());
  await verifyFence(config, env, quiescence);
  await preflight(config, env);
  const bundle = join(destination, "bundle"),
    verification = join(destination, "verification");
  await mkdir(destination, { mode: 0o700 });
  try {
    if (!capture || !restore) {
      const library = await import("./backup-lib.mjs");
      capture ??= library.createBackup;
      restore ??= library.restoreBackup;
    }
    const backedUp = await capture(config, bundle, { env });
    // A stale fence or late uncertain work invalidates this capture; do not
    // publish even a fully encrypted bundle as a successfully verified backup.
    assertQuiescence(config, quiescence, now());
    await verifyFence(config, env, quiescence);
    await preflight(config, env);
    const verified = await restore(bundle, verification, { env });
    assertQuiescence(config, quiescence, now());
    await verifyFence(config, env, quiescence);
    if (!verified.verified)
      throw new OpsError("Restore verification did not succeed.");
    await rm(verification, { recursive: true, force: true });
    return { bundle, backedUp, verified };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function stepSummary(lines) {
  return process.env.GITHUB_STEP_SUMMARY
    ? appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n")
    : undefined;
}
function mediaLine(summary) {
  if (!summary) return "not recorded";
  const stores = Object.entries(summary.mediaByStore ?? {})
    .map(([store, n]) => `${store === "r2" ? "R2" : store === "blob" ? "Blob" : store}: ${n}`)
    .join(", ");
  return `${summary.media}${stores ? ` (${stores})` : ""}`;
}

async function main() {
  const command = process.argv[2];
  if (command === "plan") {
    console.log(
      JSON.stringify({
        enabled: false,
        captureUtc: "02:17 daily (only with a sealed fence receipt; attended capture is manual)",
        freshness: "hourly, 26-hour maximum age, newest complete bundle in the private bucket",
        destination: `private R2 bucket, ${BUNDLE_ROOT}<UTC timestamp>-<run id>/, conditional writes, SHA-256 read-back`,
        retention: "bucket lifecycle rule set by the owner (for example 90 days on bundles/)",
        publish: "verified encrypted bundle only; no GitHub artifact",
        required: [
          "protected particl-backup environment",
          "scoped source credentials",
          "complete source inventory",
          "independent backup key escrow",
          "private backup bucket credentials (BACKUP_TARGET_R2_*)",
          "fresh enforced quiescence",
          "no live or uncertain jobs",
        ],
      }),
    );
    return;
  }
  if (command === "fingerprint") {
    console.log(
      sourceFingerprint(JSON.parse(await readFile(process.argv[3], "utf8"))),
    );
    return;
  }
  if (command === "freshness") {
    const result = await bucketFreshness();
    console.log(JSON.stringify(result));
    await stepSummary([
      "### Newest encrypted backup in the private bucket",
      "",
      "| | |",
      "|---|---|",
      `| Bundle | \`${result.prefix}\` |`,
      `| Uploaded | ${result.latestAt} (${result.ageHours} h ago) |`,
      `| Media objects | ${mediaLine(result.summary)} |`,
    ]);
    return;
  }
  if (command === "upload") {
    const bundle = process.argv[3];
    if (!bundle) throw new OpsError("Usage: backup-automation.mjs upload VERIFIED_BUNDLE_DIRECTORY");
    const result = await uploadBundle(resolve(bundle), {
      runId: process.env.GITHUB_RUN_ID || "manual",
      summary: process.env.PARTICL_BACKUP_SUMMARY_JSON || null,
    });
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `bundle_prefix=${result.prefix}\n`);
    console.log(JSON.stringify(result));
    await stepSummary([
      "### Encrypted backup uploaded to the private bucket",
      "",
      "| | |",
      "|---|---|",
      `| Bundle | \`${result.prefix}\` |`,
      `| Files | ${result.files} (${Math.round(result.bytes / 10485.76) / 100} MiB), each read back and checked by SHA-256 |`,
      `| Databases | ${result.summary?.databases ?? "not recorded"} |`,
      `| Media objects | ${mediaLine(result.summary)} |`,
    ]);
    return;
  }
  if (command === "download") {
    const [which, destination] = process.argv.slice(3);
    if (!which || !destination)
      throw new OpsError("Usage: backup-automation.mjs download latest|bundles/<prefix>/ NEW_DIRECTORY");
    console.log(JSON.stringify(await downloadBundle(which, resolve(destination))));
    return;
  }
  if (command !== "capture" || process.env.PARTICL_BACKUP_ENABLED !== "true")
    throw new OpsError("Scheduled backup capture is not enabled.");
  const config = JSON.parse(process.env.PARTICL_BACKUP_SOURCE_JSON || "null"),
    env = JSON.parse(process.env.PARTICL_BACKUP_ENV_JSON || "null"),
    quiescence = JSON.parse(
      process.env.PARTICL_BACKUP_QUIESCENCE_JSON || "null",
    );
  if (
    !config ||
    !env ||
    typeof env !== "object" ||
    Object.values(env).some((v) => typeof v !== "string")
  )
    throw new OpsError(
      "Protected backup source inventory and scoped credential JSON are required.",
    );
  env.PARTICL_BACKUP_KEY = process.env.PARTICL_BACKUP_KEY;
  if (
    !process.env.RUNNER_TEMP ||
    !/^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? "") ||
    !/^[0-9]+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw new OpsError(
      "Capture automation requires an isolated Actions runner.",
    );
  const destination = join(
    process.env.RUNNER_TEMP,
    `particl-backup-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  );
  const result = await captureVerified(config, destination, {
    env,
    quiescence,
  });
  const summary = uploadSummary({
    verified: true,
    databases: result.verified.databases,
    media: result.verified.media,
    mediaKind: result.verified.mediaKind ?? config.media?.kind ?? null,
    mediaByStore: result.verified.mediaByStore ?? {},
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `bundle_path=${result.bundle}\nsummary=${JSON.stringify(summary)}\n`,
  );
  console.log(JSON.stringify(summary));
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error) => {
    console.error(
      error instanceof OpsError
        ? error.message
        : "Backup automation failed; secret-bearing error details are withheld.",
    );
    process.exitCode = 1;
  });
