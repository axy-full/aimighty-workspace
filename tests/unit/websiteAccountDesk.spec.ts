import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WebsiteJobEntry } from "../../lib/higgsfield-consumer/platform-jobs";
import { websiteAccountFixtures, withEnv } from "../helpers/websiteAccount";

/* Platform desk › Website tools account: what the shared account holds and
   settled lately, in Particl credits, and whether a quote last saw the
   account under its private floor — never its balance, wallet, rate or any
   account identifier. The owner is told at most once a day. Local databases;
   nothing is read from or sent to any account. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-website-desk-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-website-desk-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
globalThis.fetch = (async () => { throw new Error("This spec never contacts the network."); }) as typeof fetch;

const fixtures = websiteAccountFixtures(directory, "desk");
fixtures.isolate();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function modules() {
  return {
    account: await import("../../lib/higgsfield-consumer/platform-account"),
    registry: await import("../../lib/higgsfield-consumer/platform-jobs"),
    billing: await import("../../lib/higgsfield-consumer/account-billing"),
    contract: await import("../../lib/higgsfield-consumer/video-contract"),
    platform: await import("../../lib/platform"),
    accountDb: await import("../../lib/accountDb"),
  };
}

test("the desk sees jobs in flight, lost replies, jobs on an earlier connection and the last 30 days, in Particl credits only", async () => {
  const { account, registry, platform, accountDb } = await modules();
  await registry.websiteJobsReady();
  const before = (await account.platformAccountStatus(null)).exposure;
  const host = await fixtures.designate(["marketing-video"]);
  const designation = (await account.readPlatformDesignation())!;
  const generation = String((await platform.platformDb().execute({ sql: "SELECT generation FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?", args: [host.workspaceId, host.userId] })).rows[0].generation);
  const tx = <T>(fn: Parameters<typeof accountDb.accountTransaction<T>>[0]) => accountDb.accountTransaction(fn);
  const workspaceId = "ws_deskclient_exposure";
  const job = (particlCredits: number, onGeneration = generation): WebsiteJobEntry => {
    const jobId = randomUUID();
    return { meterId: `gen_hfc_${sha(jobId).slice(0, 40)}`, workspaceId, jobId, userId: "member", workflow: "marketing-video", tool: "marketing-video",
      host, subjectHash: designation.subjectHash, generation: onGeneration, websiteCredits: 12, creditUsd: 0.02, particlCredits };
  };
  const where = (entry: WebsiteJobEntry) => ({ workspaceId: entry.workspaceId, jobId: entry.jobId });
  const accept = async (entry: WebsiteJobEntry) => {
    await tx((t) => registry.moveWebsiteJobTx(t, where(entry), "claimed"));
    await tx((t) => registry.moveWebsiteJobTx(t, where(entry), "accepted", { providerJobId: randomUUID() }));
  };
  const receipt = (entry: WebsiteJobEntry, status: "succeeded" | "failed", billed: number) => platform.platformDb().execute({
    sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at)
      VALUES(?,?,'video','higgsfield_account','website:marketing-video',?,?,?,1,?,?)`,
    args: [entry.meterId, entry.workspaceId, status, billed ? 0.24 : 0, billed, Date.now(), Date.now()],
  });
  const reserved = job(7), accepted = job(9), lost = job(11), earlier = job(13, "an-earlier-grant"), collected = job(15), failed = job(17), unsent = job(19);
  for (const entry of [reserved, accepted, lost, earlier, collected, failed, unsent]) await tx((t) => registry.registerWebsiteDispatchTx(t, entry));
  for (const entry of [accepted, earlier, collected, failed]) await accept(entry);
  await tx((t) => registry.moveWebsiteJobTx(t, where(lost), "claimed"));
  await tx((t) => registry.moveWebsiteJobTx(t, where(lost), "uncertain"));
  for (const [entry, status, billed] of [[collected, "succeeded", 15], [failed, "failed", 17], [unsent, "failed", 0]] as const) {
    await receipt(entry, status, billed);
    await tx((t) => registry.moveWebsiteJobTx(t, where(entry), billed ? "settled" : "released"));
  }
  const view = await account.platformAccountStatus(null);
  const now = view.exposure;
  expect({
    inFlight: { jobs: now.inFlight.jobs - before.inFlight.jobs, reserved: now.inFlight.reserved - before.inFlight.reserved },
    unconfirmed: { jobs: now.unconfirmed.jobs - before.unconfirmed.jobs, reserved: now.unconfirmed.reserved - before.unconfirmed.reserved },
    last30Days: {
      collected: now.last30Days.collected - before.last30Days.collected, failedCharged: now.last30Days.failedCharged - before.last30Days.failedCharged,
      charged: now.last30Days.charged - before.last30Days.charged, released: now.last30Days.released - before.last30Days.released,
    },
  }).toEqual({
    inFlight: { jobs: 4, reserved: 7 + 9 + 11 + 13 },
    unconfirmed: { jobs: 1, reserved: 11 },
    // Collected, and failed on the account yet charged as quoted (owner decision); one never sent is released to zero.
    last30Days: { collected: 1, failedCharged: 1, charged: 15 + 17, released: 1 },
  });
  // Only the job on another grant is on an earlier connection (anything in flight from before this designation is too).
  expect(now.earlierConnection.jobs).toBe(before.inFlight.jobs + 1);
  expect(now.capacity).toEqual({ inUse: now.inFlight.jobs, max: 1000, share: 1000 });
  // Particl credits only: no account figure, wallet, rate, grant or identifier.
  const text = JSON.stringify(view);
  expect(text).not.toMatch(/"(credits|price|usd|balance|wallet|token|generation|subject\w*)":/i);
  for (const secret of [generation, "an-earlier-grant", designation.subjectHash, host.userId, host.workspaceId, "0.02"]) expect(text).not.toContain(secret);
});

test("a quote that would leave the account under its floor is refused neutrally; the owner is told once a day, never the balance", async () => {
  const { account, registry, billing, contract } = await modules();
  const sent: { to: string; subject: string; text: string }[] = [];
  const send = async (message: { to: string; subject: string; text: string }) => { sent.push(message); };
  // No floor set: a wallet that covers the price is fine; one that cannot pay it is refused before anyone approves it.
  await withEnv({ HF_ACCOUNT_MIN_WALLET_CREDITS: undefined, RESEND_API_KEY: undefined, MAIL_FROM: undefined }, async () => {
    await billing.guardWebsiteWallet(40, 40, { send });
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(false);
    await expect(billing.guardWebsiteWallet(39, 40, { send })).rejects.toMatchObject({ code: "website_unavailable", reason: "low_balance" });
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(true);
    await billing.guardWebsiteWallet(1000, 40, { send });
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(false);
    expect(sent).toHaveLength(0);
  });
  await withEnv({ HF_ACCOUNT_MIN_WALLET_CREDITS: "100", SUPER_ADMIN_EMAIL: "platform-owner@example.test", RESEND_API_KEY: "unit-test-not-a-key", MAIL_FROM: "Particl <desk@example.test>" }, async () => {
    // At or above the floor after the price: quoted as usual.
    await billing.guardWebsiteWallet(140, 40, { send });
    expect((await account.platformAccountStatus(null)).accountLow).toMatchObject({ low: false, checkedAt: expect.any(Number) });
    // Under it: the one neutral refusal (nothing was sent or charged), the desk says so, and the owner is told.
    await expect(billing.guardWebsiteWallet(139, 40, { send })).rejects.toMatchObject({ code: "website_unavailable", status: 503, reason: "low_balance" });
    const status = await account.platformAccountStatus(null);
    expect(status.accountLow).toMatchObject({ low: true, checkedAt: expect.any(Number) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "platform-owner@example.test", subject: "Website tools: the account is running low" });
    // The owner is told the account is low, never by how much.
    for (const figure of ["139", "140", "100", "99", "40"]) expect(sent[0].text).not.toContain(figure);
    expect(JSON.stringify(status)).not.toMatch(/"(credits|balance|wallet)":/i);
    // Once a day at most.
    await expect(billing.guardWebsiteWallet(10, 40, { send })).rejects.toMatchObject({ code: "website_unavailable" });
    expect(sent).toHaveLength(1);
    expect(await registry.noteWebsiteWallet(true, Date.now() + registry.WEBSITE_WALLET_ALERT_MS + 1)).toEqual({ alertDue: true });
    // A submission the account found short of its price tells the desk too; a job on an owner's own account never does.
    await billing.guardWebsiteWallet(1000, 40, { send });
    await billing.noteWebsiteWalletShort({ funding: "own_account" }, new contract.ConsumerVideoError("insufficient_credits"), { send });
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(false);
    await billing.noteWebsiteWalletShort({ funding: "platform_account" }, new contract.ConsumerVideoError("quote_changed"), { send });
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(false);
    await billing.noteWebsiteWalletShort({ funding: "platform_account" }, new contract.ConsumerVideoError("insufficient_credits"), { send });
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(true);
  });
  // Mail not set up: the desk still says so, and nothing is sent.
  await withEnv({ HF_ACCOUNT_MIN_WALLET_CREDITS: "100", RESEND_API_KEY: undefined, MAIL_FROM: undefined }, async () => {
    // Last told long ago, so a low reading is due to be told again, if mail could carry it.
    await registry.markWebsiteWalletAlerted(Date.now() - 2 * registry.WEBSITE_WALLET_ALERT_MS);
    const count = sent.length;
    await expect(billing.guardWebsiteWallet(50, 40, { send })).rejects.toMatchObject({ code: "website_unavailable" });
    expect(sent).toHaveLength(count);
    expect((await account.platformAccountStatus(null)).accountLow.low).toBe(true);
  });
});
