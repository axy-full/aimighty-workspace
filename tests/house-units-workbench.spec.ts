import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInToRedesign } from "./helpers/newInterface";
import { newProject } from "../lib/workbench/studio";

/*
 * One screen, one unit (owner, 13 Oct). The house workspace pays at cost, in dollars: on its board (the bar's Ask line, the Atomik panel's asks, the plan card's step
 * prices and its sentence) every price reads "$N.NN", two decimals rounded up, and none reads "cr". A customer workspace reads credits everywhere, and no dollar.
 * Run with UNITS_OUT=<dir> to also write the screenshots the PR shows.
 */

const OUT = process.env.UNITS_OUT || "";
async function withHouse<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const existing = await db.execute({ sql: "SELECT 1 FROM workspaces WHERE id = 'ws_legacy'", args: [] });
    test.skip(existing.rows.length > 0, "already a house");
    const ts = Date.now();
    await db.execute({ sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at) VALUES ('ws_legacy','house-test','House test','file:house',NULL,1,1,?,?,?)`, args: [userId, ts, ts] });
    await db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES('ws_legacy',?,'owner',0,?)", args: [userId, ts] });
    try { return await run(); }
    finally {
      await db.execute({ sql: "DELETE FROM memberships WHERE workspace_id = 'ws_legacy'", args: [] });
      await db.execute({ sql: "DELETE FROM workspaces WHERE id = 'ws_legacy'", args: [] });
    }
  } finally { db.close(); }
}

/** Every line of the page that carries a price: a dollar figure or a credit figure. */
async function priceLines(page: Page): Promise<string[]> {
  return (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter((l) => /\bcr\b|\$\d/.test(l));
}

test("the board reads one unit: dollars at cost in the house, credits in a customer workspace", async ({ page }, info) => {
  /* The board bar and the Atomik panel are the desktop work surface; a phone shows the same board with fewer prices, and still never two units. */
  const desktop = /1440x900|1920x1080/.test(info.project.name);
  test.setTimeout(300_000);
  /* UNITS_VIEWPORT=1280x800 reads the same board at another desktop size (the PR's screenshots). */
  const custom = /^(\d+)x(\d+)$/.exec(process.env.UNITS_VIEWPORT ?? "");
  if (custom) await page.setViewportSize({ width: Number(custom[1]), height: Number(custom[2]) });
  const size = custom ? `${custom[1]}x${custom[2]}` : info.project.name.replace("workbench-", "");
  if (OUT) mkdirSync(OUT, { recursive: true });
  const signed = await signInToRedesign(page.request, "Units Tester");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  const look = async (label: "customer" | "house", wsId: string) => {
    const scope = `particl-active-${wsId}-${me.id}`;
    const project = { ...newProject(`Units ${label}`), brief: "A short film about a harbour." };
    const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    const { productionProjectId } = await saved.json() as { productionProjectId: string };
    await page.addInitScript(({ scope: key, id }) => { try { localStorage.setItem(key, id); } catch { /* storage off */ } }, { scope, id: project.id });
    await page.goto(`/suites?project=${project.id}&view=board`);
    if (desktop) await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    /* The bar's Ask line and the Atomik panel's asks load their own quotes. */
    if (desktop) await expect.poll(async () => (await priceLines(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    else await page.waitForTimeout(4000);
    const board = await priceLines(page);
    /* A price with no dollar figure reads a dash: the house has none on this board. */
    expect(await page.locator("[data-price]").filter({ hasText: /^—$/ }).count(), `${label}: no price reads a dash`).toBe(0);
    if (OUT) await page.screenshot({ path: `${OUT}/${label}-board-${size}.png` });
    /* A real plan on the mock planner: ask, build (free), then the plan prices every render. */
    const headers = { "X-Workbench-Scope": scope };
    const post = (data: Record<string, unknown>) => page.request.post("/api/workbench/team-canvas", { headers, data: { productionId: productionProjectId, ...data } });
    const run = async () => ((await (await page.request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}&agent=1`, { headers })).json()) as { agent: { run: { id: string; state: string; proposal: { fingerprint: string } | null } | null } }).agent.run;
    const asked = await post({ action: "agent.plan", projectId: project.id, requestId: `req-${Date.now().toString(36)}-${label}`, goal: "Two shots on the pier.", limit: 500 });
    expect(asked.status()).toBe(202);
    await expect.poll(async () => (await run())?.state, { timeout: 40_000 }).toBe("awaiting_approval");
    await post({ action: "agent.approve", runId: (await run())!.id, fingerprint: (await run())!.proposal!.fingerprint });
    await expect.poll(async () => (await run())?.state, { timeout: 60_000 }).toBe("needs_you");
    await page.goto(`/suites?project=${project.id}&view=board`);
    if (desktop) await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    if (desktop) await expect.poll(async () => (await priceLines(page)).some((l) => /ready to render/.test(l)), { timeout: 60_000 }).toBe(true);
    else await page.waitForTimeout(4000);
    const plan = await priceLines(page);
    expect(await page.locator("[data-price]").filter({ hasText: /^—$/ }).count(), `${label}: no price on the plan reads a dash`).toBe(0);
    if (OUT) await page.screenshot({ path: `${OUT}/${label}-plan-${size}.png` });
    return { board, plan };
  };

  const customer = await look("customer", signed.workspace.id);
  for (const line of [...customer.board, ...customer.plan]) {
    expect(line, "a customer workspace reads credits only").toMatch(/\bcr\b/);
    expect(line, "a customer workspace never reads a dollar").not.toMatch(/\$\d/);
  }

  await withHouse(me.id, async () => {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: "ws_legacy" } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { id: string } }).workspace?.id).toBe("ws_legacy");
    const house = await look("house", "ws_legacy");
    if (desktop) expect(house.board.length, "the board bar and the Atomik panel show prices").toBeGreaterThan(0);
    for (const line of [...house.board, ...house.plan]) {
      expect(line, "the house reads dollars only").not.toMatch(/\bcr\b/);
      for (const figure of line.match(/\$[\d,]+(?:\.\d+)?/g) ?? []) expect(figure, `${line}: dollars to two decimals`).toMatch(/^\$[\d,]+\.\d{2}$/);
    }
    await page.request.post("/api/workspaces/switch", { data: { id: signed.workspace.id } });
  });
});
