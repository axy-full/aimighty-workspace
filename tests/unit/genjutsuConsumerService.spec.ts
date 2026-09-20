import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerGenjutsuInput } from "../../lib/higgsfield-consumer/genjutsu-contract";
import type * as Service from "../../lib/higgsfield-consumer/genjutsu-service";
import { type ConsumerVideoOriginal } from "../../lib/higgsfield-consumer/video-original";

const directory = mkdtempSync(
  path.join(tmpdir(), "particl-consumer-genjutsu-service-"),
);
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??=
  "consumer-service-unit-keyring-not-a-real-secret";
let sequence = 0;
const identity = { userId: "owner", draftId: "draft" };
const prompt: ConsumerGenjutsuInput = {
  variant: "motion-transfer",
  resolution: "1080p",
  prompt: "Preserve the original product",
  source: { uploadId: "source" },
  references: [{ uploadId: "still" }],
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
    for (const [id, kind] of [
      ["source", "video"],
      ["still", "image"],
    ])
      await f.database.db().execute({
        sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES(?,?,?, ?,1000,'fixture',?,?,0)",
        args: [
          id,
          id,
          kind === "video" ? "video/mp4" : "image/png",
          kind === "video" ? "mp4" : "png",
          `/api/uploads/${id}`,
          kind,
        ],
      });
    return run(f);
  });
}
async function serviceFixture() {
  const tenant = await import("../../lib/tenant"),
    database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"),
    oauth = await import("../../lib/higgsfield-consumer/oauth"),
    contract = await import("../../lib/higgsfield-consumer/video-contract");
  const id = `genjutsu-service-${++sequence}`;
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
    beforeImportReconnect: false,
    importClaims: 0,
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
  };
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/workbench/studio": await import("../../lib/workbench/studio"),
    "./video-availability": await import(
      "../../lib/higgsfield-consumer/video-availability"
    ),
    "./jobs": {
      ...jobs,
      markConsumerAccepted: async (
        ...args: Parameters<typeof jobs.markConsumerAccepted>
      ) => {
        if (state.failAckPersistence)
          throw new Error("Fixture failed acknowledgement persistence");
        return jobs.markConsumerAccepted(...args);
      },
      completeConsumerJob: async (
        ...args: Parameters<typeof jobs.completeConsumerJob>
      ) => {
        if (state.completeFailure === "before")
          throw new Error("Fixture completion persistence outage");
        const result = await jobs.completeConsumerJob(...args);
        if (state.completeFailure === "after")
          throw new Error("Fixture lost completion acknowledgement");
        return result;
      },
    },
    "./video-original": {
      collectConsumerVideoOriginal: async (
        job: Parameters<typeof jobs.getConsumerJob>[0] & {
          providerJobId: string;
          quoteCredits: number;
        },
        url: string,
      ) => {
        state.collectCount++;
        expect(url).toBe("https://media.example.com/qualified-original.mp4");
        expect(job.userId).toBe(identity.userId);
        expect(job.draftId).toBe(identity.draftId);
        expect(job.providerJobId).toBe(state.providerJobId);
        if (state.collectorError) throw state.collectorError;
        let original = state.originals.get(job.id);
        if (!original) {
          const generationId = (
            await import("../../lib/higgsfield-consumer/video-original")
          ).consumerOriginalGenerationId(workspace.id, job.id);
          original = {
            generationId,
            providerJobId: job.providerJobId,
            bytes: 1024,
            sha256: "a".repeat(64),
            width: 1280,
            height: 720,
            seconds: 15,
            credits: job.quoteCredits,
            creditUnit: "higgsfield_credits",
            asset: {
              generationId,
              url: `/api/media/${generationId}`,
              kind: "video",
              mime: "video/mp4",
              width: 1280,
              height: 720,
              durationS: 15,
            },
          };
          state.originals.set(job.id, original);
          await (
            await import("../../lib/uploadReservations")
          ).uploadReservationsReady();
          await database.db().execute({
            sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind)
              VALUES(?,'hf_mult_motion_control','',?,'succeeded',?,?,'owner',0,0,'higgsfield','video')`,
            args: [
              generationId,
              JSON.stringify({
                consumerJobId: job.id,
                consumerProviderJobId: job.providerJobId,
                originalSha256: original.sha256,
              }),
              original.asset.url,
              original.bytes,
            ],
          });
          await database.db().execute({
            sql: `INSERT INTO consumer_video_originals(job_id,generation_id,owner_id,draft_id,provider_job_id,state,bytes,sha256,receipt_json,updated_at)
              VALUES(?,?,?,?,?,'stored',?,?,?,0)`,
            args: [
              job.id,
              generationId,
              job.userId,
              job.draftId,
              job.providerJobId,
              original.bytes,
              original.sha256,
              JSON.stringify(original),
            ],
          });
        }
        return original;
      },
    },
    "./genjutsu-contract": await import(
      "../../lib/higgsfield-consumer/genjutsu-contract"
    ),
    "./video-service": await import(
      "../../lib/higgsfield-consumer/video-service"
    ),
    "./genjutsu-sources": {
      resolveConsumerGenjutsuSources: async () => ({ sources: [] }),
      resolveConsumerMediaImport: async () => {
        state.importClaims++;
        throw Error("not used by quote stub");
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
      getConsumerGenjutsuQuote: async (
        _token: string,
        input: ConsumerGenjutsuInput,
        _sources: unknown,
        options: {
          resolveMedia: (
            index: number,
            wallet: string,
            perform: () => Promise<string>,
          ) => Promise<string>;
        },
      ) => {
        state.quoteCount++;
        if (state.beforeImportReconnect) {
          state.generation = randomUUID();
          await options.resolveMedia(0, state.wallet, async () => randomUUID());
        }
        if (state.quoteBarrier) await state.quoteBarrier();
        if (state.rejectQuote)
          throw new contract.ConsumerVideoError("invalid_quote");
        if (state.changeGrantDuringQuote) state.generation = randomUUID();
        return {
          input,
          params: (
            await import("../../lib/higgsfield-consumer/genjutsu-contract")
          ).consumerGenjutsuParams(input, [
            { value: state.providerJobId, role: "video_references" },
            { value: state.wallet, role: "image_references" },
          ]),
          workspace: { id: state.wallet, name: "Fixture wallet", credits: 100 },
          credits: state.credits,
        };
      },
      submitConsumerGenjutsu: async (
        _token: string,
        _input: ConsumerGenjutsuInput,
        _params: unknown,
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
      readConsumerGenjutsuJob: async (
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
    readFileSync("lib/higgsfield-consumer/genjutsu-service.ts", "utf8"),
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

const scoped = (id: string) => ({ ...identity, id });
async function accepted(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const quote = await f.service.quoteConsumerGenjutsu(
    identity.userId,
    identity.draftId,
    prompt,
    randomUUID(),
  );
  return f.service.submitConsumerGenjutsuJob(scoped(quote.id), {
    workspaceId: f.state.wallet,
    credits: f.state.credits,
  });
}
async function readyAgain(
  f: Awaited<ReturnType<typeof serviceFixture>>,
  id: string,
) {
  await f.database.db().execute({
    sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?",
    args: [id],
  });
}
async function terminal(
  f: Awaited<ReturnType<typeof serviceFixture>>,
  id: string,
  status = "completed",
) {
  const stored = await f.jobs.getConsumerJob(scoped(id));
  const params = JSON.parse(stored!.payloadJson).params;
  return {
    generation: {
      id: f.state.providerJobId,
      model: params.model,
      type: "video",
      status,
      params: {
        ...params,
        // The live echo: the media KIND under `role`, `media_input` under
        // `data.type`. Recorded read-only from the connected account on
        // 20 September 2026; see tests/fixtures/connectedStatusEnvelopes.ts.
        medias: params.medias.map((m: { value: string; role: string }) => ({
          role: m.role === "video_references" ? "video" : "image",
          data: {
            id: m.value,
            type: "media_input",
            url: "https://private.example/source",
          },
        })),
      },
      results:
        status === "completed"
          ? { rawUrl: "https://media.example.com/qualified-original.mp4" }
          : null,
    },
  };
}
test("Genjutsu quote replay and concurrent submission retain one immutable wallet/credit admission", async () =>
  fixture(async (f) => {
    const key = randomUUID();
    const first = await f.service.quoteConsumerGenjutsu(
      identity.userId,
      identity.draftId,
      prompt,
      key,
    );
    const replay = await f.service.quoteConsumerGenjutsu(
      identity.userId,
      identity.draftId,
      prompt,
      key,
    );
    expect(replay.id).toBe(first.id);
    expect(f.state.quoteCount).toBe(1);
    await expect(
      f.service.quoteConsumerGenjutsu(
        identity.userId,
        identity.draftId,
        { ...prompt, resolution: "720p" },
        key,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await Promise.allSettled(
      [1, 2].map(() =>
        f.service.submitConsumerGenjutsuJob(scoped(first.id), {
          workspaceId: f.state.wallet,
          credits: f.state.credits,
        }),
      ),
    );
    expect(f.state.paidCount).toBe(1);
    await f.service.submitConsumerGenjutsuJob(scoped(first.id), {
      workspaceId: f.state.wallet,
      credits: f.state.credits,
    });
    expect(f.state.paidCount).toBe(1);
    expect(
      (await f.jobs.getConsumerJob(scoped(first.id)))?.originalAssetIds,
    ).toEqual(["upload:source", "upload:still"]);
  }));
test("connection/price drift and foreign draft stop before paid admission", async () =>
  fixture(async (f) => {
    const q = await f.service.quoteConsumerGenjutsu(
      identity.userId,
      identity.draftId,
      prompt,
      randomUUID(),
    );
    f.state.credits++;
    await expect(
      f.service.submitConsumerGenjutsuJob(scoped(q.id), {
        workspaceId: f.state.wallet,
        credits: q.quoteCredits,
      }),
    ).rejects.toMatchObject({ code: "quote_changed" });
    f.state.credits = q.quoteCredits;
    f.state.generation = randomUUID();
    await expect(
      f.service.submitConsumerGenjutsuJob(scoped(q.id), {
        workspaceId: f.state.wallet,
        credits: q.quoteCredits,
      }),
    ).rejects.toMatchObject({ code: "connection_changed" });
    await expect(
      f.service.pollConsumerGenjutsu({ ...scoped(q.id), userId: "other" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.paidCount).toBe(0);
  }));
test("saved accepted UUID survives acknowledgement outage and recovers without another paid call", async () =>
  fixture(async (f) => {
    f.state.failAckPersistence = true;
    const job = await accepted(f);
    expect(job.status).toBe("uncertain");
    f.state.failAckPersistence = false;
    expect(
      (await f.service.pollConsumerGenjutsu(scoped(job.id))).job.status,
    ).toBe("accepted");
    expect(f.state.paidCount).toBe(1);
  }));
test("strict original collection survives completion outage and deleted originals become unavailable", async () =>
  fixture(async (f) => {
    const job = await accepted(f);
    f.state.pollRaw = await terminal(f, job.id);
    f.state.completeFailure = "before";
    await expect(
      f.service.pollConsumerGenjutsu(scoped(job.id)),
    ).rejects.toThrow("Fixture completion");
    expect(f.state.originals.size).toBe(1);
    expect((await f.jobs.getConsumerJob(scoped(job.id)))?.status).toBe(
      "accepted",
    );
    f.state.completeFailure = false;
    await readyAgain(f, job.id);
    const done = await f.service.pollConsumerGenjutsu(scoped(job.id));
    expect(done.job.status).toBe("completed");
    expect(done.job.originalAvailable).toBe(true);
    expect(f.state.originals.size).toBe(1);
    expect(f.state.paidCount).toBe(1);
    const generationId = f.state.originals.get(job.id)!.generationId;
    await f.database.db().execute({
      sql: "UPDATE generations SET deleted=1 WHERE id=?",
      args: [generationId],
    });
    const deleted = await f.service.pollConsumerGenjutsu(scoped(job.id));
    expect(deleted.job.originalAvailability).toBe("deleted");
    expect(deleted.job.result?.original).not.toHaveProperty("asset");
  }));
test("unknown and mismatched terminal shapes never collect, errors release poll lease for recovery", async () =>
  fixture(async (f) => {
    const job = await accepted(f);
    f.state.pollRaw = {
      result_url: "https://private.example/guess.mp4",
      status: "completed",
    };
    expect(
      (await f.service.pollConsumerGenjutsu(scoped(job.id))).job.status,
    ).toBe("accepted");
    expect(f.state.collectCount).toBe(0);
    await readyAgain(f, job.id);
    const raw = await terminal(f, job.id);
    f.state.pollRaw = { generation: { ...raw.generation, id: randomUUID() } };
    await f.service.pollConsumerGenjutsu(scoped(job.id));
    expect(f.state.collectCount).toBe(0);
    await readyAgain(f, job.id);
    f.state.pollRaw = raw;
    f.state.collectorError = Error("fixture storage unavailable");
    await expect(
      f.service.pollConsumerGenjutsu(scoped(job.id)),
    ).rejects.toThrow("fixture storage");
    f.state.collectorError = undefined;
    await readyAgain(f, job.id);
    expect(
      (await f.service.pollConsumerGenjutsu(scoped(job.id))).job.status,
    ).toBe("completed");
    expect(f.state.paidCount).toBe(1);
  }));
test("verified provider failure releases active capacity, no result or refund claim is fabricated", async () =>
  fixture(async (f) => {
    const job = await accepted(f);
    f.state.pollRaw = await terminal(f, job.id, "canceled");
    expect(
      (await f.service.pollConsumerGenjutsu(scoped(job.id))).job.status,
    ).toBe("failed");
    expect(f.state.collectCount).toBe(0);
    expect(f.state.paidCount).toBe(1);
    expect(
      (await f.jobs.getConsumerJob(scoped(job.id)))?.resultManifest,
    ).toBeNull();
  }));

test("reconnect before media transfer creates no permanent import claim or paid job", async () =>
  fixture(async (f) => {
    f.state.beforeImportReconnect = true;
    await expect(
      f.service.quoteConsumerGenjutsu(
        identity.userId,
        identity.draftId,
        prompt,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "connection_changed" });
    expect(f.state.importClaims).toBe(0);
    expect(f.state.paidCount).toBe(0);
    expect((await f.jobs.listConsumerJobs(identity)).items).toHaveLength(0);
  }));
