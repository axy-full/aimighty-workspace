import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import ts from "typescript";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ProductFetchDependencies } from "../../lib/workbench/product-fetch";
import type { ConsumerShortsInput, ConsumerShortsParams } from "../../lib/higgsfield-consumer/shorts-studio";
import type * as Service from "../../lib/higgsfield-consumer/shorts-service";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-shorts-service-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "consumer-shorts-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";
const mp4 = readFileSync("tests/fixtures/astra-source.mp4");
const saved: string[] = [];
test.afterAll(async () => {
  await Promise.all(saved.map((id) => unlink(path.join(process.cwd(), ".data/generations", `${id}.mp4`)).catch(() => {})));
});
let sequence = 0;
const identity = { userId: "owner", draftId: "draft" };
const shorts: ConsumerShortsInput = { source: { uploadId: "clip" }, preset: { id: "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f", source: "cms", name: "Bold Urban" }, aspectRatio: "9:16" };

/** The collector's public-fetch seam: every clip URL returns the fixture MP4. */
function transport() {
  const urls: string[] = [];
  const request = ((url: URL, _options: unknown, callback: (response: IncomingMessage) => void) => {
    urls.push(String(url));
    const req = new EventEmitter() as ClientRequest;
    req.destroy = () => req;
    req.end = (() => {
      queueMicrotask(() => {
        const response = Readable.from([mp4]) as IncomingMessage;
        response.statusCode = 200;
        response.headers = { "content-type": "video/mp4" };
        callback(response);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as ProductFetchDependencies["https"];
  return { urls, deps: { http: request, https: request, resolve: async () => [{ address: "93.184.216.34", family: 4 }] } };
}
async function serviceFixture() {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"), oauth = await import("../../lib/higgsfield-consumer/oauth"),
    contract = await import("../../lib/higgsfield-consumer/video-contract"), originals = await import("../../lib/higgsfield-consumer/video-original"),
    studio = await import("../../lib/higgsfield-consumer/shorts-studio");
  const id = `shorts-service-${++sequence}`;
  const workspace = {
    id, slug: id, name: id, legacy: true, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: mp4.length * 50, deletedAt: null,
  } as TenantWorkspace;
  const net = transport();
  const state = {
    generation: randomUUID(), wallet: randomUUID(), session: randomUUID(), mediaId: randomUUID(), clips: [randomUUID(), randomUUID(), randomUUID()],
    quoteCount: 0, importCount: 0, paidCount: 0, sessionReads: 0, clipReads: 0, collectCalls: 0, presetReads: 0,
    /** A collection failure to raise for a clip index (the collector is otherwise real). */
    collectFailures: {} as Record<number, Error>,
    sessionStatus: "processing", clipStatus: {} as Record<string, "completed" | "failed" | "processing">,
  };
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/db": database,
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/uploadReservations": await import("../../lib/uploadReservations"),
    "./jobs": jobs,
    "./shorts-studio": studio,
    "./voice-tools": await import("../../lib/higgsfield-consumer/voice-tools"),
    "./shorts-sources": await import("../../lib/higgsfield-consumer/shorts-sources"),
    "./genjutsu-contract": await import("../../lib/higgsfield-consumer/genjutsu-contract"),
    "./video-contract": contract,
    "./video-service": await import("../../lib/higgsfield-consumer/video-service"),
    // The real clip-keyed collector, fetching through the fixture transport.
    "./video-original": { ...originals, collectConsumerVideoOriginal: (job: Parameters<typeof originals.collectConsumerVideoOriginal>[0], url: string, options: Parameters<typeof originals.collectConsumerVideoOriginal>[2]) => {
      state.collectCalls++;
      const failure = options?.clip ? state.collectFailures[options.clip.index] : undefined;
      if (failure) return Promise.reject(failure);
      return originals.collectConsumerVideoOriginal(job, url, { ...options, fetchDependencies: net.deps });
    } },
    "./oauth": {
      ConsumerOAuthError: oauth.ConsumerOAuthError,
      getConsumerAccess: async (_w: string, userId: string, options: { expectedGeneration?: string }) => {
        expect(userId).toBe(identity.userId);
        if (options.expectedGeneration && options.expectedGeneration !== state.generation) throw new oauth.ConsumerOAuthError("connection_changed");
        return { accessToken: "private-fixture-token", generation: state.generation };
      },
    },
    "./mcp": {
      readShortsPresets: async () => { state.presetReads++; return { presets: [{ id: shorts.preset.id, name: "Bold Urban", source: "cms" }], complete: true, fetchedAt: Date.now() }; },
      getConsumerShortsQuote: async (_t: string, input: ConsumerShortsInput, source: { url: string; type: string; durationSeconds?: number }, options: { resolveMedia: (w: string, perform: () => Promise<string>) => Promise<string> }) => {
        state.quoteCount++;
        expect(source).toEqual({ url: "https://fixtures.particl.invalid/uploads/clip.mp4", type: "video", durationSeconds: 31 });
        const mediaId = await options.resolveMedia(state.wallet, async () => { state.importCount++; return state.mediaId; });
        return { input, params: studio.consumerShortsParams(input, mediaId, source.durationSeconds), workspace: { id: state.wallet, name: "Fixture wallet", credits: 100 }, credits: 40 };
      },
      submitConsumerShorts: async (_t: string, input: ConsumerShortsInput, params: ConsumerShortsParams, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        expect(params).toEqual(studio.consumerShortsParams(input, state.mediaId, 31));
        expect([wallet, credits]).toEqual([state.wallet, 40]);
        await options.admit();
        state.paidCount++;
        return { state: "accepted", providerJobId: state.session, raw: { id: state.session, status: "queued", job_ids: [] } };
      },
      readConsumerShortsSession: async (_t: string, sessionId: string) => {
        state.sessionReads++;
        expect(sessionId).toBe(state.session);
        return { id: sessionId, status: state.sessionStatus, job_ids: state.sessionStatus === "processing" ? state.clips.slice(0, 1) : state.clips };
      },
      readConsumerShortsClips: async (_t: string, ids: string[]) => {
        state.clipReads++;
        return ids.map((jobId) => {
          const status = state.clipStatus[jobId] ?? "completed";
          return { jobId, raw: { generation: { id: jobId, type: "video", status, results: status === "completed" ? { rawUrl: `https://media.example.com/${jobId}.mp4` } : null } } };
        });
      },
    },
  };
  const loaded = { exports: {} as typeof Service };
  const source = ts.transpileModule(readFileSync("lib/higgsfield-consumer/shorts-service.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`); return deps[name]; }, loaded, loaded.exports);
  return { service: loaded.exports, state, workspace, tenant, database, jobs, originals, net };
}
async function fixture(run: (f: Awaited<ReturnType<typeof serviceFixture>>) => Promise<void>) {
  const f = await serviceFixture();
  return f.tenant.runInTenant(f.workspace, async () => {
    await f.database.ready();
    await f.database.db().execute("INSERT INTO projects(id,name,created_at) VALUES('production','Fixture',0)");
    await f.database.db().execute(`INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Campaign','{"productionProjectId":"production"}',1,0)`);
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at,duration_s) VALUES('clip','Launch cut.mp4','video/mp4','mp4',4000,'fixture','/api/uploads/clip','video',0,31)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at,duration_s) VALUES('long','Long cut.mp4','video/mp4','mp4',4000,'fixture','/api/uploads/long','video',0,200)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('still','still.png','image/png','png',1000,'fixture','/api/uploads/still','image',0)");
    return run(f);
  });
}
const scoped = (id: string) => ({ ...identity, id });
const unlease = (f: Awaited<ReturnType<typeof serviceFixture>>, id: string) =>
  f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [id] });

test("one session: one quote, one paid create, every successful clip collected as its own original, one settlement", async () =>
  fixture(async (f) => {
    // Out-of-range or wrong-kind sources are refused before the provider is asked.
    for (const [bad, code] of [[{ ...shorts, source: { uploadId: "long" } }, "invalid_input"], [{ ...shorts, source: { uploadId: "still" } }, "source_limits"]] as const)
      await expect(f.service.quoteConsumerShorts(identity.userId, identity.draftId, bad as ConsumerShortsInput, randomUUID())).rejects.toMatchObject({ code });
    expect(f.state.quoteCount).toBe(0);
    const key = randomUUID();
    const quote = await f.service.quoteConsumerShorts(identity.userId, identity.draftId, shorts, key);
    expect(quote).toMatchObject({ status: "quoted", quoteCredits: 40, pricedSeconds: 31, source: { kind: "video", name: "Launch cut.mp4" }, clips: [] });
    expect((await f.service.quoteConsumerShorts(identity.userId, identity.draftId, shorts, key)).id).toBe(quote.id);
    expect([f.state.quoteCount, f.state.importCount]).toEqual([1, 1]);
    await expect(f.service.submitConsumerShortsJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 41 })).rejects.toMatchObject({ code: "approval_changed" });
    const submitted = await f.service.submitConsumerShortsJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 40 });
    expect(submitted).toMatchObject({ status: "accepted", providerJobId: f.state.session });
    await f.service.submitConsumerShortsJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 40 });
    expect(f.state.paidCount).toBe(1);
    // In progress: nothing is collected yet.
    const first = await f.service.pollConsumerShorts(scoped(quote.id));
    expect(first.job).toMatchObject({ status: "accepted", progress: { clips: 1, collected: 0, status: "processing" } });
    expect(f.state.collectCalls).toBe(0);
    // Terminal session with one clip still processing: collected clips persist, no settlement yet.
    f.state.sessionStatus = "completed";
    f.state.clipStatus = { [f.state.clips[1]]: "failed", [f.state.clips[2]]: "processing" };
    await unlease(f, quote.id);
    const second = await f.service.pollConsumerShorts(scoped(quote.id));
    expect(second.job).toMatchObject({ status: "accepted", progress: { clips: 3, collected: 1 } });
    expect(f.net.urls).toHaveLength(1);
    // Every clip terminal: the stored clip is reused, the new one collected, one settlement.
    f.state.clipStatus = { [f.state.clips[1]]: "failed" };
    await unlease(f, quote.id);
    const done = await f.service.pollConsumerShorts(scoped(quote.id));
    expect(f.net.urls).toHaveLength(2);
    expect(done.job).toMatchObject({ status: "completed", settlement: { clips: 3, collected: 2, failed: 1, credits: 40, creditUnit: "higgsfield_credits" } });
    const clips = done.job.clips;
    expect(clips.map((clip) => [clip.index, clip.state, clip.availability])).toEqual([[0, "collected", "available"], [1, "failed", undefined], [2, "collected", "available"]]);
    const ids = clips.flatMap((clip) => (clip.state === "collected" ? [(clip.original as { generationId: string }).generationId] : []));
    saved.push(...ids);
    expect(new Set(ids).size).toBe(2);
    for (const [n, id] of ids.entries()) {
      const row = (await f.database.db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [id] })).rows[0];
      expect(row).toMatchObject({ project_id: "production", provider: "higgsfield", model: "shorts_studio", kind: "video", status: "succeeded", created_by: "owner" });
      const params = JSON.parse(String(row.params));
      const index = n === 0 ? 0 : 2;
      expect(params).toMatchObject({ task: "connected-generation", workflow: "shorts", consumerJobId: `${quote.id}.clip-${index}`, consumerProviderJobId: f.state.clips[index],
        consumerParentJobId: quote.id, consumerParentProviderJobId: f.state.session, clipIndex: index, consumerCredits: 40, references: [{ uploadId: "clip", role: "video", kind: "video" }] });
      expect(await f.originals.hasRetainedConsumerOriginal(id)).toBe(true);
    }
    // Settled once: a further poll neither reads nor collects.
    const reads = f.state.sessionReads;
    await f.service.pollConsumerShorts(scoped(quote.id));
    expect(f.state.sessionReads).toBe(reads);
    expect(f.state.paidCount).toBe(1);
    const listed = await f.service.consumerShortsJobs(identity.userId, identity.draftId);
    expect(listed).toHaveLength(1);
    expect(listed[0].clips.filter((clip) => clip.availability === "available")).toHaveLength(2);
    // A deleted clip is reported as deleted and loses its asset link.
    await f.database.db().execute({ sql: "UPDATE generations SET deleted=1 WHERE id=?", args: [ids[0]] });
    const after = await f.service.consumerShortsJobs(identity.userId, identity.draftId);
    expect(after[0].clips[0]).toMatchObject({ availability: "deleted" });
    expect(after[0].clips[0].original).not.toHaveProperty("asset");
  }));

test("a session whose every clip failed settles as failed; the collector refuses clips outside a Shorts job", async () =>
  fixture(async (f) => {
    const quote = await f.service.quoteConsumerShorts(identity.userId, identity.draftId, shorts, randomUUID());
    await f.service.submitConsumerShortsJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 40 });
    f.state.sessionStatus = "completed";
    f.state.clipStatus = Object.fromEntries(f.state.clips.map((id) => [id, "failed" as const]));
    const polled = await f.service.pollConsumerShorts(scoped(quote.id));
    expect(polled.job).toMatchObject({ status: "failed", failureCode: "provider_failed" });
    expect(f.state.collectCalls).toBe(0);
    // Clip keys are only for a Shorts job, and a Shorts job only collects by clip.
    const job = (await f.jobs.getConsumerJob(scoped(quote.id)))!;
    await expect(f.originals.collectConsumerVideoOriginal(job, "https://media.example.com/x.mp4", { fetchDependencies: f.net.deps })).rejects.toMatchObject({ code: "not_found" });
    await expect(f.originals.collectConsumerVideoOriginal(job, "https://media.example.com/x.mp4", { clip: { index: 25, providerJobId: randomUUID() }, fetchDependencies: f.net.deps })).rejects.toMatchObject({ code: "not_found" });
  }));

test("only a style the account lists as a library style is quoted, whatever source the request claims", async () =>
  fixture(async (f) => {
    const unlisted = { ...shorts, preset: { ...shorts.preset, id: randomUUID() } };
    const owned = { ...shorts, preset: { ...shorts.preset, source: "user" as const } };
    for (const bad of [unlisted, owned])
      await expect(f.service.quoteConsumerShorts(identity.userId, identity.draftId, bad, randomUUID())).rejects.toMatchObject({ code: "invalid_input" });
    expect([f.state.quoteCount, f.state.importCount]).toEqual([0, 0]);
    // The listing is read once an hour, not once a quote.
    await f.service.quoteConsumerShorts(identity.userId, identity.draftId, shorts, randomUUID());
    await f.service.quoteConsumerShorts(identity.userId, identity.draftId, { ...shorts, preset: { ...shorts.preset, id: shorts.preset.id.toUpperCase() } }, randomUUID());
    expect(f.state.presetReads).toBe(1);
    expect(f.state.quoteCount).toBe(2);
  }));

test("a clip that can never be kept settles as failed with its reason; one that can pass later keeps the session open and says why", async () =>
  fixture(async (f) => {
    const originalError = (await import("../../lib/higgsfield-consumer/video-original")).ConsumerOriginalError;
    const quote = await f.service.quoteConsumerShorts(identity.userId, identity.draftId, shorts, randomUUID());
    await f.service.submitConsumerShortsJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 40 });
    f.state.sessionStatus = "completed";
    f.state.collectFailures = { 0: new originalError("too_large"), 1: new originalError("quota") };
    const held = await f.service.pollConsumerShorts(scoped(quote.id));
    // Storage full is retried on the next poll, and the owner is told why.
    expect(held.job).toMatchObject({ status: "accepted", progress: { clips: 3, collected: 1 } });
    expect(held).toMatchObject({ collection: { code: "quota" } });
    expect(f.state.paidCount).toBe(1);
    f.state.collectFailures = { 0: new originalError("too_large") };
    await unlease(f, quote.id);
    const done = await f.service.pollConsumerShorts(scoped(quote.id));
    expect(done).not.toHaveProperty("collection");
    expect(done.job).toMatchObject({ status: "completed", settlement: { clips: 3, collected: 2, failed: 1 } });
    expect(done.job.clips.map((clip) => [clip.index, clip.state])).toEqual([[0, "failed"], [1, "collected"], [2, "collected"]]);
    expect(done.job.clips[0]).toMatchObject({ reason: "too_large" });
    saved.push(...done.job.clips.flatMap((clip) => (clip.state === "collected" ? [(clip.original as { generationId: string }).generationId] : [])));
    expect(f.state.paidCount).toBe(1);
  }));
