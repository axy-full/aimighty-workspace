import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { removeHouseJobsOf } from "./helpers/houseJobs";
import { signInToRedesign } from "./helpers/newInterface";

/**
 * Make in the house workspace (lib/houseWorkspace.ts), which pays in dollars at cost: the press goes through at the price shown. The
 * figure on the button is the engine's dollars; the figure the dispatch gate compares with the fresh quote is the same dollars counted in
 * credits at no margin (never the rate card's credits, which carry the customer margin: that mismatch stopped every press with "The
 * price is now N cr"). Local ENGINE_MOCK
 * server; the house workspace row is made for this test (a person is made its owner) and removed after, as the other specs that
 * need the house do, so it never stays behind to be mistaken for the real one; so is the take this test ran in it, which would otherwise
 * count against the house's monthly cap. Nothing real is spent.
 */
const WORDS = "A paper kite over a grey sea";
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];

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
      /* The press sends a take in the house: its jobs go with the house, or the cap spec reads them. */
      try { await removeHouseJobsOf(db, userId); }
      finally {
        await db.execute({ sql: "DELETE FROM memberships WHERE workspace_id = 'ws_legacy'", args: [] });
        await db.execute({ sql: "DELETE FROM workspaces WHERE id = 'ws_legacy'", args: [] });
      }
    }
  } finally { db.close(); }
}

const isGenerate = (r: { url(): string; method(): string }) => new URL(r.url()).pathname === "/api/generate" && r.method() === "POST";

test("the house's Make press goes through at the price shown: no repricing, no credits worded, one take sent", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const signed = await signInToRedesign(page.request, "House Make Tester");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  await withHouse(me.id, async () => {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: "ws_legacy" } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { id: string } }).workspace?.id).toBe("ws_legacy");
    await page.goto("/suites?view=make");
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Image" }).click();
    await page.getByTestId("v12-make-chip-count").click();
    await page.getByRole("menuitem", { name: "1" }).click();
    /* Enhance is On by default (the house has it too: tests/enhance-house-v12-workbench.spec.ts); this is the take alone. */
    const toggle = page.getByTestId("v12-make-enhance");
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    await toggle.click();
    await page.getByTestId("v12-make-bar-input").fill(WORDS);
    const price = page.getByTestId("v12-make-price");
    await expect(price).toHaveText(/^\$/, { timeout: 60_000 });
    await expect(price).toHaveAttribute("title", "Pays at cost");
    const sent = page.waitForRequest(isGenerate);
    const answered = page.waitForResponse((r) => isGenerate(r.request()));
    await page.getByTestId("v12-make-go").click();
    const generate = (await sent).postDataJSON() as { maxCredits?: number };
    expect(typeof generate.maxCredits).toBe("number");
    expect(await page.locator("body").innerText()).not.toMatch(/The price is now/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    /* The take is in the house's meter before this test removes it (withHouse). */
    await answered;
    await page.request.post("/api/workspaces/switch", { data: { id: signed.workspace.id } });
  });
});
