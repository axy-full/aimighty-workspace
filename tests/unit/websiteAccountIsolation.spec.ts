import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { WebsiteJobEntry } from "../../lib/higgsfield-consumer/platform-jobs";

/* Isolation on one shared website account. Two tenants on one
   fixture account: their objects and jobs never cross, no id can be guessed
   into another workspace's, the planner and catalogue carry no account facts,
   and a client's view and approval never name the account's wallet, credits,
   provider ids or replies. Local databases only; nothing is sent anywhere. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-website-isolation-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-website-isolation-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let sequence = 0;
async function modules() {
  return {
    objects: await import("../../lib/higgsfield-consumer/account-objects"),
    builds: await import("../../lib/higgsfield-consumer/build-records"),
    registry: await import("../../lib/higgsfield-consumer/platform-jobs"),
    account: await import("../../lib/higgsfield-consumer/platform-account"),
    view: await import("../../lib/higgsfield-consumer/client-view"),
    reads: await import("../../lib/higgsfield-consumer/planner-reads"),
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    characters: await import("../../lib/higgsfield-consumer/character-records"),
    elements: await import("../../lib/higgsfield-consumer/element-records"),
    store: await import("../../lib/higgsfield-consumer/store"),
    platform: await import("../../lib/platform"),
    tenant: await import("../../lib/tenant"),
    database: await import("../../lib/db"),
    accountDb: await import("../../lib/accountDb"),
  };
}
function workspace(managed = true): TenantWorkspace {
  const id = `ws_iso${++sequence}${randomBytes(3).toString("hex")}`;
  return {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: managed, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
}
async function inside<T>(ws: TenantWorkspace, fn: () => Promise<T>) {
  const { tenant, database } = await modules();
  return tenant.runInTenant(ws, async () => {
    await database.ready();
    await database.db().execute({ sql: "INSERT OR IGNORE INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('m-d','member','draft','Draft','{}',1,?)", args: [Date.now()] });
    return fn();
  });
}
const PLATFORM = { kind: "platform_account", tool: "generation" } as const;
const OWN = { kind: "own_account" } as const;
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
async function register(id: string, kind: "soul" | "element", workspaceId: string) {
  const { registry, accountDb } = await modules();
  await registry.websiteJobsReady();
  await accountDb.accountTransaction((tx) => registry.registerWebsiteObjectTx(tx, { id, kind, workspaceId }));
}

test("a request names only the Soul IDs and elements its own workspace made; on the shared account, only ones registered to it", async () => {
  const { objects, characters, elements } = await modules();
  expect(objects.accountObjectsNamed({
    prompt: "Hero <<<el_one>>> walks past <<<el_two>>>, then <<<el_one>>> again.",
    parameters: { soul_id: "soul_a", negative: "no <<<el_three>>>", seed_ref: randomUUID(), preset_id: randomUUID(), style_id: randomUUID(), avatar_ids: [randomUUID()], strength: 0.5 },
  })).toEqual({ souls: ["soul_a"], elements: ["el_one", "el_two", "el_three"], unclassified: ["seed_ref"] });
  const a = workspace(), b = workspace();
  await inside(a, async () => {
    await characters.recordParticlCharacter({ soulId: "soul_a", userId: "member", projectId: null, name: "Mira", type: "soul_2" });
    await elements.recordParticlElement({ elementId: "el_a" }, { userId: "member", projectId: null, name: "Harbour", category: "environment" });
    // Its own account: its own records pass, anything else refuses before a quote.
    await objects.refuseForeignAccountObjects({ prompt: "<<<el_a>>>", parameters: { soul_id: "soul_a" } }, OWN);
    await objects.refuseForeignAccountObjects({ prompt: "nothing named", parameters: { seed_ref: randomUUID() } }, OWN);
    for (const request of [{ parameters: { soul_id: "soul_theirs" } }, { prompt: "<<<el_theirs>>>" }, { prompt: "<<<el_a>>> <<<el_theirs>>>" }])
      await expect(objects.refuseForeignAccountObjects(request, OWN)).rejects.toMatchObject({ code: "object_not_particl", status: 409, paidAttempted: false });
    // The shared account: an unclassified id-shaped parameter refuses, and a record alone is not enough.
    await expect(objects.refuseForeignAccountObjects({ parameters: { seed_ref: randomUUID() } }, PLATFORM)).rejects.toMatchObject({ code: "object_not_particl" });
    await expect(objects.refuseForeignAccountObjects({ prompt: "<<<el_a>>>" }, PLATFORM)).rejects.toMatchObject({ code: "object_not_particl" });
    await register("el_a", "element", b.id);
    await expect(objects.refuseForeignAccountObjects({ prompt: "<<<el_a>>>" }, PLATFORM)).rejects.toMatchObject({ code: "object_not_particl" });
    await register("soul_a", "soul", a.id);
    await objects.refuseForeignAccountObjects({ parameters: { soul_id: "soul_a" } }, PLATFORM);
    await objects.refuseForeignAccountObjects({ prompt: "nothing", parameters: { preset_id: randomUUID() } }, PLATFORM);
  });
  // Workspace B never reaches A's records, whatever it names.
  await inside(b, async () => {
    await expect(objects.refuseForeignAccountObjects({ parameters: { soul_id: "soul_a" } }, OWN)).rejects.toMatchObject({ code: "object_not_particl" });
    await expect(objects.refuseForeignAccountObjects({ parameters: { soul_id: "soul_a" } }, PLATFORM)).rejects.toMatchObject({ code: "object_not_particl" });
  });
});

test("every quote meets the object guard before its account is asked", async () => {
  const ws = workspace(false);
  await inside(ws, async () => {
    const generation = await import("../../lib/higgsfield-consumer/generation-service");
    const video = await import("../../lib/higgsfield-consumer/video-service");
    const templates = await import("../../lib/higgsfield-consumer/marketing-template-service");
    const key = randomUUID();
    // No connection exists here: a refusal proves the guard ran before any grant or account read.
    await expect(generation.quoteConsumerGeneration("member", "draft", { type: "image", model: "soul_2", prompt: "hero", parameters: { soul_id: "not_ours" }, medias: [] }, key))
      .rejects.toMatchObject({ code: "object_not_particl" });
    await expect(generation.quoteConsumerGeneration("member", "draft", { type: "image", model: "nano_banana_2", prompt: "hero <<<el_foreign>>>", parameters: {}, medias: [] }, key))
      .rejects.toMatchObject({ code: "object_not_particl" });
    await expect(video.quoteConsumerMarketingVideo("member", "draft", { prompt: "an ad with <<<el_foreign>>>", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true }, key))
      .rejects.toMatchObject({ code: "object_not_particl" });
    await expect(templates.quoteConsumerMarketingTemplate("member", "draft", { presetId: randomUUID(), prompt: "<<<el_foreign>>>" } as never, key))
      .rejects.toMatchObject({ code: "object_not_particl" });
  });
});

test("builds are never adopted by name across workspaces, nor at all on the shared account", async () => {
  const { builds, account, platform, store } = await modules();
  const a = workspace(false), b = workspace(false), n = randomBytes(3).toString("hex");
  const [ofB, ofA, free] = [`el_b${n}`, `el_a${n}`, `el_free${n}`];
  const entries = [{ id: ofB, name: "Harbour" }, { id: ofA, name: "Harbour" }, { id: free, name: "Harbour" }];
  await register(ofB, "element", b.id);
  await register(ofA, "element", a.id);
  await inside(a, async () => expect(await builds.matchableEntries("member", entries)).toEqual([{ id: ofA, name: "Harbour" }, { id: free, name: "Harbour" }]));
  await inside(b, async () => expect((await builds.matchableEntries("member", entries)).map((e) => e.id)).toEqual([ofB, free]));
  // A pure name match would adopt the other workspace's entry: the window and name fit exactly.
  expect(builds.matchBuild({ name: "Harbour", type: "environment", createdAt: 1_000_000 }, [{ id: ofB, name: "Harbour", type: "environment", createdAt: 1_000_500 }])).toBe(ofB);
  // Reading the designated shared account itself: no candidate at all, so every build stays pending.
  await platform.platformReady();
  const host = { workspaceId: a.id, userId: "member" };
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)", args: [a.id, a.id, "Host", a.dbUrl, "member"] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,0)", args: [a.id, "member"] },
  ], "write");
  const state = randomBytes(32).toString("base64url"), sessionHash = store.hashConsumerSecret("s");
  await store.storeAuthorization({ ...host, state, sessionHash, verifier: randomBytes(32).toString("base64url"), clientId: "c", redirectUri: "r" });
  const auth = await store.consumeAuthorization(state, { ...host, sessionHash });
  await store.completeAuthorization(auth!, { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scope: "s", clientId: "c", redirectUri: "r" }, Date.now(), sha("issuer\nhost"));
  await account.designatePlatformAccount(host, "member");
  await inside(a, async () => expect(await builds.matchableEntries("member", entries)).toEqual([]));
  await account.releasePlatformAccount("member");
});

test("the planner and the catalogue carry no account facts for a workspace on the shared account", async () => {
  const { reads } = await modules();
  expect(reads.plannerReads("a bottle ad").map((read) => read.name)).toEqual(["recommend", "presets", "voices", "balance", "plan"]);
  expect(reads.plannerReads("a bottle ad", { accountFacts: false }).map((read) => read.name)).toEqual(["recommend", "presets", "voices"]);
  const results = [
    { name: "balance" as const, value: { credits: 4210, plan: "Creator" } },
    { name: "plan" as const, value: { current_plan: "Creator" } },
    { name: "voices" as const, value: { items: [{ voice_id: "v1", name: "Ava", voice_type: "preset" }] } },
  ];
  const own = reads.summarizePlannerReads(results);
  expect(own.balance).toBe(4210);
  expect(own.lines.join("\n")).toContain("Creator");
  const shared = reads.summarizePlannerReads(results, { accountFacts: false });
  expect(shared.balance).toBeNull();
  expect(shared.lines.join("\n")).not.toMatch(/4,?210|Creator|credits/i);
  expect(shared.lines.join("\n")).toContain("Voices");
  const { presentCatalogue } = await import("../../lib/higgsfield-consumer/generation-service");
  const catalogue = { models: [], unlim: { image: true }, complete: true, fetchedAt: 1 } as never;
  expect(presentCatalogue(catalogue).unlim).toEqual({ image: true });
  expect(presentCatalogue(catalogue, undefined, { shared: true }).unlim).toBeNull();
});

test("a client's job view and approval never name the account's wallet, credits, provider ids or replies", async () => {
  const { view, jobs } = await modules();
  const wallet = randomUUID(), provider = randomUUID();
  const platformJob = { funding: "platform_account" as const, particlCredits: 25, higgsfieldWorkspaceId: wallet, quoteCredits: 12 };
  const shown = view.workspaceJobView(platformJob, {
    id: "j", status: "completed", workspaceId: wallet, workspaceName: "Owner's wallet", quoteCredits: 12, creditUnit: "higgsfield_credits",
    providerJobId: provider, providerReceipt: { job_id: provider, response: { raw: true } },
    result: { original: { generationId: "gen_hfc_x", providerJobId: provider, credits: 12, creditUnit: "higgsfield_credits", sha256: "s", asset: { url: "/api/media/gen_hfc_x" } }, providerResult: { enhancedPrompt: "a brighter bottle", raw: { cost: 12 } } },
    settlement: { collected: 2, failed: 0, credits: 12, creditUnit: "higgsfield_credits" },
    clips: [{ index: 0, providerJobId: provider, state: "collected", original: { providerJobId: provider, credits: 12, asset: { url: "/api/media/c" } } }],
  });
  const text = JSON.stringify(shown);
  for (const secret of [wallet, provider, "Owner's wallet", "higgsfield_credits", '"raw"', '"cost"']) expect(text).not.toContain(secret);
  // A saved reply is said to exist (a status check can still recover the job on the server), never shown.
  expect(shown).toMatchObject({ quoteCredits: 25, creditUnit: "particl_credits", workspaceId: null, providerReceipt: null, receiptSaved: true,
    result: { original: { asset: { url: "/api/media/gen_hfc_x" } }, providerResult: { enhancedPrompt: "a brighter bottle" } }, settlement: { collected: 2, credits: 25, creditUnit: "particl_credits" } });
  // An own-account job is shown exactly as before.
  const mine = { workspaceId: wallet, quoteCredits: 12, creditUnit: "higgsfield_credits", providerJobId: provider };
  expect(view.workspaceJobView({ funding: "own_account", particlCredits: null }, mine)).toBe(mine);
  expect(view.providerDetail(platformJob, { raw: true })).toBeUndefined();
  expect(view.providerDetail({ funding: "own_account" }, { raw: true })).toEqual({ raw: true });
  // A platform job is approved by its Particl credits alone: never by the wallet or the account's own price.
  expect(view.approvalMatches(platformJob, { credits: 25 })).toBe(true);
  expect(view.approvalMatches(platformJob, { workspaceId: null, credits: 25 })).toBe(true);
  expect(view.approvalMatches(platformJob, { workspaceId: wallet, credits: 25 })).toBe(false);
  expect(view.approvalMatches(platformJob, { workspaceId: wallet, credits: 12 })).toBe(false);
  expect(view.approvalMatches(platformJob, { credits: 24 })).toBe(false);
  expect(view.approvalMatches({ ...platformJob, funding: "own_account" }, { workspaceId: wallet, credits: 12 })).toBe(true);
  // A take card collected for a platform job carries no account figure or provider id.
  const { rowToGeneration } = await import("../../lib/jobs");
  const card = await (await modules()).tenant.runInTenant(workspace(), async () => rowToGeneration({
    id: `gen_hfc_${"a".repeat(40)}`, provider: "higgsfield", model: "marketing_studio_video", status: "succeeded", kind: "video",
    params: JSON.stringify({ consumerJobId: "j", consumerProviderJobId: provider, consumerCredits: 12, consumerCreditUnit: "higgsfield_credits", consumerFunding: "platform_account", originalSha256: "s" }),
    receipt_credits: 25,
  }));
  expect(card.providerCreditQuote).toBeNull();
  expect(card.creditsBilled).toBe(25);
  expect(JSON.stringify(card.params)).not.toMatch(/consumerCredits|consumerCreditUnit|consumerProviderJobId|consumerFunding/);
  // One clip of a platform Shorts session: the session carries the receipt, so the clip shows no charge (never "0").
  const clip = await (await modules()).tenant.runInTenant(workspace(), async () => rowToGeneration({
    id: `gen_hfc_${"b".repeat(40)}`, provider: "higgsfield", model: "shorts_studio", status: "succeeded", kind: "video",
    params: JSON.stringify({ consumerJobId: "j.clip-0", consumerProviderJobId: provider, consumerParentJobId: "j", consumerParentProviderJobId: provider,
      clipIndex: 0, consumerCredits: 40, consumerCreditUnit: "higgsfield_credits", consumerFunding: "platform_account", originalSha256: "s" }),
    receipt_credits: null,
  }));
  expect([clip.creditsBilled, clip.providerCreditQuote]).toEqual([null, null]);
  expect(clip.params).toMatchObject({ consumerParentJobId: "j", clipIndex: 0 });
  expect(JSON.stringify(clip.params)).not.toMatch(/consumerCredits|consumerParentProviderJobId|consumerProviderJobId/);
  void jobs;
});

test("the shared account's reports, capacity and provider jobs are global; one provider job is one platform job", async () => {
  const { registry, accountDb, jobs } = await modules();
  await registry.websiteJobsReady();
  const tx = <T>(fn: Parameters<typeof accountDb.accountTransaction<T>>[0]) => accountDb.accountTransaction(fn);
  const base = await tx((t) => registry.websiteJobsInFlightTx(t));
  const entry = (workspaceId: string): WebsiteJobEntry => {
    const jobId = randomUUID();
    return {
      meterId: jobs.consumerJobMeterId(workspaceId, jobId), workspaceId, jobId, userId: "member", workflow: "shorts", tool: "shorts",
      host: { workspaceId: "ws_host", userId: "host" }, subjectHash: sha("host"), generation: "g", websiteCredits: 5, creditUsd: 0.02, particlCredits: 2,
    };
  };
  await withEnv({ HF_ACCOUNT_MAX_ACTIVE: String(base + 2), HF_ACCOUNT_WORKSPACE_SHARE: "1" }, async () => {
    expect(registry.websiteAccountCapacity()).toEqual({ maxActive: base + 2, workspaceShare: 1 });
    const a1 = entry("ws_cap_a"), a2 = entry("ws_cap_a"), b1 = entry("ws_cap_b"), c1 = entry("ws_cap_c");
    expect(await tx((t) => registry.registerWebsiteDispatchTx(t, a1))).toBe("registered");
    await expect(tx((t) => registry.registerWebsiteDispatchTx(t, a2))).rejects.toMatchObject({ code: "capacity" });
    expect(await tx((t) => registry.registerWebsiteDispatchTx(t, b1))).toBe("registered");
    await expect(tx((t) => registry.registerWebsiteDispatchTx(t, c1))).rejects.toMatchObject({ code: "capacity" });
    // A settled job frees its place; a replay of a registered job never counts twice.
    expect(await tx((t) => registry.registerWebsiteDispatchTx(t, a1))).toBe("replayed");
    await tx((t) => registry.moveWebsiteJobTx(t, a1, "claimed"));
    const provider = randomUUID();
    await tx((t) => registry.moveWebsiteJobTx(t, a1, "accepted", { providerJobId: provider }));
    await tx((t) => registry.moveWebsiteJobTx(t, b1, "claimed"));
    await expect(tx((t) => registry.moveWebsiteJobTx(t, b1, "accepted", { providerJobId: provider }))).rejects.toMatchObject({ code: "provider_job_conflict" });
    await tx((t) => registry.moveWebsiteJobTx(t, a1, "settled"));
    expect(await tx((t) => registry.registerWebsiteDispatchTx(t, c1))).toBe("registered");
    await tx((t) => registry.moveWebsiteJobTx(t, b1, "released"));
    await tx((t) => registry.moveWebsiteJobTx(t, c1, "released"));
  });
  expect(registry.websiteAccountCapacity()).toEqual({ maxActive: 4, workspaceShare: 2 });
  // Objects on the shared account belong to exactly one workspace.
  await register("soul_one", "soul", "ws_one");
  await register("soul_one", "soul", "ws_one");
  await expect(register("soul_one", "soul", "ws_two")).rejects.toMatchObject({ code: "object_conflict" });
  await expect(register("soul_one", "element", "ws_one")).rejects.toMatchObject({ code: "object_conflict" });
  expect(await registry.websiteObjectOwners(["soul_one", "unknown", "bad id!"])).toEqual(new Map([["soul_one", { kind: "soul", workspaceId: "ws_one" }]]));
});

test("own-account reports never count a platform-funded job", async () => {
  const { jobs, tenant } = await modules();
  const ws = workspace();
  await inside(ws, async () => {
    const { job } = await jobs.createConsumerJob({
      userId: "member", draftId: "draft", workflow: "marketing-video", funding: "platform_account", particlCredits: 9, connectedOwnerId: jobs.PLATFORM_CONNECTED_OWNER,
      connectionGeneration: "g", higgsfieldWorkspaceId: randomUUID(), idempotencyKey: randomUUID(), payload: { input: {} }, quoteCredits: 40,
      quoteExpiresAt: Date.now() + 60_000, originalAssetIds: [],
    });
    expect(await jobs.claimConsumerDispatch({ userId: "member", draftId: "draft", id: job.id }, { meterId: job.meterId! })).toBeTruthy();
    const { getConsumerCreditActivity } = await import("../../lib/higgsfield-consumer/activity");
    const activity = await getConsumerCreditActivity("member");
    // The job is admitted (claimed under its reservation), yet the viewer's own-account report never counts it.
    expect(Object.values(activity.totals).every((total) => (total as { quoteCredits: number }).quoteCredits === 0)).toBe(true);
    expect(activity.projects).toEqual([]);
    void tenant;
  });
});
