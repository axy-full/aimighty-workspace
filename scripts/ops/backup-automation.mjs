import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OpsError } from "./ops-error.mjs";

export const ARTIFACT_PREFIX = "particl-backup-verified-";
/* Weekly backups (owner, 24 September): stale after eight days without a verified artifact. */
export const FRESHNESS_MS = 8 * 24 * 60 * 60 * 1000;
export function sourceFingerprint(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
/** Every weekly backup is kept twelve weeks. */
export function retentionDays(at = Date.now()) {
  void at;
  return 84;
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

export function freshness(artifacts, at = Date.now()) {
  const valid = artifacts.filter(
    (a) =>
      a.name?.startsWith(ARTIFACT_PREFIX) &&
      a.expired === false &&
      Number(a.size_in_bytes) > 0 &&
      Number.isFinite(Date.parse(a.created_at)) &&
      Date.parse(a.created_at) <= at,
  );
  valid.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!valid.length)
    throw new OpsError(
      "No retained verified encrypted backup artifact exists.",
    );
  const ageMs = at - Date.parse(valid[0].created_at);
  if (ageMs > FRESHNESS_MS)
    throw new OpsError(
      "The latest verified encrypted backup is older than 26 hours.",
    );
  return {
    fresh: true,
    latestAt: valid[0].created_at,
    ageHours: Math.round(ageMs / 36000) / 100,
  };
}
export async function githubFreshness(env = process.env, fetcher = fetch) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
    !env.GITHUB_TOKEN
  )
    throw new OpsError(
      "GitHub repository and read-only Actions token are required for freshness checks.",
    );
  const artifacts = [];
  for (let page = 1; page <= 100; page++) {
    const response = await fetcher(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new OpsError(
        "Could not read backup artifact freshness from GitHub.",
      );
    const value = await response.json();
    if (!Array.isArray(value.artifacts))
      throw new OpsError("Invalid GitHub artifact listing.");
    artifacts.push(...value.artifacts);
    if (value.artifacts.length < 100) return freshness(artifacts);
  }
  throw new OpsError("Artifact inventory exceeded the bounded freshness scan.");
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
    return { bundle, backedUp, verified, retentionDays: retentionDays(now()) };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "plan") {
    console.log(
      JSON.stringify({
        enabled: false,
        captureUtc: "02:17 daily",
        freshness: "hourly, 26-hour maximum age",
        dailyRetentionDays: 30,
        weeklyRetentionDays: 84,
        publish: "verified encrypted bundle only",
        required: [
          "protected particl-backup environment",
          "scoped source credentials",
          "complete source inventory",
          "independent backup key escrow",
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
    console.log(JSON.stringify(await githubFreshness()));
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
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `bundle_path=${result.bundle}\nretention_days=${result.retentionDays}\n`,
  );
  console.log(
    JSON.stringify({
      verified: true,
      databases: result.verified.databases,
      media: result.verified.media,
      retentionDays: result.retentionDays,
    }),
  );
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
