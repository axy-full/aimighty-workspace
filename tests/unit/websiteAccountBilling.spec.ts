import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerVideoInput } from "../../lib/higgsfield-consumer/video-contract";
import type * as Service from "../../lib/higgsfield-consumer/video-service";

/* Marketing video on the platform's website account, for a managed client
   workspace: an exact Particl-credit quote, a reservation taken with the job's
   registry row just before the one paid call, settlement at the approved
   price whether the job succeeds or fails, and a release to zero when nothing
   was sent. The service, ledger, registry, credits and grant are real; the
   account is a fixture transport. Nothing is sent anywhere. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-website-billing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-website-billing-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
// No request leaves this process: a token refresh or a stray call fails loudly instead.
globalThis.fetch = (async () => { throw new Error("This spec never contacts the network."); }) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const input: ConsumerVideoInput = { prompt: "A plain bottle on a studio background.", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true };
/** A synthetic private rate (dollars per account credit), for these fixtures only. */
const RATE = "0.02";
const IN_FLIGHT = "('reserved','claimed','accepted','uncertain')";
let sequence = 0;

async function modules() {
  return {
    account: await import("../../lib/higgsfield-consumer/platform-account"),
    registry: await import("../../lib/higgsfield-consumer/platform-jobs"),
    billing: await import("../../lib/higgsfield-consumer/account-billing"),
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    store: await import("../../lib/higgsfield-consumer/store"),
    contract: await import("../../lib/higgsfield-consumer/video-contract"),
    platform: await import("../../lib/platform"),
    tenant: await import("../../lib/tenant"),
    database: await import("../../lib/db"),
    credits: await import("../../lib/credits"),
    terms: await import("../../lib/billingTerms"),
    requests: await import("../../lib/generationRequests"),
  };
}
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

/** The platform owner's own connected account, designated, with marketing video switched on. */
async function designate(options: { tools?: string[] } = {}) {
  const { platform, store, account } = await modules();
  await platform.platformReady();
  const n = ++sequence, host = { workspaceId: `ws_billhost${n}${randomBytes(3).toString("hex")}`, userId: `acct_billhost_${n}` };
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)",
      args: [host.workspaceId, host.workspaceId, "Host", `file:${path.join(directory, `${host.workspaceId}.db`)}`, host.userId] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,0)", args: [host.workspaceId, host.userId] },
  ], "write");
  const state = randomBytes(32).toString("base64url"), sessionHash = store.hashConsumerSecret(`session-${n}`);
  await store.storeAuthorization({ ...host, state, sessionHash, verifier: randomBytes(32).toString("base64url"), clientId: "https://particl.example/client", redirectUri: "https://particl.example/callback" });
  const authorization = await store.consumeAuthorization(state, { ...host, sessionHash });
  expect(await store.completeAuthorization(authorization!, {
    accessToken: "platform-fixture-token", refreshToken: "platform-fixture-refresh", expiresAt: Date.now() + 3_600_000, scope: "openid email offline_access",
    clientId: authorization!.clientId, redirectUri: authorization!.redirectUri,
  }, Date.now(), sha(`issuer\nhost-${n}`))).toBe(true);
  await account.designatePlatformAccount(host, host.userId, Date.now(), { acknowledgeInFlight: true });
  await account.setPlatformAccountTools(options.tools ?? ["marketing-video"], host.userId);
  return host;
}
/** A managed client workspace with one saved project and `credits` granted. */
async function client(credits = 1000): Promise<TenantWorkspace> {
  const { platform, tenant, database } = await modules();
  await platform.platformReady();
  const id = `ws_billclient${++sequence}${randomBytes(3).toString("hex")}`;
  const ws = {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "client-owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null,
    flagNote: null, concurrency: 10, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'client-owner',0,0)", args: [id, id, id, ws.dbUrl] },
    { sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,'manual',0)", args: [`grant_${id}`, id, credits] },
  ], "write");
  await tenant.runInTenant(ws, async () => {
    await database.ready();
    await database.db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('m-d','member','draft','Client draft','{}',1,?)", args: [Date.now()] });
  });
  return ws;
}

/** video-service.ts over the real ledger, registry, credits and grant, with the account as a fixture transport. */
async function service() {
  const m = await modules();
  const state = {
    wallet: randomUUID(), websiteCredits: 12, balance: 10_000, providerJobId: randomUUID(),
    mode: "accept" as "accept" | "uncertain" | "not-sent",
    pollRaw: undefined as unknown, quotes: 0, paid: 0, reads: 0, collected: 0,
  };
  const original = await import("../../lib/higgsfield-consumer/video-original");
  const deps: Record<string, unknown> = {
    "node:crypto": await import("node:crypto"),
    "@/lib/tenant": m.tenant,
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/workbench/studio": await import("../../lib/workbench/studio"),
    "./client-view": await import("../../lib/higgsfield-consumer/client-view"),
    "./access": await import("../../lib/higgsfield-consumer/access"),
    "./funding": await import("../../lib/higgsfield-consumer/funding"),
    "./account-billing": m.billing,
    "./jobs": m.jobs,
    "./video-contract": m.contract,
    "./marketing-records": await import("../../lib/higgsfield-consumer/marketing-records"),
    "./marketing-setup": await import("../../lib/higgsfield-consumer/marketing-setup"),
    "./account-objects": await import("../../lib/higgsfield-consumer/account-objects"),
    "./video-availability": await import("../../lib/higgsfield-consumer/video-availability"),
    "./video-original": {
      ...original,
      collectConsumerVideoOriginal: async (job: { meterId: string | null; providerJobId: string | null; quoteCredits: number }) => {
        state.collected++;
        return { generationId: job.meterId, providerJobId: job.providerJobId, bytes: 1024, sha256: "a".repeat(64), width: 1280, height: 720, seconds: 15,
          credits: job.quoteCredits, creditUnit: "higgsfield_credits",
          asset: { generationId: job.meterId, url: `/api/media/${job.meterId}`, kind: "video", mime: "video/mp4", width: 1280, height: 720, durationS: 15 } };
      },
    },
    "./mcp": {
      getConsumerVideoQuote: async (token: string, value: ConsumerVideoInput) => {
        expect(token).toBe("platform-fixture-token");
        state.quotes++;
        return { input: value, workspace: { id: state.wallet, name: "Owner's own wallet", credits: state.balance }, credits: state.websiteCredits };
      },
      submitConsumerVideo: async (token: string, _value: ConsumerVideoInput, wallet: string, credits: number, options: { admit: () => Promise<void> }) => {
        expect(token).toBe("platform-fixture-token");
        if (wallet !== state.wallet) throw new m.contract.ConsumerVideoError("workspace_changed");
        if (credits !== state.websiteCredits) throw new m.contract.ConsumerVideoError("quote_changed");
        if (state.balance < credits) throw new m.contract.ConsumerVideoError("insufficient_credits");
        await options.admit();
        // The call never left: the transport's own preflight refused after admission.
        if (state.mode === "not-sent") throw new m.contract.ConsumerVideoError("preflight_unavailable");
        state.paid++;
        if (state.mode === "uncertain") return { state: "uncertain", raw: { status: "submitted" }, error: { code: "submission_uncertain", message: "No reply." } };
        return { state: "accepted", providerJobId: state.providerJobId, raw: { job_id: state.providerJobId } };
      },
      readConsumerVideoJob: async (token: string, providerJobId: string, wallet: string) => {
        expect(token).toBe("platform-fixture-token");
        expect(wallet).toBe(state.wallet);
        state.reads++;
        return { raw: state.pollRaw ?? { raw_data: { id: providerJobId, status: "processing" } }, pollAfterSeconds: 15 };
      },
    },
  };
  const loaded = { exports: {} as typeof Service };
  const source = ts.transpileModule(readFileSync("lib/higgsfield-consumer/video-service.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`);
    return deps[name];
  }, loaded, loaded.exports);
  return { service: loaded.exports, state };
}
const scopeOf = (id: string) => ({ userId: "member", draftId: "draft", id });
/** The account's finished reply for exactly this video and these settings. */
const completed = (id: string) => ({ raw_data: { id, status: "completed", job_set_type: "marketing_studio_video",
  result_url: "https://media.example.com/original.mp4",
  params: { prompt: input.prompt, duration: input.duration, resolution: input.resolution, aspect_ratio: input.aspectRatio,
    generate_audio: input.generateAudio, mode: "ugc", width: 1344, height: 768, medias: [], avatars: [], products: [] } } });
const rejected = (id: string, status: string) => ({ raw_data: { ...completed(id).raw_data, status, result_url: null } });
async function meterRow(id: string) {
  const { platform } = await modules();
  const row = (await platform.platformDb().execute({ sql: "SELECT status,billed_credits,engine,model FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { ...row } : null;
}
async function intentState(workspaceId: string, id: string) {
  const { platform } = await modules();
  return (await platform.platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE workspace_id=? AND id=?", args: [workspaceId, id] })).rows[0]?.state ?? null;
}
async function balance(ws: TenantWorkspace) {
  const { credits } = await modules();
  return (await credits.creditStateFor(ws))!.balance;
}
async function inFlightNow() {
  const { platform, registry } = await modules();
  await registry.websiteJobsReady();
  return Number((await platform.platformDb().execute(`SELECT COUNT(*) AS n FROM website_account_jobs WHERE state IN ${IN_FLIGHT}`)).rows[0].n);
}
/** The client's price for an account price: at the private rate, through the retail terms. */
async function priceOf(websiteCredits: number) {
  const { terms } = await modules();
  return terms.creditsAtTerms(websiteCredits * Number(RATE), terms.currentBillingTerms("video", "website:marketing-video"));
}

/* Jobs other spec files left in flight on this process's platform database
   never fill the shared account's caps here; the cap test sets its own. */
const CAPS = ["HF_ACCOUNT_MAX_ACTIVE", "HF_ACCOUNT_WORKSPACE_SHARE"] as const;
const capsBefore: Partial<Record<(typeof CAPS)[number], string | undefined>> = {};
test.beforeEach(() => { for (const key of CAPS) { capsBefore[key] = process.env[key]; process.env[key] = "1000"; } });
test.afterEach(() => { for (const key of CAPS) { const value = capsBefore[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
/* One worker reuses one platform client across spec files: leave its platform
   database as this file found it — no designation, and none of these clients'
   jobs holding the shared account's capacity. */
test.afterAll(async () => {
  const { account, platform, registry } = await modules();
  const designation = await account.readPlatformDesignation();
  if (designation) await account.releasePlatformAccount(designation.userId, { acknowledgeInFlight: true });
  await registry.websiteJobsReady();
  await platform.platformDb().execute(`UPDATE website_account_jobs SET state='released' WHERE workspace_id LIKE 'ws_billclient%' AND state IN ${IN_FLIGHT}`);
});

test("nothing is offered until the rate is set, the account designated and the tool switched on; nothing is read from the account", async () => {
  const { tenant, account } = await modules();
  const ws = await client();
  const f = await service();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: undefined }, async () => {
    await designate();
    await tenant.runInTenant(ws, async () => {
      await expect(f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID())).rejects.toMatchObject({ code: "particl_quote_unavailable" });
    });
  });
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    const host = await designate({ tools: [] });
    await tenant.runInTenant(ws, async () => {
      await expect(f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID())).rejects.toMatchObject({ code: "particl_quote_unavailable" });
    });
    await account.setPlatformAccountTools(["marketing-video"], host.userId);
    await account.setPlatformAccountPaused(true, host.userId);
    await tenant.runInTenant(ws, async () => {
      await expect(f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID())).rejects.toMatchObject({ code: "website_unavailable", status: 503 });
    });
  });
  expect(f.state.quotes).toBe(0);
});

test("the client is quoted exact Particl credits and told a failed job is still charged; the account's facts stay on the server", async () => {
  const { tenant } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const view = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      const price = await priceOf(f.state.websiteCredits);
      expect(price).toBeGreaterThan(1);
      expect(price).not.toBe(f.state.websiteCredits);
      expect(view).toMatchObject({ status: "quoted", quoteCredits: price, creditUnit: "particl_credits", workspaceId: null, workspaceName: null,
        providerJobId: null, providerReceipt: null, chargeTerms: { credits: price, onFailure: "charged" } });
      const text = JSON.stringify(view);
      for (const secret of [f.state.wallet, "Owner's own wallet", "higgsfield_credits", "platform-fixture-token"]) expect(text).not.toContain(secret);
      // Approval names the price alone: never the wallet, never the account's own figure.
      for (const approval of [{ credits: price + 1 }, { workspaceId: f.state.wallet, credits: price }, { credits: f.state.websiteCredits }])
        await expect(f.service.submitConsumerMarketingVideo(scopeOf(view.id), approval)).rejects.toMatchObject({ code: "approval_changed" });
      expect(f.state.paid).toBe(0);
      expect(await balance(ws)).toBe(start);
    });
  });
});

test("a job that succeeds is charged exactly its approved price, reserved just before its one paid call", async () => {
  const { tenant, registry, jobs } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const quote = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      const price = await priceOf(f.state.websiteCredits);
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      expect(await meterRow(job.meterId!)).toBeNull();
      expect(await registry.websiteJobPin(ws.id, quote.id)).toBeNull();
      const submitted = await f.service.submitConsumerMarketingVideo(scopeOf(quote.id), { credits: price });
      expect(submitted).toMatchObject({ status: "accepted", providerJobId: null, quoteCredits: price });
      expect(f.state.paid).toBe(1);
      expect(await meterRow(job.meterId!)).toEqual({ status: "running", billed_credits: price, engine: "higgsfield_account", model: "website:marketing-video" });
      expect(await balance(ws)).toBe(start - price);
      expect(await registry.websiteJobPin(ws.id, quote.id)).toMatchObject({ state: "accepted", providerJobId: f.state.providerJobId, particlCredits: price, websiteCredits: 12 });
      expect(await intentState(ws.id, job.meterId!)).toBe("accepted");
      // Again: nothing is sent twice.
      expect(await f.service.submitConsumerMarketingVideo(scopeOf(quote.id), { credits: price })).toMatchObject({ status: "accepted" });
      expect(f.state.paid).toBe(1);
      f.state.pollRaw = completed(f.state.providerJobId);
      const done = await f.service.pollConsumerMarketingVideo(scopeOf(quote.id));
      expect(done.job).toMatchObject({ status: "completed", quoteCredits: price, creditUnit: "particl_credits" });
      const text = JSON.stringify(done);
      for (const secret of [f.state.providerJobId, f.state.wallet, "higgsfield_credits", "media.example.com"]) expect(text).not.toContain(secret);
      expect(f.state.collected).toBe(1);
      expect(await meterRow(job.meterId!)).toMatchObject({ status: "succeeded", billed_credits: price });
      expect(await registry.websiteJobPin(ws.id, quote.id)).toMatchObject({ state: "settled" });
      expect(await intentState(ws.id, job.meterId!)).toBe("resolved");
      expect(await balance(ws)).toBe(start - price);
      await f.service.pollConsumerMarketingVideo(scopeOf(quote.id));
      expect(await balance(ws)).toBe(start - price);
      expect([f.state.paid, f.state.collected]).toEqual([1, 1]);
    });
  });
});

test("a job that fails on the account is charged its approved price (owner decision), settled once, its bill final", async () => {
  const { tenant, registry, jobs } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const quote = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      const price = await priceOf(f.state.websiteCredits);
      await f.service.submitConsumerMarketingVideo(scopeOf(quote.id), { credits: price });
      f.state.pollRaw = rejected(f.state.providerJobId, "nsfw");
      const failed = await f.service.pollConsumerMarketingVideo(scopeOf(quote.id));
      expect(failed.job).toMatchObject({ status: "failed", failureCode: "provider_failed", quoteCredits: price, chargeTerms: { credits: price, onFailure: "charged" } });
      // The account's own words for it stay on the server.
      expect(JSON.stringify(failed)).not.toContain("nsfw");
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      expect(await meterRow(job.meterId!)).toMatchObject({ status: "failed", billed_credits: price });
      expect(await registry.websiteJobPin(ws.id, quote.id)).toMatchObject({ state: "settled" });
      expect(await intentState(ws.id, job.meterId!)).toBe("resolved");
      expect(await balance(ws)).toBe(start - price);
      await f.service.pollConsumerMarketingVideo(scopeOf(quote.id));
      expect(await balance(ws)).toBe(start - price);
      expect([f.state.paid, f.state.collected]).toEqual([1, 0]);
    });
  });
});

test("a call that never left is released to zero; a lost reply keeps its reservation and is never sent again", async () => {
  const { tenant, registry, jobs } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf(f.state.websiteCredits);
      f.state.mode = "not-sent";
      const unsent = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      expect(await f.service.submitConsumerMarketingVideo(scopeOf(unsent.id), { credits: price })).toMatchObject({ status: "failed", failureCode: "submission_rejected" });
      const unsentJob = (await jobs.getConsumerJob(scopeOf(unsent.id)))!;
      expect(await meterRow(unsentJob.meterId!)).toMatchObject({ status: "failed", billed_credits: 0 });
      expect(await registry.websiteJobPin(ws.id, unsent.id)).toMatchObject({ state: "released" });
      expect(await intentState(ws.id, unsentJob.meterId!)).toBe("resolved");
      expect(await balance(ws)).toBe(start);
      // A later poll never turns a job that was never sent into a charge.
      await f.service.pollConsumerMarketingVideo(scopeOf(unsent.id));
      expect(await balance(ws)).toBe(start);

      f.state.mode = "uncertain";
      const lost = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      expect(await f.service.submitConsumerMarketingVideo(scopeOf(lost.id), { credits: price })).toMatchObject({ status: "uncertain", providerReceipt: null });
      const lostJob = (await jobs.getConsumerJob(scopeOf(lost.id)))!;
      expect(await meterRow(lostJob.meterId!)).toMatchObject({ status: "running", billed_credits: price });
      expect(await registry.websiteJobPin(ws.id, lost.id)).toMatchObject({ state: "uncertain" });
      expect(await intentState(ws.id, lostJob.meterId!)).toBe("accepted");
      expect(await balance(ws)).toBe(start - price);
      expect(await f.service.submitConsumerMarketingVideo(scopeOf(lost.id), { credits: price })).toMatchObject({ status: "uncertain" });
      await f.service.pollConsumerMarketingVideo(scopeOf(lost.id));
      expect([f.state.paid, f.state.reads]).toEqual([1, 0]);
      expect(await balance(ws)).toBe(start - price);
    });
  });
});

test("a changed rate or account price, a busy account, its caps, or too few credits refuse before anything is reserved or sent", async () => {
  const { tenant, registry } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf(f.state.websiteCredits);
      // The private rate moved: the client's price would change.
      const drift = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      await withEnv({ HF_ACCOUNT_CREDIT_USD: String(Number(RATE) * 3) }, async () => {
        await expect(f.service.submitConsumerMarketingVideo(scopeOf(drift.id), { credits: price })).rejects.toMatchObject({ code: "price_changed", status: 409 });
      });
      // The account's own price moved: the transport refuses before admission.
      const moved = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      f.state.websiteCredits = 13;
      await expect(f.service.submitConsumerMarketingVideo(scopeOf(moved.id), { credits: price })).rejects.toMatchObject({ code: "quote_changed" });
      f.state.websiteCredits = 12;
      // Another dispatch holds the shared account.
      const busy = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      expect(await registry.takeWebsiteLease("dispatch", "someone-else", 60_000)).toBe(true);
      await expect(f.service.submitConsumerMarketingVideo(scopeOf(busy.id), { credits: price })).rejects.toMatchObject({ code: "website_unavailable", status: 503 });
      await registry.releaseWebsiteLease("dispatch", "someone-else");
      for (const id of [drift.id, moved.id, busy.id]) expect(await registry.websiteJobPin(ws.id, id)).toBeNull();
      expect([f.state.paid, await balance(ws)]).toEqual([0, start]);
      // The shared account's global cap: one more job fits, the next does not.
      const room = (await inFlightNow()) + 1;
      await withEnv({ HF_ACCOUNT_MAX_ACTIVE: String(room), HF_ACCOUNT_WORKSPACE_SHARE: String(room) }, async () => {
        f.state.mode = "uncertain";
        const last = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
        await f.service.submitConsumerMarketingVideo(scopeOf(last.id), { credits: price });
        f.state.mode = "accept";
        const capped = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
        await expect(f.service.submitConsumerMarketingVideo(scopeOf(capped.id), { credits: price })).rejects.toMatchObject({ code: "capacity" });
        expect(await registry.websiteJobPin(ws.id, capped.id)).toBeNull();
      });
      // One workspace's share of it.
      await withEnv({ HF_ACCOUNT_MAX_ACTIVE: "1000", HF_ACCOUNT_WORKSPACE_SHARE: "1" }, async () => {
        const shared = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
        await expect(f.service.submitConsumerMarketingVideo(scopeOf(shared.id), { credits: price })).rejects.toMatchObject({ code: "capacity" });
      });
      expect([f.state.paid, await balance(ws)]).toEqual([1, start - price]);
    });
  });
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    await designate();
    const poor = await client(1);
    const f = await service();
    await tenant.runInTenant(poor, async () => {
      const start = await balance(poor);
      const price = await priceOf(f.state.websiteCredits);
      expect(start).toBeLessThan(price);
      const quote = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      await expect(f.service.submitConsumerMarketingVideo(scopeOf(quote.id), { credits: price })).rejects.toMatchObject({ status: 402 });
      expect(await registry.websiteJobPin(poor.id, quote.id)).toBeNull();
      expect([f.state.paid, await balance(poor)]).toEqual([0, start]);
    });
  });
});

test("housekeeping releases a reservation whose claim never happened, and settles a job that ended unsettled", async () => {
  const { tenant, registry, billing, jobs, account, requests } = await modules();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    const host = await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf(f.state.websiteCredits);
      const quote = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      const designation = (await account.readPlatformDesignation())!;
      // The process died between its reservation (with the registry row) and its claim, long enough ago.
      await requests.reserveGenerationSpend({ id: job.meterId!, kind: "video", engine: "higgsfield_account", model: "website:marketing-video", status: "running",
        engineCostUsd: f.state.websiteCredits * Number(RATE), createdBy: "member" }, {
        expectedCredits: price,
        within: async (tx, ts) => {
          await registry.registerWebsiteDispatchTx(tx, {
            meterId: job.meterId!, workspaceId: ws.id, jobId: job.id, userId: "member", workflow: "marketing-video", tool: "marketing-video",
            host, subjectHash: designation.subjectHash, generation: job.connectionGeneration,
            websiteCredits: f.state.websiteCredits, creditUsd: Number(RATE), particlCredits: price,
          }, ts - billing.WEBSITE_UNCLAIMED_MS - 1);
        },
      });
      expect(await balance(ws)).toBe(start - price);
      // Not yet old enough: nothing moves.
      expect(await billing.repairWebsiteJobs(Date.now() - billing.WEBSITE_UNCLAIMED_MS)).toEqual({ released: 0, settled: 0 });
      expect(await billing.repairWebsiteJobs()).toEqual({ released: 1, settled: 0 });
      expect(await balance(ws)).toBe(start);
      expect(await registry.websiteJobPin(ws.id, job.id)).toMatchObject({ state: "released" });
      expect(await meterRow(job.meterId!)).toMatchObject({ status: "failed", billed_credits: 0 });
      // Fenced: that quote can never be claimed now.
      await expect(f.service.submitConsumerMarketingVideo(scopeOf(job.id), { credits: price })).rejects.toMatchObject({ code: "quote_expired" });
      expect(f.state.paid).toBe(0);

      // A job whose poll ended it but crashed before its settlement.
      const ended = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      await f.service.submitConsumerMarketingVideo(scopeOf(ended.id), { credits: price });
      const endedJob = (await jobs.getConsumerJob(scopeOf(ended.id)))!;
      const claim = (await jobs.claimConsumerPoll(scopeOf(ended.id)))!;
      await jobs.failConsumerPoll({ ...scopeOf(ended.id), leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      expect(await registry.websiteJobPin(ws.id, ended.id)).toMatchObject({ state: "accepted" });
      expect(await billing.repairWebsiteJobs()).toEqual({ released: 0, settled: 1 });
      expect(await registry.websiteJobPin(ws.id, ended.id)).toMatchObject({ state: "settled" });
      expect(await meterRow(endedJob.meterId!)).toMatchObject({ status: "failed", billed_credits: price });
      expect(await balance(ws)).toBe(start - price);
      // Idempotent: nothing is left to repair.
      expect(await billing.repairWebsiteJobs()).toEqual({ released: 0, settled: 0 });
    });
  });
});

test("the recovery drain continues only a website job it holds: ended → settled, still a quote → fenced and released, unconfirmed → loud", async () => {
  const { tenant, registry, jobs, account, requests } = await modules();
  const drain = await import("../../lib/higgsfield-consumer/website-drain");
  await withEnv({ HF_ACCOUNT_CREDIT_USD: RATE }, async () => {
    const host = await designate();
    const ws = await client();
    const f = await service();
    await tenant.runInTenant(ws, async () => {
      const start = await balance(ws);
      const price = await priceOf(f.state.websiteCredits);
      // Not a website job, or one this workspace's registry does not hold: left to the ordinary drain.
      expect(await drain.drainWebsiteJob("gen_ark_something")).toBe(false);
      expect(await drain.drainWebsiteJob(`gen_hfc_${"c".repeat(40)}`)).toBe(false);

      // Reserved with its registry row, the claim never taken: fenced, then released to zero.
      const quote = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      const job = (await jobs.getConsumerJob(scopeOf(quote.id)))!;
      const designation = (await account.readPlatformDesignation())!;
      await requests.reserveGenerationSpend({ id: job.meterId!, kind: "video", engine: "higgsfield_account", model: "website:marketing-video", status: "running",
        engineCostUsd: f.state.websiteCredits * Number(RATE), createdBy: "member" }, {
        expectedCredits: price,
        within: async (tx, ts) => {
          await registry.registerWebsiteDispatchTx(tx, {
            meterId: job.meterId!, workspaceId: ws.id, jobId: job.id, userId: "member", workflow: "marketing-video", tool: "marketing-video",
            host, subjectHash: designation.subjectHash, generation: job.connectionGeneration,
            websiteCredits: f.state.websiteCredits, creditUsd: Number(RATE), particlCredits: price,
          }, ts);
        },
      });
      expect(await balance(ws)).toBe(start - price);
      expect(await drain.drainWebsiteJob(job.meterId!)).toBe(true);
      expect(await balance(ws)).toBe(start);
      expect(await registry.websiteJobPin(ws.id, job.id)).toMatchObject({ state: "released" });
      expect(await intentState(ws.id, job.meterId!)).toBe("resolved");
      await expect(f.service.submitConsumerMarketingVideo(scopeOf(job.id), { credits: price })).rejects.toMatchObject({ code: "quote_expired" });

      // Ended on the account, its settlement lost: settled at the approved price.
      const ended = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      await f.service.submitConsumerMarketingVideo(scopeOf(ended.id), { credits: price });
      const endedJob = (await jobs.getConsumerJob(scopeOf(ended.id)))!;
      const claim = (await jobs.claimConsumerPoll(scopeOf(ended.id)))!;
      await jobs.failConsumerPoll({ ...scopeOf(ended.id), leaseToken: claim.leaseToken, failureCode: "provider_failed" });
      expect(await drain.drainWebsiteJob(endedJob.meterId!)).toBe(true);
      expect(await registry.websiteJobPin(ws.id, ended.id)).toMatchObject({ state: "settled" });
      expect(await intentState(ws.id, endedJob.meterId!)).toBe("resolved");
      expect(await balance(ws)).toBe(start - price);

      // A lost reply: whether it was sent is unknown, so it stays for review and is never sent again.
      f.state.mode = "uncertain";
      const lost = await f.service.quoteConsumerMarketingVideo("member", "draft", input, randomUUID());
      await f.service.submitConsumerMarketingVideo(scopeOf(lost.id), { credits: price });
      const lostJob = (await jobs.getConsumerJob(scopeOf(lost.id)))!;
      await expect(drain.drainWebsiteJob(lostJob.meterId!)).rejects.toThrow(/never sent again/);
      expect(await intentState(ws.id, lostJob.meterId!)).toBe("accepted");
      expect([f.state.paid, await balance(ws)]).toEqual([2, start - 2 * price]);
    });
  });
});

test("the credits ledger names a website job by its tool, never by the account or its provider", async () => {
  const { meteredEngine } = await import("../../lib/usageLedger");
  expect(meteredEngine("video", "higgsfield_account", "website:marketing-video")).toBe("Marketing video");
  expect(meteredEngine("video", "higgsfield_account", "website:not-a-tool")).toBe("Website tool");
  const { vendorKeyNameFor } = await import("../../lib/platformSpend");
  // Its platform spend is counted with the provider's own key, for the desk alone.
  expect(vendorKeyNameFor("higgsfield_account")).toBe("higgsfield");
});
