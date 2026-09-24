#!/usr/bin/env node
/**
 * The weekly backup, one command (owner, 24 September: "Existing tool, weekly
 * only"). It runs the documented checkpoint end to end:
 *
 *   1. close admission (recovery-fence begin) — the site shows maintenance;
 *   2. wait for admitted work to drain (status, renewing the coordinator);
 *   3. seal — the authoritative source inventory and a receipt (≤ 2 hours);
 *   4. hand the three per-checkpoint files to the protected `particl-backup`
 *      environment as secrets, start the capture workflow and watch it: it
 *      captures, encrypts, restores and verifies, and keeps only ciphertext;
 *   5. ALWAYS reopen the site (resume) and delete the per-checkpoint secrets,
 *      even when a step fails — a failed backup must not leave the site down.
 *
 * Credentials come from the operator's environment (from the password manager
 * or `vercel env pull` on an encrypted disk), never from arguments or files in
 * the repository, and are never printed:
 *   PLATFORM_DATABASE_URL, PLATFORM_AUTH_TOKEN  the platform database
 *   KEYRING_SECRET                              the ORIGINAL application keyring
 *   BLOB_READ_WRITE_TOKEN                       the private media store
 * PARTICL_BACKUP_KEY is set once as an environment secret (docs/weekly-backup.md).
 *
 * Usage: node scripts/ops/weekly-backup.mjs PRIVATE_NEW_DIRECTORY CHECKPOINT_INPUT_JSON [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ENVIRONMENT = "particl-backup";
export const REQUIRED_ENV = ["PLATFORM_DATABASE_URL", "PLATFORM_AUTH_TOKEN", "KEYRING_SECRET", "BLOB_READ_WRITE_TOKEN"];
export const CHECKPOINT_SECRETS = [
  ["PARTICL_BACKUP_SOURCE_JSON", "sources.json"],
  ["PARTICL_BACKUP_ENV_JSON", "source-env.json"],
  ["PARTICL_BACKUP_QUIESCENCE_JSON", "receipt.json"],
];
const DRAIN_TIMEOUT_MS = 20 * 60_000, POLL_MS = 15_000, RENEW_MS = 5 * 60_000;

/** Every command the run issues, in order; the last two always run. */
export function plan(directory, input) {
  const fence = (...args) => ["node", "scripts/ops/recovery-fence.mjs", ...args];
  return {
    begin: fence("begin", directory, input),
    status: fence("status", directory),
    renew: fence("renew", directory),
    seal: fence("seal", directory),
    secrets: CHECKPOINT_SECRETS.map(([name, file]) => ({ name, file: join(directory, file), command: ["gh", "secret", "set", name, "--env", ENVIRONMENT] })),
    capture: ["gh", "workflow", "run", "backup.yml", "--ref", "main", "-f", "operation=capture"],
    resume: fence("resume", directory),
    cleanup: CHECKPOINT_SECRETS.map(([name]) => ["gh", "secret", "delete", name, "--env", ENVIRONMENT]),
  };
}

function run(command, { input, quiet = false } = {}) {
  const out = spawnSync(command[0], command.slice(1), { input, encoding: "utf8", stdio: [input == null ? "inherit" : "pipe", "pipe", "pipe"] });
  if (!quiet && out.stdout) process.stdout.write(out.stdout);
  if (out.status !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed${out.stderr ? `: ${out.stderr.trim().split("\n").at(-1)}` : ""}`);
  return out.stdout;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [directory, input, flag] = process.argv.slice(2);
  if (!directory || !input) throw new Error("Usage: node scripts/ops/weekly-backup.mjs PRIVATE_NEW_DIRECTORY CHECKPOINT_INPUT_JSON [--dry-run]");
  const steps = plan(resolve(directory), resolve(input));
  if (flag === "--dry-run") { console.log(JSON.stringify(steps, null, 2)); return; }
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Set these in this shell first (values are never printed): ${missing.join(", ")}`);
  run(["gh", "auth", "status"], { quiet: true });

  let closed = false;
  try {
    console.log("1/5 Closing admission — the site shows maintenance until step 5.");
    run(steps.begin); closed = true;
    console.log("2/5 Waiting for admitted work to drain…");
    const started = Date.now(); let renewed = Date.now();
    for (;;) {
      const status = JSON.parse(run(steps.status, { quiet: true }));
      if (!status.activities?.length && !status.intents?.length) break;
      if (Date.now() - started > DRAIN_TIMEOUT_MS) throw new Error(`Work did not drain in 20 minutes (${status.activities?.length ?? 0} activities, ${status.intents?.length ?? 0} intents). Reconcile them, then run again.`);
      if (Date.now() - renewed > RENEW_MS) { run(steps.renew, { quiet: true }); renewed = Date.now(); }
      await sleep(POLL_MS);
    }
    console.log("3/5 Sealing the checkpoint…");
    run(steps.seal);
    console.log("4/5 Capturing, encrypting and verifying on the protected runner…");
    for (const secret of steps.secrets) run(secret.command, { input: await readFile(secret.file, "utf8"), quiet: true });
    const since = new Date().toISOString();
    run(steps.capture, { quiet: true });
    let id = "";
    for (let i = 0; i < 20 && !id; i++) {
      await sleep(3_000);
      id = run(["gh", "run", "list", "--workflow", "backup.yml", "--event", "workflow_dispatch", "--limit", "1", "--json", "databaseId,createdAt", "-q", `.[] | select(.createdAt >= "${since}") | .databaseId`], { quiet: true }).trim();
    }
    if (!id) throw new Error("The capture run did not start.");
    run(["gh", "run", "watch", id, "--exit-status"], { quiet: true });
    console.log(`Backup verified and retained (run ${id}).`);
  } finally {
    if (closed) {
      console.log("5/5 Reopening the site and removing the per-checkpoint secrets.");
      try { run(steps.resume); } catch (error) { console.error(`RESUME FAILED — reopen by hand now: node scripts/ops/recovery-fence.mjs resume ${resolve(directory)} (${error.message})`); process.exitCode = 1; }
    }
    for (const command of steps.cleanup) { try { run(command, { quiet: true }); } catch { /* absent secrets are fine */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Weekly backup failed."); process.exitCode = 1; });
