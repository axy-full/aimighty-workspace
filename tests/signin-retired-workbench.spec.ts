import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

/**
 * The Higgsfield sign-in is retired (lib/higgsfield-consumer/retired.ts), on
 * the real local server and its real routes, with the owner's account ledger
 * seeded as earlier work left it. Every request for new work on the account
 * is refused with one plain answer, whatever it carries. What the owner made
 * there still reads: the jobs still running hold their slots on Workspace ›
 * Engines, where a stuck one can be set aside; their approved quotes are in
 * Workspace › Usage and on the /usage Higgsfield tab. Nothing reaches the
 * account: this workspace holds no grant, and ENGINE_MOCK is on.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const RETIRED = "Particl no longer signs in to Higgsfield. Past results stay in your Library.";
const MIN = 60_000;

async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url); }
  finally { platform.close(); }
}

/** The owner's ledger as earlier work left it: one job stuck unconfirmed (past its grace), one still rendering, one finished. */
async function seedLedger(page: Page, workspaceId: string, userId: string) {
  expect((await page.request.get("/api/usage?rows=connected")).ok()).toBe(true); // its table exists once read
  const tenant = createClient({ url: await tenantOf(workspaceId), timeout: 10_000 });
  const now = Date.now();
  const jobs = { stuck: randomUUID(), open: randomUUID(), done: randomUUID() };
  try {
    for (const [id, workflow, status, credits, age] of [[jobs.stuck, "generation", "uncertain", 12, 40 * MIN], [jobs.open, "genjutsu", "accepted", 40.5, 3 * MIN], [jobs.done, "generation", "completed", 75, 25 * MIN]] as const)
      await tenant.execute({
        sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,dispatch_claim_hash,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, userId, "draft-gone", userId, "gen", workflow, `k_${id}`, "{}", "h", "h", credits, now - age + 5 * MIN, "[]", status, "claim", now - age, now - age],
      });
  } finally { tenant.close(); }
  return jobs;
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

test("the owner's account history still reads on the real routes — running jobs on Engines (a stuck one set aside), their quotes in Usage and on /usage — while every new-work request is refused", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const { workspace } = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner: boolean };
  expect(me.owner, "the owner's own workspace").toBe(true);
  const headers = { "X-Workbench-Scope": workbenchScopeFor(workspace.id, me.id) };
  const jobs = await seedLedger(page, workspace.id, me.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  /* New work is refused on the real server, whatever the body carries; nothing is priced, started or read from the account. */
  const refusals: [string, Record<string, unknown>][] = [
    ["generation", { action: "quote", draftId: "draft-1" }], ["generation", { action: "catalogue" }], ["generation", { action: "submit-batch" }],
    ["generation", { action: "characters-create" }], ["generation", { action: "elements" }], ["genjutsu", { action: "submit" }],
    ["video", { action: "setup" }], ["marketing-templates", { action: "catalogue" }], ["shorts", { action: "presets" }],
    ["audio-tools", { action: "voices" }], ["connection", { action: "developer-probe" }],
  ];
  for (const [route, body] of refusals) {
    const response = await page.request.post(`/api/higgsfield/consumer/${route}`, { headers, data: body });
    expect(response.status(), `${route} ${String(body.action)}`).toBe(410);
    expect(await response.json()).toEqual({ code: "retired", error: RETIRED });
  }
  for (const [method, path] of [["POST", "/api/higgsfield/consumer/connect"], ["GET", "/api/higgsfield/consumer/client"], ["POST", "/api/higgsfield/consumer/capabilities"], ["POST", "/api/higgsfield/consumer/qualification"], ["GET", "/api/atomik/recipes"]] as const) {
    const response = method === "GET" ? await page.request.get(path, { headers }) : await page.request.post(path, { headers, data: {} });
    expect(response.status(), path).toBe(410);
  }
  /* A sign-in coming back from before the retirement is never finished: it is sent to Engines where the
     deployment has its https origin, and answered with the plain refusal where it has none (this local server). */
  const callback = await page.request.get("/api/higgsfield/consumer/callback?code=c&state=s", { maxRedirects: 0 });
  if (callback.status() === 303) expect(callback.headers().location).toMatch(/\/suites\?view=workspace&tab=engines&higgsfield=retired$/);
  else {
    expect(callback.status()).toBe(410);
    expect(await callback.json()).toEqual({ code: "retired", error: RETIRED });
  }

  /* Engines: the two jobs still holding slots; the stuck one, past its grace, can be set aside. No grant is held, so no Disconnect. */
  await page.goto("/suites?view=workspace&tab=engines");
  const card = page.getByTestId("engine-connected-account");
  await expect(card).toContainText("Sign-in retired");
  await expect(page.getByTestId("connected-account-retired")).toHaveText(RETIRED);
  await expect(page.getByTestId("connected-account-disconnect")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /Connect|Reconnect/ })).toHaveCount(0);
  await expect(page.getByTestId("connected-account-capacity")).toContainText("2 of 4 job slots in use");
  const rows = page.getByTestId("connected-account-job");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Generate · Untitled project");
  await expect(rows.nth(0)).toContainText("unconfirmed");
  await expect(rows.nth(1)).toContainText("Transform · Untitled project");
  await expect(rows.nth(1).getByRole("button", { name: "Set aside" })).toHaveCount(0);
  const aside = rows.nth(0).getByRole("button", { name: "Set aside" });
  if (phone) expect(Math.round((await aside.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await noSideScroll(page);
  await aside.click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("connected-account-capacity")).toContainText("1 of 4 job slots in use");
  /* Set aside in the ledger only: the job is still there, with its status and quote. */
  const tenant = createClient({ url: await tenantOf(workspace.id), timeout: 10_000 });
  try {
    const row = (await tenant.execute({ sql: "SELECT status, quote_credits, released_at FROM higgsfield_consumer_jobs WHERE id=?", args: [jobs.stuck] })).rows[0];
    expect(row).toMatchObject({ status: "uncertain", quote_credits: 12 });
    expect(Number(row.released_at)).toBeGreaterThan(0);
  } finally { tenant.close(); }

  /* Usage: the owner's connected-account jobs, apart, in that provider's credits as quoted. */
  await page.goto("/suites?view=workspace&tab=usage");
  const connected = page.getByTestId("ws-ledger-connected");
  await expect(connected.getByTestId("ws-ledger-connected-row")).toHaveCount(3);
  await expect(connected).toContainText("3 jobs · 127.5 connected cr quoted");
  await noSideScroll(page);

  /* The /usage Higgsfield tab: the approved quote commitments, from the same ledger. */
  await page.goto("/usage");
  await page.getByRole("button", { name: "My connected-account activity", exact: true }).click();
  const panel = page.getByRole("region", { name: "My connected-account activity", exact: true });
  for (const [label, credits] of [["Completed", 75], ["Pending", 40.5], ["Uncertain", 12]] as const)
    await expect(panel.locator(".management-stat").filter({ has: page.getByText(label, { exact: true }) })).toContainText(`${credits} connected credits`);
  expect(errors).toEqual([]);
});
