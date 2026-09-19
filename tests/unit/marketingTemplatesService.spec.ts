import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerMarketingTemplateInput, MarketingTemplate, MarketingTemplateCosts } from "../../lib/higgsfield-consumer/marketing-templates";
import type * as Service from "../../lib/higgsfield-consumer/marketing-template-service";
import type { ConsumerVideoOriginal } from "../../lib/higgsfield-consumer/video-original";

const directory = mkdtempSync(path.join(tmpdir(), "particl-marketing-template-service-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "marketing-template-unit-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
const identity = { userId: "owner", draftId: "draft" };
const fixture = JSON.parse(readFileSync("tests/fixtures/marketing-templates.json", "utf8"));
const catalogueRaw = { items: fixture.pages.flatMap((p: { presets: unknown[] }) => p.presets), total: 6, complete: true };
const request: ConsumerMarketingTemplateInput = { presetId: "tpl_product_shot_studio", prompt: "A plain bottle on a clean background.", brandName: "Our bottle", productImage: { uploadId: "still" } };

async function fixtureRun(run: (f: Awaited<ReturnType<typeof serviceFixture>>) => Promise<void>) {
  const f = await serviceFixture();
  return f.tenant.runInTenant(f.workspace, async () => {
    await f.database.ready();
    await f.database.db().execute("INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Campaign','{}',1,0)");
    await f.database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('still','still.png','image/png','png',1000,'fixture','/api/uploads/still','image',0)");
    return run(f);
  });
}
async function serviceFixture() {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"), oauth = await import("../../lib/higgsfield-consumer/oauth"),
    contract = await import("../../lib/higgsfield-consumer/video-contract"), original = await import("../../lib/higgsfield-consumer/video-original"),
    templates = await import("../../lib/higgsfield-consumer/marketing-templates");
  const id = `marketing-template-service-${++sequence}`;
  const workspace = {
    id, slug: id, name: id, legacy: true, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
  const state = {
    generation: randomUUID(), wallet: randomUUID(), credits: 40, providerJobId: randomUUID(), mediaId: randomUUID(),
    mode: "accepted" as "accepted" | "uncertain" | "throw-after-claim", catalogueReads: 0, costReads: 0, quoteCount: 0, importCount: 0, paidCount: 0, statusCount: 0, collectCount: 0,
    pollRaw: undefined as unknown, collectorError: undefined as unknown, submitBarrier: undefined as (() => Promise<void>) | undefined,
    originals: new Map<string, ConsumerVideoOriginal>(),
  };
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "./jobs": jobs,
    "./video-availability": await import("../../lib/higgsfield-consumer/video-availability"),
    "./marketing-templates": templates,
    "./marketing-template-cache": await import("../../lib/higgsfield-consumer/marketing-template-cache"),
    "./marketing-template-sources": await import("../../lib/higgsfield-consumer/marketing-template-sources"),
    "./genjutsu-contract": await import("../../lib/higgsfield-consumer/genjutsu-contract"),
    "./video-service": await import("../../lib/higgsfield-consumer/video-service"),
    "./video-contract": contract,
    "./video-original": {
      collectConsumerVideoOriginal: async (job: { id: string; userId: string; draftId: string; providerJobId: string; quoteCredits: number }, url: string) => {
        state.collectCount++;
        expect(url).toBe("https://media.example.com/qualified-template.png");
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
            sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind) VALUES(?,'marketing_studio_v2','',?,'succeeded',?,?,'owner',0,0,'higgsfield','image')`,
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
      readMarketingTemplateCatalogue: async () => { state.catalogueReads++; return catalogueRaw; },
      readMarketingTemplateCosts: async () => { state.costReads++; return fixture.costs; },
      getConsumerMarketingTemplateQuote: async (_token: string, template: MarketingTemplate, costs: MarketingTemplateCosts | null, input: ConsumerMarketingTemplateInput, source: { url: string; type: string } | null,
        options: { resolveMedia: (wallet: string, perform: () => Promise<string>) => Promise<string> }) => {
        state.quoteCount++;
        expect(template.id).toBe(input.presetId);
        expect(source).toEqual(input.productImage ? { url: `https://fixtures.particl.invalid/uploads/${input.productImage.uploadId}.png`, type: "image" } : null);
        const mediaId = source ? await options.resolveMedia(state.wallet, async () => { state.importCount++; return state.mediaId; }) : null;
        const priced = templates.priceForTemplate(costs, template)!;
        return { input, params: templates.consumerMarketingTemplateParams(input, mediaId), shape: { nested: false, getCost: false }, workspace: { id: state.wallet, name: "Fixture wallet", credits: 100 }, credits: priced.credits, priceSource: priced.source };
      },
      submitConsumerMarketingTemplate: async (_token: string, _template: unknown, _costs: unknown, _input: unknown, _params: unknown, _shape: unknown, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        if (credits !== state.credits) throw new contract.ConsumerVideoError("quote_changed");
        await options.admit();
        if (state.submitBarrier) await state.submitBarrier();
        state.paidCount++;
        if (state.mode === "throw-after-claim") throw new Error("PRIVATE-PROVIDER-DETAIL");
        return state.mode === "uncertain"
          ? { state: "uncertain", raw: { status: "queued", unexpected_ref: "receipt-for-support" } }
          : { state: "accepted", providerJobId: state.providerJobId, raw: { job_id: state.providerJobId, status: "pending" } };
      },
      readConsumerMarketingTemplateJob: async (_token: string, providerJobId: string, wallet: string) => {
        state.statusCount++;
        expect(providerJobId).toBe(state.providerJobId);
        if (wallet !== state.wallet) throw new contract.ConsumerVideoError("workspace_changed");
        return { jobId: providerJobId, raw: state.pollRaw ?? { job_id: providerJobId, status: "processing" }, pollAfterSeconds: 20 };
      },
    },
  };
  const loaded = { exports: {} as typeof Service };
  const source = ts.transpileModule(readFileSync("lib/higgsfield-consumer/marketing-template-service.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`); return deps[name]; }, loaded, loaded.exports);
  return { service: loaded.exports, state, workspace, tenant, database, jobs };
}
const scoped = (id: string) => ({ ...identity, id });

test("the catalogue and cost table are read once per connection, browsed with prices, and every quote is validated against them first", async () =>
  fixtureRun(async (f) => {
    const listing = await f.service.connectedMarketingTemplateCatalogue(identity.userId);
    expect(listing.templates).toHaveLength(6);
    const costs = await f.service.connectedMarketingTemplateCosts(identity.userId);
    expect(costs.version).toBe("2026-09-18");
    await f.service.connectedMarketingTemplateCatalogue(identity.userId);
    await f.service.connectedMarketingTemplateCosts(identity.userId);
    expect([f.state.catalogueReads, f.state.costReads]).toEqual([1, 1]);
    await f.service.connectedMarketingTemplateCatalogue(identity.userId, { refresh: true });
    expect(f.state.catalogueReads).toBe(2);
    const view = f.service.presentMarketingTemplates(listing, costs, { category: "product-shot" });
    expect(view.templates).toEqual([expect.objectContaining({ id: "tpl_product_shot_studio", credits: 40, priceSource: "cost_table", outputKind: "image" })]);
    expect(view).toMatchObject({ matched: 1, total: 6, loaded: 6, complete: true, costsVersion: "2026-09-18" });
    expect(JSON.stringify(view).toLowerCase()).not.toContain("higgsfield");
    await expect(f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, { ...request, presetId: "not_in_catalogue" }, randomUUID())).rejects.toMatchObject({ code: "template_unknown" });
    await expect(f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, { ...request, productImage: { uploadId: "absent" } }, randomUUID())).rejects.toMatchObject({ code: "source_unavailable" });
    expect(f.state.quoteCount).toBe(0);
    expect(f.state.importCount).toBe(0);
    f.state.generation = randomUUID();
    await f.service.connectedMarketingTemplateCatalogue(identity.userId);
    expect(f.state.catalogueReads).toBe(3);
  }));

test("quotes replay by key, import the product image once, and one durable claim admits exactly one paid create", async () =>
  fixtureRun(async (f) => {
    const key = randomUUID();
    const first = await f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, request, key);
    expect(first).toMatchObject({ status: "quoted", quoteCredits: 40, priceSource: "cost_table", costsVersion: "2026-09-18", creditUnit: "higgsfield_credits", workspaceId: f.state.wallet, workspaceName: "Fixture wallet", outputKind: "image", template: { id: "tpl_product_shot_studio", name: "Studio product shot", category: "product-shot" } });
    expect(f.state.importCount).toBe(1);
    const replay = await f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, request, key);
    expect(replay.id).toBe(first.id);
    expect(f.state.quoteCount).toBe(1);
    await expect(f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, { ...request, prompt: "Other" }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
    const stored = await f.jobs.getConsumerJob(scoped(first.id));
    expect(stored!.workflow).toBe("marketing-template");
    expect(JSON.parse(stored!.payloadJson).params).toEqual({ preset_id: "tpl_product_shot_studio", prompt: request.prompt, brand_name: "Our bottle", product_image: f.state.mediaId });
    expect(stored!.originalAssetIds).toEqual(["upload:still"]);
    await expect(f.service.submitConsumerMarketingTemplateJob(scoped(first.id), { workspaceId: f.state.wallet, credits: 39 })).rejects.toMatchObject({ code: "approval_changed" });
    let release!: () => void;
    f.state.submitBarrier = () => new Promise<void>((resolve) => { release = resolve; });
    const approval = { workspaceId: f.state.wallet, credits: f.state.credits };
    const a = f.service.submitConsumerMarketingTemplateJob(scoped(first.id), approval);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = f.service.submitConsumerMarketingTemplateJob(scoped(first.id), approval).catch((error: { code?: string }) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [accepted, second] = await Promise.all([a, b]);
    expect(accepted).toMatchObject({ status: "accepted", providerJobId: f.state.providerJobId });
    expect((second as { code?: string; status?: string }).code === "already_submitted" || ["dispatching", "accepted"].includes(String((second as { status?: string }).status))).toBe(true);
    expect(f.state.paidCount).toBe(1);
    expect((await f.service.submitConsumerMarketingTemplateJob(scoped(first.id), approval)).status).toBe("accepted");
    expect(f.state.paidCount).toBe(1);
    const listed = await f.service.consumerMarketingTemplateJobs(identity.userId, identity.draftId);
    expect(listed.map((job) => job.id)).toEqual([first.id]);
  }));

test("an ambiguous acknowledgement or an interrupted paid request stays uncertain with its receipt and never resubmits", async () =>
  fixtureRun(async (f) => {
    f.state.mode = "uncertain";
    const quote = await f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, request, randomUUID());
    const uncertain = await f.service.submitConsumerMarketingTemplateJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.providerReceipt).toEqual({ response: { status: "queued", unexpected_ref: "receipt-for-support" } });
    expect(f.state.paidCount).toBe(1);
    const polled = await f.service.pollConsumerMarketingTemplate(scoped(quote.id));
    expect(polled.job.status).toBe("uncertain");
    expect(f.state.statusCount).toBe(0);
    expect((await f.service.submitConsumerMarketingTemplateJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits })).status).toBe("uncertain");
    expect(f.state.paidCount).toBe(1);
    // A receipt that later reads as one job UUID is adopted without another paid call.
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET provider_receipt=? WHERE id=?", args: [JSON.stringify({ response: { job_id: f.state.providerJobId, status: "queued" } }), quote.id] });
    const recovered = await f.service.pollConsumerMarketingTemplate(scoped(quote.id));
    expect(recovered.job).toMatchObject({ status: "accepted", providerJobId: f.state.providerJobId });
    expect(f.state.paidCount).toBe(1);
    f.state.mode = "throw-after-claim";
    const other = await f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, { ...request, prompt: "Second" }, randomUUID());
    const interrupted = await f.service.submitConsumerMarketingTemplateJob(scoped(other.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(interrupted.status).toBe("uncertain");
    expect(JSON.stringify(interrupted)).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(f.state.paidCount).toBe(2);
  }));

test("polling collects the verified original once as a template variant, records provider failure, and keeps a job accepted when collection is out of bounds", async () =>
  fixtureRun(async (f) => {
    const quote = await f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, request, randomUUID());
    const accepted = await f.service.submitConsumerMarketingTemplateJob(scoped(quote.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect(accepted.status).toBe("accepted");
    const processing = await f.service.pollConsumerMarketingTemplate(scoped(quote.id));
    expect(processing.job.status).toBe("accepted");
    expect(processing.pollAfterSeconds).toBe(20);
    expect(f.state.collectCount).toBe(0);
    expect((await f.service.pollConsumerMarketingTemplate(scoped(quote.id))).pollAfterSeconds).toBe(30);
    expect(f.state.statusCount).toBe(1);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.pollRaw = { job_id: f.state.providerJobId, status: "completed", result_url: "https://media.example.com/qualified-template.png" };
    const original = await import("../../lib/higgsfield-consumer/video-original");
    f.state.collectorError = new original.ConsumerOriginalError("invalid_video");
    await expect(f.service.pollConsumerMarketingTemplate(scoped(quote.id))).rejects.toMatchObject({ code: "invalid_video" });
    expect((await f.jobs.getConsumerJob(scoped(quote.id)))!.status).toBe("accepted");
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [quote.id] });
    f.state.collectorError = undefined;
    const done = await f.service.pollConsumerMarketingTemplate(scoped(quote.id));
    expect(done.job.status).toBe("completed");
    expect(done.job.originalAvailable).toBe(true);
    expect(done.job.result).toMatchObject({ original: { asset: { kind: "image", mime: "image/png" }, credits: 40 }, providerResult: { template: "tpl_product_shot_studio", outputKind: "image" } });
    expect(f.state.collectCount).toBe(2);
    expect((await f.service.pollConsumerMarketingTemplate(scoped(quote.id))).job.status).toBe("completed");
    expect(f.state.statusCount).toBe(3);
    // A different job's terminal envelope is diagnostic only; the provider's failure settles the job.
    const failing = await f.service.quoteConsumerMarketingTemplate(identity.userId, identity.draftId, { ...request, prompt: "Third" }, randomUUID());
    f.state.providerJobId = randomUUID();
    f.state.pollRaw = { job_id: randomUUID(), status: "completed", result_url: "https://media.example.com/other.png" };
    await f.service.submitConsumerMarketingTemplateJob(scoped(failing.id), { workspaceId: f.state.wallet, credits: f.state.credits });
    expect((await f.service.pollConsumerMarketingTemplate(scoped(failing.id))).job.status).toBe("accepted");
    expect(f.state.collectCount).toBe(2);
    await f.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [failing.id] });
    f.state.pollRaw = { job_id: f.state.providerJobId, status: "failed" };
    const failed = await f.service.pollConsumerMarketingTemplate(scoped(failing.id));
    expect(failed.job).toMatchObject({ status: "failed", failureCode: "provider_failed" });
    expect(failed.providerStatus).toEqual({ status: "failed" });
  }));
