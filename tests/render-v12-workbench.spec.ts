import { test, expect, type Page } from "@playwright/test";
import { openShotsBoard, BATCH_ROWS, landShot, type ShotRow } from "./helpers/shotsV12";

/**
 * Render cards in the new interface (redesign P3; docs/redesign/inventory.md § 7, docs/redesign/cancel-billing.md, plan decisions
 * 8 and 9) on the Shots grid, over C1's render-state model: the source blurred and dimmed under a slow field of dots, the
 * stages In queue → Preparing → Rendering → Saving, the time on one line, the bar to about 90% and no further, the money once,
 * Cancel only where nothing is billed, slow without red, failed with Retry; and for a batch, the stage's "3 of 8 ready ·
 * about 4 min left", the board tab's ring, the toast and the tab title when a take lands, and the opt-in notice.
 * Desktop with the switch on; phones keep today's phone board. Seeded rows only: nothing is generated or spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const shots = (page: Page) => page.locator('.bd-node[data-card-kind="take"]');
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const KLING = "fal-ai/kling-video/v3/standard";

async function closeDock(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
}
const box = (loc: ReturnType<Page["locator"]>) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; });
const stageOf = (page: Page, n: number) => shots(page).nth(n).getByTestId("v12-render-stage");

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("a batch: every stage in its words, the time on one line, the bar capped, the money once, no gap, Cancel only where nothing is billed", async ({ page }) => {
    const { errors } = await openShotsBoard(page, "/suites?view=board&stage=shots", { rows: BATCH_ROWS });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);

    /* The stage header: the batch, in its words. */
    await expect(page.getByTestId("v12-stage-meta")).toHaveText(/^3 of 8 ready · about \d+ (min|s) left$/, { timeout: 30_000 });

    /* Stages. The label may take a beat to settle while the typical times and the line load. */
    await expect(stageOf(page, 3)).toHaveText("Saving");
    await expect(stageOf(page, 4)).toHaveText("Rendering");
    await expect(stageOf(page, 5)).toHaveText("Preparing");
    await expect(stageOf(page, 6)).toHaveText(/^In queue/);
    await expect(stageOf(page, 7)).toHaveText(/^In queue · position \d+$/);

    /* Finished takes can be approved while the others render. */
    await shots(page).nth(0).getByTestId("take-approve").click();
    await expect(shots(page).nth(0).getByTestId("take-approve")).toHaveText("Approved", { timeout: 30_000 });

    /* The time on ONE line, cut with an ellipsis rather than wrapped; the full words are its tooltip. */
    for (const n of [3, 4, 5, 6, 7]) {
      const line = shots(page).nth(n).getByTestId("v12-render-line");
      const style = await line.evaluate((el) => { const c = getComputedStyle(el); return { ws: c.whiteSpace, ov: c.textOverflow, h: el.getBoundingClientRect().height, lh: parseFloat(c.lineHeight) || 16 }; });
      expect(style.ws).toBe("nowrap");
      expect(style.ov).toBe("ellipsis");
      expect(style.h).toBeLessThanOrEqual(style.lh + 1);
      expect(await line.getAttribute("title")).toMatch(/usually .* · (\d+:\d\d so far|not started)/);
    }
    await expect(shots(page).nth(4).getByTestId("v12-render-line")).toHaveText(/^Kling 3\.0 · 1–2 min · \d+:\d\d$/);

    /* The bar fills toward 90% and never past it; Saving holds at the cap. */
    for (const n of [3, 4, 5, 6, 7]) {
      const now = Number(await shots(page).nth(n).getByTestId("v12-render-bar").getAttribute("aria-valuenow"));
      expect(now).toBeGreaterThan(0);
      expect(now).toBeLessThanOrEqual(90);
    }
    await expect(shots(page).nth(3).getByTestId("v12-render-bar")).toHaveAttribute("data-hold", "");

    /* Money, once per card, from the ledger's reservation or its own words: never a literal in the page's code. */
    for (const n of [3, 4, 5, 6]) await expect(shots(page).nth(n).getByTestId("v12-render-money")).toHaveCount(1);

    /* Particles never over text: the field and the text block never share a pixel. */
    for (const n of [3, 4, 5, 6, 7]) {
      const field = await box(shots(page).nth(n).getByTestId("v12-render-field"));
      const text = await box(shots(page).nth(n).getByTestId("v12-render-text"));
      expect(field.b, `card ${n + 1}: the field ends where the text begins`).toBeLessThanOrEqual(text.y + 1);
    }

    /* Cancel: only on the take held for a slot (nothing was sent or reserved). Never on Preparing, Rendering or Saving, or one in a provider's queue. */
    await expect(page.getByTestId("v12-render-cancel")).toHaveCount(1);
    await expect(shots(page).nth(7).getByTestId("v12-render-cancel")).toBeVisible();
    /* Esc never cancels. */
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-render-cancel")).toHaveCount(1);
    await shots(page).nth(7).getByTestId("v12-render-cancel").click();
    await expect(page.getByTestId("v12-toast")).toContainText("Cancelled · nothing billed · the frame stays", { timeout: 30_000 });
    await expect(page.getByTestId("v12-render-cancel")).toHaveCount(0, { timeout: 30_000 });

    /* One size, 4 across, one gap: finished and rendering cards mix with no empty canvas. */
    const b = await shots(page).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height) }; }));
    expect(new Set(b.map((x) => x.h)).size).toBe(1);
    const ys = [...new Set(b.map((x) => x.y))].sort((p, q) => p - q);
    expect(ys).toHaveLength(2);
    expect(ys[1] - ys[0] - b[0].h).toBe(24);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("slow: past twice the typical time it says so in words, in no red; a failed take says it didn't finish and offers Retry", async ({ page }) => {
    const rows: (ShotRow | null)[] = [
      { status: "running", kind: "video", model: KLING, ageS: 600 },
      { status: "failed", kind: "video", model: KLING, ageS: 300, error: "The engine did not finish this take." },
      null, null, null, null, null, null,
    ];
    const { errors } = await openShotsBoard(page, "/suites?view=board&stage=shots", { rows });
    await expect(shots(page).nth(0)).toBeVisible({ timeout: 90_000 });
    await closeDock(page);
    const slow = shots(page).nth(0);
    await expect(slow.getByTestId("v12-render-line")).toHaveText("Taking longer than usual · still working");
    await expect(slow.getByTestId("v12-render-line")).toHaveAttribute("title", "Taking longer than usual — the provider is slow right now. Still working; you won’t be charged twice.");
    await expect(slow.locator(".v12-rc-stage")).toHaveAttribute("data-tone", "blue");
    await expect(slow.getByTestId("v12-render-bar")).toHaveAttribute("data-hold", "");
    expect(await slow.getByTestId("v12-render-bar").getAttribute("aria-valuenow")).toBe("90");
    /* The wait is not a failure: nothing in the overlay is red. */
    const reds = await slow.locator(".v12-rc *").evaluateAll((els) => els.filter((el) => /255, 69, 58|255, 105, 97/.test(getComputedStyle(el).color + getComputedStyle(el).backgroundColor)).length);
    expect(reds).toBe(0);

    const failed = shots(page).nth(1);
    await expect(failed.getByTestId("v12-render-stage")).toHaveText("Didn’t finish");
    await expect(failed.getByTestId("take-failed")).toBeVisible();
    await expect(failed.getByTestId("take-retry")).toBeVisible();
    await expect(failed.getByTestId("v12-render-field")).toHaveCount(0);
    await expect(failed.getByTestId("v12-render-cancel")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("reduced motion: the dots stand still and the bar's shimmer is gone", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openShotsBoard(page, "/suites?view=board&stage=shots", { rows: BATCH_ROWS });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    const dot = shots(page).nth(4).locator(".v12-rc-field i").first();
    await expect(dot).toBeAttached();
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    expect(await shots(page).nth(3).locator(".v12-rc-bar > span").evaluate((el) => getComputedStyle(el, "::after").display)).toBe("none");
  });

  test("a take that lands: the toast with View (bottom-centre), the tab title, the dots gathering; the tab shows a ring while work runs", async ({ page }) => {
    const rows: (ShotRow | null)[] = [{ status: "succeeded" }, { status: "running", kind: "video", model: KLING, ageS: 40 }, null, null, null, null, null, null];
    const { errors, workspaceId } = await openShotsBoard(page, "/suites?view=board&stage=shots", { rows });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    await expect(stageOf(page, 1)).toHaveText("Rendering", { timeout: 30_000 });
    /* The board's tab: a ring (its share of the running work), with the time left in its tooltip. */
    await expect(page.getByTestId("v12-tab-ring")).toBeVisible({ timeout: 30_000 });
    expect(await page.title()).not.toMatch(/ready/);
    await landShot(workspaceId, 2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("particl:jobs", { detail: { id: "gshot2" } })));
    const toast = page.getByTestId("v12-toast");
    await expect(toast).toContainText("Shot 2 is ready", { timeout: 60_000 });
    await expect(page.getByTestId("v12-toast-action")).toHaveText("View");
    const at = await box(toast);
    const view = page.viewportSize()!;
    expect(Math.abs(at.x + at.w / 2 - view.width / 2)).toBeLessThan(view.width * 0.35);
    expect(at.y).toBeGreaterThan(view.height / 2);
    await expect.poll(() => page.title()).toMatch(/^\(1 ready\) /);
    /* View: the card is selected, and the title no longer counts it. */
    await page.getByTestId("v12-toast-action").click();
    await expect(shots(page).nth(1)).toHaveAttribute("data-selected", "true");
    await expect.poll(() => page.title()).not.toMatch(/ready/);
    expect(errors).toEqual([]);
  });

  test("Tell me when it's done: offered once, on the first take past a minute; the browser is asked only on the press", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __asked: number; __made: string[] };
      w.__asked = 0; w.__made = [];
      class Fake { static permission = "default"; constructor(title: string) { w.__made.push(title); } static requestPermission() { w.__asked += 1; Fake.permission = "granted"; return Promise.resolve("granted"); } }
      Object.defineProperty(window, "Notification", { value: Fake, configurable: true });
    });
    const rows: (ShotRow | null)[] = [{ status: "running", kind: "video", model: KLING, ageS: 90 }, null, null, null, null, null, null, null];
    await openShotsBoard(page, "/suites?view=board&stage=shots", { rows });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    const ask = page.getByTestId("v12-notify-ask");
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask).toContainText("This one takes a few minutes.");
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
    await page.getByTestId("v12-notify-tell").click();
    await expect(page.getByTestId("v12-toast")).toContainText("We’ll tell you when it’s done · browser notification");
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
    await expect(ask).toHaveCount(0);
    await page.reload();
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId("v12-notify-ask")).toHaveCount(0);
  });

  test("switch off: today's cards, with none of it", async ({ page }) => {
    await openShotsBoard(page, "/suites?view=board", { on: false, rows: BATCH_ROWS });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await expect(page.getByTestId("v12-render")).toHaveCount(0);
    await expect(page.getByTestId("v12-tab-ring")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("today's phone board: none of the new render cards, no sideways scroll", async ({ page }) => {
    const { errors } = await openShotsBoard(page, "/suites?view=board", { rows: BATCH_ROWS });
    await expect(page.locator("[data-phone], [data-testid='phone-app']").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-render")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
