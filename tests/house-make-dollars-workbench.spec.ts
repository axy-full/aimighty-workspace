import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { removeHouseJobsOf } from "./helpers/houseJobs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { isCompact } from "./helpers/shellMode";
import { newProject } from "../lib/workbench/studio";

/**
 * Make's price in the unit the workspace pays in (components/graphite/make/price.tsx). The house workspace (lib/houseWorkspace.ts) pays at
 * cost and reads the engine's own dollars: Make's button and engine line read "$…", hovered "Pays at cost", never "Make · —" (which they
 * read while the drawn figure dropped the dollars Make holds). A customer workspace reads credits there, as before, and no dollar. The
 * phone draws this Make; a desktop size frames the phone (`device=phone`), since the house's desktop Make is the new interface's page.
 * Local ENGINE_MOCK server; nothing is pressed, so nothing is sent or spent. The house row is made for this test and removed after.
 */

async function withHouse<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const existing = await db.execute({ sql: "SELECT 1 FROM workspaces WHERE id = 'ws_legacy'", args: [] });
    test.skip(existing.rows.length > 0, "this local deployment already has a house workspace");
    const ts = Date.now();
    await db.execute({ sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at) VALUES ('ws_legacy','house-test','House test','file:house',NULL,1,1,?,?,?)`, args: [userId, ts, ts] });
    await db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES('ws_legacy',?,'owner',0,?)", args: [userId, ts] });
    try { return await run(); }
    finally {
      /* Nothing is pressed here; the house's jobs are cleared anyway, as every spec that makes the house does. */
      try { await removeHouseJobsOf(db, userId); }
      finally {
        await db.execute({ sql: "DELETE FROM memberships WHERE workspace_id = 'ws_legacy'", args: [] });
        await db.execute({ sql: "DELETE FROM workspaces WHERE id = 'ws_legacy'", args: [] });
      }
    }
  } finally { db.close(); }
}

/** A project in `workspaceId`, opened on Make. */
async function openMake(page: Page, workspaceId: string, userId: string, framed: boolean) {
  const scope = `particl-active-${workspaceId}-${userId}`;
  const project = newProject(`Make price ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ key, id }) => { try { localStorage.setItem(key, id); } catch { /* storage off */ } }, { key: scope, id: project.id });
  await page.goto(`/suites?screen=make${framed ? "&device=phone" : ""}`);
  await expect(page.getByTestId("phone-make-go")).toBeVisible({ timeout: 90_000 });
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("Make reads the house's dollars on its button and engine line, and a customer's credits", async ({ page }, info) => {
  test.setTimeout(300_000);
  const framed = !isCompact(info);
  const signed = await signInWithNewInterface(page.request, "Make Price Tester");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  const go = page.getByTestId("phone-make-go");
  const line = page.getByTestId("phone-make-engine-line");

  /* A customer workspace: credits, exactly as before. */
  await openMake(page, signed.workspace.id, me.id, framed);
  await expect(go).toHaveText(/^Make · [\d,.]+ cr$/, { timeout: 90_000 });
  await expect(line).toHaveText(/ · [\d,.]+ cr$/);
  expect(await go.innerText()).not.toMatch(/\$/);
  expect(await noOverflow(page), "customer: sideways overflow").toBe(true);

  await withHouse(me.id, async () => {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: "ws_legacy" } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { id: string } }).workspace?.id).toBe("ws_legacy");
    await openMake(page, "ws_legacy", me.id, framed);
    /* The house: the engine's dollars, never a dash for a take the quote priced, and no credits worded. */
    await expect(go).toHaveText(/^Make · \$\d[\d,]*\.\d\d$/, { timeout: 90_000 });
    /* Make waits for the words, so the button carries the reason; the figure itself says what it is. */
    await expect(go.locator("[data-price]")).toHaveAttribute("title", "Pays at cost");
    await expect(line).toHaveText(/ · \$\d[\d,]*\.\d\d$/);
    expect(await go.innerText()).not.toMatch(/—|\bcr\b/);
    expect(await noOverflow(page), "house: sideways overflow").toBe(true);
    await page.request.post("/api/workspaces/switch", { data: { id: signed.workspace.id } });
  });
});
