import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerShortsInput, ConsumerShortsParams } from "../../lib/higgsfield-consumer/shorts-studio";
import type { ConsumerMarketingTemplateInput, MarketingTemplate, MarketingTemplateCosts } from "../../lib/higgsfield-consumer/marketing-templates";
import type * as ShortsService from "../../lib/higgsfield-consumer/shorts-service";
import type * as TemplateService from "../../lib/higgsfield-consumer/marketing-template-service";
import { RATE, ACCESS_TOKEN, balance, intentState, meterRow, priceOf, websiteAccountFixtures, withEnv } from "../helpers/websiteAccount";

/* Shorts sessions and video templates on the platform's website account, for
   a managed client workspace: quoted and approved in Particl credits, reserved
   just before the one paid call, and charged the approved price once whether
   the session collects every clip, some, or none (owner decision). Image
   templates, and templates the account cannot price itself, are refused
   before anything is imported. Services, ledger, registry, credits and grant
   are real; the account is a fixture transport. Nothing is sent anywhere. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-website-workflows-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-website-workflows-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
globalThis.fetch = (async () => { throw new Error("This spec never contacts the network."); }) as typeof fetch;

const fixtures = websiteAccountFixtures(directory, "flow");
fixtures.isolate();
const scopeOf = (id: string) => ({ userId: "member", draftId: "draft", id });
/** The next poll may read at once (a poll otherwise waits for its next turn). */
const unlease = async (id: string) =>
  (await import("../../lib/db")).db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=NULL WHERE id=?", args: [id] });
const shorts: ConsumerShortsInput = { source: { uploadId: "clip" }, preset: { id: "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f", source: "cms", name: "Bold Urban" }, aspectRatio: "9:16" };
const templateFixture = JSON.parse(readFileSync("tests/fixtures/marketing-templates.json", "utf8"));
const catalogueRaw = { items: templateFixture.pages.flatMap((p: { presets: unknown[] }) => p.presets), total: 6, complete: true };
const videoTemplate: ConsumerMarketingTemplateInput = { presetId: "tpl_ugc_unboxing_01", prompt: "A creator unboxes the bottle.", productImage: { uploadId: "still" } };
const imageTemplate: ConsumerMarketingTemplateInput = { presetId: "tpl_product_shot_studio", prompt: "A plain bottle.", productImage: { uploadId: "still" } };

async function modules() {
  return {
    tenant: await import("../../lib/tenant"),
    database: await import("../../lib/db"),
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    registry: await import("../../lib/higgsfield-consumer/platform-jobs"),
    contract: await import("../../lib/higgsfield-consumer/video-contract"),
    originals: await import("../../lib/higgsfield-consumer/video-original"),
    studio: await import("../../lib/higgsfield-consumer/shorts-studio"),
    templates: await import("../../lib/higgsfield-consumer/marketing-templates"),
  };
}
/** The client's sources: a 31-second video and a still. */
async function uploads() {
  const { database } = await modules();
  await database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at,duration_s) VALUES('clip','Launch cut.mp4','video/mp4','mp4',4000,'fixture','/api/uploads/clip','video',0,31)");
  await database.db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('still','still.png','image/png','png',1000,'fixture','/api/uploads/still','image',0)");
}
/** Every real module a consumer service imports, with the account's transport and the original collector replaced. */
async function load<T>(file: string, replaced: Record<string, unknown>): Promise<T> {
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/uploadReservations": await import("../../lib/uploadReservations"),
    "./oauth": await import("../../lib/higgsfield-consumer/oauth"),
    "./client-view": await import("../../lib/higgsfield-consumer/client-view"),
    "./access": await import("../../lib/higgsfield-consumer/access"),
    "./funding": await import("../../lib/higgsfield-consumer/funding"),
    "./account-billing": await import("../../lib/higgsfield-consumer/account-billing"),
    "./account-objects": await import("../../lib/higgsfield-consumer/account-objects"),
    "./jobs": await import("../../lib/higgsfield-consumer/jobs"),
    "./shorts-studio": await import("../../lib/higgsfield-consumer/shorts-studio"),
    "./shorts-sources": await import("../../lib/higgsfield-consumer/shorts-sources"),
    "./voice-tools": await import("../../lib/higgsfield-consumer/voice-tools"),
    "./genjutsu-contract": await import("../../lib/higgsfield-consumer/genjutsu-contract"),
    "./video-contract": await import("../../lib/higgsfield-consumer/video-contract"),
    "./video-service": await import("../../lib/higgsfield-consumer/video-service"),
    "./video-availability": await import("../../lib/higgsfield-consumer/video-availability"),
    "./marketing-templates": await import("../../lib/higgsfield-consumer/marketing-templates"),
    "./marketing-template-cache": await import("../../lib/higgsfield-consumer/marketing-template-cache"),
    "./marketing-template-sources": await import("../../lib/higgsfield-consumer/marketing-template-sources"),
    ...replaced,
  };
  const loaded = { exports: {} as T };
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`);
    return deps[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
/** The real collector's receipt shape, without fetching or storing anything. */
async function collector(state: { collected: number }, workspace: () => TenantWorkspace) {
  const { originals } = await modules();
  return {
    ...originals,
    collectConsumerVideoOriginal: async (job: { id: string; providerJobId: string | null; quoteCredits: number }, _url: string, options?: { clip?: { index: number; providerJobId: string } }) => {
      state.collected++;
      const key = options?.clip ? originals.consumerClipKey(job.id, options.clip.index) : job.id;
      const generationId = originals.consumerOriginalGenerationId(workspace().id, key);
      return { generationId, providerJobId: options?.clip?.providerJobId ?? job.providerJobId, bytes: 1024, sha256: "a".repeat(64), width: 720, height: 1280, seconds: 10,
        credits: job.quoteCredits, creditUnit: "higgsfield_credits", asset: { generationId, url: `/api/media/${generationId}`, kind: "video", mime: "video/mp4", width: 720, height: 1280, durationS: 10 } };
    },
  };
}

async function shortsService(workspace: () => TenantWorkspace) {
  const { studio, contract } = await modules();
  const state = {
    wallet: randomUUID(), session: randomUUID(), mediaId: randomUUID(), clips: [randomUUID(), randomUUID(), randomUUID()], websiteCredits: 40,
    mode: "accept" as "accept" | "not-sent", sessionStatus: "processing", clipStatus: {} as Record<string, "completed" | "failed" | "processing">,
    quotes: 0, imports: 0, paid: 0, collected: 0,
  };
  const service = await load<typeof ShortsService>("lib/higgsfield-consumer/shorts-service.ts", {
    "./video-original": await collector(state, workspace),
    "./mcp": {
      readShortsPresets: async (token: string) => {
        expect(token).toBe(ACCESS_TOKEN);
        return { presets: [{ id: shorts.preset.id, name: "Bold Urban", source: "cms" }], complete: true, fetchedAt: Date.now() };
      },
      getConsumerShortsQuote: async (token: string, input: ConsumerShortsInput, source: { durationSeconds?: number }, options: { resolveMedia: (w: string, perform: () => Promise<string>) => Promise<string> }) => {
        expect(token).toBe(ACCESS_TOKEN);
        state.quotes++;
        const mediaId = await options.resolveMedia(state.wallet, async () => { state.imports++; return state.mediaId; });
        return { input, params: studio.consumerShortsParams(input, mediaId, source.durationSeconds), workspace: { id: state.wallet, name: "Owner's own wallet", credits: 10_000 }, credits: state.websiteCredits };
      },
      submitConsumerShorts: async (token: string, _input: ConsumerShortsInput, _params: ConsumerShortsParams, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        expect([token, wallet]).toEqual([ACCESS_TOKEN, state.wallet]);
        if (credits !== state.websiteCredits) throw new contract.ConsumerVideoError("quote_changed");
        await options.admit();
        if (state.mode === "not-sent") throw new contract.ConsumerVideoError("preflight_unavailable");
        state.paid++;
        return { state: "accepted", providerJobId: state.session, raw: { id: state.session, status: "queued", job_ids: [] } };
      },
      readConsumerShortsSession: async (_token: string, sessionId: string) => ({
        id: sessionId, status: state.sessionStatus, job_ids: state.sessionStatus === "failed" ? [] : state.clips,
      }),
      readConsumerShortsClips: async (_token: string, ids: string[]) => ids.map((jobId) => {
        const status = state.clipStatus[jobId] ?? "completed";
        return { jobId, raw: { generation: { id: jobId, type: "video", status, results: status === "completed" ? { rawUrl: `https://media.example.com/${jobId}.mp4` } : null } } };
      }),
    },
  });
  return { service, state };
}

async function templateService(workspace: () => TenantWorkspace) {
  const { templates, contract } = await modules();
  const state = {
    wallet: randomUUID(), providerJobId: randomUUID(), mediaId: randomUUID(), websiteCredits: 42, getCost: true,
    pollRaw: undefined as unknown, quotes: 0, imports: 0, paid: 0, collected: 0,
  };
  const service = await load<typeof TemplateService>("lib/higgsfield-consumer/marketing-template-service.ts", {
    "./video-original": await collector(state, workspace),
    "./mcp": {
      readMarketingTemplateCatalogue: async () => catalogueRaw,
      readMarketingTemplateCosts: async () => templateFixture.costs,
      getConsumerMarketingTemplateQuote: async (token: string, template: MarketingTemplate, costs: MarketingTemplateCosts | null, input: ConsumerMarketingTemplateInput, source: unknown,
        options: { requireGetCost?: boolean; resolveMedia: (wallet: string, perform: () => Promise<string>) => Promise<string> }) => {
        expect(token).toBe(ACCESS_TOKEN);
        state.quotes++;
        // As the transport does: a required account price is checked before any import.
        if (options.requireGetCost && !state.getCost) throw new templates.MarketingTemplateError("price_unknown", "No exact price.");
        const mediaId = source ? await options.resolveMedia(state.wallet, async () => { state.imports++; return state.mediaId; }) : null;
        const priced = state.getCost ? { credits: state.websiteCredits, source: "get_cost" as const } : templates.priceForTemplate(costs, template)!;
        return { input, params: templates.consumerMarketingTemplateParams(input, mediaId), shape: { nested: false, getCost: state.getCost },
          workspace: { id: state.wallet, name: "Owner's own wallet", credits: 10_000 }, credits: priced.credits, priceSource: priced.source };
      },
      submitConsumerMarketingTemplate: async (token: string, _t: unknown, _c: unknown, _i: unknown, _p: unknown, _s: unknown, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        expect([token, wallet]).toEqual([ACCESS_TOKEN, state.wallet]);
        if (credits !== state.websiteCredits) throw new contract.ConsumerVideoError("quote_changed");
        await options.admit();
        state.paid++;
        return { state: "accepted", providerJobId: state.providerJobId, raw: { job_id: state.providerJobId, status: "pending" } };
      },
      readConsumerMarketingTemplateJob: async (_token: string, providerJobId: string) =>
        ({ jobId: providerJobId, raw: state.pollRaw ?? { job_id: providerJobId, status: "processing" }, pollAfterSeconds: 20 }),
    },
  });
  return { service, state };
}

test("a Shorts session is quoted and charged once in Particl credits, however many of its clips are collected", async () => {
  const { tenant, jobs, registry } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await fixtures.designate(["shorts"]);
    const ws = await fixtures.client(1000, uploads);
    const f = await shortsService(() => ws);
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf("shorts", f.state.websiteCredits);
      expect(price).not.toBe(f.state.websiteCredits);
      const quote = await f.service.quoteConsumerShorts("member", "draft", shorts, randomUUID());
      expect(quote).toMatchObject({ status: "quoted", quoteCredits: price, creditUnit: "particl_credits", workspaceId: null, workspaceName: null, pricedSeconds: 31,
        chargeTerms: { credits: price, onFailure: "charged" } });
      for (const secret of [f.state.wallet, "Owner's own wallet", "higgsfield_credits"]) expect(JSON.stringify(quote)).not.toContain(secret);
      await expect(f.service.submitConsumerShortsJob(scopeOf(quote.id), { workspaceId: f.state.wallet, credits: f.state.websiteCredits })).rejects.toMatchObject({ code: "approval_changed" });
      expect(await f.service.submitConsumerShortsJob(scopeOf(quote.id), { credits: price })).toMatchObject({ status: "accepted", providerJobId: null });
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      expect(await meterRow(job.meterId!)).toEqual({ status: "running", billed_credits: price, engine: "higgsfield_account", model: "website:shorts" });
      expect(await balance(ws)).toBe(start - price);
      // Still cutting: nothing collected, nothing settled.
      expect((await f.service.pollConsumerShorts(scopeOf(quote.id))).job).toMatchObject({ status: "accepted" });
      // Two of three clips collected, one failed: one settlement at the approved price.
      f.state.sessionStatus = "completed";
      f.state.clipStatus = { [f.state.clips[1]]: "failed" };
      await unlease(quote.id);
      const done = await f.service.pollConsumerShorts(scopeOf(quote.id));
      expect(done.job).toMatchObject({ status: "completed", settlement: { clips: 3, collected: 2, failed: 1, credits: price, creditUnit: "particl_credits" } });
      expect(done.job.clips.map((clip) => [clip.index, clip.state, clip.providerJobId])).toEqual([[0, "collected", null], [1, "failed", null], [2, "collected", null]]);
      const text = JSON.stringify(done);
      for (const secret of [f.state.session, ...f.state.clips, f.state.wallet, "higgsfield_credits"]) expect(text).not.toContain(secret);
      expect(await meterRow(job.meterId!)).toMatchObject({ status: "succeeded", billed_credits: price });
      expect(await registry.websiteJobPin(ws.id, quote.id)).toMatchObject({ state: "settled" });
      expect(await intentState(ws.id, job.meterId!)).toBe("resolved");
      expect(await balance(ws)).toBe(start - price);
      await f.service.pollConsumerShorts(scopeOf(quote.id));
      expect([f.state.paid, f.state.collected, await balance(ws)]).toEqual([1, 2, start - price]);
    });
  });
});

test("a Shorts session that yields no clip is still charged its approved price; one never sent is released to zero", async () => {
  const { tenant, jobs, registry } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await fixtures.designate(["shorts"]);
    const ws = await fixtures.client(1000, uploads);
    const f = await shortsService(() => ws);
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf("shorts", f.state.websiteCredits);
      // Every clip failed.
      const allFailed = await f.service.quoteConsumerShorts("member", "draft", shorts, randomUUID());
      await f.service.submitConsumerShortsJob(scopeOf(allFailed.id), { credits: price });
      f.state.sessionStatus = "completed";
      f.state.clipStatus = Object.fromEntries(f.state.clips.map((id) => [id, "failed" as const]));
      expect((await f.service.pollConsumerShorts(scopeOf(allFailed.id))).job).toMatchObject({ status: "failed", failureCode: "provider_failed", chargeTerms: { onFailure: "charged" } });
      expect(await registry.websiteJobPin(ws.id, allFailed.id)).toMatchObject({ state: "settled" });
      expect(await balance(ws)).toBe(start - price);
      // The session itself failed with no clip at all: said without the account's words.
      f.state.session = randomUUID();
      f.state.sessionStatus = "processing";
      const empty = await f.service.quoteConsumerShorts("member", "draft", shorts, randomUUID());
      await f.service.submitConsumerShortsJob(scopeOf(empty.id), { credits: price });
      f.state.sessionStatus = "failed";
      const failed = await f.service.pollConsumerShorts(scopeOf(empty.id));
      expect(failed.job).toMatchObject({ status: "failed", failureCode: "provider_failed" });
      expect(failed.providerStatus).toBeUndefined();
      const emptyJob = (await jobs.getConsumerJob(scopeOf(empty.id)))!;
      expect(await meterRow(emptyJob.meterId!)).toMatchObject({ status: "failed", billed_credits: price });
      expect(await balance(ws)).toBe(start - 2 * price);
      // The call never left: failed, released to zero.
      f.state.mode = "not-sent";
      const unsent = await f.service.quoteConsumerShorts("member", "draft", shorts, randomUUID());
      expect(await f.service.submitConsumerShortsJob(scopeOf(unsent.id), { credits: price })).toMatchObject({ status: "failed", failureCode: "submission_rejected" });
      expect(await registry.websiteJobPin(ws.id, unsent.id)).toMatchObject({ state: "released" });
      expect([f.state.paid, await balance(ws)]).toEqual([2, start - 2 * price]);
    });
  });
});

test("templates on the shared account: an image template, or one the account cannot price itself, is refused before anything is imported", async () => {
  const { tenant } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await fixtures.designate(["marketing-template"]);
    const ws = await fixtures.client(1000, uploads);
    const f = await templateService(() => ws);
    await tenant.runInTenant(ws, async () => {
      // Image templates run on the API's presets, never here.
      await expect(f.service.quoteConsumerMarketingTemplate("member", "draft", imageTemplate, randomUUID())).rejects.toMatchObject({ code: "particl_quote_unavailable" });
      expect([f.state.quotes, f.state.imports]).toEqual([0, 0]);
      // A video template priced only by the catalogue's cost table: no exact price from the account itself.
      f.state.getCost = false;
      await expect(f.service.quoteConsumerMarketingTemplate("member", "draft", videoTemplate, randomUUID())).rejects.toMatchObject({ code: "particl_quote_unavailable" });
      expect(f.state.imports).toBe(0);
      expect(await balance(ws)).toBe(1000);
    });
  });
});

test("a video template is quoted in Particl credits and charged its approved price whether it is collected or fails", async () => {
  const { tenant, jobs, registry } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await fixtures.designate(["marketing-template"]);
    const ws = await fixtures.client(1000, uploads);
    const f = await templateService(() => ws);
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf("marketing-template", f.state.websiteCredits);
      const quote = await f.service.quoteConsumerMarketingTemplate("member", "draft", videoTemplate, randomUUID());
      expect(quote).toMatchObject({ status: "quoted", outputKind: "video", priceSource: "get_cost", quoteCredits: price, creditUnit: "particl_credits",
        workspaceId: null, workspaceName: null, chargeTerms: { credits: price, onFailure: "charged" } });
      expect(f.state.imports).toBe(1);
      await f.service.submitConsumerMarketingTemplateJob(scopeOf(quote.id), { credits: price });
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      expect(await meterRow(job.meterId!)).toEqual({ status: "running", billed_credits: price, engine: "higgsfield_account", model: "website:marketing-template" });
      f.state.pollRaw = { job_id: f.state.providerJobId, status: "completed", result_url: "https://media.example.com/template.mp4" };
      const done = await f.service.pollConsumerMarketingTemplate(scopeOf(quote.id));
      expect(done.job).toMatchObject({ status: "completed", quoteCredits: price });
      for (const secret of [f.state.providerJobId, f.state.wallet, "higgsfield_credits"]) expect(JSON.stringify(done)).not.toContain(secret);
      expect(await registry.websiteJobPin(ws.id, quote.id)).toMatchObject({ state: "settled" });
      expect(await balance(ws)).toBe(start - price);

      f.state.providerJobId = randomUUID();
      f.state.pollRaw = undefined;
      const second = await f.service.quoteConsumerMarketingTemplate("member", "draft", videoTemplate, randomUUID());
      await f.service.submitConsumerMarketingTemplateJob(scopeOf(second.id), { credits: price });
      f.state.pollRaw = { job_id: f.state.providerJobId, status: "failed" };
      const failed = await f.service.pollConsumerMarketingTemplate(scopeOf(second.id));
      expect(failed.job).toMatchObject({ status: "failed", failureCode: "provider_failed" });
      expect(failed.providerStatus).toBeUndefined();
      const secondJob = (await jobs.getConsumerJob(scopeOf(second.id)))!;
      expect(await meterRow(secondJob.meterId!)).toMatchObject({ status: "failed", billed_credits: price });
      expect(await intentState(ws.id, secondJob.meterId!)).toBe("resolved");
      expect([f.state.paid, await balance(ws)]).toEqual([2, start - 2 * price]);
    });
  });
});

test("the drain continues a platform Shorts session or template from its registry row", async () => {
  const drain = await import("../../lib/higgsfield-consumer/website-drain");
  const { tenant, jobs, registry } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await fixtures.designate(["shorts"]);
    const ws = await fixtures.client(1000, uploads);
    const f = await shortsService(() => ws);
    await tenant.runInTenant(ws, async () => {
      const price = await priceOf("shorts", f.state.websiteCredits);
      const quote = await f.service.quoteConsumerShorts("member", "draft", shorts, randomUUID());
      await f.service.submitConsumerShortsJob(scopeOf(quote.id), { credits: price });
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      const claim = (await jobs.claimConsumerPoll(scopeOf(quote.id)))!;
      await jobs.failConsumerPoll({ ...scopeOf(quote.id), leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      expect(await drain.drainWebsiteJob(job.meterId!)).toBe(true);
      expect(await registry.websiteJobPin(ws.id, quote.id)).toMatchObject({ state: "settled", tool: "shorts" });
      expect(await meterRow(job.meterId!)).toMatchObject({ status: "failed", billed_credits: price });
    });
  });
});
