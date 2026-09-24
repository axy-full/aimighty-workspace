import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { CHECKPOINT_SECRETS, ENVIRONMENT, plan } from "../../scripts/ops/weekly-backup.mjs";
import { FRESHNESS_MS, retentionDays } from "../../scripts/ops/backup-automation.mjs";

/* Owner, 24 September: weekly backups with the existing tool. */
test("the weekly run closes, drains, seals, hands the three checkpoint files to the protected environment, captures, then reopens and cleans up", () => {
  const steps = plan("/secure/checkpoint", "/secure/input.json");
  assert.deepEqual(steps.begin.slice(1), ["scripts/ops/recovery-fence.mjs", "begin", "/secure/checkpoint", "/secure/input.json"]);
  assert.deepEqual(steps.seal.slice(2), ["seal", "/secure/checkpoint"]);
  assert.deepEqual(steps.secrets.map((s) => [s.name, s.file]), CHECKPOINT_SECRETS.map(([name, file]) => [name, `/secure/checkpoint/${file}`]));
  for (const s of steps.secrets) assert.deepEqual(s.command, ["gh", "secret", "set", s.name, "--env", ENVIRONMENT]);
  assert.deepEqual(steps.capture, ["gh", "workflow", "run", "backup.yml", "--ref", "main", "-f", "operation=capture"]);
  assert.deepEqual(steps.resume.slice(2), ["resume", "/secure/checkpoint"]);
  assert.deepEqual(steps.cleanup.map((c) => c[3]), CHECKPOINT_SECRETS.map(([name]) => name));
});

test("a weekly cadence: stale after eight days, every backup kept twelve weeks", () => {
  assert.equal(FRESHNESS_MS, 8 * 24 * 60 * 60 * 1000);
  assert.equal(retentionDays(Date.parse("2026-09-24T02:00:00Z")), 84);
});

test("--dry-run prints the plan and touches nothing", () => {
  const out = JSON.parse(execFileSync("node", ["scripts/ops/weekly-backup.mjs", "/secure/c", "/secure/i.json", "--dry-run"], { encoding: "utf8", env: { PATH: process.env.PATH } }));
  assert.equal(out.begin[2], "begin");
  assert.equal(out.cleanup.length, 3);
});

test("the permanent archive keeps every file of the bundle under its run's prefix", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { files, archiveKey } = await import("../../scripts/ops/archive-backup.mjs");
  const root = await mkdtemp(join(tmpdir(), "particl-archive-"));
  await mkdir(join(root, "objects"));
  await writeFile(join(root, "header.json"), "{}"); await writeFile(join(root, "manifest.enc"), "x"); await writeFile(join(root, "objects", "0001.enc"), "y");
  const list = await files(root);
  assert.deepEqual(list.map((p) => archiveKey("backups/42-1/", root, p)), ["backups/42-1/header.json", "backups/42-1/manifest.enc", "backups/42-1/objects/0001.enc"]);
});
