import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * A workspace on the platform's keys reads credits on its Productions and
 * Projects pages, and never a dollar figure: not a production's spend, not a
 * deliverable's cap, not a shot's cost. The takes below cost the vendors
 * money the workspace must not see, and their projects carry a dollar cap
 * beside the credit cap. Real local routes on a mock engine; nothing is
 * rendered or paid for. Screenshots are opt-in: NO_VENDOR_DOLLARS_SHOTS=<dir>.
 */
const SHOTS = process.env.NO_VENDOR_DOLLARS_SHOTS;
/* What the vendors charged for the seeded takes: a leak would print one of these. */
const VENDOR_USD = [1.339101, 0.512901];

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

/** A production with one deliverable, one shot and two takes the vendors charged for, capped in both units. */
async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  expect(me.rates.unit, "a new workspace pays in credits").toBe("cr");
  const name = `Harbour ${randomUUID().slice(0, 6)}`;
  const made = await page.request.post("/api/projects", { data: { name } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const projectId = ((await made.json()) as { id: string }).id;
  const shotMade = await page.request.post("/api/shots", { data: { projectId, code: "SH010", title: "Harbour wide", planned: 5 } });
  expect(shotMade.ok(), await shotMade.text()).toBeTruthy();
  const shotId = ((await shotMade.json()) as { shot: { id: string } }).shot.id;
  const tenant = createClient({ url: await tenantOf(signed.workspace.id), timeout: 10_000 });
  const at = Date.now() - 60_000;
  try {
    for (const [i, cost] of VENDOR_USD.entries())
      await tenant.execute({
        sql: `INSERT INTO generations(id,project_id,shot_id,kind,model,prompt,params,status,created_by,created_at,updated_at,provider,cost_usd,stored_url,version)
              VALUES(?,?,?,'video','dreamina-seedance-2-5-260628','A harbour at dawn',?,'succeeded',?,?,?,'byteplus',?,'/fixtures/clip.mp4',?)`,
        args: [`gen_margin_${randomUUID().slice(0, 8)}`, projectId, shotId, JSON.stringify({ resolution: "1080p", ratio: "16:9", duration: 5 }), me.id, at + i, at + i, cost, i + 1],
      });
    /* A dollar cap beside the credit cap: only the credit one is this workspace's. */
    await tenant.execute({ sql: "UPDATE projects SET cap_usd = 55.55, cap_credits = 555 WHERE id = ?", args: [projectId] });
    await tenant.execute({ sql: "UPDATE productions SET cap_usd = 77.77, cap_credits = 777 WHERE id = (SELECT production_id FROM projects WHERE id = ?)", args: [projectId] });
  } finally { tenant.close(); }
  const productions = await page.request.get("/api/productions").then((r) => r.json());
  const production = (productions.productions as { id: string; projects: { id: string }[] }[]).find((p) => p.projects.some((x) => x.id === projectId))!;
  return { projectId, productionId: production.id, name };
}

/** Every dollar figure the page shows, and any vendor figure however it is printed. */
async function dollars(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  const found = [...text.matchAll(/\$\s?\d[\d,]*(\.\d+)?/g)].map((m) => m[0]);
  for (const usd of VENDOR_USD) for (const printed of [usd.toFixed(2), usd.toFixed(3), usd.toFixed(4)]) if (text.includes(printed)) found.push(printed);
  return found;
}

async function floors(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);
}

test("the Productions list reads credits, never a vendor's dollar", async ({ page }, info) => {
  const { name } = await seeded(page);
  await page.goto("/productions");
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\bcr\b/).first()).toBeVisible();
  expect(await dollars(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "productions");
});

test("a deliverable's Shots and Media pages read credits, never a vendor's dollar", async ({ page }, info) => {
  const { projectId, productionId, name } = await seeded(page);
  for (const tab of ["shots", "media"] as const) {
    await page.goto(`/productions/${productionId}/${projectId}/${tab}`);
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/\bcr\b/).first()).toBeVisible();
    expect(await dollars(page), tab).toEqual([]);
    await floors(page);
    await shot(page, info, `deliverable-${tab}`);
  }
});

test("the project overview reads credits, never a vendor's dollar", async ({ page }, info) => {
  const { projectId, name } = await seeded(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\bcr\b/).first()).toBeVisible();
  expect(await dollars(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "project");
});

test("the shot list reads credits per shot, and its CSV has no dollar column", async ({ page }, info) => {
  const { projectId } = await seeded(page);
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), projectId);
  await page.goto("/atomik/shots");
  await expect(page.getByText("SH010").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/SPENT · FROM PARTICL/)).toBeVisible();
  expect(await dollars(page)).toEqual([]);
  await floors(page);
  await shot(page, info, "shot-list");
  const csv = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export CSV/ }).click();
  const file = await (await csv).path();
  const body = readFileSync(file, "utf8");
  const header = body.split("\n")[0];
  expect(header).toContain("spent_credits");
  expect(header).not.toMatch(/usd/i);
  for (const usd of VENDOR_USD) expect(body).not.toContain(usd.toFixed(2));
});
