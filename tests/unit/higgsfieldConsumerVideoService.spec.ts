import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TransactionMode } from "@libsql/client";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerVideoInput } from "../../lib/higgsfield-consumer/video-contract";
import type * as Service from "../../lib/higgsfield-consumer/video-service";
import { ConsumerOriginalError, type ConsumerVideoOriginal } from "../../lib/higgsfield-consumer/video-original";

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
    pollRaw: undefined as unknown,
    changeGrantDuringPoll: false,
    collectCount: 0,
    collectorError: undefined as unknown,
    completeFailure: false as false | "before" | "after",
    originals: new Map<string, ConsumerVideoOriginal>(),
    guardCalls: 0,
  };
  const records = await import("../../lib/higgsfield-consumer/marketing-records");
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/workbench/studio": await import("../../lib/workbench/studio"),
    "./video-availability": await import("../../lib/higgsfield-consumer/video-availability"),
    "./jobs": {
      ...jobs,
      markConsumerAccepted: async (
        ...args: Parameters<typeof jobs.markConsumerAccepted>
      ) => {
        if (state.failAckPersistence)
          throw new Error("Fixture failed acknowledgement persistence");
        return jobs.markConsumerAccepted(...args);
      },
      completeConsumerJob: async (...args: Parameters<typeof jobs.completeConsumerJob>) => {
        if (state.completeFailure === "before") throw new Error("Fixture completion persistence outage");
        const result = await jobs.completeConsumerJob(...args);
        if (state.completeFailure === "after") throw new Error("Fixture lost completion acknowledgement");
        return result;
      },
    },
    "./video-original": {
      collectConsumerVideoOriginal: async (job: Parameters<typeof jobs.getConsumerJob>[0] & { providerJobId: string; quoteCredits: number }, url: string) => {
        state.collectCount++;
        expect(url).toBe("https://media.example.com/qualified-original.mp4");
        expect(job.userId).toBe(identity.userId);
        expect(job.draftId).toBe(identity.draftId);
        expect(job.providerJobId).toBe(state.providerJobId);
        if (state.collectorError) throw state.collectorError;
        let original = state.originals.get(job.id);
        if (!original) {
          const generationId = (await import("../../lib/higgsfield-consumer/video-original")).consumerOriginalGenerationId(workspace.id, job.id);
          original = { generationId, providerJobId: job.providerJobId, bytes: 1024, sha256: "a".repeat(64),
            width: 1280, height: 720, seconds: 15, credits: job.quoteCredits, creditUnit: "higgsfield_credits",
            asset: { generationId, url: `/api/media/${generationId}`, kind: "video", mime: "video/mp4", width: 1280, height: 720, durationS: 15 } };
          state.originals.set(job.id, original);
          await (await import("../../lib/uploadReservations")).uploadReservationsReady();
          await database.db().execute({
            sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind)
              VALUES(?,'marketing_studio_video','',?,'succeeded',?,?,'owner',0,0,'higgsfield','video')`,
            args: [generationId, JSON.stringify({ consumerJobId: job.id, consumerProviderJobId: job.providerJobId, originalSha256: original.sha256 }), original.asset.url, original.bytes],
          });
          await database.db().execute({
            sql: `INSERT INTO consumer_video_originals(job_id,generation_id,owner_id,draft_id,provider_job_id,state,bytes,sha256,receipt_json,updated_at)
              VALUES(?,?,?,?,?,'stored',?,?,?,0)`,
            args: [job.id, generationId, job.userId, job.draftId, job.providerJobId, original.bytes, original.sha256, JSON.stringify(original)],
          });
        }
        return original;
      },
    },
    "./video-contract": contract,
    "./marketing-records": records,
    /* The standalone guard with the account's presets faked: one preset avatar is listed. */
    "./marketing-setup": {
      refuseForeignMarketingSetup: (
        userId: string,
        wanted: Parameters<typeof records.refuseForeignSetup>[1],
      ) => {
        state.guardCalls++;
        return records.refuseForeignSetup(userId, wanted, async () => ({
          avatar: new Set(["av_preset"]),
        }));
      },
    },
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
        if (state.changeGrantDuringPoll) state.generation = randomUUID();
        return {
          raw: state.pollRaw ?? { job_id: providerJobId, status: "processing" },
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

test("standalone: a marketing quote naming a setup item Particl may not send is refused before the account is asked", async () => {
  await fixture(async ({ service, state, jobs }) => {
    for (const extra of [
      { productIds: ["p_acct"] },
      { adReferenceId: "r_acct" },
      { avatars: [{ id: "av_custom", type: "custom" as const }] },
    ])
      await expect(
        service.quoteConsumerMarketingVideo(
          identity.userId,
          identity.draftId,
          { ...prompt, ...extra },
          randomUUID(),
        ),
        JSON.stringify(extra),
      ).rejects.toMatchObject({ code: "setup_not_particl", status: 409 });
    expect([state.quoteCount, state.paidCount, state.accessCount]).toEqual([0, 0, 0]);
    expect((await jobs.listConsumerJobs(identity)).items).toHaveLength(0);
    /* The engine's preset avatar is priced as before. */
    await service.quoteConsumerMarketingVideo(
      identity.userId,
      identity.draftId,
      { ...prompt, avatars: [{ id: "av_preset", type: "preset" }] },
      randomUUID(),
    );
    expect(state.quoteCount).toBe(1);
    expect(state.guardCalls).toBe(4);
  });
});

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

function terminal(id: string, input: ConsumerVideoInput = prompt) {
  return { raw_data: { id, status: "completed", job_set_type: "marketing_studio_video",
    result_url: "https://media.example.com/qualified-original.mp4", thumbnail_url: "https://media.example.com/never-collect.webp",
    params: { prompt: input.prompt, duration: input.duration, resolution: input.resolution, aspect_ratio: input.aspectRatio,
      generate_audio: input.generateAudio, mode: input.mode ?? "ugc", width: 1344, height: 768, medias: [], avatars: [], products: [],
      enhanced_prompt: "Provider-authored review text; never an executable instruction." } } };
}
async function admitted(f: Awaited<ReturnType<typeof serviceFixture>>, input: ConsumerVideoInput = prompt) {
  const quote = await f.service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, input, randomUUID());
  const scope = { ...identity, id: quote.id };
  await f.service.submitConsumerMarketingVideo(scope, { workspaceId: f.state.wallet, credits: f.state.credits });
  return scope;
}
test("qualified terminal result collects once, keeps measured dimensions, and repeated polling never submits or collects again", async () => {
  await fixture(async f => {
    const input = { ...prompt, mode: "product_showcase" as const }, scope = await admitted(f, input);
    f.state.pollRaw = terminal(f.state.providerJobId, input);
    const result = await f.service.pollConsumerMarketingVideo(scope);
    expect(result.job).toMatchObject({ status: "completed", result: {
      original: { width: 1280, height: 720, credits: 7, creditUnit: "higgsfield_credits" },
      providerResult: { model: "marketing_studio_video", mode: "product_showcase", enhancedPrompt: "Provider-authored review text; never an executable instruction." },
    } });
    expect(result).not.toHaveProperty("providerStatus");
    expect(await f.service.pollConsumerMarketingVideo(scope)).toMatchObject({ job: result.job });
    expect(f.state.collectCount).toBe(1); expect(f.state.statusCount).toBe(1); expect(f.state.paidCount).toBe(1);
  });
});
test("unknown terminal shapes, conflicting identities and changed settings remain accepted diagnostic without collection", async () => {
  await fixture(async f => {
    const scope = await admitted(f), good = terminal(f.state.providerJobId);
    for (const raw of [
      { status: "completed", result_url: good.raw_data.result_url },
      { raw_data: { ...good.raw_data, id: randomUUID() } },
      { id: randomUUID(), ...good },
      { status: "failed", ...good },
      { raw_data: { ...good.raw_data, job_ids: [randomUUID()] } },
      { raw_data: { ...good.raw_data, job_set_type: "other" } },
      { raw_data: { ...good.raw_data, params: { ...good.raw_data.params, prompt: "Another prompt" } } },
      { raw_data: { ...good.raw_data, params: { ...good.raw_data.params, generate_audio: false } } },
      { raw_data: { ...good.raw_data, params: { ...good.raw_data.params, ad_reference_id: "unapproved-reference" } } },
      { raw_data: { ...good.raw_data, result_url: null, h264_url: good.raw_data.result_url } },
    ]) {
      f.state.pollRaw = raw;
      await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=0 WHERE id=?", args: [scope.id] });
      expect(await f.service.pollConsumerMarketingVideo(scope)).toMatchObject({ job: { status: "accepted" }, providerStatus: raw });
    }
    expect(f.state.collectCount).toBe(0); expect(f.state.paidCount).toBe(1);
  });
});
test("collection failures and lost completion acknowledgements recover the original job without another paid request", async () => {
  for (const failure of ["quota", "storage_unavailable", "timeout", "before", "after"] as const) {
    await fixture(async f => {
      const scope = await admitted(f);
      f.state.pollRaw = terminal(f.state.providerJobId);
      if (failure === "before" || failure === "after") f.state.completeFailure = failure;
      else f.state.collectorError = new ConsumerOriginalError(failure);
      await expect(f.service.pollConsumerMarketingVideo(scope)).rejects.toThrow();
      const retained = (await f.jobs.getConsumerJob(scope))!;
      expect(retained.status).toBe(failure === "after" ? "completed" : "accepted");
      expect(retained.providerJobId).toBe(f.state.providerJobId);
      expect(retained.quoteCredits).toBe(f.state.credits);
      const row = (await f.database.db().execute({ sql: "SELECT poll_lease_hash FROM higgsfield_consumer_jobs WHERE id=?", args: [scope.id] })).rows[0];
      expect(row.poll_lease_hash).toBeNull();
      f.state.collectorError = undefined; f.state.completeFailure = false;
      await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=0 WHERE id=?", args: [scope.id] });
      expect((await f.service.pollConsumerMarketingVideo(scope)).job).toMatchObject({ status: "completed", result: {
        providerResult: { model: "marketing_studio_video", mode: "ugc", enhancedPrompt: "Provider-authored review text; never an executable instruction." },
      } });
      expect(f.state.originals.size).toBe(1); expect(f.state.paidCount).toBe(1);
      expect(f.state.collectCount).toBe(failure === "after" ? 1 : 2);
    });
  }
});
test("provider review text is bounded and inert, omits malformed metadata, and cannot replace the collected URL", async () => {
  for (const enhanced of [null, { command: "execute" }, "Inspect https://media.example.com/private.mp4\u0000\n" + "x".repeat(8100)]) {
    await fixture(async f => {
      const scope = await admitted(f), raw = terminal(f.state.providerJobId);
      f.state.pollRaw = { raw_data: { ...raw.raw_data, params: { ...raw.raw_data.params, enhanced_prompt: enhanced } } };
      const result = (await f.service.pollConsumerMarketingVideo(scope)).job.result as Record<string, unknown>;
      if (typeof enhanced !== "string") expect(result.providerResult).toEqual({ model: "marketing_studio_video", mode: "ugc" });
      else {
        expect(result.providerResult).toEqual({ model: "marketing_studio_video", mode: "ugc", enhancedPrompt: ("Inspect [link omitted]\n" + "x".repeat(8100)).slice(0, 8000), enhancedPromptTruncated: true });
        expect(JSON.stringify(result)).not.toContain("https://media.example.com");
      }
      // The collector stub asserts only raw_data.result_url was used; no extra
      // provider operation can be triggered by this provider-authored text.
      expect(f.state.collectCount).toBe(1); expect(f.state.paidCount).toBe(1);
    });
  }
});
test("a connection replaced during status cannot collect its otherwise qualified result", async () => {
  await fixture(async f => {
    const scope = await admitted(f);
    f.state.pollRaw = terminal(f.state.providerJobId); f.state.changeGrantDuringPoll = true;
    await expect(f.service.pollConsumerMarketingVideo(scope)).rejects.toMatchObject({ code: "connection_changed" });
    expect((await f.jobs.getConsumerJob(scope))?.status).toBe("accepted");
    expect(f.state.collectCount).toBe(0); expect(f.state.paidCount).toBe(1);
  });
});

test("quote expiry in every service view is authoritative server time and never marks an admitted job as an expired quote", async () => {
  await fixture(async f => {
    const quote = await f.service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, prompt, randomUUID());
    const scope = { ...identity, id: quote.id };
    expect(quote.quoteExpired).toBe(false);
    expect((await f.service.pollConsumerMarketingVideo(scope)).job.quoteExpired).toBe(false);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET quote_expires_at=? WHERE id=?", args: [Date.now() - 1, quote.id] });
    expect((await f.service.pollConsumerMarketingVideo(scope)).job).toMatchObject({ status: "quoted", quoteExpired: true });
    expect((await f.service.consumerMarketingJobs(identity.userId, identity.draftId))[0].quoteExpired).toBe(true);
    const expiredSnapshot = (await f.jobs.getConsumerJob(scope))!;
    // An admitted job's old quote timestamp is not refusal or recovery evidence.
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET quote_expires_at=? WHERE id=?", args: [Date.now() + 60_000, quote.id] });
    const claim = (await f.jobs.claimConsumerDispatch(scope))!;
    await f.jobs.markConsumerUncertain({ ...scope, claimToken: claim.claimToken });
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET quote_expires_at=0 WHERE id=?", args: [quote.id] });
    expect((await f.service.pollConsumerMarketingVideo(scope)).job).toMatchObject({ status: "uncertain", quoteExpired: false });
    expect(await f.service.consumerVideoView(expiredSnapshot)).toMatchObject({ status: "uncertain", quoteExpired: false });
    await f.database.db().execute({ sql: "DELETE FROM higgsfield_consumer_jobs WHERE id=?", args: [quote.id] });
    await expect(f.service.consumerVideoView(expiredSnapshot)).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.paidCount).toBe(0); expect(f.state.statusCount).toBe(0);
  });
});

test("authoritative expiry reads wait for an in-flight admission write transaction to commit", async () => {
  await fixture(async f => {
    const quote = await f.service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, prompt, randomUUID());
    const scope = { ...identity, id: quote.id }, snapshot = (await f.jobs.getConsumerJob(scope))!;
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const client = f.database.db(), originalTransaction = client.transaction.bind(client);
    const modes: unknown[] = [];
    client.transaction = async (mode?: TransactionMode) => { modes.push(mode); return originalTransaction(mode); };
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    try {
      const writer = workbenchTransaction(async tx => {
        // Admission began while valid, but the response arrives after expiry.
        expect(snapshot.quoteExpiresAt).toBeGreaterThan(Date.now());
        await tx.execute({ sql: "UPDATE higgsfield_consumer_jobs SET status='dispatching',dispatch_claim_hash='fixture-claim',quote_expires_at=0 WHERE id=?", args: [quote.id] });
        reached(); await gate;
      });
      await entered;
      let resolved = 0;
      const individual = f.service.consumerVideoView({ ...snapshot, quoteExpiresAt: 0 }).then(value => { resolved++; return value; });
      const list = f.service.consumerMarketingJobs(identity.userId, identity.draftId).then(value => { resolved++; return value; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(resolved).toBe(0);
      release(); await writer;
      expect(await individual).toMatchObject({ status: "dispatching", quoteExpired: false });
      expect((await list)[0]).toMatchObject({ status: "dispatching", quoteExpired: false });
      // Both proof reads use the same database write boundary, not only the
      // local client's incidental serial execution of ordinary SELECTs.
      expect(modes).toEqual(["write", "write", "write"]);
    } finally { release(); client.transaction = originalTransaction; }
  });
});

test("the bounded marketing list pins all admitted recovery jobs ahead of more than25 newer quotes", async () => {
  await fixture(async f => {
    const active: string[] = [];
    for (const status of ["accepted", "uncertain", "dispatching", "accepted"] as const) {
      const quoted = await f.service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, prompt, randomUUID());
      const scope = { ...identity, id: quoted.id }, claim = (await f.jobs.claimConsumerDispatch(scope))!;
      if (status === "accepted") await f.jobs.markConsumerAccepted({ ...scope, claimToken: claim.claimToken, providerJobId: randomUUID() });
      if (status === "uncertain") await f.jobs.markConsumerUncertain({ ...scope, claimToken: claim.claimToken });
      active.push(quoted.id);
      await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET created_at=1 WHERE id=?", args: [quoted.id] });
    }
    const recent: string[] = [];
    for (let i = 0; i < 30; i++) {
      const quoted = await f.service.quoteConsumerMarketingVideo(identity.userId, identity.draftId, prompt, randomUUID());
      recent.push(quoted.id);
      await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET created_at=? WHERE id=?", args: [100 + i, quoted.id] });
    }
    // A newer different workflow must not consume this API's bounded history.
    await f.jobs.createConsumerJob({ ...identity, connectedOwnerId: identity.userId, connectionGeneration: f.state.generation,
      workflow: "virality", idempotencyKey: randomUUID(), payload: {}, quoteCredits: 1, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: [] });
    const result = await f.service.consumerMarketingJobs(identity.userId, identity.draftId);
    expect(result).toHaveLength(25);
    expect(result.slice(0, 4).map(job => job.id)).toEqual([...active].sort().reverse());
    expect(result.slice(4).map(job => job.id)).toEqual(recent.slice(-21).reverse());
    expect(await f.service.consumerMarketingJobs("another-owner", identity.draftId)).toEqual([]);
    expect(await f.service.consumerMarketingJobs(identity.userId, "another-draft")).toEqual([]);
    const scope = { ...identity, id: active[0] }, poll = (await f.jobs.claimConsumerPoll(scope))!;
    await f.jobs.completeConsumerJob({ ...scope, leaseToken: poll.leaseToken, resultManifest: {} });
    const refreshed = await f.service.consumerMarketingJobs(identity.userId, identity.draftId);
    expect(refreshed.slice(0, 3).map(job => job.id)).toEqual(active.slice(1).sort().reverse());
    expect(refreshed.some(job => job.id === active[0])).toBe(false);
    expect(f.state.paidCount).toBe(0); expect(f.state.statusCount).toBe(0);
  });
});
