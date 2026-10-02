import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

/**
 * The Higgsfield sign-in is gone (CLAUDE.md ground rule 10), on the real local
 * server and its real routes, with the owner's account ledger seeded as earlier
 * work left it. The account's routes are gone: nothing prices, starts, reads or
 * signs in to the account, whatever is asked. What the owner made there still
 * reads: their approved quotes in Workspace › Usage (a job still open there was
 * never collected, and says so) and on the /usage Higgsfield tab, through the
 * one account route left, the credit history's read. Workspace › Engines has no
 * account row. The account's own UI is gone: Gen has no account catalogue,
 * identities, Analysis or takes left on the account, and no page asks the
 * account anything. Nothing reaches the account: ENGINE_MOCK is on.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const MIN = 60_000;

async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url); }
  finally { platform.close(); }
}

/** The owner's ledger as earlier work left it: one job stuck unconfirmed, one sent and never collected, one finished. */
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

test("the owner's account history still reads on the real routes — its quotes in Usage and on /usage — while every other account route is gone", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { workspace } = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner: boolean };
  expect(me.owner, "the owner's own workspace").toBe(true);
  const headers = { "X-Workbench-Scope": workbenchScopeFor(workspace.id, me.id) };
  await seedLedger(page, workspace.id, me.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  /* The account's routes are gone on the real server, whatever is asked: no price, start, read, sign-in or way back. */
  for (const route of ["generation", "genjutsu", "video", "marketing-templates", "shorts", "audio-tools", "connection", "connect", "client", "capabilities", "qualification", "analysis-qualification", "callback"]) {
    const read = await page.request.get(`/api/higgsfield/consumer/${route}?draftId=draft-1&code=c&state=s`, { headers, maxRedirects: 0 });
    expect(read.status(), `GET ${route}`).toBe(404);
    const write = await page.request.post(`/api/higgsfield/consumer/${route}`, { headers, data: { action: "quote", draftId: "draft-1" }, maxRedirects: 0 });
    expect([404, 405], `POST ${route}`).toContain(write.status());
  }
  /* The one account route left: the signed-in person's own credit history, read from the ledger. */
  const history = await page.request.get("/api/higgsfield/consumer/activity", { headers });
  expect(history.status()).toBe(200);
  expect(await history.json()).toMatchObject({ creditUnit: "higgsfield_credits", scope: "own_account", totals: { completed: { jobs: 1, quoteCredits: 75 } } });

  /* Engines: no account row, even with jobs still open in the ledger. */
  await page.goto("/suites?view=workspace&tab=engines");
  await expect(page.getByTestId("ws-engines")).toBeVisible();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await noSideScroll(page);

  /* Usage: the owner's connected-account jobs, apart, in that provider's credits as quoted. */
  await page.goto("/suites?view=workspace&tab=usage");
  const connected = page.getByTestId("ws-ledger-connected");
  await expect(connected.getByTestId("ws-ledger-connected-row")).toHaveCount(3);
  await expect(connected).toContainText("3 jobs · 127.5 connected cr quoted");
  /* A job still open in the ledger was never collected, and nothing collects it now: said so, and nothing more. */
  await expect(connected.getByTestId("ws-ledger-connected-row").filter({ hasText: "Not collected" })).toHaveCount(2);
  await expect(connected.getByTestId("ws-ledger-connected-row").filter({ hasText: "Completed" })).toHaveCount(1);
  await noSideScroll(page);

  /* The /usage Higgsfield tab: the approved quote commitments, from the same ledger. */
  await page.goto("/usage");
  await page.getByRole("button", { name: "My connected-account activity", exact: true }).click();
  const panel = page.getByRole("region", { name: "My connected-account activity", exact: true });
  for (const [label, credits] of [["Completed", 75], ["Pending", 40.5], ["Uncertain", 12]] as const)
    await expect(panel.locator(".management-stat").filter({ has: page.getByText(label, { exact: true }) })).toContainText(`${credits} connected credits`);
  expect(errors).toEqual([]);
});

test("Gen and its model sheet show none of the account's UI and ask the account nothing, the owner's own included", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { workspace } = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner: boolean };
  expect(me.owner, "the owner's own workspace").toBe(true);
  /* Jobs the shell's collector used to follow are still open in the ledger: nothing reads them from a page now. */
  await seedLedger(page, workspace.id, me.id);
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/higgsfield/consumer/")) asked.push(`${request.method()} ${url.pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 30_000 });
  /* The outputs and Edit: no Analysis. */
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab")).toHaveText(["Video", "Images", "Audio", "Edit"]);
  for (const id of ["gen-tab-analysis", "gen-resumed", "gen-resumed-jump", "gen-identity", "gen-connection-retry", "gen-enhanced-on-account", "gen-ref-role", "gen-prompt-only"])
    await expect(page.getByTestId(id), id).toHaveCount(0);
  /* This workspace's credits, and its Studio engines only: no catalogue to switch to. */
  await expect(page.getByText(/^Charged to .+’s credits\.$/)).toBeVisible();
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await expect(sheet.getByTestId("gen-sheet-catalogue")).toHaveText("Studio engines");
  await expect(sheet.getByRole("tablist", { name: "Catalogue" })).toHaveCount(0);
  await expect(sheet).not.toContainText(/connected cr|Higgsfield catalogue/);
  await noSideScroll(page);
  await page.keyboard.press("Escape");

  expect(asked, "nothing asks the account, not even for a list of saved jobs").toEqual([]);
  expect(errors).toEqual([]);
});
