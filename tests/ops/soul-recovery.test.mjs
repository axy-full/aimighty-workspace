import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { assertNoActiveOrUncertain } from "../../scripts/ops/backup-automation.mjs";
import { recoveryReport } from "../../scripts/ops/recovery-report.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "particl-soul-recovery-"));
  await mkdir(join(root, "databases"));
  const url = pathToFileURL(join(root, "databases", "fixture.db")).href;
  const db = createClient({ url });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await db.executeMultiple(`CREATE TABLE soul_identities(id TEXT,status TEXT,provider_reference_id TEXT,paid_claim TEXT,settlement_status TEXT,settled_at INTEGER,purged_at INTEGER,cost_usd REAL);
  CREATE TABLE soul_training_receipts(id TEXT,workspace_id TEXT,provider_reference_id TEXT,provider_status TEXT,settled_at INTEGER);
  CREATE TABLE meter_events(id TEXT,workspace_id TEXT,kind TEXT,engine TEXT,status TEXT,billed_credits INTEGER);
  CREATE TABLE recovery_intents(id TEXT,workspace_id TEXT,kind TEXT,state TEXT);`);
  await writeFile(
    join(root, "OFFLINE-RESTORE.txt"),
    "Fixture; no live credentials.",
  );
  await writeFile(
    join(root, "inventory.json"),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      databases: [{ id: "fixture", workspaceIds: ["ws_fixture"] }],
    }),
  );
  return { root, db, config: { databases: [{ url }] } };
}
test("backup refuses Soul training, uncertain submissions and orphan remote receipts until durable settlement", async (t) => {
  const { db, config } = await fixture(t);
  for (const state of ["submitting", "training", "uncertain"]) {
    await db.execute({
      sql: "INSERT INTO soul_identities VALUES('id',?,NULL,'claim',NULL,NULL,NULL,2.5)",
      args: [state],
    });
    await assert.rejects(
      assertNoActiveOrUncertain(config, {}),
      /reconciliation/,
    );
    await db.execute("DELETE FROM soul_identities");
  }
  await db.execute(
    "INSERT INTO soul_training_receipts VALUES('id','ws_fixture','known-uuid','completed',NULL)",
  );
  await assert.rejects(assertNoActiveOrUncertain(config, {}), /reconciliation/);
  await db.execute("UPDATE soul_training_receipts SET settled_at=1");
  await assertNoActiveOrUncertain(config, {});
});
test("charged terminal failure needs exact workspace settlement proof, including after remote handle purge", async (t) => {
  const { db, config } = await fixture(t);
  await db.execute(
    "INSERT INTO meter_events VALUES('id','ws_fixture','training','higgsfield','failed',38)",
  );
  await db.execute(
    "INSERT INTO soul_training_receipts VALUES('id','another-workspace','known-uuid','failed',1)",
  );
  await assert.rejects(assertNoActiveOrUncertain(config, {}), /reconciliation/);
  await db.execute(
    "UPDATE soul_training_receipts SET workspace_id='ws_fixture'",
  );
  await assertNoActiveOrUncertain(config, {});
  await db.execute("DELETE FROM soul_training_receipts");
  await assert.rejects(assertNoActiveOrUncertain(config, {}), /reconciliation/);
  await db.execute(
    "INSERT INTO recovery_intents VALUES('id','ws_fixture','training','resolved')",
  );
  await assertNoActiveOrUncertain(config, {});
  await db.execute("UPDATE meter_events SET engine='another-provider'");
  await assert.rejects(assertNoActiveOrUncertain(config, {}), /reconciliation/);
});
test("offline report distinguishes known Soul handles, unknown acceptance and persisted terminal settlement without submitting", async (t) => {
  const { root, db } = await fixture(t);
  await db.executeMultiple(`INSERT INTO soul_identities VALUES('known','training','provider-uuid','claim',NULL,NULL,NULL,2.5),('unknown','uncertain',NULL,'claim',NULL,NULL,NULL,2.5),('terminal','ready','ready-uuid','claim','succeeded',NULL,NULL,2.5);
    INSERT INTO soul_training_receipts VALUES('receipt','ws_receipt','receipt-uuid','completed',NULL);`);
  await recoveryReport(root);
  const report = JSON.parse(
    await readFile(join(root, "reconciliation-report.json"), "utf8"),
  );
  const actions = Object.fromEntries(
    report.actions.map((action) => [action.id, action]),
  );
  assert.equal(
    actions.known.disposition,
    "poll-existing-soul-training-handle-only",
  );
  assert.equal(
    actions.unknown.disposition,
    "uncertain-provider-outcome-never-resubmit",
  );
  assert.equal(
    actions.terminal.disposition,
    "settle-persisted-soul-training-cost-no-submit",
  );
  assert.equal(
    actions.receipt.disposition,
    "restore-known-soul-handle-and-settle-no-submit",
  );
  assert.deepEqual(actions.receipt.workspaceIds, ["ws_receipt"]);
  assert.equal(actions.receipt.handle, "receipt-uuid");
});

test("orphan accepted Soul generation receipt blocks backup and gives a GET-only offline recovery action", async (t) => {
  const { root, db, config } = await fixture(t);
  await db.executeMultiple(`CREATE TABLE higgsfield_generation_receipts(id TEXT,workspace_id TEXT,handle_json TEXT,settled_at INTEGER);
    INSERT INTO higgsfield_generation_receipts VALUES('image-id','ws_fixture','{"ref":"image-request-uuid"}',NULL);`);
  await assert.rejects(assertNoActiveOrUncertain(config, {}), /reconciliation/);
  await recoveryReport(root);
  const report = JSON.parse(
    await readFile(join(root, "reconciliation-report.json"), "utf8"),
  );
  assert.equal(report.actions[0].handle, "image-request-uuid");
  assert.equal(
    report.actions[0].disposition,
    "restore-known-soul-generation-handle-and-poll-only",
  );
  await db.execute("UPDATE higgsfield_generation_receipts SET settled_at=1");
  await assertNoActiveOrUncertain(config, {});
});
