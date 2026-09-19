import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerGenerationInput } from "../../lib/higgsfield-consumer/generation-contract";
import type * as Service from "../../lib/higgsfield-consumer/generation-service";
import type { ConsumerVideoOriginal } from "../../lib/higgsfield-consumer/video-original";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-generation-service-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "consumer-generation-unit-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
const identity = { userId: "owner", draftId: "draft" };
const catalogueRaw = JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8"));
const request: ConsumerGenerationInput = {
  type: "image", model: "nano_banana_2", prompt: "A plain bottle on a clean background.",
  parameters: { resolution: "2k", aspect_ratio: "1:1" }, medias: [{ role: "image_references", source: { uploadId: "still" } }],
};

async function fixture(run: (f: Awaited<ReturnType<typeof serviceFixture>>) => Promise<void>) {
  const f = await serviceFixture();
  return f.tenant.runInTenant(f.workspace, async () => {
    await f.database.ready();
    await f.database.db().execute("INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Campaign','{}',1,0)");
    await f.database.db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('still','still.png','image/png','png',1000,'fixture','/api/uploads/still','image',0)",
      args: [],
    });
    return run(f);
  });
}
async function serviceFixture() {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"), oauth = await import("../../lib/higgsfield-consumer/oauth"),
    contract = await import("../../lib/higgsfield-consumer/video-contract"), original = await import("../../lib/higgsfield-consumer/video-original"),
    generation = await import("../../lib/higgsfield-consumer/generation-contract");
  const id = `generation-service-${++sequence}`;
  const workspace = {
    id, slug: id, name: id, legacy: true, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
  const state = {
    generation: randomUUID(), wallet: randomUUID(), credits: 9, providerJobId: randomUUID(), mediaId: randomUUID(),
    mode: "accepted" as "accepted" | "uncertain" | "throw-after-claim", catalogueReads: 0, quoteCount: 0, importCount: 0, paidCount: 0, statusCount: 0, collectCount: 0,
    pollRaw: undefined as unknown, collectorError: undefined as unknown, submitBarrier: undefined as (() => Promise<void>) | undefined,
    originals: new Map<string, ConsumerVideoOriginal>(),
    batchPaid: 0, batchItems: [] as unknown[], batchResult: null as null | { state: string; providerJobId?: string }[], presetChecks: [] as string[],
  };
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "./jobs": jobs,
    "./video-availability": await import("../../lib/higgsfield-consumer/video-availability"),
    "./generation-contract": generation,
    "./catalogue": await import("../../lib/higgsfield-consumer/catalogue"),
    "./tools": await import("../../lib/higgsfield-consumer/tools"),
    "./catalogue-cache": await import("../../lib/higgsfield-consumer/catalogue-cache"),
    "./generation-sources": await import("../../lib/higgsfield-consumer/generation-sources"),
    "./genjutsu-contract": await import("../../lib/higgsfield-consumer/genjutsu-contract"),
    "./video-service": await import("../../lib/higgsfield-consumer/video-service"),
    "./presets": { requireConnectedPreset: async (_user: string, _access: unknown, presetId: string) => {
      state.presetChecks.push(presetId);
      if (presetId !== "preset-dolly") throw new (await import("../../lib/higgsfield-consumer/catalogue")).CatalogueError("parameter_invalid", "That motion preset is not offered by the connected account.");
    } },
    "./video-contract": contract,
    "./video-original": {
      collectConsumerVideoOriginal: async (job: { id: string; userId: string; draftId: string; providerJobId: string; quoteCredits: number }, url: string) => {
        state.collectCount++;
        expect(url).toBe("https://media.example.com/qualified-original.png");
        expect(job.providerJobId).toBe(state.providerJobId);
        if (state.collectorError) throw state.collectorError;
        let stored = state.originals.get(job.id);
        if (!stored) {
          const generationId = original.consumerOriginalGenerationId(workspace.id, job.id);
          stored = { generationId, providerJobId: job.providerJobId, bytes: 1024, sha256: "a".repeat(64), width: 1024, height: 1024, mime: "image/png",
            credits: job.quoteCredits, creditUnit: "higgsfield_credits", asset: { generationId, url: `/api/media/${generationId}`, kind: "image", mime: "image/png", width: 1024, height: 1024 } };
          state.originals.set(job.id, stored);
          await (await import("../../lib/uploadReservations")).uploadReservationsReady();
          await database.db().execute({
            sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind) VALUES(?,'nano_banana_2','',?,'succeeded',?,?,'owner',0,0,'higgsfield','image')`,
            args: [generationId, JSON.stringify({ task: "connected-generation", consumerJobId: job.id, consumerProviderJobId: job.providerJobId, originalSha256: stored.sha256 }), stored.asset.url, stored.bytes],
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
      readConnectedCatalogue: async () => { state.catalogueReads++; return catalogueRaw; },
      getConsumerGenerationQuote: async (_token: string, model: { id: string }, input: ConsumerGenerationInput, sources: { url: string; type: string; role: string }[],
        options: { resolveMedia: (index: number, wallet: string, perform: () => Promise<string>) => Promise<string> }) => {
        state.quoteCount++;
        expect(model.id).toBe(input.model);
        expect(sources).toEqual(input.medias.map((m) => ({ url: `https://fixtures.particl.invalid/uploads/${m.source.uploadId}.png`, type: "image", role: m.role })));
        const medias = [];
        for (let i = 0; i < sources.length; i++)
          medias.push({ value: await options.resolveMedia(i, state.wallet, async () => { state.importCount++; return state.mediaId; }), role: sources[i].role });
        const catalogue = (await import("../../lib/higgsfield-consumer/catalogue")).parseConnectedCatalogue(catalogueRaw);
        const entry = catalogue.models.find((m) => m.id === input.model)!;
        return { input, params: generation.consumerGenerationParams(entry, input, medias), workspace: { id: state.wallet, name: "Fixture wallet", credits: 100 }, credits: state.credits };
      },
      submitConsumerGeneration: async (_token: string, _model: unknown, _input: unknown, _params: unknown, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        if (credits !== state.credits) throw new contract.ConsumerVideoError("quote_changed");
        await options.admit();
        if (state.submitBarrier) await state.submitBarrier();
        state.paidCount++;
        if (state.mode === "throw-after-claim") throw new Error("PRIVATE-PROVIDER-DETAIL");
        return state.mode === "uncertain"
          ? { state: "uncertain", raw: { status: "submitted", unexpected_ref: "receipt-for-support" } }
          : { state: "accepted", providerJobId: state.providerJobId, raw: { results: [{ id: state.providerJobId, model: "nano_banana_2", type: "image" }] } };
      },
      submitConsumerGenerationBatch: async (_token: string, entries: { credits: number; params: unknown }[], wallet: string, options: { admit: () => Promise<void> }) => {
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        state.batchItems = entries.map((entry) => entry.params);
        await options.admit();
        state.batchPaid++;
        return { raw: { jobs: [] }, items: state.batchResult ?? entries.map(() => ({ state: "uncertain" })) };
      },
      readConsumerGenerationJob: async (_token: string, providerJobId: string, wallet: string, model: string, type: string) => {
        state.statusCount++;
        expect(providerJobId).toBe(state.providerJobId); expect(model).toBe("nano_banana_2"); expect(type).toBe("image");
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        return { raw: state.pollRaw ?? { job_id: providerJobId, status: "processing" }, pollAfterSeconds: 20 };
      },
    },
  };
  const loaded = { exports: {} as typeof Service };
  const source = ts.transpileModule(readFileSync("lib/higgsfield-consumer/generation-service.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`); return deps[name]; }, loaded, loaded.exports);
  return { service: loaded.exports, state, workspace, tenant, database, jobs };
}
const scoped = (id: string) => ({ ...identity, id });
function terminal(f: Awaited<ReturnType<typeof serviceFixture>>, params: Record<string, unknown>, status = "completed") {
  return { generation: { id: f.state.providerJobId, model: "nano_banana_2", type: "image", status, params, results: status === "completed" ? { rawUrl: "https://media.example.com/qualified-original.png" } : null } };
}

test("the catalogue is read once per connection and every quote is validated against it before the provider is asked", async () =>
  fixture(async (f) => {
    const listing = await f.service.connectedGenerationCatalogue(identity.userId);
    expect(listing.models).toHaveLength(98);
    expect(f.state.catalogueReads).toBe(1);
    await f.service.connectedGenerationCatalogue(identity.userId);
    expect(f.state.catalogueReads).toBe(1);
    await f.service.connectedGenerationCatalogue(identity.userId, { refresh: true });
    expect(f.state.catalogueReads).toBe(2);
    for (const [bad, code] of [
      [{ ...request, parameters: { seed: 4 } }, "parameter_unknown"],
      [{ ...request, model: "not_in_catalogue" }, "model_unknown"],
      [{ ...request, type: "video" }, "type_mismatch"],
      [{ ...request, medias: [{ role: "start_image", source: { uploadId: "still" } }] }, "media_role_unknown"],
    ] as const)
      await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, bad as ConsumerGenerationInput, randomUUID())).rejects.toMatchObject({ code });
    expect(f.state.quoteCount).toBe(0);
    expect(f.state.importCount).toBe(0);
    // A missing source fails before any import.
    await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, medias: [{ role: "image_references", source: { uploadId: "absent" } }] }, randomUUID())).rejects.toMatchObject({ code: "source_unavailable" });
    expect(f.state.quoteCount).toBe(0);
    // A new authorization generation reads the catalogue again.
    f.state.generation = randomUUID();
    await f.service.connectedGenerationCatalogue(identity.userId);
    expect(f.state.catalogueReads).toBe(3);
  }));

test("quotes replay by key, import each reference once, and one durable claim admits exactly one paid submission", async () =>
  fixture(async (f) => {
    const key = randomUUID();
    const first = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, request, key);
    expect(first).toMatchObject({ status: "quoted", quoteCredits: 9, creditUnit: "higgsfield_credits", workspaceId: f.state.wallet, workspaceName: "Fixture wallet", model: { id: "nano_banana_2", outputType: "image" } });
    expect(first.model.name.toLowerCase()).not.toContain("higgsfield");
    expect(f.state.importCount).toBe(1);
    const replay = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, request, key);
    expect(replay.id).toBe(first.id);
    expect(f.state.quoteCount).toBe(1);
    await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, prompt: "Other" }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
    const stored = await f.jobs.getConsumerJob(scoped(first.id));
    expect(JSON.parse(stored!.payloadJson).params).toEqual({ resolution: "2k", aspect_ratio: "1:1", model: "nano_banana_2", prompt: request.prompt, medias: [{ value: f.state.mediaId, role: "image_references" }], count: 1, use_unlim: false });
    expect(stored!.originalAssetIds).toEqual(["upload:still"]);
    await expect(f.service.submitConsumerGenerationJob(scoped(first.id), { workspaceId: f.state.wallet, credits: 8 })).rejects.toMatchObject({ code: "approval_changed" });
    let release!: () => void;
    f.state.submitBarrier = () => new Promise<void>((resolve) => { release = resolve; });
    const approval = { workspaceId: f.state.wallet, credits: f.state.credits };
    const a = f.service.submitConsumerGenerationJob(scoped(first.id), approval);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = f.service.submitConsumerGenerationJob(scoped(first.id), approval).catch((error: { code?: string }) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [accepted, second] = await Promise.all([a, b]);
    expect(accepted).toMatchObject({ status: "accepted", providerJobId: f.state.providerJobId });
    // The loser either sees the claim refused or reads the already-dispatched job; it never pays.
    expect((second as { code?: string; status?: string }).code === "already_submitted" || ["dispatching", "accepted"].includes(String((second as { status?: string }).status))).toBe(true);
    expect(f.state.paidCount).toBe(1);
    expect((await f.service.submitConsumerGenerationJob(scoped(first.id), approval)).status).toBe("accepted");
    expect(f.state.paidCount).toBe(1);
    const listed = await f.service.consumerGenerationJobs(identity.userId, identity.draftId);
    expect(listed.map((job) => job.id)).toEqual([first.id]);
  }));

test("an ambiguous acknowledgement or an interrupted paid request stays uncertain with its receipt and never resubmits", async () =>
  fixture(async (f) => {
    f.state.mode = "uncertain";
    const quote = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, request, randomUUID());
    const uncertain = await f.service.submitConsumerGenerationJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.providerReceipt).toEqual({ response: { status: "submitted", unexpected_ref: "receipt-for-support" } });
    expect(f.state.paidCount).toBe(1);
    const polled = await f.service.pollConsumerGeneration(scoped(quote.id));
    expect(polled.job.status).toBe("uncertain");
    expect(f.state.statusCount).toBe(0);
    expect((await f.service.submitConsumerGenerationJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits })).status).toBe("uncertain");
    expect(f.state.paidCount).toBe(1);
    f.state.mode = "throw-after-claim";
    const other = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, prompt: "Second" }, randomUUID());
    const interrupted = await f.service.submitConsumerGenerationJob(scoped(other.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(interrupted.status).toBe("uncertain");
    expect(JSON.stringify(interrupted)).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(f.state.paidCount).toBe(2);
  }));

test("polling collects the verified original once, records failure from the provider, and keeps a job accepted when collection is out of bounds", async () =>
  fixture(async (f) => {
    const quote = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, request, randomUUID());
    const accepted = await f.service.submitConsumerGenerationJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(accepted.status).toBe("accepted");
    const params = JSON.parse((await f.jobs.getConsumerJob(scoped(quote.id)))!.payloadJson).params;
    const processing = await f.service.pollConsumerGeneration(scoped(quote.id));
    expect(processing.job.status).toBe("accepted");
    expect(processing.pollAfterSeconds).toBe(20);
    expect(f.state.collectCount).toBe(0);
    // A second poll inside the lease window is refused without a provider read.
    expect((await f.service.pollConsumerGeneration(scoped(quote.id))).pollAfterSeconds).toBe(30);
    expect(f.state.statusCount).toBe(1);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    // Out-of-bounds bytes leave the job accepted and recoverable.
    f.state.pollRaw = terminal(f, params);
    const original = await import("../../lib/higgsfield-consumer/video-original");
    f.state.collectorError = new original.ConsumerOriginalError("invalid_video");
    await expect(f.service.pollConsumerGeneration(scoped(quote.id))).rejects.toMatchObject({ code: "invalid_video" });
    expect((await f.jobs.getConsumerJob(scoped(quote.id)))!.status).toBe("accepted");
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.collectorError = undefined;
    const done = await f.service.pollConsumerGeneration(scoped(quote.id));
    expect(done.job.status).toBe("completed");
    expect(done.job.originalAvailable).toBe(true);
    expect(done.job.result).toMatchObject({ original: { asset: { kind: "image", mime: "image/png" }, credits: 9 }, providerResult: { model: "nano_banana_2", type: "image" } });
    expect(f.state.collectCount).toBe(2);
    expect((await f.service.pollConsumerGeneration(scoped(quote.id))).job.status).toBe("completed");
    expect(f.state.statusCount).toBe(3);
    // A mismatching terminal envelope is diagnostic only.
    const failing = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, prompt: "Third" }, randomUUID());
    f.state.providerJobId = randomUUID();
    f.state.pollRaw = { generation: { id: f.state.providerJobId, model: "soul_2", type: "image", status: "completed", results: { rawUrl: "https://media.example.com/other.png" } } };
    await f.service.submitConsumerGenerationJob(scoped(failing.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect((await f.service.pollConsumerGeneration(scoped(failing.id))).job.status).toBe("accepted");
    expect(f.state.collectCount).toBe(2);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [failing.id] });
    const failedParams = JSON.parse((await f.jobs.getConsumerJob(scoped(failing.id)))!.payloadJson).params;
    f.state.pollRaw = terminal(f, failedParams, "failed");
    const failed = await f.service.pollConsumerGeneration(scoped(failing.id));
    expect(failed.job.status).toBe("failed");
    expect(failed.job.failureCode).toBe("provider_failed");
    expect(failed.providerStatus).toEqual({ status: "failed" });
    expect(f.state.collectCount).toBe(2);
  }));

test("a tool preset quotes through the same pipeline, records the tool and source names on the job, and refuses a missing or extra source before any import", async () =>
  fixture(async (f) => {
    const upscale: ConsumerGenerationInput = {
      type: "image", model: "bytedance_image_upscale", prompt: "", parameters: { resolution: "2k" },
      medias: [{ role: "image_references", source: { uploadId: "still" } }], tool: { name: "upscale_image", model: "bytedance_image_upscale" },
    };
    for (const [bad, code] of [
      [{ ...upscale, medias: [] }, "tool_source"],
      [{ ...upscale, medias: [{ role: "image_references", source: { uploadId: "still" } }, { role: "image_references", source: { uploadId: "other" } }] }, "tool_source"],
      [{ ...upscale, model: "nano_banana_2", tool: { name: "upscale_image", model: "nano_banana_2" } }, "tool_model"],
      [{ ...upscale, parameters: { resolution: "8k" } }, "parameter_invalid"],
      [{ ...upscale, tool: { name: "lip_sync", model: "bytedance_image_upscale" } }, "tool_model"],
    ] as const)
      await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, bad as ConsumerGenerationInput, randomUUID()), code).rejects.toMatchObject({ code });
    expect(f.state.quoteCount).toBe(0);
    expect(f.state.importCount).toBe(0);
    const quoted = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, upscale, randomUUID());
    expect(quoted).toMatchObject({ status: "quoted", quoteCredits: 9, model: { id: "bytedance_image_upscale", outputType: "image" },
      tool: { name: "upscale_image", label: "Upscale image", model: "bytedance_image_upscale", suffix: "upscaled" }, sources: [{ role: "image_references", kind: "image", name: "still.png" }] });
    expect(f.state.importCount).toBe(1);
    const stored = JSON.parse((await f.jobs.getConsumerJob(scoped(quoted.id)))!.payloadJson);
    expect(stored.params).toEqual({ resolution: "2k", model: "bytedance_image_upscale", medias: [{ value: f.state.mediaId, role: "image_references" }], count: 1, use_unlim: false });
    expect(stored.params).not.toHaveProperty("tool");
    expect(stored.input.tool).toEqual({ name: "upscale_image", model: "bytedance_image_upscale" });
    // Plain generations carry no tool and still list their source names.
    const plain = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, request, randomUUID());
    expect(plain.tool).toBeNull();
    expect(plain.sources).toEqual([{ role: "image_references", kind: "image", name: "still.png" }]);
    expect((await f.service.consumerGenerationJobs(identity.userId, identity.draftId)).map((job) => job.tool?.name ?? null)).toEqual([null, "upscale_image"]);
  }));

test("A3: a motion preset reaches the provider only as preset_id of the preset model, checked against the live listing first", async () =>
  fixture(async (f) => {
    const preset: ConsumerGenerationInput = { type: "video", model: "higgsfield_preset", prompt: "", parameters: {}, medias: [{ role: "image", source: { uploadId: "still" } }], presetId: "preset-dolly" };
    const quoted = await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, preset, randomUUID());
    expect(f.state.presetChecks).toEqual(["preset-dolly"]);
    const stored = await f.jobs.getConsumerJob(scoped(quoted.id));
    expect(JSON.parse(stored!.payloadJson).params).toMatchObject({ model: "higgsfield_preset", preset_id: "preset-dolly", count: 1, use_unlim: false });
    // An unlisted preset is refused before any import or price.
    const before = { imports: f.state.importCount, quotes: f.state.quoteCount };
    await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...preset, presetId: "preset-unknown" }, randomUUID())).rejects.toMatchObject({ code: "parameter_invalid" });
    // A preset on another model, or preset_id as a plain setting, never validates.
    await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, presetId: "preset-dolly" }, randomUUID())).rejects.toMatchObject({ code: "parameter_reserved" });
    await expect(f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...preset, presetId: undefined, parameters: { preset_id: "preset-dolly" } }, randomUUID())).rejects.toMatchObject({ code: "parameter_reserved" });
    expect({ imports: f.state.importCount, quotes: f.state.quoteCount }).toEqual(before);
  }));

test("A4: one approval for the exact sum, one atomic durable claim per item, one paid batch call, per-item settlement", async () =>
  fixture(async (f) => {
    const quotes = [];
    for (const prompt of ["First bottle.", "Second bottle.", "Third bottle."])
      quotes.push(await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, prompt }, randomUUID()));
    const ids = quotes.map((q) => q.id);
    // A total that is not the exact sum, or another wallet, spends nothing.
    await expect(f.service.submitConsumerGenerationBatchJobs(identity.userId, identity.draftId, ids, { workspaceId: f.state.wallet, credits: 26 })).rejects.toMatchObject({ code: "approval_changed" });
    await expect(f.service.submitConsumerGenerationBatchJobs(identity.userId, identity.draftId, ids, { workspaceId: randomUUID(), credits: 27 })).rejects.toMatchObject({ code: "approval_changed" });
    expect(f.state.batchPaid).toBe(0);
    const accepted = randomUUID();
    f.state.batchResult = [{ state: "accepted", providerJobId: accepted }, { state: "rejected" }, { state: "uncertain" }];
    const views = await f.service.submitConsumerGenerationBatchJobs(identity.userId, identity.draftId, ids, { workspaceId: f.state.wallet, credits: 27 });
    expect(f.state.batchPaid).toBe(1);
    expect(f.state.batchItems).toHaveLength(3);
    expect(views.map((v) => v.status)).toEqual(["accepted", "failed", "uncertain"]);
    expect(views[0].providerJobId).toBe(accepted);
    expect(views[1].failureCode).toBe("submission_rejected");
    expect(views[2].providerReceipt).toMatchObject({ batch_index: 2 });
    // Nothing in the batch can be sent again, as a batch or on its own.
    await expect(f.service.submitConsumerGenerationBatchJobs(identity.userId, identity.draftId, ids, { workspaceId: f.state.wallet, credits: 27 })).rejects.toMatchObject({ code: "approval_changed" });
    expect((await f.service.submitConsumerGenerationJob(scoped(ids[2]), { workspaceId: f.state.wallet, credits: 9 })).status).toBe("uncertain");
    expect(f.state.batchPaid + f.state.paidCount).toBe(1);
    // Capacity is checked for the whole batch before any claim: two more would exceed four active jobs.
    const more = [];
    for (const prompt of ["Fourth.", "Fifth.", "Sixth."])
      more.push((await f.service.quoteConsumerGeneration(identity.userId, identity.draftId, { ...request, prompt }, randomUUID())).id);
    await expect(f.service.submitConsumerGenerationBatchJobs(identity.userId, identity.draftId, more, { workspaceId: f.state.wallet, credits: 27 })).rejects.toMatchObject({ code: "capacity" });
    for (const id of more) expect((await f.jobs.getConsumerJob(scoped(id)))!.status).toBe("quoted");
    expect(f.state.batchPaid).toBe(1);
  }));
