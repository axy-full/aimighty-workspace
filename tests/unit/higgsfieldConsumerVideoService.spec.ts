import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerVideoInput } from "../../lib/higgsfield-consumer/video-contract";
import type * as Service from "../../lib/higgsfield-consumer/video-service";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-service-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??=
  "consumer-service-unit-keyring-not-a-real-secret";
let sequence = 0;
const identity = { userId: "owner", draftId: "draft" };
const prompt: ConsumerVideoInput = {
  prompt: "A plain bottle",
  duration: 15,
  resolution: "720p",
  aspectRatio: "16:9",
  generateAudio: true,
};

/** The real service and real tenant ledger run together. Only OAuth and MCP
 * network dependencies are substituted; these tests never contact a provider. */
async function fixture(
  run: (f: Awaited<ReturnType<typeof serviceFixture>>) => Promise<void>,
) {
  const f = await serviceFixture();
  return f.tenant.runInTenant(f.workspace, async () => {
    await f.database.ready();
    await f.database
      .db()
      .execute(
        "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Campaign','{}',1,0)",
      );
    return run(f);
  });
}
async function serviceFixture() {
  const tenant = await import("../../lib/tenant"),
    database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"),
    oauth = await import("../../lib/higgsfield-consumer/oauth"),
    contract = await import("../../lib/higgsfield-consumer/video-contract");
  const id = `service-${++sequence}`;
  const workspace = {
    id,
    slug: id,
    name: id,
    legacy: true,
    dbUrl: `file:${path.join(directory, `${id}.db`)}`,
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
  } as TenantWorkspace;
  const state = {
    generation: randomUUID(),
    wallet: randomUUID(),
    credits: 7,
    providerJobId: randomUUID(),
    mode: "accepted" as "accepted" | "uncertain" | "throw-after-claim",
    quoteCount: 0,
    paidCount: 0,
    statusCount: 0,
    accessCount: 0,
    rejectQuote: false,
    failAckPersistence: false,
    changeGrantAtAdmission: false,
    changeGrantDuringQuote: false,
    pollAfterSeconds: 120,
    pollFailure: false,
    quoteBarrier: undefined as (() => Promise<void>) | undefined,
  };
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/workbench/studio": await import("../../lib/workbench/studio"),
    "./jobs": {
      ...jobs,
      markConsumerAccepted: async (
        ...args: Parameters<typeof jobs.markConsumerAccepted>
      ) => {
        if (state.failAckPersistence)
          throw new Error("Fixture failed acknowledgement persistence");
        return jobs.markConsumerAccepted(...args);
      },
    },
    "./video-contract": contract,
    "./oauth": {
      ConsumerOAuthError: oauth.ConsumerOAuthError,
      getConsumerAccess: async (
        workspaceId: string,
        userId: string,
        options: { expectedGeneration?: string },
      ) => {
        state.accessCount++;
        expect(workspaceId).toBe(workspace.id);
        expect(userId).toBe(identity.userId);
        if (
          options.expectedGeneration &&
          options.expectedGeneration !== state.generation
        )
          throw new oauth.ConsumerOAuthError("connection_changed");
        return {
          accessToken: "private-fixture-token",
          generation: state.generation,
        };
      },
    },
    "./mcp": {
      getConsumerVideoQuote: async (
        _token: string,
        input: ConsumerVideoInput,
      ) => {
        state.quoteCount++;
        if (state.quoteBarrier) await state.quoteBarrier();
        if (state.rejectQuote)
          throw new contract.ConsumerVideoError("invalid_quote");
        if (state.changeGrantDuringQuote) state.generation = randomUUID();
        return {
          input,
          workspace: { id: state.wallet, name: "Fixture wallet", credits: 100 },
          credits: state.credits,
        };
      },
      submitConsumerVideo: async (
        _token: string,
        _input: ConsumerVideoInput,
        wallet: string,
        credits: number,
        options: { admit: () => Promise<void> },
      ) => {
        if (wallet !== state.wallet)
          throw new contract.ConsumerVideoError("workspace_changed");
        if (credits !== state.credits)
          throw new contract.ConsumerVideoError("quote_changed");
        if (state.changeGrantAtAdmission) state.generation = randomUUID();
        await options.admit();
        state.paidCount++;
        if (state.mode === "throw-after-claim")
          throw new Error("PRIVATE-PROVIDER-DETAIL");
        return state.mode === "uncertain"
          ? {
              state: "uncertain",
              raw: {
                status: "submitted",
                unexpected_ref: "receipt-for-support",
              },
            }
          : {
              state: "accepted",
              providerJobId: state.providerJobId,
              raw: { job_id: state.providerJobId },
            };
      },
      readConsumerVideoJob: async (
        _token: string,
        providerJobId: string,
        wallet: string,
      ) => {
        state.statusCount++;
        expect(providerJobId).toBe(state.providerJobId);
        if (wallet !== state.wallet)
          throw new contract.ConsumerVideoError("workspace_changed");
        if (state.pollFailure)
          throw new contract.ConsumerVideoError("provider_error");
        return {
          raw: { job_id: providerJobId, status: "processing" },
          pollAfterSeconds: state.pollAfterSeconds,
        };
      },
    },
  };
  const loaded = { exports: {} as typeof Service };
  const source = ts.transpileModule(
    readFileSync("lib/higgsfield-consumer/video-service.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`);
      return deps[name];
    },
    loaded,
    loaded.exports,
  );
  return { service: loaded.exports, state, workspace, tenant, database, jobs };
}

test("quote retry and concurrent first quotes reuse one saved job; changed input conflicts", async () => {
  await fixture(async ({ service, state, jobs }) => {
    const requestKey = randomUUID();
    let reached = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.quoteBarrier = async () => {
      if (++reached === 2) release();
      await barrier;
    };
    const quotes = await Promise.all(
      [1, 2].map(() =>
        service.quoteConsumerMarketingVideo(
          identity.userId,
          identity.draftId,
          prompt,
          requestKey,
        ),
      ),
    );
    expect(quotes[0].id).toBe(quotes[1].id);
    expect((await jobs.listConsumerJobs(identity)).items).toHaveLength(1);
    const before = state.quoteCount;
    expect(
      (
        await service.quoteConsumerMarketingVideo(
          identity.userId,
          identity.draftId,
          prompt,
          requestKey,
        )
      ).id,
    ).toBe(quotes[0].id);
    expect(state.quoteCount).toBe(before);
    await expect(
      service.quoteConsumerMarketingVideo(
        identity.userId,
        identity.draftId,
        { ...prompt, prompt: "Changed" },
        requestKey,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(state.paidCount).toBe(0);
  });
});

test("concurrent submissions admit one paid call and retries reuse its provider UUID", async () => {
  await fixture(async ({ service, state }) => {
    const quote = await service.quoteConsumerMarketingVideo(
      identity.userId,
      identity.draftId,
      prompt,
      randomUUID(),
    );
    const scope = { ...identity, id: quote.id },
      approval = { workspaceId: state.wallet, credits: state.credits };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.submitConsumerMarketingVideo(scope, approval),
      ),
    );
    expect(outcomes.some((result) => result.status === "fulfilled")).toBe(true);
    expect(state.paidCount).toBe(1);
    expect(
      await service.submitConsumerMarketingVideo(scope, approval),
    ).toMatchObject({ status: "accepted", providerJobId: state.providerJobId });
    expect(state.paidCount).toBe(1);
  });
});

test("approval, grant and wallet changes reject before durable admission or paid requests", async () => {
  await fixture(async ({ service, state, jobs }) => {
    const quote = await service.quoteConsumerMarketingVideo(
      identity.userId,
      identity.draftId,
      prompt,
      randomUUID(),
    );
    const scope = { ...identity, id: quote.id },
      approval = { workspaceId: state.wallet, credits: state.credits };
    await expect(
      service.submitConsumerMarketingVideo(scope, {
        ...approval,
        credits: 999,
      }),
    ).rejects.toMatchObject({ code: "approval_changed" });
    const generation = state.generation;
    state.generation = randomUUID();
    await expect(
      service.submitConsumerMarketingVideo(scope, approval),
    ).rejects.toMatchObject({ code: "connection_changed" });
    state.generation = generation;
    const wallet = state.wallet;
    state.wallet = randomUUID();
    await expect(
      service.submitConsumerMarketingVideo(scope, approval),
    ).rejects.toMatchObject({ code: "workspace_changed" });
    state.wallet = wallet;
    state.changeGrantAtAdmission = true;
    await expect(
      service.submitConsumerMarketingVideo(scope, approval),
    ).rejects.toMatchObject({ code: "connection_changed" });
    expect(state.paidCount).toBe(0);
    expect((await jobs.getConsumerJob(scope))?.status).toBe("quoted");
  });
});

test("invalid input/provider quote and a connection replaced during pricing create no job", async () => {
  await fixture(async ({ service, state, jobs }) => {
    await expect(
      service.quoteConsumerMarketingVideo(
        identity.userId,
        identity.draftId,
        { ...prompt, duration: 500 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(state.quoteCount).toBe(0);
    state.rejectQuote = true;
    await expect(
      service.quoteConsumerMarketingVideo(
        identity.userId,
        identity.draftId,
        prompt,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "invalid_quote" });
    state.rejectQuote = false;
    state.changeGrantDuringQuote = true;
    await expect(
      service.quoteConsumerMarketingVideo(
        identity.userId,
        identity.draftId,
        prompt,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "connection_changed" });
    expect((await jobs.listConsumerJobs(identity)).items).toHaveLength(0);
  });
});

test("post-admission errors and unsupported acknowledgement shapes stay uncertain without resubmission", async () => {
  for (const mode of ["throw-after-claim", "uncertain"] as const)
    await fixture(async ({ service, state, jobs }) => {
      state.mode = mode;
      const quote = await service.quoteConsumerMarketingVideo(
        identity.userId,
        identity.draftId,
        prompt,
        randomUUID(),
      );
      const scope = { ...identity, id: quote.id },
        approval = { workspaceId: state.wallet, credits: state.credits };
      const response = await service.submitConsumerMarketingVideo(
        scope,
        approval,
      );
      expect(response.status).toBe("uncertain");
      expect(JSON.stringify(response)).not.toContain("PRIVATE-PROVIDER-DETAIL");
      if (mode === "uncertain")
        expect(
          (await jobs.getConsumerJob(scope))?.providerReceipt,
        ).toMatchObject({
          response: { unexpected_ref: "receipt-for-support" },
        });
      await service.submitConsumerMarketingVideo(scope, approval);
      await service.pollConsumerMarketingVideo(scope);
      expect(state.paidCount).toBe(1);
      expect(state.statusCount).toBe(0);
    });
});

test("accepted UUID remains in uncertain receipt if first acknowledgement persistence fails", async () => {
  await fixture(async ({ service, state, jobs }) => {
    state.failAckPersistence = true;
    const quote = await service.quoteConsumerMarketingVideo(
      identity.userId,
      identity.draftId,
      prompt,
      randomUUID(),
    );
    const scope = { ...identity, id: quote.id };
    expect(
      (
        await service.submitConsumerMarketingVideo(scope, {
          workspaceId: state.wallet,
          credits: state.credits,
        })
      ).status,
    ).toBe("uncertain");
    expect((await jobs.getConsumerJob(scope))?.providerReceipt).toMatchObject({
      job_id: state.providerJobId,
    });
    expect(state.paidCount).toBe(1);
  });
});

test("private draft scope blocks reads, pricing and submissions for other owners or projects", async () => {
  await fixture(async ({ service, state }) => {
    const quote = await service.quoteConsumerMarketingVideo(
      identity.userId,
      identity.draftId,
      prompt,
      randomUUID(),
    );
    for (const wrong of [
      { userId: "another-owner", draftId: identity.draftId },
      { userId: identity.userId, draftId: "another-draft" },
    ]) {
      expect(
        await service.consumerMarketingJobs(wrong.userId, wrong.draftId),
      ).toEqual([]);
      await expect(
        service.quoteConsumerMarketingVideo(
          wrong.userId,
          wrong.draftId,
          prompt,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "project_missing" });
      await expect(
        service.submitConsumerMarketingVideo(
          { ...wrong, id: quote.id },
          { workspaceId: state.wallet, credits: state.credits },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(state.quoteCount).toBe(1);
    expect(state.paidCount).toBe(0);
  });
});

test("accepted polling obeys persisted provider backoff and pins the original connection", async () => {
  await fixture(async ({ service, state }) => {
    const quote = await service.quoteConsumerMarketingVideo(
      identity.userId,
      identity.draftId,
      prompt,
      randomUUID(),
    );
    const scope = { ...identity, id: quote.id };
    await service.submitConsumerMarketingVideo(scope, {
      workspaceId: state.wallet,
      credits: state.credits,
    });
    expect(
      (await service.pollConsumerMarketingVideo(scope)).pollAfterSeconds,
    ).toBe(120);
    expect(state.statusCount).toBe(1);
    await service.pollConsumerMarketingVideo(scope);
    expect(state.statusCount).toBe(1);
    state.generation = randomUUID();
    await expect(
      service.pollConsumerMarketingVideo(scope),
    ).rejects.toMatchObject({ code: "connection_changed" });
    expect(state.statusCount).toBe(1);
    expect(state.paidCount).toBe(1);
  });
});

test("an immutable qualified receipt recovers the original job without a second paid call", async () => {
  await fixture(async ({ service, state, jobs }) => {
    const quote = await service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, prompt, randomUUID());
    const scope = { ...identity, id: quote.id };
    const claim = await jobs.claimConsumerDispatch(scope);
    await jobs.markConsumerUncertain({ ...scope, claimToken: claim!.claimToken,
      providerReceipt: { response: { results: [{ id: state.providerJobId, model: "marketing_studio_video", type: "video", status: "pending" }] } } });
    const recovered = await service.pollConsumerMarketingVideo(scope);
    expect(recovered.job.status).toBe("accepted");
    expect(recovered.job.providerJobId).toBe(state.providerJobId);
    expect(state.paidCount).toBe(0);
    expect(state.statusCount).toBe(1);
    await service.pollConsumerMarketingVideo(scope);
    expect(state.paidCount).toBe(0);
    expect(state.statusCount).toBe(1);
  });
});

test("a saved accepted UUID survives diagnostic truncation; conflicting receipt IDs stay uncertain", async () => {
  await fixture(async ({ service, state, jobs }) => {
    for (const conflicting of [false, true]) {
      const quote = await service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, prompt, randomUUID());
      const scope = { ...identity, id: quote.id };
      const claim = await jobs.claimConsumerDispatch(scope);
      const providerReceipt: NonNullable<Parameters<typeof jobs.markConsumerUncertain>[0]["providerReceipt"]> = { job_id: state.providerJobId, response: conflicting
        ? { job_id: randomUUID() } : { truncated: true, preview: "not parsed for identifiers" } };
      await jobs.markConsumerUncertain({ ...scope, claimToken: claim!.claimToken, providerReceipt });
      const recovered = await service.pollConsumerMarketingVideo(scope);
      expect(recovered.job.status).toBe(conflicting ? "uncertain" : "accepted");
      expect(state.paidCount).toBe(0);
      expect(state.statusCount).toBe(1);
    }
  });
});
