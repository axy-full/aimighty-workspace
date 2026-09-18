import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-lifecycle-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";

test("purge retains credentials and unfinished stages on failure, retries exactly the unfinished work", async () => {
  const { platformReady, platformDb, getWorkspace } =
    await import("../../lib/platform");
  const { markWorkspaceDeleted, purgeWorkspace } =
    await import("../../lib/purge");
  const { seal } = await import("../../lib/keyring");
  await platformReady();
  await (await import("../../lib/accountDb")).accountDbReady();
  const p = platformDb();
  await p.execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,db_token_enc,keys_enc,gateway_key_id,owner_id,created_at,updated_at) VALUES('purge','purge','Customer',?,?,?,'key-id','owner',0,0)`,
    args: [`file:${path.join(dir, "purge.db")}`, seal("db-token"), seal(JSON.stringify({ gateway: "secret" }))],
  });
  await p.execute(
    `INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES('purge','owner','owner',0,0)`,
  );
  await p.execute({
    sql: `INSERT INTO workspace_provisioning(request_id,request_key,owner_id,workspace_id,name,slug,db_name,db_token_enc,state,created_at,updated_at) VALUES('p','p','owner','purge','Customer','purge','purge',?,'ready',0,0)`,
    args: [seal("db-token")],
  });
  const ws = (await getWorkspace("purge"))!;
  let files = 0,
    keys = 0,
    databases = 0,
    fail = true;
  const dependencies = {
    files: async () => {
      files++;
      return { files: 2, uploads: 1 };
    },
    key: async () => {
      keys++;
      if (fail) throw new Error("Temporary revocation failure");
    },
    database: async () => {
      databases++;
    },
  };
  expect((await purgeWorkspace(ws, dependencies)).errors).toHaveLength(1);
  expect(files).toBe(0);
  await markWorkspaceDeleted(ws.id);
  expect(
    Number(
      (
        await p.execute(
          `SELECT disabled FROM memberships WHERE workspace_id='purge'`,
        )
      ).rows[0].disabled,
    ),
  ).toBe(1);
  expect((await purgeWorkspace(ws, dependencies)).pending).toBe(true);
  expect(files).toBe(0);
  await p.execute(
    `UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id='purge'`,
  );
  const failed = await purgeWorkspace(ws, dependencies);
  expect(failed.completed).toBe(false);
  expect(failed.errors[0]).toContain("revocation");
  expect(databases).toBe(0);
  const retained = (
    await p.execute(`SELECT * FROM workspaces WHERE id='purge'`)
  ).rows[0];
  expect(retained.purged_at).toBeNull();
  expect(retained.db_token_enc).toBeTruthy();
  expect(retained.gateway_key_id).toBe("key-id");
  fail = false;
  await p.execute(
    `UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id='purge'`,
  );
  expect((await purgeWorkspace(ws, dependencies)).completed).toBe(true);
  expect(files).toBe(1);
  expect(keys).toBe(2);
  expect(databases).toBe(1);
  expect((await purgeWorkspace(ws, dependencies)).completed).toBe(true);
  expect(databases).toBe(1);
  const done = (await p.execute(`SELECT * FROM workspaces WHERE id='purge'`))
    .rows[0];
  expect(done.purged_at).toBeTruthy();
  expect(done.db_token_enc).toBeNull();
  expect(done.keys_enc).toBeNull();
  expect(
    (
      await p.execute(
        "SELECT db_token_enc FROM workspace_provisioning WHERE workspace_id='purge'",
      )
    ).rows[0].db_token_enc,
  ).toBeNull();
});

test("workspace purge removes only its consumer grants and pending states, fencing a late OAuth callback", async () => {
  const { platformReady, platformDb, getWorkspace } = await import("../../lib/platform");
  const { markWorkspaceDeleted, purgeWorkspace } = await import("../../lib/purge");
  const consumer = await import("../../lib/higgsfield-consumer/store");
  await platformReady();
  const p = platformDb();
  await p.execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES('consumer-purge','consumer-purge','Customer',?,'owner',0,0)`,
    args: [`file:${path.join(dir, "consumer-purge.db")}`],
  });
  const states = [];
  for (const [index, workspaceId] of ["consumer-purge", "other-customer"].entries()) {
    const identity = { workspaceId, userId: "owner" };
    const state = String(index).repeat(43), sessionHash = "fixture-session-hash";
    await consumer.storeAuthorization({ ...identity, state, sessionHash, verifier: "v".repeat(43), clientId: "fixture-client", redirectUri: "https://particl.example/callback" });
    const authorization = await consumer.consumeAuthorization(state, { ...identity, sessionHash });
    const tokens = { accessToken: "fixture-access", refreshToken: "fixture-refresh", clientId: "fixture-client", redirectUri: "https://particl.example/callback", expiresAt: Date.now() + 3600_000, scope: "offline_access" };
    expect(await consumer.completeAuthorization(authorization!, tokens)).toBe(true);
    states.push({ authorization: authorization!, tokens });
  }
  // A second pending login from another owner must also be removed.
  await consumer.storeAuthorization({ workspaceId: "consumer-purge", userId: "previous-owner", state: "p".repeat(43), sessionHash: "hash", verifier: "v".repeat(43), clientId: "fixture-client", redirectUri: "https://particl.example/callback" });
  const ws = (await getWorkspace("consumer-purge"))!;
  await markWorkspaceDeleted(ws.id);
  await p.execute("UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id='consumer-purge'");
  const result = await purgeWorkspace(ws, { files: async () => ({ files: 0, uploads: 0 }), key: async () => {}, database: async () => {} });
  expect(result.completed).toBe(true);
  for (const table of ["higgsfield_consumer_connections", "higgsfield_consumer_authorizations"]) {
    const rows = (await p.execute(`SELECT workspace_id FROM ${table} WHERE workspace_id IN ('consumer-purge','other-customer')`)).rows;
    expect(rows.map(row => row.workspace_id)).toEqual(["other-customer"]);
  }
  expect(await consumer.completeAuthorization(states[0].authorization, states[0].tokens)).toBe(false);
  expect(await consumer.claimConsumerAccess({ workspaceId: "consumer-purge", userId: "owner" })).toEqual({ kind: "missing" });
  expect((await consumer.claimConsumerAccess({ workspaceId: "other-customer", userId: "owner" })).kind).toBe("ready");
});

test("workspace export includes shared production records and owner drafts but excludes other private drafts and credentials", async () => {
  const { rowToWorkspace, platformDb, platformReady } =
    await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { saveDraft, publishBible } =
    await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workspaceExport } = await import("../../lib/workspaceExport");
  await platformReady();
  const ws = rowToWorkspace({
    id: "export",
    slug: "customer",
    name: "Customer House",
    db_url: `file:${path.join(dir, "export.db")}`,
    owner_id: "owner",
    uses_platform_keys: 1,
  });
  await platformDb().execute(
    `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('a','export',30,'purchase',0),('b','different',100,'purchase',0)`,
  );
  await runInTenant(ws, async () => {
    await saveDraft(
      "owner",
      { ...newProject("Owner work"), brief: "owner draft" },
      0,
    );
    const other = newProject("Collaborator work");
    await saveDraft("collaborator", { ...other, brief: "published brief" }, 0);
    await publishBible("collaborator", "Collaborator", other.id, 0);
    await saveDraft(
      "collaborator",
      { ...other, brief: "PRIVATE-COLLABORATOR-SECRET" },
      1,
    );
    await db().execute(
      `INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('owner','owner@example.test','Owner','admin','PASSWORD-SECRET',0)`,
    );
    await db().execute(
      `INSERT INTO generations(id,model,prompt,params,status,cost_usd,created_at,updated_at) VALUES('export-take','test','Customer prompt','{"paidClaim":"INTERNAL-CLAIM"}','succeeded',12.34,0,0)`,
    );
    const { soulIdentitiesReady } = await import("../../lib/soulIdentities");
    await soulIdentitiesReady();
    await db().execute({ sql: "UPDATE generations SET params=? WHERE id='export-take'", args: [JSON.stringify({ paidClaim: "INTERNAL-CLAIM", soulReferenceId: "PRIVATE-SOUL-UUID", soulCredentialFingerprint: "PRIVATE-CONNECTION", soulVendorCostUsd: 9.87, higgsfieldCredentialFingerprint: "PRIVATE-MARKETING-CONNECTION", higgsfieldVendorCostUsd: 99.1, higgsfieldStillHandle: { ref: "PRIVATE-REQUEST" }, higgsfieldVideoHandle: { ref: "PRIVATE-VIDEO-REQUEST", cancelUrl: "PRIVATE-CANCEL-URL" }, higgsfieldVideoPollUntil: 123, higgsfieldVideoPollToken: "PRIVATE-POLL-TOKEN", genjutsuOriginal: {sha256:"PRIVATE-DIGEST"}, soulIdentityId: "soul-local" })] });
    await db().execute(`INSERT INTO soul_identities(id,owner,name,description,subject_type,references_json,status,provider_reference_id,credential_fingerprint,created_at,updated_at,consent_at) VALUES('soul-local','owner','Mira','','character','[]','ready','PRIVATE-SOUL-UUID','PRIVATE-CONNECTION',0,0,0)`);
    const soulExport = await workspaceExport("owner", "owner@example.test") as unknown as { soul_identities: unknown[]; generations: { params: Record<string, unknown> }[] };
    expect(JSON.stringify(soulExport)).not.toMatch(/PRIVATE-SOUL-UUID|PRIVATE-CONNECTION|PRIVATE-REQUEST|soulVendorCostUsd|PRIVATE-MARKETING-CONNECTION|higgsfieldVendorCostUsd|PRIVATE-VIDEO-REQUEST|PRIVATE-CANCEL-URL|PRIVATE-POLL-TOKEN|PRIVATE-DIGEST|higgsfieldVideoPollUntil/);
    expect(soulExport.soul_identities).toHaveLength(1);
    expect(soulExport.generations[0].params).toMatchObject({ soulIdentityId: "soul-local" });
    await platformDb().execute(
      `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('export-take','export','video','test','test','succeeded',12.34,186,1,0,0)`,
    );
    const { pipelineStore } = await import("../../lib/pipeline/store");
    const { pipelineHash } = await import("../../lib/pipeline/compile");
    const store = await pipelineStore();
    const publishedProject = (
      await db().execute("SELECT project_id FROM workbench_bibles LIMIT 1")
    ).rows[0].project_id;
    const specification = {
      schemaVersion: 1,
      name: "Owner pipeline",
      context: { projectId: String(publishedProject), bibleVersion: 1 },
      stages: [
        {
          id: "images",
          label: "Images",
          kind: "image",
          model: "image-model",
          prompt: { source: "brief" },
          resolution: "1K",
        },
      ],
    };
    const ownerVersion = await store.saveVersion("owner", specification, 0);
    const run = await store.createRun("owner", ownerVersion.id, 1);
    const reference = await store.stageInputs("owner", run.id, "images");
    const quote = await store.quoteStage(
      "owner",
      run.id,
      run.revision,
      "images",
      reference.inputHash,
      [
        {
          unit: 0,
          prepared: {
            version: 1,
            kind: "image",
            workspaceId: "export",
            actorId: "owner",
            request: {
              projectId: String(publishedProject),
              model: "image-model",
            },
            compiled: {
              provider: "PRIVATE-PROVIDER-KEY",
              storageUrl: "https://private.example.test/SECRET-STORAGE-PATH",
            },
            quote: {
              fingerprint: pipelineHash("quoted"),
              estimatedCredits: 7,
              price: 7,
              unit: "cr",
            },
          },
        },
      ],
    );
    await store.approveQuote(
      "owner",
      run.id,
      quote.baseRevision,
      quote.id,
      quote.fingerprint,
    );
    await store.claimRun(run.id);
    const otherVersion = await store.saveVersion(
      "collaborator",
      { ...specification, name: "PRIVATE-COLLABORATOR-PIPELINE" },
      0,
    );
    await store.createRun("collaborator", otherVersion.id, 1);
    const exported = await workspaceExport("owner", "owner@example.test");
    const serialized = JSON.stringify(exported);
    expect(exported.workspace.name).toBe("Customer House");
    expect(exported.counts.workbench_projects).toBe(1);
    expect(exported.counts.workbench_bibles).toBe(1);
    expect(exported.counts.credit_grants).toBe(1);
    expect(exported.counts.pipeline_versions).toBe(1);
    expect(exported.counts.pipeline_runs).toBe(1);
    expect(JSON.parse(serialized).pipeline_runs[0].attempts[0]).toMatchObject({
      state: "queued",
      kind: "image",
      estimatedCredits: 7,
    });
    expect(serialized).toContain("Owner pipeline");
    expect(serialized).not.toContain("PRIVATE-COLLABORATOR-PIPELINE");
    expect(serialized).not.toContain("PRIVATE-PROVIDER-KEY");
    expect(serialized).not.toContain("SECRET-STORAGE-PATH");
    expect(serialized).not.toContain("lease_token");
    expect(serialized).not.toContain('"prepared"');
    expect(serialized).not.toContain('"compiled"');
    expect(serialized).not.toContain("pipeline_wakeups");
    expect(serialized).toContain("owner draft");
    expect(serialized).toContain("published brief");
    expect(serialized).not.toContain("PRIVATE-COLLABORATOR-SECRET");
    expect(serialized).not.toContain("PASSWORD-SECRET");
    expect(serialized).not.toContain("INTERNAL-CLAIM");
    expect(serialized).not.toContain("cost_usd");
    expect(serialized).not.toContain("12.34");
    expect(JSON.parse(serialized).generations[0].billed_credits).toBe(186);
  });
});
