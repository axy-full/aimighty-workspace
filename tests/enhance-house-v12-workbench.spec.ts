import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { removeHouseJobsOf } from "./helpers/houseJobs";
import { signInToRedesign } from "./helpers/newInterface";

/**
 * Enhance in the house workspace (lib/houseWorkspace.ts), which pays in dollars at cost: the switch is there, and with it On the
 * button reads ONE total in dollars, "up to $N" (the take's own dollars plus the text model's estimate for the enhancement), with
 * "Pays at cost" on hover; the press approves the enhancement at its quoted ceiling and the take at its own. Local ENGINE_MOCK
 * server; the house workspace row is made for this test (a person is made its owner) and removed after, as the other specs that
 * need the house do, so it never stays behind to be mistaken for the real one; so are the jobs this test ran in it, which would
 * otherwise count against the house's monthly cap. Nothing real is spent.
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
      try { await removeHouseJobsOf(db, userId); }
      finally {
        await db.execute({ sql: "DELETE FROM memberships WHERE workspace_id = 'ws_legacy'", args: [] });
        await db.execute({ sql: "DELETE FROM workspaces WHERE id = 'ws_legacy'", args: [] });
      }
    }
  } finally { db.close(); }
}

const isEnhanceCall = (r: { url(): string; method(): string; postDataJSON(): unknown }) =>
  new URL(r.url()).pathname === "/api/prompt/enhance" && r.method() === "POST" && (r.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly !== true;
const isGenerate = (r: { url(): string; method(): string }) => new URL(r.url()).pathname === "/api/generate" && r.method() === "POST";
const dollarsOf = (text: string) => Number(text.match(/\$([\d,]+(?:\.\d+)?)/)![1].replace(/,/g, ""));

test("the house has the Enhance switch, priced at cost: one total in dollars, up to, hovered Pays at cost", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const signed = await signInToRedesign(page.request, "House Enhance Tester");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  await withHouse(me.id, async () => {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: "ws_legacy" } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { id: string } }).workspace?.id).toBe("ws_legacy");
    await page.goto("/suites?view=make");
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Image" }).click();
    await page.getByTestId("v12-make-chip-count").click();
    await page.getByRole("menuitem", { name: "1" }).click();
    const toggle = page.getByTestId("v12-make-enhance");
    await expect(toggle, "the house has the switch").toBeVisible({ timeout: 60_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const input = page.getByTestId("v12-make-bar-input");
    const go = page.getByTestId("v12-make-go");
    const price = page.getByTestId("v12-make-price");
    /* Off: the take alone, in its own dollars. */
    await toggle.click();
    await input.fill(WORDS);
    await expect(price).toHaveText(/^\$/, { timeout: 60_000 });
    const takeOnly = dollarsOf(await price.innerText());
    expect(takeOnly).toBeGreaterThan(0);
    /* On: the enhancer's own quote in dollars is added, and the figure is one total, "up to", hovered "Pays at cost". */
    const quoted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/prompt/enhance" && r.request().method() === "POST" && r.request().postDataJSON()?.quoteOnly === true);
    await toggle.click();
    const quote = (await (await quoted).json()) as { estimateCredits: number; estimateUsd: number };
    expect(typeof quote.estimateUsd).toBe("number");
    await expect(price).toHaveText(/^up to \$/, { timeout: 60_000 });
    await expect(price).toHaveAttribute("title", "Pays at cost");
    await expect(go).toContainText("Make");
    expect(await go.innerText()).not.toMatch(/\bcr\b/);
    const total = dollarsOf(await price.innerText());
    expect(total).toBeGreaterThanOrEqual(takeOnly);
    expect(total).toBeCloseTo(takeOnly + quote.estimateUsd, 1);
    /* The press: the enhancer at its quoted ceiling, then the take; the figure on the button was both. */
    const enhanceSent = page.waitForRequest(isEnhanceCall);
    const generateSent = page.waitForRequest(isGenerate);
    const generateAnswered = page.waitForResponse((r) => isGenerate(r.request()));
    await go.click();
    const enhanceBody = (await enhanceSent).postDataJSON() as { maxCredits?: number; prompt?: string };
    expect(enhanceBody.prompt).toBe(WORDS);
    expect(enhanceBody.maxCredits).toBe(quote.estimateCredits);
    const generateBody = (await generateSent).postDataJSON() as { enhanced?: { from: string } | false };
    expect(generateBody.enhanced).toMatchObject({ from: WORDS });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    /* The take is in the house's meter before this test removes it (withHouse). */
    await generateAnswered;
    /* Back to a credit workspace for the next spec. */
    await page.request.post("/api/workspaces/switch", { data: { id: signed.workspace.id } });
  });
});
