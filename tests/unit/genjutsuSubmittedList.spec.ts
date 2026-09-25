import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { CreateConsumerJob } from "../../lib/higgsfield-consumer/jobs";

/**
 * Viral › History reads the transform jobs with `submittedOnly`: every estimate
 * the composer reads is a `quoted` row, and with 25 rows to a page they would
 * push finished results off it. The recovery list without the flag is unchanged.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-submitted-list-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-consumer-ledger-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
const workspace = (): TenantWorkspace => ({
  id: "submitted-list", slug: "submitted-list", name: "submitted-list", legacy: true, dbUrl: `file:${path.join(directory, "workspace.db")}`, dbToken: null, keys: {},
  usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null,
  flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});
const owner = { userId: "owner", draftId: "draft" };
const input = (): CreateConsumerJob => ({
  ...owner, connectedOwnerId: "connected-owner", connectionGeneration: randomUUID(), workflow: "marketing-video", idempotencyKey: randomUUID(),
  payload: { params: { prompt: "Bottle on a stone plinth", duration: 15 }, count: 1 }, quoteCredits: 7.5, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: ["product-original"],
});

test("a submitted-only list leaves read-only quotes out and keeps everything that ran", async () => {
  const jobs = await import("../../lib/higgsfield-consumer/jobs");
  const database = await import("../../lib/db");
  const tenant = await import("../../lib/tenant");
  await tenant.runInTenant(workspace(), async () => {
    await database.ready();
    await database.db().execute({
      sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
      args: [`${owner.userId}-${owner.draftId}`, owner.userId, owner.draftId, "Test draft", JSON.stringify({ assets: [{ id: "product-original" }] }), Date.now()],
    });
    const quotes = await Promise.all(Array.from({ length: 30 }, () => jobs.createConsumerJob(input())));
    const ran = quotes[0].job;
    const claim = await jobs.claimConsumerDispatch({ ...owner, id: ran.id });
    await jobs.markConsumerAccepted({ ...owner, id: ran.id, claimToken: claim!.claimToken, providerJobId: randomUUID() });

    const every = await jobs.listConsumerRecoveryJobs({ ...owner, workflow: "marketing-video", limit: 25 });
    expect(every).toHaveLength(25);
    expect(every.some((job) => job.status === "quoted")).toBe(true);
    const submitted = await jobs.listConsumerRecoveryJobs({ ...owner, workflow: "marketing-video", limit: 25, submittedOnly: true });
    expect(submitted.map((job) => [job.id, job.status])).toEqual([[ran.id, "accepted"]]);
    /* Scoped as before: another owner's draft reads nothing. */
    expect(await jobs.listConsumerRecoveryJobs({ userId: "someone-else", draftId: owner.draftId, workflow: "marketing-video", submittedOnly: true })).toEqual([]);
  });
});
