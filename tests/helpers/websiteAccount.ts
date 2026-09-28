import { test, expect } from "@playwright/test";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { WebsiteToolId } from "../../lib/higgsfield-consumer/website-tools";

/**
 * Fixtures for the platform's designated website account over local
 * databases: a designated host connection, managed client workspaces with
 * credits, and reads of the ledger, registry and recovery intents. The spec
 * sets PLATFORM_DATABASE_URL before calling any of these; nothing here reads
 * an account or sends anything.
 */
/** A synthetic private rate (dollars per account credit), for these fixtures only. */
export const RATE = "0.02";
export const IN_FLIGHT = "('reserved','claimed','accepted','uncertain')";
export const ACCESS_TOKEN = "platform-fixture-token";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

async function modules() {
  return {
    account: await import("../../lib/higgsfield-consumer/platform-account"),
    registry: await import("../../lib/higgsfield-consumer/platform-jobs"),
    store: await import("../../lib/higgsfield-consumer/store"),
    platform: await import("../../lib/platform"),
    tenant: await import("../../lib/tenant"),
    database: await import("../../lib/db"),
    credits: await import("../../lib/credits"),
    terms: await import("../../lib/billingTerms"),
    tools: await import("../../lib/higgsfield-consumer/website-tools"),
    billing: await import("../../lib/higgsfield-consumer/account-billing"),
  };
}

export function websiteAccountFixtures(directory: string, prefix: string) {
  let sequence = 0;
  /** The platform owner's own connected account, designated, with these tools switched on. */
  async function designate(tools: WebsiteToolId[]) {
    const { platform, store, account } = await modules();
    await platform.platformReady();
    const n = ++sequence, host = { workspaceId: `ws_${prefix}host${n}${randomBytes(3).toString("hex")}`, userId: `acct_${prefix}host_${n}` };
    await platform.platformDb().batch([
      { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)",
        args: [host.workspaceId, host.workspaceId, "Host", `file:${path.join(directory, `${host.workspaceId}.db`)}`, host.userId] },
      { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,0)", args: [host.workspaceId, host.userId] },
    ], "write");
    const state = randomBytes(32).toString("base64url"), sessionHash = store.hashConsumerSecret(`session-${prefix}-${n}`);
    await store.storeAuthorization({ ...host, state, sessionHash, verifier: randomBytes(32).toString("base64url"), clientId: "https://particl.example/client", redirectUri: "https://particl.example/callback" });
    const authorization = await store.consumeAuthorization(state, { ...host, sessionHash });
    expect(await store.completeAuthorization(authorization!, {
      accessToken: ACCESS_TOKEN, refreshToken: "platform-fixture-refresh", expiresAt: Date.now() + 3_600_000, scope: "openid email offline_access",
      clientId: authorization!.clientId, redirectUri: authorization!.redirectUri,
    }, Date.now(), sha(`issuer\n${prefix}-host-${n}`))).toBe(true);
    await account.designatePlatformAccount(host, host.userId, Date.now(), { acknowledgeInFlight: true });
    await account.setPlatformAccountTools(tools, host.userId);
    return host;
  }
  /** A managed client workspace with one saved project ("member"'s "draft") and `credits` granted. */
  async function client(credits = 1000, setup?: () => Promise<void>): Promise<TenantWorkspace> {
    const { platform, tenant, database } = await modules();
    await platform.platformReady();
    const id = `ws_${prefix}client${++sequence}${randomBytes(3).toString("hex")}`;
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
      await setup?.();
    });
    return ws;
  }
  /* One worker reuses one platform client across spec files: these hooks keep
     jobs other files left in flight from filling the shared account's caps
     here (a cap test sets its own), and leave the database as found — no
     designation, and none of this file's clients holding the account's capacity. */
  function isolate() {
    const caps = ["HF_ACCOUNT_MAX_ACTIVE", "HF_ACCOUNT_WORKSPACE_SHARE"] as const;
    const before: Partial<Record<(typeof caps)[number], string | undefined>> = {};
    test.beforeEach(() => { for (const key of caps) { before[key] = process.env[key]; process.env[key] = "1000"; } });
    test.afterEach(() => { for (const key of caps) { const value = before[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    test.afterAll(async () => {
      const { account, platform, registry } = await modules();
      const designation = await account.readPlatformDesignation();
      if (designation) await account.releasePlatformAccount(designation.userId, { acknowledgeInFlight: true });
      await registry.websiteJobsReady();
      await platform.platformDb().execute({ sql: `UPDATE website_account_jobs SET state='released' WHERE workspace_id LIKE ? AND state IN ${IN_FLIGHT}`, args: [`ws_${prefix}client%`] });
    });
  }
  return { designate, client, isolate };
}

export async function meterRow(id: string) {
  const { platform } = await modules();
  const row = (await platform.platformDb().execute({ sql: "SELECT status,billed_credits,engine,model FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { ...row } : null;
}
export async function intentState(workspaceId: string, id: string) {
  const { platform } = await modules();
  return (await platform.platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE workspace_id=? AND id=?", args: [workspaceId, id] })).rows[0]?.state ?? null;
}
export async function balance(ws: TenantWorkspace) {
  const { credits } = await modules();
  return (await credits.creditStateFor(ws))!.balance;
}
export async function inFlightNow() {
  const { platform, registry } = await modules();
  await registry.websiteJobsReady();
  return Number((await platform.platformDb().execute(`SELECT COUNT(*) AS n FROM website_account_jobs WHERE state IN ${IN_FLIGHT}`)).rows[0].n);
}
/** The client's price for an account price: at the private rate, through the retail terms. */
export async function priceOf(tool: WebsiteToolId, websiteCredits: number) {
  const { terms, tools, billing } = await modules();
  return terms.creditsAtTerms(websiteCredits * Number(RATE), terms.currentBillingTerms(billing.websiteMeterKind(tool), tools.websiteMeterModel(tool)));
}
