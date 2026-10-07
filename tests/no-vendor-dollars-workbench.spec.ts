import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * A workspace on the platform's keys reads credits wherever its spend is drawn, and never a vendor's dollar: not a production's
 * spend, not a project's cap, not a shot's cost. The takes below cost the vendors money the workspace must not see, and their
 * projects carry a dollar cap beside the credit cap. Real local routes on a mock engine; nothing is rendered or paid for.
 * Screenshots are opt-in: NO_VENDOR_DOLLARS_SHOTS=<dir>.
 *
 * Release 1: the Productions list, a deliverable's Shots and Media pages, the project overview and the shot list are gone (their
 * addresses redirect: lib/shell/old-routes.ts). The same rule is asserted where spend is drawn now: Home's project card, the board's
 * Shots region, Settings > Spending rules (the budget and per-shot cap, in credits), Settings > Plan & credits (the ledger's month and its Usage
 * fold) and the month's printable statement with its CSV. The routes the old pages read are held to it in
 * tests/r1-port-credit-units-workbench.spec.ts. (A credit's own dollars, at the served rate, are the workspace's and are allowed:
 * the check is that no vendor amount and no dollar cap is printed.)
 */
const SHOTS = process.env.NO_VENDOR_DOLLARS_SHOTS;
/* What the vendors charged for the seeded takes, and the dollar caps beside the credit ones: a leak would print one of these. */
const VENDOR_USD = [1.339101, 0.512901];
const DOLLAR_CAPS = [55.55, 77.77];

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png`, fullPage: true });
}

async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url); }
  finally { platform.close(); }
}

/** A Studio project (Home's card, the board) over a production project with one shot and two takes the vendors charged for, capped in both units. */
async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  expect(me.rates.unit, "a new workspace pays in credits").toBe("cr");
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const name = `Harbour ${randomUUID().slice(0, 6)}`;
  const project = { ...newProject(name), id: `nvd-${randomUUID().slice(0, 8)}` };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const { productionProjectId: projectId } = (await saved.json()) as { productionProjectId: string };
  const tenant = createClient({ url: await tenantOf(signed.workspace.id), timeout: 10_000 });
  const at = Date.now() - 60_000;
  const shotId = `shot_nvd_${randomUUID().slice(0, 8)}`;
  try {
    await tenant.execute({
      sql: `INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty)
            VALUES (?,?,?,?,?,?,'open',0,?,?,?,5,'{}','[]','render',1)`,
      args: [shotId, projectId, "", "SH010", "Harbour wide", "", me.id, at, at],
    });
    for (const [i, cost] of VENDOR_USD.entries())
      await tenant.execute({
        sql: `INSERT INTO generations(id,project_id,shot_id,kind,model,prompt,params,status,created_by,created_at,updated_at,provider,cost_usd,stored_url,version)
              VALUES(?,?,?,'video','dreamina-seedance-2-5-260628','A harbour at dawn',?,'succeeded',?,?,?,'byteplus',?,'/fixtures/clip.mp4',?)`,
        args: [`gen_margin_${randomUUID().slice(0, 8)}`, projectId, shotId, JSON.stringify({ resolution: "1080p", ratio: "16:9", duration: 5 }), me.id, at + i, at + i, cost, i + 1],
      });
    /* The ledger's own row for a take the vendors charged for (admission's meter: the vendor's cost kept, the credits billed). */
    const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      await platform.execute({
        sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [`gen_meter_${randomUUID().slice(0, 8)}`, signed.workspace.id, "video", "byteplus", "dreamina-seedance-2-5-260628", "succeeded", VENDOR_USD[0], 20, 1, me.id, at, at],
      });
    } finally { platform.close(); }
    /* A dollar cap beside the credit cap: only the credit one is this workspace's. */
    await tenant.execute({ sql: "UPDATE projects SET cap_usd = 55.55, cap_credits = 555 WHERE id = ?", args: [projectId] });
    await tenant.execute({ sql: "UPDATE productions SET cap_usd = 77.77, cap_credits = 777 WHERE id = (SELECT production_id FROM projects WHERE id = ?)", args: [projectId] });
  } finally { tenant.close(); }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  return { project, projectId, scope, name, month: new Date(at).toISOString().slice(0, 7) };
}

/** Any vendor figure or dollar cap in the page's words, however it is printed. */
async function vendorFigures(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  const found: string[] = [];
  for (const usd of [...VENDOR_USD, ...DOLLAR_CAPS]) for (const printed of [usd.toFixed(2), usd.toFixed(3), usd.toFixed(4), usd.toFixed(6)]) if (text.includes(printed)) found.push(printed);
  return found;
}

/** Every dollar figure in one part of the page. */
const dollarsIn = (text: string) => [...text.matchAll(/\$\s?\d[\d,]*(\.\d+)?/g)].map((m) => m[0]);

async function floors(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);
}

test("Home's project card reads credits, never a vendor's dollar", async ({ page }, info) => {
  const { name } = await seeded(page);
  await page.goto("/suites?view=home");
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
  expect(await vendorFigures(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "home");
});

test("the board's Shots region reads credits per shot, never a vendor's dollar", async ({ page }, info) => {
  test.skip((info.project.use.viewport?.width ?? 0) < 1280, "a phone draws no board canvas; its spend is on Settings and the statement below");
  const { project } = await seeded(page);
  await page.goto(`/suites?project=${project.id}&view=board&region=shots`);
  await expect(page.getByTestId("board-canvas")).toBeVisible({ timeout: 60_000 });
  expect(await vendorFigures(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "board-shots");
});

test("Settings › Spending rules reads the budget and cap in credits, never the dollar cap seeded beside the credit one", async ({ page }, info) => {
  const { scope } = await seeded(page);
  /* The page lists the budget and cap as credits; the workspace's budget is set in credits and the seeded dollar caps stay unseen. */
  const set = await page.request.patch("/api/settings", { headers: { "X-Workbench-Scope": scope }, data: { productionBudgetCredits: "777" } });
  expect(set.ok(), await set.text()).toBe(true);
  await page.goto("/suites?view=workspace&tab=rules");
  await expect(page.getByTestId("settings-budget-value")).toContainText("777 cr", { timeout: 60_000 });
  expect(await vendorFigures(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "spending-rules");
});

test("Settings › Plan & credits reads the month and the Usage fold in credits, never a vendor's dollar", async ({ page }, info) => {
  await seeded(page);
  await page.goto("/suites?view=workspace&tab=credits&open=usage");
  await expect(page.getByTestId("settings-month")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("settings-usage-row").first()).toBeVisible({ timeout: 60_000 });
  /* The ledger rows are credits only; the balance's own dollars (a credit's worth at the served rate) sit on the balance row. */
  for (const row of await page.getByTestId("settings-usage-row").all()) expect(dollarsIn(await row.innerText()), "a usage row").toEqual([]);
  expect(dollarsIn(await page.getByTestId("settings-usage-total").innerText())).toEqual([]);
  expect(await vendorFigures(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "plan-and-credits");
});

test("the month's statement itemises the takes in credits, and its CSV has no dollar column and no vendor amount", async ({ page }, info) => {
  const { month } = await seeded(page);
  await page.goto(`/statements/${month}`);
  await expect(page.getByText(/\bcr\b/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("SH010").first()).toBeVisible({ timeout: 60_000 });
  expect(dollarsIn(await page.evaluate(() => document.body.innerText)), "no packs were bought, so no dollar line").toEqual([]);
  expect(await vendorFigures(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "statement");
  const csv = await page.request.get(`/api/statements?month=${month}&format=csv`);
  expect(csv.ok(), await csv.text()).toBe(true);
  const body = await csv.text();
  expect(body.split("\n")[0]).not.toMatch(/usd/i);
  for (const usd of [...VENDOR_USD, ...DOLLAR_CAPS]) expect(body).not.toContain(usd.toFixed(2));
});

test.fixme("the shot list's own Export CSV names spent_credits and has no dollar column (owner question: the shot list page has no new home; its CSV is held at /api/export in tests/r1-port-credit-units-workbench.spec.ts)", async () => {
  /* Was /atomik/shots › Export CSV (lib/shotListCost.ts › moneyColumns still names the columns). Port to the board's Shots region
     when it has an export, or accept the loss. */
});
