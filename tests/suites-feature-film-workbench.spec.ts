import { test, expect, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { featureProject } from "./helpers/featureProject";

/**
 * Owner, 23 September: raise the project limits for feature films. A feature's
 * project — 180 scenes, 900 shots, 2,700 assets, 900 Rig shots, a 900-shot cut,
 * about 4.4 MB — loads into every Production page and saves an edit, through
 * the real routes: gzipped on the way up and on the way down.
 */
async function seed(page: Page, rig: boolean) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = featureProject(`Feature ${Date.now().toString(36)}`, { rig });
  /* A first save links the production; every frame and take is then a real generation row in it, as the save verifies. */
  const first = await page.request.put("/api/workbench/projects", { headers, data: { project: { ...project, assets: [], nodes: [], shots: [], production: undefined }, revision: 0 } });
  expect(first.ok(), await first.text()).toBe(true);
  const production = String((await first.json()).productionProjectId);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  platform.close();
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const now = Date.now();
    await tenant.batch(project.assets.map((asset) => ({ sql: "INSERT OR IGNORE INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at) VALUES(?,?,'feature-test','feature test','{}','succeeded',?,?)", args: [asset.id, production, now, now] })), "write");
  } finally { tenant.close(); }
  const body = JSON.stringify({ project: { ...project, productionProjectId: production }, revision: 1 });
  expect(body.length).toBeGreaterThan(3_500_000);
  const saved = await page.request.put("/api/workbench/projects", { headers: { ...headers, "Content-Type": "application/json", "X-Particl-Body-Encoding": "gzip" }, data: gzipSync(body) });
  expect(saved.ok(), await saved.text()).toBe(true);
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json()));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const puts: Record<string, string>[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/workbench/projects") && request.method() === "PUT") puts.push(request.headers()); });
  return { project, headers, read, errors, puts };
}

test("a feature film's project loads on every Production page and saves an edit", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run");
  test.setTimeout(240_000);
  const { project, headers, read, errors, puts } = await seed(page, true);

  /* The load comes back gzipped. */
  const raw = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { ...headers, "Accept-Encoding": "gzip" } });
  expect(raw.headers()["content-encoding"]).toBe("gzip");
  expect((await raw.json()).project.nodes).toHaveLength(900);


  await page.goto(`/suites?suite=studio&page=brief&sp=beats&project=${project.id}`);
  await expect(page.getByTestId("beats-counts")).toHaveText("180 scenes · 540 beats · 900 shots", { timeout: 60_000 });
  await page.getByTestId("beat-scene").first().click();
  await page.getByLabel("Shot 1.1 description").fill("Wide: the fox on the ice, the hut's lamp far off — feature cut");
  await page.getByTestId("beat-close").click();
  await expect.poll(async () => (await read()).project.production.beats.scenes[0].shots[0].description, { timeout: 30_000 }).toBe("Wide: the fox on the ice, the hut's lamp far off — feature cut");
  expect(puts.some((h) => h["x-particl-body-encoding"] === "gzip")).toBe(true);
  expect((await read()).project.nodes).toHaveLength(900);

  for (const [pageId, sp, probe] of [["boards", "", "boards-stage"], ["rig", "", "rig-list"], ["takes", "", "edit-takes"]] as const) {
    await page.goto(`/suites?suite=studio&page=${pageId}${sp ? `&sp=${sp}` : ""}&project=${project.id}`);
    await expect(page.getByTestId(probe)).toBeVisible({ timeout: 60_000 });
  }
  await expect(page.getByTestId("project-name")).toHaveText(project.name);
  expect(errors).toEqual([]);
});

test("the Rig builds a shot for every storyboard frame of a feature and saves them", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run");
  test.setTimeout(240_000);
  const { project, read, errors, puts } = await seed(page, false);
  await page.route(/\/api\/workbench\/engines\?/, (route) => route.fulfill({ json: { models: [], credits: 12 } }));
  await page.goto(`/suites?suite=studio&page=rig&project=${project.id}`);
  const list = page.getByTestId("rig-list");
  await list.getByTestId("rig-from-boards").click();
  /* 900 shots: the list keeps only a window of them in the page (SOW §5); the last one arrives by scrolling. */
  const shots = list.getByRole("list", { name: "Shots" });
  await expect(shots).toHaveAttribute("data-virtual", "on", { timeout: 60_000 });
  const last = list.getByText("180.5 — The fox on the ice, 180.5");
  for (let i = 0; i < 40 && !(await last.count()); i++) {
    await shots.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      const scrolls = (n: HTMLElement) => ["auto", "scroll"].includes(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1;
      while (node && !scrolls(node)) node = node.parentElement;
      const scroller = node ?? document.scrollingElement!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(100);
  }
  await expect(last).toBeVisible();
  expect(await shots.locator(".pxw-rig-row").count()).toBeLessThan(80);
  await expect.poll(async () => (await read()).project.nodes.length, { timeout: 60_000 }).toBe(1800);
  const nodes = (await read()).project.nodes as { x: number; y: number; boardShotId?: string }[];
  expect(nodes.filter((n) => n.boardShotId)).toHaveLength(900);
  expect(nodes.every((n) => n.y <= 20000 && n.x <= 20000)).toBe(true);
  expect(puts.at(-1)?.["x-particl-body-encoding"]).toBe("gzip");
  expect(errors).toEqual([]);
});
