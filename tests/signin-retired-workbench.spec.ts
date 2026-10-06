import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { workbenchScopeFor } from "../lib/workbench/request-scope";
import { newProject } from "../lib/workbench/studio";

/**
 * Release 1 has no feature that needs a Higgsfield sign-in
 * (lib/higgsfield-consumer/retired.ts › SIGN_IN_OFF), on the real local server
 * and its real routes, for the workspace owner, with the owner's account
 * ledger seeded as earlier work left it (jobs still open on a project).
 *
 * Every account route refuses, whatever it is asked, status reads, saved
 * lists, the connection, Set aside, Disconnect and the credit history
 * included; the old sign-in return address lands on Settings › Connections.
 * No page asks the account anything: the shell's collector is off, Settings ›
 * Connections and Engines have no connected-account row, /usage has no
 * connected-account tab, and Shorts is no page. What the owner made earlier is
 * history only: Workspace › Usage still lists it. ENGINE_MOCK is on and this
 * workspace holds no grant.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const RETIRED = { code: "retired", error: "The connected account is no longer used. Past results stay in your Library." };
const MIN = 60_000;

async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url); }
  finally { platform.close(); }
}

/** The owner's ledger as earlier work left it, on the open project: one job unconfirmed, one still rendering, one finished. */
async function seedLedger(page: Page, workspaceId: string, userId: string, draftId: string) {
  expect((await page.request.get("/api/usage?rows=connected")).ok()).toBe(true); // its table exists once read
  const tenant = createClient({ url: await tenantOf(workspaceId), timeout: 10_000 });
  const now = Date.now();
  try {
    for (const [workflow, status, credits, age] of [["generation", "uncertain", 12, 40 * MIN], ["genjutsu", "accepted", 40.5, 3 * MIN], ["generation", "completed", 75, 25 * MIN]] as const) {
      const id = randomUUID();
      await tenant.execute({
        sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,dispatch_claim_hash,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, userId, draftId, userId, "gen", workflow, `k_${id}`, "{}", "h", "h", credits, now - age + 5 * MIN, "[]", status, "claim", now - age, now - age],
      });
    }
  } finally { tenant.close(); }
}
/** Settings' own sections (Connections) or the Workspace tabs (Engines, Usage), whichever the shell draws for the address. */
const settingsOrWorkspace = (page: Page) => page.getByTestId("settings-view").or(page.getByTestId("workspace-view")).first();
async function noSideScroll(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${where}: no horizontal page scroll`).toBeLessThanOrEqual(1);
}

test("no feature needs a Higgsfield sign-in: every account route refuses, and no page offers, shows or asks the connected account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { workspace } = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner: boolean };
  expect(me.owner, "the owner's own workspace").toBe(true);
  const headers = { "X-Workbench-Scope": workbenchScopeFor(workspace.id, me.id) };
  const project = newProject("Harbour night shoot");
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await seedLedger(page, workspace.id, me.id, project.id);

  /* Warm the shell once (a cold dev server compiles on first paint), then watch every request from here on. */
  await page.goto("/suites");
  await expect(page.locator("body")).toBeVisible();
  const asked: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/higgsfield/consumer/") || url.hostname.endsWith("higgsfield.ai")) asked.push(`${request.method()} ${url.pathname}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));

  /* The real routes refuse everything, on every method, whatever the body carries. */
  const status = { draftId: project.id, id: randomUUID() };
  const posts: [string, Record<string, unknown>][] = [
    ["generation", { action: "status", ...status }], ["generation", { action: "check-batch", draftId: project.id, ids: [randomUUID()] }], ["generation", { action: "quote", draftId: project.id }],
    ["genjutsu", { action: "status", ...status }], ["genjutsu", { action: "submit" }], ["video", { action: "status", ...status }], ["video", { action: "setup" }],
    ["marketing-templates", { action: "status", ...status }], ["shorts", { action: "status", ...status }], ["audio-tools", { action: "status", ...status }],
    ["connection", { action: "set-aside", id: randomUUID() }], ["connection", { action: "developer-probe" }],
    ["connect", {}], ["capabilities", {}], ["qualification", {}], ["analysis-qualification", {}],
  ];
  for (const [route, body] of posts) {
    const response = await page.request.post(`/api/higgsfield/consumer/${route}`, { headers, data: body });
    expect(response.status(), `POST ${route} ${String(body.action ?? "")}`).toBe(410);
    expect(await response.json()).toEqual(RETIRED);
  }
  for (const route of ["generation", "genjutsu", "video", "marketing-templates", "shorts", "audio-tools", "connection", "activity", "client"]) {
    const response = await page.request.get(`/api/higgsfield/consumer/${route}?draftId=${project.id}`, { headers });
    expect(response.status(), `GET ${route}`).toBe(410);
    expect(await response.json()).toEqual(RETIRED);
  }
  const disconnect = await page.request.delete("/api/higgsfield/consumer/connection", { headers });
  expect(disconnect.status(), "Disconnect").toBe(410);
  /* An old sign-in return lands on Settings › Connections, with nothing in the address to say why. */
  const callback = await page.request.get("/api/higgsfield/consumer/callback?code=c&state=s", { maxRedirects: 0 });
  expect(callback.status()).toBe(303);
  expect(callback.headers().location).toMatch(/\/suites\?view=workspace&tab=connections$/);

  /* The open project, with the owner's account jobs still open in the ledger: nothing lists or reads them. */
  await page.goto(`/suites?project=${encodeURIComponent(project.id)}`);
  await expect(page.locator("body")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await noSideScroll(page, "the open project");

  /* Settings › Connections and Workspace › Engines: no connected-account row. */
  for (const tab of ["connections", "engines"]) {
    await page.goto(`/suites?view=workspace&tab=${tab}`);
    await expect(settingsOrWorkspace(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("settings-earlier-account")).toHaveCount(0);
    await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
    await expect(page.getByTestId("connected-account-disconnect")).toHaveCount(0);
    await expect(page.getByText(/Connect Higgsfield|Higgsfield account|Sign-in retired|Earlier connected account/i)).toHaveCount(0);
    await noSideScroll(page, tab);
  }
  /* The return address itself, followed: Settings › Connections, no message. */
  await page.goto("/api/higgsfield/consumer/callback?code=c&state=s");
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("connections");
  await expect(settingsOrWorkspace(page)).toBeVisible();
  await expect(page.getByText(/sign-in|connected account/i)).toHaveCount(0);

  /* History stays history: Workspace › Usage still lists what ran on the account, read from Particl's own ledger. */
  await page.goto("/suites?view=workspace&tab=usage");
  await expect(page.getByTestId("ws-ledger-connected").getByTestId("ws-ledger-connected-row")).toHaveCount(3);
  await noSideScroll(page, "usage");

  /* /usage: no connected-account tab. */
  await page.goto("/usage");
  await expect(page.locator('[aria-label="Usage views"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /connected-account/i })).toHaveCount(0);
  await noSideScroll(page, "/usage");

  /* Shorts is no page: its old addresses open the suite's first page. */
  await page.goto(`/subatomik?project=${encodeURIComponent(project.id)}&page=shorts&shell=legacy`);
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).not.toBe("shorts");
  await expect(page.getByText(/Shorts is retired/)).toHaveCount(0);

  /* Only this spec's own direct calls reached the account routes; no page asked anything. */
  const own = new Set([...posts.map(([route]) => `POST /api/higgsfield/consumer/${route}`), "GET /api/higgsfield/consumer/callback"]);
  expect(asked.filter((call) => !own.has(call))).toEqual([]);
  expect(errors).toEqual([]);
});
