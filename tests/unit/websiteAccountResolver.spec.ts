import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { WebsiteJobEntry } from "../../lib/higgsfield-consumer/platform-jobs";

/* Who funds a website job, how a job's grant is resolved, and the
   platform registry that pins a platform job to the account it was admitted
   on. Local databases only; nothing is read from or sent to any account. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-website-resolver-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-website-resolver-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ACCESS = "resolver-access-private-token";
let sequence = 0;
async function modules() {
  return {
    account: await import("../../lib/higgsfield-consumer/platform-account"),
    registry: await import("../../lib/higgsfield-consumer/platform-jobs"),
    funding: await import("../../lib/higgsfield-consumer/funding"),
    access: await import("../../lib/higgsfield-consumer/access"),
    tools: await import("../../lib/higgsfield-consumer/website-tools"),
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    store: await import("../../lib/higgsfield-consumer/store"),
    platform: await import("../../lib/platform"),
    tenant: await import("../../lib/tenant"),
    database: await import("../../lib/db"),
    accountDb: await import("../../lib/accountDb"),
  };
}
type Identity = { workspaceId: string; userId: string };
async function signIn(identity: Identity, subject: string) {
  const { store } = await modules();
  const state = randomBytes(32).toString("base64url"), sessionHash = store.hashConsumerSecret(`session-${identity.userId}`);
  await store.storeAuthorization({ ...identity, state, sessionHash, verifier: randomBytes(32).toString("base64url"), clientId: "https://particl.example/client", redirectUri: "https://particl.example/callback" });
  const authorization = await store.consumeAuthorization(state, { ...identity, sessionHash });
  expect(await store.completeAuthorization(authorization!, {
    accessToken: ACCESS, refreshToken: "resolver-refresh-private", expiresAt: Date.now() + 3_600_000, scope: "openid email offline_access",
    clientId: authorization!.clientId, redirectUri: authorization!.redirectUri,
  }, Date.now(), subject)).toBe(true);
}
/** The platform owner's workspace and connection, designated. */
async function designatedHost() {
  const { platform, account } = await modules();
  await platform.platformReady();
  const n = ++sequence, workspaceId = `ws_resolverhost${n}${randomBytes(3).toString("hex")}`, userId = `acct_resolver_${n}`;
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)",
      args: [workspaceId, workspaceId, `Host ${n}`, `file:${path.join(directory, `${workspaceId}.db`)}`, userId] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,0)", args: [workspaceId, userId] },
  ], "write");
  const subject = sha(`issuer\nhost-${n}`);
  await signIn({ workspaceId, userId }, subject);
  await account.designatePlatformAccount({ workspaceId, userId }, userId);
  const generation = String((await platform.platformDb().execute({ sql: "SELECT generation FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?", args: [workspaceId, userId] })).rows[0].generation);
  return { workspaceId, userId, subject, generation };
}
/** A client workspace: managed (every workspace is), with its own database and one saved project. */
function client(managed = true): TenantWorkspace {
  const id = `ws_client${++sequence}${randomBytes(3).toString("hex")}`;
  return {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: managed, allowanceUsd: null, gatewayKeyId: null, ownerId: "client-owner", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
}
async function inClient<T>(workspace: TenantWorkspace, fn: () => Promise<T>) {
  const { tenant, database } = await modules();
  return tenant.runInTenant(workspace, async () => {
    await database.ready();
    await database.db().execute({
      sql: "INSERT OR IGNORE INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
      args: ["member-draft", "member", "draft", "Client draft", "{}", Date.now()],
    });
    return fn();
  });
}
const meterOf = (workspaceId: string, jobId: string) => `gen_hfc_${sha(JSON.stringify([workspaceId, jobId])).slice(0, 40)}`;
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
/** A quoted platform job in `workspace` (the shape its quote will create), and its registry entry once admitted. */
async function platformJob(workspace: TenantWorkspace, host: Awaited<ReturnType<typeof designatedHost>>) {
  const { jobs } = await modules();
  const idempotencyKey = randomUUID();
  const { job } = await jobs.createConsumerJob({
    userId: "member", draftId: "draft", workflow: "marketing-video", funding: "platform_account", particlCredits: 25,
    connectedOwnerId: jobs.PLATFORM_CONNECTED_OWNER, connectionGeneration: host.generation, higgsfieldWorkspaceId: randomUUID(),
    idempotencyKey, payload: { input: { prompt: "A bottle" } }, quoteCredits: 12, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: [],
  });
  const entry: WebsiteJobEntry = {
    meterId: job.meterId!, workspaceId: workspace.id, jobId: job.id, userId: "member", workflow: "marketing-video", tool: "marketing-video",
    host: { workspaceId: host.workspaceId, userId: host.userId }, subjectHash: host.subject, generation: host.generation,
    websiteCredits: 12, creditUsd: 0.02, particlCredits: 25,
  };
  return { job, entry };
}
async function admit(entry: WebsiteJobEntry, job: { id: string; meterId: string | null }) {
  const { registry, accountDb, jobs } = await modules();
  await registry.websiteJobsReady();
  await accountDb.accountTransaction((tx) => registry.registerWebsiteDispatchTx(tx, entry));
  const claim = await jobs.claimConsumerDispatch({ userId: "member", draftId: "draft", id: job.id }, { meterId: job.meterId! });
  expect(claim).toBeTruthy();
  await accountDb.accountTransaction((tx) => registry.moveWebsiteJobTx(tx, entry, "claimed"));
  const provider = randomUUID();
  const accepted = await jobs.markConsumerAccepted({ userId: "member", draftId: "draft", id: job.id, claimToken: claim!.claimToken, providerJobId: provider });
  await accountDb.accountTransaction((tx) => registry.moveWebsiteJobTx(tx, entry, "accepted", { providerJobId: provider }));
  return { accepted: accepted!, provider };
}

test("the commercial API is always preferred, and a managed workspace is offered only a website tool whose billing is built", async () => {
  const { tools, funding, account, jobs } = await modules();
  expect(tools.websiteToolTransport({ workflow: "genjutsu" })).toEqual({ kind: "commercial_api", route: "studio-engines" });
  expect(tools.websiteToolTransport({ tool: "soul-build" })).toEqual({ kind: "commercial_api", route: "studio-identities" });
  expect(tools.websiteToolTransport({ tool: "element-build" })).toEqual({ kind: "website_account", tool: "element-build" });
  expect(tools.websiteToolTransport({ workflow: "marketing-video" })).toEqual({ kind: "website_account", tool: "marketing-video" });
  expect(tools.websiteToolTransport({ workflow: "voice-tool", voiceTool: "reframe" })).toEqual({ kind: "website_account", tool: "reframe" });
  expect(tools.websiteToolTransport({ workflow: "voice-tool", voiceTool: null })).toEqual({ kind: "none" });
  expect(tools.websiteToolTransport({ workflow: "reference-match" })).toEqual({ kind: "none" });
  // Marketing video is the first whose Particl-credit quote, reservation and settlement are built.
  expect([...tools.WEBSITE_BILLING_READY]).toEqual(["marketing-video"]);
  // Even designated, every tool switched on, priced, and the private rate set.
  const host = await designatedHost();
  await withEnv({ HF_ACCOUNT_CREDIT_USD: "0.02", HF_ACCOUNT_FIXED_CREDITS: JSON.stringify(Object.fromEntries(tools.WEBSITE_TOOL_IDS.map((id) => [id, 5]))) }, async () => {
    await account.setPlatformAccountTools(tools.WEBSITE_TOOL_IDS.filter((id) => !tools.servedByCommercialApi(id)), host.userId);
    await inClient(client(), async () => {
      for (const target of [
        ...(["shorts", "marketing-template", "generation", "virality", "genjutsu", "reference-match"] as const).map((workflow) => ({ workflow })),
        ...["reframe", "voice_change", "dubbing", "video_analysis", "unknown"].map((voiceTool) => ({ workflow: "voice-tool" as const, voiceTool })),
        { tool: "soul-build" as const }, { tool: "element-build" as const },
      ]) {
        await expect(funding.websiteFunding(target)).rejects.toMatchObject({ code: "particl_quote_unavailable", status: 409 });
        expect(await funding.readFunding(target)).toEqual({ kind: "own_account" });
      }
      // The one built tool is offered through the platform's account, and only while the rate is set.
      expect(await funding.websiteFunding({ workflow: "marketing-video" })).toEqual({ kind: "platform_account", tool: "marketing-video" });
      await withEnv({ HF_ACCOUNT_CREDIT_USD: undefined }, async () => {
        await expect(funding.websiteFunding({ workflow: "marketing-video" })).rejects.toMatchObject({ code: "particl_quote_unavailable", status: 409 });
      });
      // The own-account guard of every managed workspace is unchanged.
      expect(() => jobs.requireConsumerFunding()).toThrow(jobs.ConsumerJobError);
    });
  });
  // A workspace on its own account keeps its owner's own connection.
  await inClient(client(false), async () => expect(await funding.websiteFunding({ workflow: "marketing-video" })).toEqual({ kind: "own_account" }));
});

test("the ledger takes a platform job only from a managed workspace, with no person as its connection and its exact client price", async () => {
  const { jobs } = await modules();
  const host = await designatedHost();
  const base = {
    userId: "member", draftId: "draft", workflow: "marketing-video" as const, funding: "platform_account" as const, particlCredits: 25,
    connectedOwnerId: jobs.PLATFORM_CONNECTED_OWNER, connectionGeneration: host.generation,
    higgsfieldWorkspaceId: randomUUID(), payload: { input: {} }, quoteCredits: 12, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: [],
  };
  await inClient(client(false), async () => {
    await expect(jobs.createConsumerJob({ ...base, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "invalid_input" });
  });
  await inClient(client(), async () => {
    for (const bad of [{ connectedOwnerId: "member" }, { particlCredits: 0 }, { particlCredits: 2.5 }, { particlCredits: undefined }, { funding: "someone_else" }])
      await expect(jobs.createConsumerJob({ ...base, ...bad, idempotencyKey: randomUUID() } as never)).rejects.toMatchObject({ code: "invalid_input" });
    // An own-account job is still refused in a managed workspace (unchanged).
    await expect(jobs.createConsumerJob({ ...base, funding: "own_account", connectedOwnerId: "member", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "particl_quote_unavailable" });
    const key = randomUUID();
    const { job } = await jobs.createConsumerJob({ ...base, idempotencyKey: key });
    // Its meter id is its reservation's and its collected original's: derived, never chosen.
    const originals = await import("../../lib/higgsfield-consumer/video-original");
    const ws = (await modules()).tenant.requireTenant().id;
    expect(job).toMatchObject({ funding: "platform_account", particlCredits: 25, meterId: originals.consumerOriginalGenerationId(ws, job.id), connectedOwnerId: "platform", status: "quoted" });
    expect(job.meterId).toBe(meterOf(ws, job.id));
    expect(jobs.ownsConsumerJob(job, "member")).toBe(true);
    expect(jobs.ownsConsumerJob(job, "platform")).toBe(false);
    expect(jobs.ownsConsumerJob({ ...job, funding: "own_account" }, "member")).toBe(false);
    // The same quote replays; a different client price under the same key conflicts.
    expect((await jobs.createConsumerJob({ ...base, idempotencyKey: key })).replayed).toBe(true);
    await expect(jobs.createConsumerJob({ ...base, particlCredits: 26, idempotencyKey: key })).rejects.toMatchObject({ code: "idempotency_conflict" });
    // Only the admission that reserved it, under its own meter id, can claim it; batches never carry one.
    const scope = { userId: "member", draftId: "draft", id: job.id };
    await expect(jobs.claimConsumerDispatch(scope)).rejects.toMatchObject({ code: "particl_quote_unavailable" });
    await expect(jobs.claimConsumerDispatch(scope, { meterId: `gen_hfc_${"b".repeat(40)}` })).rejects.toMatchObject({ code: "particl_quote_unavailable" });
    await expect(jobs.claimConsumerDispatchBatch([scope, scope])).rejects.toMatchObject({ code: "particl_quote_unavailable" });
    expect((await jobs.getConsumerJob(scope))?.status).toBe("quoted");
    const claim = await jobs.claimConsumerDispatch(scope, { meterId: job.meterId! });
    expect(claim?.job.status).toBe("dispatching");
  });
});

test("an admitted platform job is read only through its registry pin; a tampered row or another workspace's pin is refused", async () => {
  const { access, account, registry, accountDb, jobs, platform } = await modules();
  const host = await designatedHost();
  const workspace = client();
  await inClient(workspace, async () => {
    const { job, entry } = await platformJob(workspace, host);
    // Quoted: new spend, so only a designation that can serve now.
    expect(await access.accessForJob(job)).toMatchObject({ accessToken: ACCESS, connectedOwnerId: "platform", funding: "platform_account" });
    await account.setPlatformAccountPaused(true, host.userId);
    await expect(access.accessForJob(job)).rejects.toMatchObject({ code: "website_unavailable", status: 503 });
    await account.setPlatformAccountPaused(false, host.userId);
    const { accepted, provider } = await admit(entry, job);
    // Admitted: the pin, even while paused.
    await account.setPlatformAccountPaused(true, host.userId);
    expect(await access.accessForJob(accepted)).toMatchObject({ accessToken: ACCESS, generation: host.generation });
    await account.setPlatformAccountPaused(false, host.userId);
    const refused = (forged: typeof accepted) => expect(access.accessForJob(forged)).rejects.toMatchObject({ code: "website_unavailable" });
    await refused({ ...accepted, connectionGeneration: randomUUID() });
    await refused({ ...accepted, providerJobId: randomUUID() });
    await refused({ ...accepted, meterId: `gen_hfc_${"c".repeat(40)}` });
    await refused({ ...accepted, userId: "someone-else" });
    await refused({ ...accepted, connectedOwnerId: "member" });
    await refused({ ...accepted, id: randomUUID() });
    expect(accepted.providerJobId).toBe(provider);
    // A different account signed into the host connection can never read it.
    await signIn({ workspaceId: host.workspaceId, userId: host.userId }, sha("issuer\nanother"));
    await refused(accepted);
    await accountDb.accountTransaction((tx) => registry.moveWebsiteJobTx(tx, entry, "settled"));
    void platform; void jobs;
  });
  // The same job id in another workspace has no pin there.
  const other = client();
  await inClient(other, async () => {
    const { job } = await platformJob(other, await designatedHost());
    const forged = { ...job, status: "accepted" as const, providerJobId: randomUUID() };
    await expect(access.accessForJob(forged)).rejects.toMatchObject({ code: "website_unavailable" });
  });
});

test("an own-account job keeps its owner's own connection and pinned generation", async () => {
  const { access, jobs, store } = await modules();
  const workspace = client(false);
  const owner = { workspaceId: workspace.id, userId: "member" };
  await signIn(owner, sha("issuer\nclient-owner"));
  await inClient(workspace, async () => {
    const generation = (await store.claimConsumerAccess(owner)) as { generation: string };
    const { job } = await jobs.createConsumerJob({
      userId: "member", draftId: "draft", workflow: "marketing-video", connectedOwnerId: "member", connectionGeneration: generation.generation,
      idempotencyKey: randomUUID(), payload: { input: {} }, quoteCredits: 3, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: [],
    });
    expect(job).toMatchObject({ funding: "own_account", particlCredits: null, meterId: null });
    expect(await access.accessForJob(job)).toMatchObject({ accessToken: ACCESS, connectedOwnerId: "member", funding: "own_account" });
    await expect(access.accessForJob({ ...job, connectionGeneration: randomUUID() })).rejects.toMatchObject({ code: "connection_changed" });
    expect(access.consumerCacheScope("member", { funding: "own_account", generation: "g1" })).toBe(`${workspace.id}:member:g1`);
    expect(access.consumerCacheScope("member", { funding: "platform_account", generation: "g1" })).toBe(`${workspace.id}:platform:g1`);
  });
});

test("the registry records each admission once, moves one way, and never swaps a provider job", async () => {
  const { registry, accountDb } = await modules();
  await registry.websiteJobsReady();
  const host = await designatedHost();
  const jobId = randomUUID(), workspaceId = "ws_registry";
  const entry: WebsiteJobEntry = {
    meterId: meterOf(workspaceId, jobId), workspaceId, jobId, userId: "member", workflow: "shorts", tool: "shorts",
    host: { workspaceId: host.workspaceId, userId: host.userId }, subjectHash: host.subject, generation: host.generation,
    websiteCredits: 40, creditUsd: 0.02, particlCredits: 9,
  };
  const tx = <T>(fn: Parameters<typeof accountDb.accountTransaction<T>>[0]) => accountDb.accountTransaction(fn);
  expect(await tx((t) => registry.registerWebsiteDispatchTx(t, entry))).toBe("registered");
  expect(await tx((t) => registry.registerWebsiteDispatchTx(t, entry))).toBe("replayed");
  await expect(tx((t) => registry.registerWebsiteDispatchTx(t, { ...entry, particlCredits: 10 }))).rejects.toMatchObject({ code: "registry_conflict" });
  await expect(tx((t) => registry.registerWebsiteDispatchTx(t, { ...entry, meterId: meterOf(workspaceId, "other") }))).rejects.toMatchObject({ code: "registry_conflict" });
  for (const bad of [{ meterId: "gen_bad" }, { subjectHash: "short" }, { particlCredits: 0 }, { creditUsd: 0 }, { tool: "genjutsu" }])
    await expect(tx((t) => registry.registerWebsiteDispatchTx(t, { ...entry, jobId: randomUUID(), ...bad } as WebsiteJobEntry))).rejects.toMatchObject({ code: "invalid_entry" });
  const where = { workspaceId, jobId };
  expect(await tx((t) => registry.moveWebsiteJobTx(t, where, "accepted", { providerJobId: randomUUID() }))).toBe(false);
  expect(await tx((t) => registry.moveWebsiteJobTx(t, where, "claimed"))).toBe(true);
  const provider = randomUUID();
  expect(await tx((t) => registry.moveWebsiteJobTx(t, where, "accepted", { providerJobId: provider.toUpperCase() }))).toBe(true);
  expect(await tx((t) => registry.moveWebsiteJobTx(t, where, "accepted", { providerJobId: provider }))).toBe(true);
  await expect(tx((t) => registry.moveWebsiteJobTx(t, where, "accepted", { providerJobId: randomUUID() }))).rejects.toMatchObject({ code: "provider_job_conflict" });
  expect(await tx((t) => registry.websiteJobsInFlightTx(t, { workspaceId: host.workspaceId, userId: host.userId }))).toBe(1);
  expect(await tx((t) => registry.moveWebsiteJobTx(t, where, "settled"))).toBe(true);
  expect(await tx((t) => registry.moveWebsiteJobTx(t, where, "released"))).toBe(false);
  expect(await registry.websiteJobPin(workspaceId, jobId)).toMatchObject({ state: "settled", providerJobId: provider, particlCredits: 9 });
  expect(await tx((t) => registry.websiteJobsInFlightTx(t, { workspaceId: host.workspaceId, userId: host.userId }))).toBe(0);
  // One dispatch lease across every workspace, until it lapses.
  expect(await registry.takeWebsiteLease("dispatch", "a", 5_000)).toBe(true);
  expect(await registry.takeWebsiteLease("dispatch", "b", 5_000)).toBe(false);
  expect(await registry.releaseWebsiteLease("dispatch", "b")).toBe(false);
  expect(await registry.releaseWebsiteLease("dispatch", "a")).toBe(true);
  expect(await registry.takeWebsiteLease("dispatch", "b", 5_000)).toBe(true);
});

test("moving or releasing the designation while its jobs run needs a confirmation", async () => {
  const { account, registry, accountDb } = await modules();
  const host = await designatedHost();
  const jobId = randomUUID(), workspaceId = "ws_inflight";
  const entry: WebsiteJobEntry = {
    meterId: meterOf(workspaceId, jobId), workspaceId, jobId, userId: "member", workflow: "marketing-video", tool: "marketing-video",
    host: { workspaceId: host.workspaceId, userId: host.userId }, subjectHash: host.subject, generation: host.generation,
    websiteCredits: 10, creditUsd: 0.02, particlCredits: 3,
  };
  await registry.websiteJobsReady();
  await accountDb.accountTransaction((tx) => registry.registerWebsiteDispatchTx(tx, entry));
  await expect(account.releasePlatformAccount(host.userId)).rejects.toMatchObject({ code: "jobs_in_flight", status: 409 });
  expect(await account.isDesignatedIdentity(host)).toBe(true);
  // The same connection again is not a move.
  await account.designatePlatformAccount(host, host.userId);
  // Another connection is a move: refused, then confirmed.
  const { platform } = await modules();
  const n = ++sequence, next = { workspaceId: `ws_nexthost${n}${randomBytes(3).toString("hex")}`, userId: `acct_next_${n}` };
  await platform.platformDb().batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)", args: [next.workspaceId, next.workspaceId, "Next", "file:unused.db", next.userId] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,0)", args: [next.workspaceId, next.userId] },
  ], "write");
  await signIn(next, sha("issuer\nnext"));
  await expect(account.designatePlatformAccount(next, next.userId)).rejects.toMatchObject({ code: "jobs_in_flight" });
  await account.designatePlatformAccount(next, next.userId, Date.now(), { acknowledgeInFlight: true });
  expect(await account.isDesignatedIdentity(next)).toBe(true);
  // Its jobs still resolve through their own pin, not the new designation.
  expect((await registry.websiteJobPin(workspaceId, jobId))?.host).toEqual({ workspaceId: host.workspaceId, userId: host.userId });
  await accountDb.accountTransaction((tx) => registry.moveWebsiteJobTx(tx, { workspaceId, jobId }, "released"));
  await account.releasePlatformAccount(next.userId);
});
