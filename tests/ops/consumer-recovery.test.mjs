import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { assertNoActiveOrUncertain } from "../../scripts/ops/backup-automation.mjs";
import { recoveryReport } from "../../scripts/ops/recovery-report.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "particl-consumer-recovery-"));
  await mkdir(join(root, "databases"));
  const url = pathToFileURL(join(root, "databases", "tenant.db")).href;
  const db = createClient({ url });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await db.execute(`CREATE TABLE higgsfield_consumer_jobs (
    id TEXT,status TEXT,user_id TEXT,draft_id TEXT,connected_owner_id TEXT,
    connection_generation TEXT,higgsfield_workspace_id TEXT,provider_job_id TEXT,
    quote_credits REAL,payload_json TEXT,dispatch_claim_hash TEXT,result_manifest TEXT)`);
  await writeFile(join(root, "OFFLINE-RESTORE.txt"), "Offline fixture");
  await writeFile(
    join(root, "inventory.json"),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      databases: [{ id: "tenant", workspaceIds: ["workspace-a"] }],
    }),
  );
  return { root, db, config: { databases: [{ url }] } };
}

test("backup preflight blocks consumer admission, accepted jobs, uncertainty and unknown states without writing", async (t) => {
  const { db, config } = await fixture(t);
  for (const status of [
    "dispatching",
    "accepted",
    "uncertain",
    "future-state",
    null,
  ]) {
    await db.execute({
      sql: "INSERT INTO higgsfield_consumer_jobs(id,status) VALUES('job',?)",
      args: [status],
    });
    await assert.rejects(
      assertNoActiveOrUncertain(config, {}),
      /requires reconciliation/,
    );
    assert.equal(
      (await db.execute("SELECT status FROM higgsfield_consumer_jobs")).rows[0]
        .status,
      status,
    );
    await db.execute("DELETE FROM higgsfield_consumer_jobs");
  }
  for (const status of ["quoted", "failed", "completed"]) {
    await db.execute({
      sql: "INSERT INTO higgsfield_consumer_jobs(id,status) VALUES(?,?)",
      args: [status, status],
    });
  }
  await assertNoActiveOrUncertain(config, {});
  assert.equal(
    (await db.execute("SELECT count(*) AS n FROM higgsfield_consumer_jobs"))
      .rows[0].n,
    3,
  );
});

test("offline consumer report preserves separate credit units and recovery identities without prompts, claims or results", async (t) => {
  const { root, db } = await fixture(t);
  for (const status of [
    "quoted",
    "dispatching",
    "uncertain",
    "accepted",
    "completed",
    "failed",
  ]) {
    await db.execute({
      sql: "INSERT INTO higgsfield_consumer_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [
        status,
        status,
        "owner",
        "private-draft",
        "connected-owner",
        "original-grant-generation",
        "consumer-wallet",
        status === "accepted" ? "known-provider-uuid" : null,
        12.5,
        '{"prompt":"PRIVATE-PROMPT"}',
        "PRIVATE-CLAIM",
        '{"result":"PRIVATE-RESULT"}',
      ],
    });
  }
  assert.equal((await recoveryReport(root)).actions, 6);
  const serialized = await readFile(
    join(root, "reconciliation-report.json"),
    "utf8",
  );
  assert.doesNotMatch(
    serialized,
    /PRIVATE-|reservedUsd|cost_usd|payload_json|dispatch_claim/,
  );
  const actions = Object.fromEntries(
    JSON.parse(serialized).actions.map((action) => [action.id, action]),
  );
  assert.equal(
    actions.quoted.disposition,
    "restored-consumer-quote-requires-reconciliation-never-submit",
  );
  assert.equal(
    actions.dispatching.disposition,
    "uncertain-consumer-outcome-never-resubmit",
  );
  assert.equal(
    actions.uncertain.disposition,
    "uncertain-consumer-outcome-never-resubmit",
  );
  assert.equal(
    actions.accepted.disposition,
    "verify-consumer-connection-then-poll-existing-handle-only",
  );
  assert.equal(
    actions.completed.disposition,
    "recover-persisted-consumer-result-no-submit",
  );
  assert.equal(
    actions.failed.disposition,
    "terminal-consumer-no-provider-work",
  );
  assert.equal(actions.accepted.handle, "known-provider-uuid");
  for (const action of Object.values(actions)) {
    assert.equal(action.quoteCredits, 12.5);
    assert.equal(action.creditUnit, "higgsfield_credits");
    assert.equal(action.connectionGeneration, "original-grant-generation");
    assert.deepEqual(action.workspaceIds, ["workspace-a"]);
  }
  assert.equal(
    (
      await db.execute(
        "SELECT count(*) AS n FROM higgsfield_consumer_jobs WHERE status='quoted'",
      )
    ).rows[0].n,
    1,
  );
});
