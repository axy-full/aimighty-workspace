import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInToRedesign } from "./helpers/newInterface";

/**
 * Enhance in the house workspace (lib/houseWorkspace.ts), which pays in dollars at cost: the Enhance button is there and wears the text model's
 * estimate in dollars ("Enhance · up to $N", "Pays at cost" on hover); pressing it puts the enhanced words in the box and sends no take; Make's own
 * figure is the take alone, and a later Make press sends the box as it is. Local ENGINE_MOCK server; the house workspace row is made for this test
 * (a person is made its owner) and removed after, as the other specs that need the house do, so it never stays behind to be mistaken for the real one.
 * Nothing real is spent.
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
      await db.execute({ sql: "DELETE FROM memberships WHERE workspace_id = 'ws_legacy'", args: [] });
      await db.execute({ sql: "DELETE FROM workspaces WHERE id = 'ws_legacy'", args: [] });
    }
  } finally { db.close(); }
}

const isEnhanceCall = (r: { url(): string; method(): string; postDataJSON(): unknown }) =>
  new URL(r.url()).pathname === "/api/prompt/enhance" && r.method() === "POST" && (r.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly !== true;
const isGenerate = (r: { url(): string; method(): string }) => new URL(r.url()).pathname === "/api/generate" && r.method() === "POST";
const dollarsOf = (text: string) => Number(text.match(/\$([\d,]+(?:\.\d+)?)/)![1].replace(/,/g, ""));

test("the house has the Enhance button, priced at cost in dollars; pressing it fills the box and sends no take; Make is the take alone", async ({ page }, info) => {
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
    const enhance = page.getByTestId("v12-make-enhance");
    await expect(enhance, "the house has the button").toBeVisible({ timeout: 60_000 });
    const input = page.getByTestId("v12-make-bar-input");
    const go = page.getByTestId("v12-make-go");
    const price = page.getByTestId("v12-make-price");
    const quoted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/prompt/enhance" && r.request().method() === "POST" && r.request().postDataJSON()?.quoteOnly === true);
    await input.fill(WORDS);
    const quote = (await (await quoted).json()) as { estimateCredits: number; estimateUsd: number };
    expect(typeof quote.estimateUsd).toBe("number");
    /* Make's figure is the take alone, in its own dollars, and says "Pays at cost". */
    await expect(price).toHaveText(/^\$/, { timeout: 60_000 });
    await expect(price).toHaveAttribute("title", "Pays at cost");
    expect(await go.innerText()).not.toMatch(/\bcr\b/);
    const takeOnly = dollarsOf(await price.innerText());
    /* Enhance wears the text model's estimate in dollars, hovered "Pays at cost", before it is pressed. */
    const figure = page.getByTestId("v12-make-enhance-price");
    await expect(figure).toHaveText(/^\$|^up to \$/, { timeout: 60_000 });
    await expect(figure).toHaveAttribute("title", "Pays at cost");
    expect(await enhance.innerText()).not.toMatch(/\bcr\b/);
    /* The press: the enhancer at its quoted ceiling, and no take. */
    const generates: string[] = [];
    page.on("request", (r) => { if (isGenerate(r)) generates.push(r.url()); });
    const enhanceSent = page.waitForRequest(isEnhanceCall);
    await enhance.click();
    const enhanceBody = (await enhanceSent).postDataJSON() as { maxCredits?: number; prompt?: string };
    expect(enhanceBody.prompt).toBe(WORDS);
    expect(enhanceBody.maxCredits).toBe(quote.estimateCredits);
    await expect(page.getByTestId("v12-make-bar-note")).toContainText("Enhanced", { timeout: 60_000 });
    expect(generates, "nothing was generated by Enhance").toEqual([]);
    /* The take is still its own dollars; the next Make press sends the box, labelled Enhanced from the typed words. */
    await expect(price).toHaveText(/^\$/, { timeout: 60_000 });
    expect(dollarsOf(await price.innerText())).toBeCloseTo(takeOnly, 6);
    const generateSent = page.waitForRequest(isGenerate);
    await go.click();
    const generateBody = (await generateSent).postDataJSON() as { enhanced?: { from: string } | false };
    expect(generateBody.enhanced).toMatchObject({ from: WORDS });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    /* Back to a credit workspace for the next spec. */
    await page.request.post("/api/workspaces/switch", { data: { id: signed.workspace.id } });
  });
});
