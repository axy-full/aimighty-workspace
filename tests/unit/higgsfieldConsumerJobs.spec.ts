import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type {
  CreateConsumerJob,
  ConsumerJob,
} from "../../lib/higgsfield-consumer/jobs";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-jobs-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-consumer-ledger-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
function workspace(): TenantWorkspace {
  const name = `ledger-${++sequence}`;
  return {
    id: name,
    slug: name,
    name,
    legacy: true,
    dbUrl: `file:${path.join(directory, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "owner",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
const owner = { userId: "owner", draftId: "draft" };
const input = (
  overrides: Partial<CreateConsumerJob> = {},
): CreateConsumerJob => ({
  ...owner,
  connectedOwnerId: "connected-owner",
  connectionGeneration: randomUUID(),
  workflow: "marketing-video",
  idempotencyKey: randomUUID(),
  payload: {
    params: { prompt: "Bottle on a stone plinth", duration: 15 },
    count: 1,
  },
  quoteCredits: 7.5,
  quoteExpiresAt: Date.now() + 60_000,
  originalAssetIds: ["product-original"],
  ...overrides,
});
const key = (job: ConsumerJob) => ({
  userId: job.userId,
  draftId: job.draftId,
  id: job.id,
});
async function modules() {
  return {
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
  };
}
async function seed(userId = owner.userId, draftId = owner.draftId) {
  const { database } = await modules();
  await database.ready();
  await database.db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
    args: [
      `${userId}-${draftId}`,
      userId,
      draftId,
      "Test draft",
      JSON.stringify({ assets: [{ id: "product-original" }] }),
      Date.now(),
    ],
  });
}
async function fixture<T>(
  run: (m: Awaited<ReturnType<typeof modules>>) => Promise<T>,
) {
  const m = await modules();
  return m.tenant.runInTenant(workspace(), async () => {
    await seed();
    return run(m);
  });
}
async function accepted(jobs: Awaited<ReturnType<typeof modules>>["jobs"]) {
  const { job } = await jobs.createConsumerJob(input());
  const claim = await jobs.claimConsumerDispatch(key(job));
  const result = await jobs.markConsumerAccepted({
    ...key(job),
    claimToken: claim!.claimToken,
    providerJobId: randomUUID(),
  });
  return { job: result!, claim: claim! };
}

test("stable immutable payloads replay one row, including after dispatch; changed terms conflict", async () => {
  await fixture(async ({ jobs, database }) => {
    const request = input();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => jobs.createConsumerJob(request)),
    );
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const original = results[0].job;
    expect(
      (
        await jobs.getConsumerJobByKey({
          ...owner,
          idempotencyKey: request.idempotencyKey,
        })
      )?.id,
    ).toBe(original.id);
    expect(
      await jobs.getConsumerJobByKey({
        ...owner,
        userId: "another-owner",
        idempotencyKey: request.idempotencyKey,
      }),
    ).toBeNull();
    expect(
      await jobs.getConsumerJobByKey({
        ...owner,
        draftId: "another-draft",
        idempotencyKey: request.idempotencyKey,
      }),
    ).toBeNull();
    const reordered = await jobs.createConsumerJob({
      ...request,
      payload: {
        count: 1,
        params: { duration: 15, prompt: "Bottle on a stone plinth" },
      },
    });
    expect(reordered.replayed).toBe(true);
    expect(original.payloadHash).toBe(
      createHash("sha256").update(original.payloadJson).digest("hex"),
    );
    expect(original).toMatchObject({
      quoteCredits: 7.5,
      creditUnit: "higgsfield_credits",
      higgsfieldWorkspaceId: null,
    });
    expect(JSON.stringify(original)).not.toMatch(
      /usd|claimToken|leaseToken|claim_hash/,
    );
    for (const changed of [
      { payload: { count: 2 } },
      { connectedOwnerId: "another-owner" },
      { connectionGeneration: randomUUID() },
      { higgsfieldWorkspaceId: "another-wallet" },
      { quoteCredits: 8 },
      { quoteExpiresAt: request.quoteExpiresAt + 1 },
      { originalAssetIds: ["another-original"] },
    ])
      await expect(
        jobs.createConsumerJob({ ...request, ...changed }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await jobs.claimConsumerDispatch(key(original));
    expect((await jobs.createConsumerJob(request)).job.status).toBe(
      "dispatching",
    );
    expect(
      Number(
        (
          await database
            .db()
            .execute("SELECT count(*) AS count FROM higgsfield_consumer_jobs")
        ).rows[0].count,
      ),
    ).toBe(1);
  });
});

test("owner, draft, and tenant boundaries protect both reads and mutations", async () => {
  const { tenant, jobs } = await modules(),
    first = workspace(),
    second = workspace();
  let id = "";
  await tenant.runInTenant(first, async () => {
    await seed();
    await seed("other-owner", "draft");
    await seed("owner", "other-draft");
    const request = input({ idempotencyKey: "same-key" });
    id = (await jobs.createConsumerJob(request)).job.id;
    await expect(
      jobs.createConsumerJob({ ...request, userId: "unknown" }),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const wrong of [
      { userId: "other-owner", draftId: "draft" },
      { userId: "owner", draftId: "other-draft" },
    ]) {
      expect(await jobs.getConsumerJob({ ...wrong, id })).toBeNull();
      expect((await jobs.listConsumerJobs(wrong)).items).toEqual([]);
      await expect(
        jobs.claimConsumerDispatch({ ...wrong, id }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        (await jobs.createConsumerJob({ ...request, ...wrong })).job.id,
      ).not.toBe(id);
    }
  });
  await tenant.runInTenant(second, async () => {
    await seed();
    expect(await jobs.getConsumerJob({ ...owner, id })).toBeNull();
    expect((await jobs.listConsumerJobs(owner)).items).toEqual([]);
    await expect(
      jobs.claimConsumerDispatch({ ...owner, id }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await jobs.createConsumerJob(input({ idempotencyKey: "same-key" }))).job
        .id,
    ).not.toBe(id);
  });
  await expect(jobs.getConsumerJob({ ...owner, id })).rejects.toThrow(
    "No workspace",
  );
});

test("quote snapshots cannot change while creation awaits the database lock", async () => {
  await fixture(async ({ jobs }) => {
    const request = input(),
      approved = structuredClone(request);
    const pending = jobs.createConsumerJob(request);
    request.quoteCredits = 999;
    request.connectionGeneration = randomUUID();
    request.originalAssetIds.push("not-approved");
    request.payload.changed = true;
    const result = await pending;
    expect(result.job.quoteCredits).toBe(approved.quoteCredits);
    expect(result.job.connectionGeneration).toBe(approved.connectionGeneration);
    expect(result.job.originalAssetIds).toEqual(approved.originalAssetIds);
    expect(JSON.parse(result.job.payloadJson)).toEqual(approved.payload);
    expect((await jobs.createConsumerJob(approved)).job.id).toBe(result.job.id);
  });
});

test("concurrent dispatch has one winner; uncertainty remains active and cannot be retried", async () => {
  await fixture(async ({ jobs }) => {
    const { job } = await jobs.createConsumerJob(input());
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => jobs.claimConsumerDispatch(key(job))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(
      await jobs.markConsumerUncertain({ ...key(job), claimToken: "wrong" }),
    ).toBeNull();
    expect(
      (
        await jobs.markConsumerUncertain({
          ...key(job),
          claimToken: claim.claimToken,
        })
      )?.status,
    ).toBe("uncertain");
    expect(await jobs.claimConsumerDispatch(key(job))).toBeNull();
    expect(await jobs.claimConsumerPoll(key(job))).toBeNull();
    expect(
      await jobs.markConsumerFailed({
        ...key(job),
        claimToken: claim.claimToken,
      }),
    ).toBeNull();
    const providerJobId = randomUUID();
    expect(
      (
        await jobs.markConsumerAccepted({
          ...key(job),
          claimToken: claim.claimToken,
          providerJobId,
        })
      )?.status,
    ).toBe("accepted");
    expect(await jobs.claimConsumerDispatch(key(job))).toBeNull();
  });
});

test("a workspace admits four active jobs atomically, including uncertain jobs in another draft", async () => {
  await fixture(async ({ jobs }) => {
    await seed("owner", "second-draft");
    const records = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        jobs.createConsumerJob(
          input({ draftId: index % 2 ? "second-draft" : "draft" }),
        ),
      ),
    );
    const outcomes = await Promise.allSettled(
      records.map(({ job }) => jobs.claimConsumerDispatch(key(job))),
    );
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(4);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(4);
    const claims = outcomes.flatMap((result, index) =>
      result.status === "fulfilled" && result.value
        ? [{ ...result.value, index }]
        : [],
    );
    for (const claim of claims)
      await jobs.markConsumerUncertain({
        ...key(claim.job),
        claimToken: claim.claimToken,
      });
    const waiting = records.find(
      ({ job }) => !claims.some((claim) => claim.job.id === job.id),
    )!.job;
    await expect(
      jobs.claimConsumerDispatch(key(waiting)),
    ).rejects.toMatchObject({ code: "capacity", status: 429 });
    const first = claims[0];
    await jobs.markConsumerAccepted({
      ...key(first.job),
      claimToken: first.claimToken,
      providerJobId: randomUUID(),
    });
    const poll = await jobs.claimConsumerPoll(key(first.job));
    await jobs.completeConsumerJob({
      ...key(first.job),
      leaseToken: poll!.leaseToken,
      resultManifest: { original: "asset-result" },
    });
    expect((await jobs.claimConsumerDispatch(key(waiting)))?.job.status).toBe(
      "dispatching",
    );
  });
});

test("uncertain provider acknowledgements persist atomically and cannot be overwritten or replayed as submission", async () => {
  await fixture(async ({ jobs }) => {
    const { job } = await jobs.createConsumerJob(input()),
      claim = (await jobs.claimConsumerDispatch(key(job)))!;
    const providerReceipt = {
      response: { state: "submitted", request_ref: "unexpected-handle-format" },
      qualification: "unsupported-provider-shape",
    };
    expect(
      await jobs.markConsumerUncertain({
        ...key(job),
        claimToken: "wrong",
        providerReceipt,
      }),
    ).toBeNull();
    expect(
      (
        await jobs.markConsumerUncertain({
          ...key(job),
          claimToken: claim.claimToken,
          providerReceipt,
        })
      )?.providerReceipt,
    ).toEqual(providerReceipt);
    expect((await jobs.getConsumerJob(key(job)))?.providerReceipt).toEqual(
      providerReceipt,
    );
    expect(
      (
        await jobs.markConsumerUncertain({
          ...key(job),
          claimToken: claim.claimToken,
          providerReceipt,
        })
      )?.status,
    ).toBe("uncertain");
    await expect(
      jobs.markConsumerUncertain({
        ...key(job),
        claimToken: claim.claimToken,
        providerReceipt: { different: true },
      }),
    ).rejects.toMatchObject({ code: "receipt_conflict" });
    expect(() =>
      jobs.markConsumerUncertain({
        ...key(job),
        claimToken: claim.claimToken,
        providerReceipt: { oversized: "x".repeat(65_537) },
      }),
    ).toThrow("invalid_input");
    expect(await jobs.claimConsumerDispatch(key(job))).toBeNull();
    const providerJobId = randomUUID();
    expect(
      (
        await jobs.markConsumerAccepted({
          ...key(job),
          claimToken: claim.claimToken,
          providerJobId,
        })
      )?.providerReceipt,
    ).toEqual(providerReceipt);
  });
});

test("quote expiry blocks fresh claims but does not destroy matching idempotent replay", async () => {
  await fixture(async ({ jobs }) => {
    await expect(
      jobs.createConsumerJob(input({ quoteExpiresAt: Date.now() - 1 })),
    ).rejects.toMatchObject({ code: "quote_expired" });
    const request = input(),
      { job } = await jobs.createConsumerJob(request);
    const realNow = Date.now;
    Date.now = () => request.quoteExpiresAt + 1;
    try {
      await expect(jobs.claimConsumerDispatch(key(job))).rejects.toMatchObject({
        code: "quote_expired",
      });
      expect((await jobs.createConsumerJob(request)).job.id).toBe(job.id);
      expect((await jobs.getConsumerJob(key(job)))?.status).toBe("quoted");
    } finally {
      Date.now = realNow;
    }
  });
});

test("provider UUID is bound once to its original claim and cannot belong to a different job", async () => {
  await fixture(async ({ jobs }) => {
    const { job } = await jobs.createConsumerJob(input()),
      claim = (await jobs.claimConsumerDispatch(key(job)))!;
    await expect(
      jobs.markConsumerAccepted({
        ...key(job),
        claimToken: claim.claimToken,
        providerJobId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const providerJobId = randomUUID();
    expect(
      await jobs.markConsumerAccepted({
        ...key(job),
        claimToken: "wrong",
        providerJobId,
      }),
    ).toBeNull();
    expect(
      (
        await jobs.markConsumerAccepted({
          ...key(job),
          claimToken: claim.claimToken,
          providerJobId: providerJobId.toUpperCase(),
        })
      )?.providerJobId,
    ).toBe(providerJobId);
    expect(
      (
        await jobs.markConsumerAccepted({
          ...key(job),
          claimToken: claim.claimToken,
          providerJobId,
        })
      )?.id,
    ).toBe(job.id);
    await expect(
      jobs.markConsumerAccepted({
        ...key(job),
        claimToken: claim.claimToken,
        providerJobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "provider_job_conflict" });
    const other = (await jobs.createConsumerJob(input())).job,
      second = (await jobs.claimConsumerDispatch(key(other)))!;
    await expect(
      jobs.markConsumerAccepted({
        ...key(other),
        claimToken: second.claimToken,
        providerJobId,
      }),
    ).rejects.toMatchObject({ code: "provider_job_conflict" });
    expect((await jobs.getConsumerJob(key(other)))?.status).toBe("dispatching");
  });
});

test("poll leases admit one collector and stale or foreign claims cannot complete a job", async () => {
  await fixture(async ({ jobs, database }) => {
    const { job } = await accepted(jobs);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => jobs.claimConsumerPoll(key(job))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    expect(
      await jobs.completeConsumerJob({
        ...key(job),
        leaseToken: "wrong",
        resultManifest: { result: "wrong" },
      }),
    ).toBeNull();
    await database.db().execute({
      sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=0 WHERE id=?",
      args: [job.id],
    });
    expect(
      await jobs.completeConsumerJob({
        ...key(job),
        leaseToken: old.leaseToken,
        resultManifest: { result: "stale" },
      }),
    ).toBeNull();
    const current = (await jobs.claimConsumerPoll(key(job)))!;
    expect(current.leaseToken).not.toBe(old.leaseToken);
    expect(
      await jobs.releaseConsumerPoll({
        ...key(job),
        leaseToken: old.leaseToken,
      }),
    ).toBeNull();
    const resultManifest = {
      assets: [{ id: "collected-original", sha256: "a".repeat(64) }],
      score: null,
    };
    const completed = await jobs.completeConsumerJob({
      ...key(job),
      leaseToken: current.leaseToken,
      resultManifest,
    });
    expect(completed).toMatchObject({
      status: "completed",
      resultManifest,
      providerJobId: job.providerJobId,
    });
    expect(
      await jobs.completeConsumerJob({
        ...key(job),
        leaseToken: current.leaseToken,
        resultManifest: { overwrite: true },
      }),
    ).toBeNull();
    expect(await jobs.claimConsumerPoll(key(job))).toBeNull();
    expect(await jobs.claimConsumerDispatch(key(job))).toBeNull();
    expect((await jobs.getConsumerJob(key(job)))?.resultManifest).toEqual(
      resultManifest,
    );
  });
});

test("bounded JSON rejects non-JSON values and hostile getters without reading them", async () => {
  await fixture(async ({ jobs }) => {
    let reads = 0;
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        reads++;
        return "secret";
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const payload of [
      getter,
      cycle,
      { number: Infinity },
      { date: new Date() },
      { large: "x".repeat(65_537) },
      { undefined: undefined },
      { array: [, 1] },
    ]) {
      await expect(
        jobs.createConsumerJob(
          input({ payload: payload as CreateConsumerJob["payload"] }),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(reads).toBe(0);
    for (const partial of [
      { quoteCredits: -1 },
      { quoteCredits: NaN },
      { originalAssetIds: ["duplicate", "duplicate"] },
      { higgsfieldWorkspaceId: "invalid workspace" },
    ]) {
      await expect(
        jobs.createConsumerJob(input(partial)),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    const { job } = await accepted(jobs),
      lease = (await jobs.claimConsumerPoll(key(job)))!;
    expect(() =>
      jobs.completeConsumerJob({
        ...key(job),
        leaseToken: lease.leaseToken,
        resultManifest: { tooLarge: "x".repeat(262_145) },
      }),
    ).toThrow("invalid_input");
    expect((await jobs.getConsumerJob(key(job)))?.status).toBe("accepted");
    expect(
      (
        await jobs.releaseConsumerPoll({
          ...key(job),
          leaseToken: lease.leaseToken,
        })
      )?.status,
    ).toBe("accepted");
    const next = (await jobs.claimConsumerPoll(key(job)))!;
    expect(
      (
        await jobs.failConsumerPoll({
          ...key(job),
          leaseToken: next.leaseToken,
          failureCode: "invalid_result",
        })
      )?.failureCode,
    ).toBe("invalid_result");
    expect(await jobs.claimConsumerDispatch(key(job))).toBeNull();
  });
});

test("provider polling backoff survives fresh reads and refuses early multi-window claims", async () => {
  await fixture(async ({ jobs }) => {
    const { job } = await accepted(jobs),
      lease = (await jobs.claimConsumerPoll(key(job)))!;
    const nextPollAt = Date.now() + 120_000;
    expect(() =>
      jobs.releaseConsumerPoll({
        ...key(job),
        leaseToken: lease.leaseToken,
        nextPollAt: Date.now() - 1,
      }),
    ).toThrow("invalid_input");
    expect(() =>
      jobs.releaseConsumerPoll({
        ...key(job),
        leaseToken: lease.leaseToken,
        nextPollAt: Date.now() + 3_600_001,
      }),
    ).toThrow("invalid_input");
    expect(
      (
        await jobs.releaseConsumerPoll({
          ...key(job),
          leaseToken: lease.leaseToken,
          nextPollAt,
        })
      )?.status,
    ).toBe("accepted");
    expect((await jobs.getConsumerJob(key(job)))?.status).toBe("accepted");
    expect(await jobs.claimConsumerPoll(key(job))).toBeNull();
    const realNow = Date.now;
    Date.now = () => nextPollAt - 1;
    try {
      expect(await jobs.claimConsumerPoll(key(job))).toBeNull();
    } finally {
      Date.now = realNow;
    }
    Date.now = () => nextPollAt;
    try {
      const later = await jobs.claimConsumerPoll(key(job));
      expect(later).not.toBeNull();
      expect(later?.leaseToken).not.toBe(lease.leaseToken);
    } finally {
      Date.now = realNow;
    }
  });
});

test("stable pagination and late receipts survive draft deletion without permitting new spend", async () => {
  await fixture(async ({ jobs, database }) => {
    const created = await Promise.all(
      Array.from({ length: 5 }, () => jobs.createConsumerJob(input())),
    );
    const first = await jobs.listConsumerJobs({ ...owner, limit: 2 });
    const second = await jobs.listConsumerJobs({
      ...owner,
      limit: 2,
      before: first.nextCursor!,
    });
    const third = await jobs.listConsumerJobs({
      ...owner,
      limit: 2,
      before: second.nextCursor!,
    });
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.items, ...second.items, ...third.items].map((job) => job.id),
      ).size,
    ).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(JSON.stringify(first)).not.toMatch(
      /lease_hash|dispatch_claim|immutable_hash/,
    );
    const running = created[0].job;
    const claim = (await jobs.claimConsumerDispatch(key(running)))!;
    await database.db().execute({
      sql: "DELETE FROM workbench_projects WHERE owner=? AND project_id=?",
      args: [owner.userId, owner.draftId],
    });
    expect((await jobs.getConsumerJob(key(running)))?.status).toBe(
      "dispatching",
    );
    expect((await jobs.listConsumerJobs(owner)).items).toHaveLength(5);
    await expect(
      jobs.claimConsumerDispatch(key(created[1].job)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(jobs.createConsumerJob(input())).rejects.toMatchObject({
      code: "not_found",
    });
    const providerJobId = randomUUID();
    expect(
      (
        await jobs.markConsumerAccepted({
          ...key(running),
          claimToken: claim.claimToken,
          providerJobId,
        })
      )?.status,
    ).toBe("accepted");
    const poll = (await jobs.claimConsumerPoll(key(running)))!;
    const receipt = await jobs.completeConsumerJob({
      ...key(running),
      leaseToken: poll.leaseToken,
      resultManifest: { outputAssetId: "recoverable-original" },
    });
    expect(receipt).toMatchObject({
      status: "completed",
      providerJobId,
      resultManifest: { outputAssetId: "recoverable-original" },
    });
    await seed("reassigned-owner", "draft");
    expect(
      await jobs.getConsumerJob({
        ...key(running),
        userId: "reassigned-owner",
      }),
    ).toBeNull();
    await expect(jobs.createConsumerJob(input())).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

test("receipt recovery is immutable, owner-scoped, unique and never restores dispatch admission", async () => {
  await fixture(async ({ jobs }) => {
    const { job } = await jobs.createConsumerJob(input());
    const scope = key(job);
    const claim = await jobs.claimConsumerDispatch(scope);
    const providerJobId = randomUUID();
    const receipt = { response: { results: [{ id: providerJobId, model: "marketing_studio_video", type: "video" }] } };
    await jobs.markConsumerUncertain({ ...scope, claimToken: claim!.claimToken, providerReceipt: receipt });
    expect(await jobs.reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: { wrong: true } })).toBeNull();
    await expect(jobs.reconcileConsumerReceipt({ ...scope, userId: "another-owner", providerJobId, expectedReceipt: receipt })).rejects.toMatchObject({ code: "not_found" });
    const recovered = await jobs.reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: receipt });
    expect(recovered?.status).toBe("accepted");
    expect(recovered?.providerJobId).toBe(providerJobId);
    expect(await jobs.claimConsumerDispatch(scope)).toBeNull();
    expect((await jobs.reconcileConsumerReceipt({ ...scope, providerJobId, expectedReceipt: receipt }))?.status).toBe("accepted");
    await expect(jobs.reconcileConsumerReceipt({ ...scope, providerJobId: randomUUID(), expectedReceipt: receipt })).rejects.toMatchObject({ code: "provider_job_conflict" });
  });
});
