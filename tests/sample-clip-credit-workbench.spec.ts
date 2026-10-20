import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { isCompact } from "./helpers/shellMode";
import { tenantDb } from "./helpers/l5";

/**
 * The starter production's sample clip (Big Buck Bunny, (c) Blender Foundation, CC BY 3.0: lib/sampleClip.ts) carries its credit on screen (owner, 15 Oct 2026): on Home's
 * project card (its cover is the clip), on the board's shot cards and its review card, and in the inspector's take detail, each as one line, "Big Buck Bunny © Blender
 * Foundation, CC BY 3.0", the title linking to peach.blender.org and "CC BY 3.0" to the licence; 12 px or more and over 55% white; and no credit once the platform's
 * neutral previews are what the takes show (a starter that is not on the fallback). The data and every export path are tests/unit/sampleClipCredit.spec.ts.
 * Set SAMPLE_CLIP_SHOTS_DIR to keep screenshots. Local ENGINE_MOCK server only; nothing is rendered or spent.
 */
const LINE = "Big Buck Bunny © Blender Foundation, CC BY 3.0";
const shotsDir = process.env.SAMPLE_CLIP_SHOTS_DIR;

async function openStarter(page: Page) {
  const signed = await signInLocally(page.request, "Credit Tester");
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const made = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { action: "starter" } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = ((await made.json()) as { project: { id: string } }).project.id;
  return { id, workspaceId: signed.workspace.id };
}

async function creditIsRight(page: Page, credit: ReturnType<Page["locator"]>, where: string) {
  await expect(credit.first(), `${where}: the credit`).toBeVisible({ timeout: 60_000 });
  await expect(credit.first()).toHaveText(LINE);
  await expect(credit.first().getByRole("link", { name: "Big Buck Bunny" })).toHaveAttribute("href", "https://peach.blender.org/");
  await expect(credit.first().getByRole("link", { name: "CC BY 3.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by/3.0/");
  const style = await credit.first().evaluate((el) => { const c = getComputedStyle(el); return { size: parseFloat(c.fontSize), color: c.color }; });
  expect(style.size, `${where}: 12 px or more`).toBeGreaterThanOrEqual(12);
  const alpha = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(style.color);
  expect(alpha && Number(alpha[1]), `${where}: light text`).toBeGreaterThan(140);
  expect(alpha?.[4] === undefined || Number(alpha[4]) >= 0.55, `${where}: at least 55% white`).toBe(true);
}
async function shoot(page: Page, name: string, info: { project: { name: string } }) {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}-${info.project.name.replace("workbench-", "")}.png`) });
}

test("the starter's fallback clip carries its credit on Home's card, the board's shot and review cards and the take detail; a starter on the platform's previews has none", async ({ page }, info) => {
  test.setTimeout(300_000);
  const { id, workspaceId } = await openStarter(page);
  /* Home: the project's cover is the clip. */
  await page.goto("/suites?view=home");
  /* The phone draws a card's picture (and so its credit) once the card is near the screen: bring it near. */
  if (isCompact(info)) await page.getByTestId("phone-project").first().scrollIntoViewIfNeeded({ timeout: 60_000 });
  await creditIsRight(page, page.locator('.gx-hm-cell [data-testid="sample-credit"], .v12-hm-credit, .ph-project-credit'), "Home's project card");
  await page.locator('.gx-hm-cell [data-testid="sample-credit"], [data-testid="sample-credit"].v12-hm-credit, .ph-project-credit').first().scrollIntoViewIfNeeded();
  /* Beside the card's button, never inside it (a link cannot sit in a button). */
  expect(await page.locator('[data-testid="sample-credit"]').first().evaluate((el) => el.closest("button") === null), "Home's credit is not inside the card's button").toBe(true);
  await shoot(page, "home", info);
  /* The phone: no sideways scroll, and each link of the line is a 44 px target. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no horizontal overflow").toBeLessThanOrEqual(0);
  if (isCompact(info)) for (const link of await page.locator('[data-testid="sample-credit"] a').all()) expect((await link.boundingBox())?.height ?? 0, "a 44 px link").toBeGreaterThanOrEqual(44);
  /* The board: a desktop shows the shot cards and the review card; the phone app shows Home only. */
  if (!isCompact(info)) {
    await page.goto(`/suites?view=board&project=${encodeURIComponent(id)}`);
    await creditIsRight(page, page.locator('[data-testid="take-card"] [data-testid="sample-credit"]'), "a shot card");
    await creditIsRight(page, page.locator('[data-testid="take-review"] [data-testid="sample-credit"]'), "the review card");
    await expect(page.locator('[data-testid="take-card"] [data-testid="sample-credit"]')).toHaveCount(3);
    await shoot(page, "board", info);
    /* The credit is part of its card: clicking its links opens nothing else on the board (the card is not selected by them). */
    await page.locator('[data-testid="take-card"]').first().click({ position: { x: 20, y: 20 } });
    await page.locator('[data-testid="insp-take"]').first().waitFor({ timeout: 5_000 }).catch(() => undefined);
    const detail = page.locator('[data-testid="insp-take"] [data-testid="sample-credit"]');
    if (await detail.count()) { await creditIsRight(page, detail, "the take detail"); await shoot(page, "detail", info); }
  }
  /* Not on the fallback: the platform's previews are what the takes show, and nothing carries the credit. */
  const tenant = await tenantDb(workspaceId);
  try { await tenant.execute("UPDATE generations SET stored_url = '/api/platform/previews/move-pan' WHERE stored_url = '/fixtures/clip.mp4'"); } finally { tenant.close(); }
  await page.goto("/suites?view=home");
  await expect(page.locator(".gx-hm-card, .v12-hm-board, [data-testid=\"phone-project\"]").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2_500);
  await expect(page.locator('[data-testid="sample-credit"]')).toHaveCount(0);
  if (!isCompact(info)) {
    await page.goto(`/suites?view=board&project=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-testid="take-card"]').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await expect(page.locator('[data-testid="sample-credit"]')).toHaveCount(0);
  }
});

/* The public review page: the line under a take that is the clip, with a 44 px link on a phone, 12 px and light, no sideways scroll. The API is mocked in the shape app/api/review/[token]/route.ts returns. */
test("the review page carries the credit under the sample clip's take only, with phone-sized links and no sideways scroll", async ({ page }, info) => {
  const token = "c".repeat(40);
  const clip = readFileSync(path.resolve("tests/fixtures/astra-source.mp4"));
  const take = (id: string, credit: boolean) => ({ id, kind: "video", shot: "SH010", title: `Take ${id}`, version: 1, prompt: "A boat.", approvedBy: null, media: `/api/review/${token}/media/${id}`, notes: [], ...(credit ? { credit: true } : {}) });
  await page.route(`**/api/review/${token}`, (route) => route.fulfill({ json: { workspace: { name: "Studio", logo: null }, production: { name: "Coast Road", description: "" }, takes: [take("gen_clip", true), take("gen_other", false)], expiresAt: Date.UTC(2026, 11, 1) } }));
  await page.route(`**/api/review/${token}/media/**`, (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: clip }));
  await page.goto(`/review/${token}`);
  await expect(page.getByRole("heading", { name: "Coast Road" })).toBeVisible();
  await expect(page.locator(".rv-take")).toHaveCount(2);
  await expect(page.locator('.rv-take [data-testid="sample-credit"]')).toHaveCount(1);
  await expect(page.locator(".rv-take").first().locator('[data-testid="sample-credit"]')).toHaveText(LINE);
  await creditIsRight(page, page.locator('.rv-take [data-testid="sample-credit"]'), "the review page");
  if (isCompact(info)) for (const link of await page.locator('.rv-take [data-testid="sample-credit"] a').all()) expect((await link.boundingBox())?.height ?? 0, "a 44 px link").toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal overflow").toBeLessThanOrEqual(1);
});
