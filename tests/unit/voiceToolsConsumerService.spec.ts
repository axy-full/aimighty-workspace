import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerVoiceToolInput } from "../../lib/higgsfield-consumer/voice-tools";
import type * as Service from "../../lib/higgsfield-consumer/voice-tool-service";
import type { ConsumerVideoOriginal } from "../../lib/higgsfield-consumer/video-original";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-voice-service-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "consumer-voice-unit-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
const identity = { userId: "owner", draftId: "draft" };
const voice: ConsumerVoiceToolInput = { tool: "voice_change", source: { uploadId: "clip" }, voice: { id: "voice-nova", type: "preset", name: "Nova" } };
const dub: ConsumerVoiceToolInput = { tool: "dubbing", source: { uploadId: "clip" }, targetLanguage: "fra" };
const analysis: ConsumerVoiceToolInput = { tool: "video_analysis", source: { uploadId: "clip" } };

async function fixture(run: (f: Awaited<ReturnType<typeof serviceFixture>>) => Promise<void>, options: { analysis?: boolean } = {}) {
  const f = await serviceFixture(options);
  return f.tenant.runInTenant(f.workspace, async () => {
    await f.database.ready();
    await f.database.db().execute("INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Campaign','{}',1,0)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('clip','Hero take.mp4','video/mp4','mp4',4000,'fixture','/api/uploads/clip','video',0)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('still','still.png','image/png','png',1000,'fixture','/api/uploads/still','image',0)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at,duration_s) VALUES('wide','Launch cut.mp4','video/mp4','mp4',4000,'fixture','/api/uploads/wide','video',0,12.341)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at,duration_s) VALUES('long','Long cut.mp4','video/mp4','mp4',4000,'fixture','/api/uploads/long','video',0,75)");
    return run(f);
  });
}
async function serviceFixture(options: { analysis?: boolean }) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"), oauth = await import("../../lib/higgsfield-consumer/oauth"),
    contract = await import("../../lib/higgsfield-consumer/video-contract"), original = await import("../../lib/higgsfield-consumer/video-original"),
    tools = await import("../../lib/higgsfield-consumer/voice-tools");
  const id = `voice-service-${++sequence}`;
  const workspace = {
    id, slug: id, name: id, legacy: true, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
  const state = {
    generation: randomUUID(), wallet: randomUUID(), credits: 12, providerJobId: randomUUID(), mediaId: randomUUID(),
    mode: "accepted" as "accepted" | "uncertain" | "throw-after-claim", priced: true, voiceReads: 0, quoteCount: 0, importCount: 0, paidCount: 0, statusCount: 0, collectCount: 0,
    pollRaw: undefined as unknown, collectorError: undefined as unknown, submitBarrier: undefined as (() => Promise<void>) | undefined,
    originals: new Map<string, ConsumerVideoOriginal>(),
  };
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "./jobs": jobs,
    "./video-availability": await import("../../lib/higgsfield-consumer/video-availability"),
    "./voice-tools": tools,
    "./voices-cache": await import("../../lib/higgsfield-consumer/voices-cache"),
    "./voice-tool-sources": await import("../../lib/higgsfield-consumer/voice-tool-sources"),
    "./video-service": await import("../../lib/higgsfield-consumer/video-service"),
    "./video-contract": contract,
    "./video-original": {
      uncollectableOriginal: original.uncollectableOriginal,
      CONSUMER_ORIGINAL_SECONDS: 600,
      collectConsumerVideoOriginal: async (job: { id: string; userId: string; draftId: string; providerJobId: string; quoteCredits: number; payloadJson: string }, url: string) => {
        state.collectCount++;
        expect(url).toBe("https://media.example.com/qualified-original.mp4");
        expect(job.providerJobId).toBe(state.providerJobId);
        if (state.collectorError) throw state.collectorError;
        let stored = state.originals.get(job.id);
        if (!stored) {
          const generationId = original.consumerOriginalGenerationId(workspace.id, job.id);
          const model = JSON.parse(job.payloadJson).input.tool;
          stored = { generationId, providerJobId: job.providerJobId, bytes: 4096, sha256: "a".repeat(64), width: 640, height: 360, seconds: 2,
            credits: job.quoteCredits, creditUnit: "higgsfield_credits", asset: { generationId, url: `/api/media/${generationId}`, kind: "video", mime: "video/mp4", width: 640, height: 360, durationS: 2 } };
          state.originals.set(job.id, stored);
          await (await import("../../lib/uploadReservations")).uploadReservationsReady();
          await database.db().execute({
            sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind) VALUES(?,?,'',?,'succeeded',?,?,'owner',0,0,'higgsfield','video')`,
            args: [generationId, model, JSON.stringify({ task: "connected-generation", consumerJobId: job.id, consumerProviderJobId: job.providerJobId, originalSha256: stored.sha256 }), stored.asset.url, stored.bytes],
          });
          await database.db().execute({
            sql: `INSERT INTO consumer_video_originals(job_id,generation_id,owner_id,draft_id,provider_job_id,state,bytes,sha256,receipt_json,updated_at) VALUES(?,?,?,?,?,'stored',?,?,?,0)`,
            args: [job.id, generationId, job.userId, job.draftId, job.providerJobId, stored.bytes, stored.sha256, JSON.stringify(stored)],
          });
        }
        return stored;
      },
    },
    "./oauth": {
      ConsumerOAuthError: oauth.ConsumerOAuthError,
      getConsumerAccess: async (workspaceId: string, userId: string, options: { expectedGeneration?: string }) => {
        expect(workspaceId).toBe(workspace.id); expect(userId).toBe(identity.userId);
        if (options.expectedGeneration && options.expectedGeneration !== state.generation) throw new oauth.ConsumerOAuthError("connection_changed");
        return { accessToken: "private-fixture-token", generation: state.generation };
      },
    },
    "./mcp": {
      readConnectedVoices: async () => { state.voiceReads++; return { items: [{ voice_id: "voice-nova", voice_type: "preset", name: "Nova", preview_url: "https://cdn.example.com/a.mp3" }], complete: true }; },
      getConsumerVoiceToolQuote: async (_token: string, input: ConsumerVoiceToolInput, source: { url: string; type: string; durationSeconds?: number }, options: { resolveMedia: (wallet: string, perform: () => Promise<string>) => Promise<string> }) => {
        state.quoteCount++;
        if (input.tool === "reframe") expect(source).toEqual({ url: "https://fixtures.particl.invalid/uploads/wide.mp4", type: "video", durationSeconds: 12.341 });
        else expect(source).toEqual({ url: "https://fixtures.particl.invalid/uploads/clip.mp4", type: "video" });
        if (!state.priced) throw new tools.VoiceToolError("price_unknown", "No price. Nothing was sent.");
        const mediaId = await options.resolveMedia(state.wallet, async () => { state.importCount++; return state.mediaId; });
        const nested = input.tool !== "video_analysis";
        return { input, params: tools.consumerVoiceToolParams(input, mediaId, { durationSeconds: source.durationSeconds }), shape: { nested, getCost: true }, workspace: { id: state.wallet, name: "Fixture wallet", credits: 100 }, credits: state.credits, priceSource: "get_cost" };
      },
      submitConsumerVoiceTool: async (_token: string, input: ConsumerVoiceToolInput, params: Record<string, string>, shape: { nested: boolean }, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        expect(params).toEqual(tools.consumerVoiceToolParamsFromStored(input, params));
        expect(tools.consumerVoiceToolParamsFromStored(input, params)).toMatchObject(input.tool === "reframe" ? { medias: [{ role: "video", value: state.mediaId }] } : {});
        expect(shape.nested).toBe(input.tool !== "video_analysis");
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        if (credits !== state.credits) throw new contract.ConsumerVideoError("quote_changed");
        await options.admit();
        if (state.submitBarrier) await state.submitBarrier();
        state.paidCount++;
        if (state.mode === "throw-after-claim") throw new Error("PRIVATE-PROVIDER-DETAIL");
        return state.mode === "uncertain"
          ? { state: "uncertain", raw: { status: "submitted", unexpected_ref: "receipt-for-support" } }
          : { state: "accepted", providerJobId: state.providerJobId, raw: input.tool === "video_analysis" ? { video_analyze_id: state.providerJobId, status: "queued" } : { results: [{ id: state.providerJobId, model: input.tool, type: "video" }] } };
      },
      readConsumerVoiceToolJob: async (_token: string, providerJobId: string, wallet: string, tool: string) => {
        state.statusCount++;
        expect(providerJobId).toBe(state.providerJobId); expect(["voice_change", "dubbing", "video_analysis", "reframe"]).toContain(tool);
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        return { raw: state.pollRaw ?? { generation: { id: providerJobId, type: "video", status: "processing" } }, pollAfterSeconds: 20 };
      },
    },
  };
  const before = process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED;
  if (options.analysis) process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED = "1"; else delete process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED;
  const loaded = { exports: {} as typeof Service };
  const source = ts.transpileModule(readFileSync("lib/higgsfield-consumer/voice-tool-service.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", "process", source)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`); return deps[name]; }, loaded, loaded.exports, process);
  if (before === undefined) delete process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED; else process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED = before;
  return { service: loaded.exports, state, workspace, tenant, database, jobs };
}
const scoped = (id: string) => ({ ...identity, id });
const completed = (f: Awaited<ReturnType<typeof serviceFixture>>, status = "completed") =>
  ({ generation: { id: f.state.providerJobId, type: "video", status, results: status === "completed" ? { rawUrl: "https://media.example.com/qualified-original.mp4" } : null } });

test("voices are read once per connection; quotes validate the tool, refuse an unpriced tool and a wrong-kind source before any import, and replay by key", async () =>
  fixture(async (f) => {
    expect((await f.service.connectedVoices(identity.userId)).voices).toEqual([{ id: "voice-nova", type: "preset", name: "Nova" }]);
    await f.service.connectedVoices(identity.userId);
    expect(f.state.voiceReads).toBe(1);
    await f.service.connectedVoices(identity.userId, { refresh: true });
    expect(f.state.voiceReads).toBe(2);
    expect(f.service.VIDEO_ANALYSIS_ENABLED).toBe(false);
    for (const [bad, code] of [
      [{ ...voice, voice: undefined }, "invalid_input"],
      [{ ...voice, source: { uploadId: "still" } }, "source_limits"],
      [{ ...voice, source: { uploadId: "absent" } }, "source_unavailable"],
      [analysis, "analysis_disabled"],
    ] as const)
      await expect(f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, bad as ConsumerVoiceToolInput, randomUUID()), code).rejects.toMatchObject({ code });
    expect(f.state.quoteCount).toBe(0);
    f.state.priced = false;
    await expect(f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, voice, randomUUID())).rejects.toMatchObject({ code: "price_unknown" });
    expect(f.state.importCount).toBe(0);
    expect(await f.service.consumerVoiceToolJobs(identity.userId, identity.draftId)).toEqual([]);
    f.state.priced = true;
    const key = randomUUID();
    const first = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, voice, key);
    expect(first).toMatchObject({ status: "quoted", quoteCredits: 12, creditUnit: "higgsfield_credits", priceSource: "get_cost", workspaceId: f.state.wallet, workspaceName: "Fixture wallet",
      tool: { name: "voice_change", label: "Change voice", suffix: "voice changed", output: "video" }, source: { kind: "video", name: "Hero take.mp4" }, originalAvailable: false });
    expect(f.state.importCount).toBe(1);
    expect((await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, voice, key)).id).toBe(first.id);
    // One refused (unpriced) quote plus one real quote; the replay asked the provider nothing.
    expect(f.state.quoteCount).toBe(2);
    await expect(f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, dub, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
    const stored = await f.jobs.getConsumerJob(scoped(first.id));
    expect(stored!.workflow).toBe("voice-tool");
    expect(JSON.parse(stored!.payloadJson).params).toEqual({ video_id: f.state.mediaId, voice_id: "voice-nova", voice_type: "preset" });
    expect(stored!.originalAssetIds).toEqual(["upload:clip"]);
  }));

test("one durable claim admits exactly one paid submission; ambiguous or interrupted requests stay uncertain and never resubmit", async () =>
  fixture(async (f) => {
    const quote = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, voice, randomUUID());
    await expect(f.service.submitConsumerVoiceToolJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 11 })).rejects.toMatchObject({ code: "approval_changed" });
    let release!: () => void;
    f.state.submitBarrier = () => new Promise<void>((resolve) => { release = resolve; });
    const approval = { workspaceId: f.state.wallet, credits: f.state.credits };
    const a = f.service.submitConsumerVoiceToolJob(scoped(quote.id), approval);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = f.service.submitConsumerVoiceToolJob(scoped(quote.id), approval).catch((error: { code?: string }) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [accepted, second] = await Promise.all([a, b]);
    expect(accepted).toMatchObject({ status: "accepted", providerJobId: f.state.providerJobId });
    expect((second as { code?: string; status?: string }).code === "already_submitted" || ["dispatching", "accepted"].includes(String((second as { status?: string }).status))).toBe(true);
    expect(f.state.paidCount).toBe(1);
    expect((await f.service.submitConsumerVoiceToolJob(scoped(quote.id), approval)).status).toBe("accepted");
    expect(f.state.paidCount).toBe(1);
    f.state.submitBarrier = undefined;
    f.state.mode = "uncertain";
    const other = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, dub, randomUUID());
    const uncertain = await f.service.submitConsumerVoiceToolJob(scoped(other.id), approval);
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.providerReceipt).toEqual({ response: { status: "submitted", unexpected_ref: "receipt-for-support" } });
    expect((await f.service.pollConsumerVoiceTool(scoped(other.id))).job.status).toBe("uncertain");
    expect(f.state.statusCount).toBe(0);
    expect((await f.service.submitConsumerVoiceToolJob(scoped(other.id), approval)).status).toBe("uncertain");
    expect(f.state.paidCount).toBe(2);
    f.state.mode = "throw-after-claim";
    const third = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, { ...dub, targetLanguage: "deu" }, randomUUID());
    const interrupted = await f.service.submitConsumerVoiceToolJob(scoped(third.id), approval);
    expect(interrupted.status).toBe("uncertain");
    expect(JSON.stringify(interrupted)).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(f.state.paidCount).toBe(3);
    expect((await f.service.consumerVoiceToolJobs(identity.userId, identity.draftId)).map((job) => [job.tool.name, job.status])).toEqual([["dubbing", "uncertain"], ["dubbing", "uncertain"], ["voice_change", "accepted"]]);
  }));

test("polling collects a revoiced video through the shared collector once, records provider failure, ignores envelopes for other jobs, and settles a result that can never be kept", async () =>
  fixture(async (f) => {
    const quote = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, voice, randomUUID());
    await f.service.submitConsumerVoiceToolJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    const processing = await f.service.pollConsumerVoiceTool(scoped(quote.id));
    expect(processing.job.status).toBe("accepted");
    expect(processing.pollAfterSeconds).toBe(20);
    expect((await f.service.pollConsumerVoiceTool(scoped(quote.id))).pollAfterSeconds).toBe(30);
    expect(f.state.statusCount).toBe(1);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.pollRaw = { generation: { id: randomUUID(), type: "video", status: "completed", results: { rawUrl: "https://media.example.com/other.mp4" } } };
    expect((await f.service.pollConsumerVoiceTool(scoped(quote.id))).job.status).toBe("accepted");
    expect(f.state.collectCount).toBe(0);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.pollRaw = completed(f);
    const original = await import("../../lib/higgsfield-consumer/video-original");
    f.state.collectorError = new original.ConsumerOriginalError("timeout");
    await expect(f.service.pollConsumerVoiceTool(scoped(quote.id))).rejects.toMatchObject({ code: "timeout" });
    expect((await f.jobs.getConsumerJob(scoped(quote.id)))!.status).toBe("accepted");
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.collectorError = undefined;
    const done = await f.service.pollConsumerVoiceTool(scoped(quote.id));
    expect(done.job.status).toBe("completed");
    expect(done.job.originalAvailable).toBe(true);
    expect(done.job.result).toMatchObject({ original: { asset: { kind: "video", mime: "video/mp4" }, credits: 12 }, providerResult: { tool: "voice_change", type: "video" } });
    expect(f.state.collectCount).toBe(2);
    expect((await f.service.pollConsumerVoiceTool(scoped(quote.id))).job.status).toBe("completed");
    const failing = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, dub, randomUUID());
    f.state.providerJobId = randomUUID();
    await f.service.submitConsumerVoiceToolJob(scoped(failing.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    f.state.pollRaw = completed(f, "failed");
    const failed = await f.service.pollConsumerVoiceTool(scoped(failing.id));
    expect(failed.job.status).toBe("failed");
    expect(failed.job.failureCode).toBe("provider_failed");
    expect(failed.providerStatus).toEqual({ status: "failed" });
    expect(f.state.collectCount).toBe(2);
    // A result over the size limit is settled once, receipt kept, never downloaded again.
    const oversized = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, dub, randomUUID());
    f.state.providerJobId = randomUUID();
    await f.service.submitConsumerVoiceToolJob(scoped(oversized.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    f.state.pollRaw = completed(f);
    f.state.collectorError = new original.ConsumerOriginalError("too_large");
    const settled = await f.service.pollConsumerVoiceTool(scoped(oversized.id));
    expect(settled.job).toMatchObject({ status: "failed", failureCode: "invalid_result", providerJobId: f.state.providerJobId });
    expect(settled).toMatchObject({ collection: { code: "too_large" } });
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [oversized.id] });
    expect((await f.service.pollConsumerVoiceTool(scoped(oversized.id))).job.status).toBe("failed");
    expect(f.state.collectCount).toBe(3);
    f.state.collectorError = undefined;
  }));

test("with the analysis flag on, an analysis is quoted, submitted and completed as a bounded report on the job, never as a media original", async () =>
  fixture(async (f) => {
    expect(f.service.VIDEO_ANALYSIS_ENABLED).toBe(true);
    const quote = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, analysis, randomUUID());
    expect(quote).toMatchObject({ status: "quoted", tool: { name: "video_analysis", output: "report" }, originalAvailability: "not_collected" });
    expect(JSON.parse((await f.jobs.getConsumerJob(scoped(quote.id)))!.payloadJson).params).toEqual({ video_input_id: f.state.mediaId });
    const accepted = await f.service.submitConsumerVoiceToolJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(accepted).toMatchObject({ status: "accepted", providerJobId: f.state.providerJobId });
    f.state.pollRaw = { video_analyze_id: f.state.providerJobId, status: "processing" };
    expect((await f.service.pollConsumerVoiceTool(scoped(quote.id))).job.status).toBe("accepted");
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.pollRaw = { video_analyze_id: f.state.providerJobId, status: "completed", summary: "Strong hook.", scores: { hook_strength: 72, retention: 0.6 }, scenes: [{ start: 0, end: 3, description: "Opening." }] };
    const done = await f.service.pollConsumerVoiceTool(scoped(quote.id));
    expect(done.job.status).toBe("completed");
    expect(done.job.originalAvailable).toBe(false);
    expect(done.job.result).toMatchObject({ report: { summary: "Strong hook.", sceneCount: 1, figures: [{ label: "scores hook strength", value: 72 }, { label: "scores retention", value: 0.6 }], scenes: [{ index: 0, start: 0, end: 3, text: "Opening." }] }, providerResult: { tool: "video_analysis", estimate: true } });
    expect(f.state.collectCount).toBe(0);
    const failing = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, analysis, randomUUID());
    f.state.providerJobId = randomUUID();
    await f.service.submitConsumerVoiceToolJob(scoped(failing.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    f.state.pollRaw = { video_analyze_id: f.state.providerJobId, status: "failed", fail_reason: "Video too long" };
    const failed = await f.service.pollConsumerVoiceTool(scoped(failing.id));
    expect(failed.job.status).toBe("failed");
    expect(failed.providerStatus).toEqual({ status: "Video too long" });
  }, { analysis: true }));

test("reframe prices the stored source duration, refuses an unknown or over-long one before the provider, and files the collected video", async () =>
  fixture(async (f) => {
    const reframe: ConsumerVoiceToolInput = { tool: "reframe", source: { uploadId: "wide" }, aspectRatio: "9:16", resolution: "720p" };
    for (const [bad, code] of [
      [{ ...reframe, source: { uploadId: "long" } }, "invalid_input"],
      [{ ...reframe, source: { uploadId: "clip" } }, "invalid_input"],
      [{ ...reframe, aspectRatio: undefined }, "invalid_input"],
    ] as const)
      await expect(f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, bad as ConsumerVoiceToolInput, randomUUID()), JSON.stringify(bad)).rejects.toMatchObject({ code });
    expect(f.state.quoteCount).toBe(0);
    const quote = await f.service.quoteConsumerVoiceTool(identity.userId, identity.draftId, reframe, randomUUID());
    expect(quote).toMatchObject({ status: "quoted", quoteCredits: 12, pricedSeconds: 12.35, tool: { name: "reframe", label: "Reframe", suffix: "reframed", output: "video" }, source: { kind: "video", name: "Launch cut.mp4" } });
    const stored = await f.jobs.getConsumerJob(scoped(quote.id));
    expect(JSON.parse(stored!.payloadJson).params).toEqual({ medias: [{ role: "video", value: f.state.mediaId }], aspect_ratio: "9:16", duration_seconds: 12.35, resolution: "720p" });
    expect(stored!.originalAssetIds).toEqual(["upload:wide"]);
    const submitted = await f.service.submitConsumerVoiceToolJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 12 });
    expect(submitted.status).toBe("accepted");
    expect(f.state.paidCount).toBe(1);
    f.state.pollRaw = completed(f);
    const polled = await f.service.pollConsumerVoiceTool(scoped(quote.id));
    expect(polled.job).toMatchObject({ status: "completed", originalAvailable: true });
    expect(f.state.collectCount).toBe(1);
    // A second submit of the same job never pays again.
    await f.service.submitConsumerVoiceToolJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: 12 });
    expect(f.state.paidCount).toBe(1);
  }));
