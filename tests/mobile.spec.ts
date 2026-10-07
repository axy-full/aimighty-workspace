import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 0 acceptance (docs/particl-sow-v1.md §6): every route, signed out,
 * at 360×640, 390×844 and 844×390 —
 *   • the document is never wider than the viewport;
 *   • no visible text field is under 16px (iOS zooms into anything smaller);
 *   • every screen renders itself, never the error boundary.
 *
 * The routes are the ones Release 1 serves where they are. The old Make, Library, Rig and Atomik addresses redirect into the
 * shell; the phone's own app (dock, Make sheet, Atomik sheet, Settings) is held by the signed-in phone specs (demo-s10-*, r1-phone-*).
 */

const ROUTES = [
  "/welcome", "/login", "/signup", "/reset",
  "/platform", "/statements/2026-09", "/admin",
  "/policy", "/terms", "/privacy", "/report",
];
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => { /* polling routes never go idle */ });
  await page.waitForTimeout(500);
}

const overflowReport = () => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
    })
    .slice(0, 6)
    .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}@${Math.round(e.getBoundingClientRect().right)}`),
});

const smallFields = () => Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select"))
  .filter((el) => {
    const r = el.getBoundingClientRect();
    const type = (el as HTMLInputElement).type;
    return r.width > 0 && r.height > 0 && !["checkbox", "radio", "range", "hidden", "file"].includes(type);
  })
  .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), size: parseFloat(getComputedStyle(el).fontSize) }))
  .filter((f) => f.size < 16);

for (const route of ROUTES) {
  test.describe(route, () => {
    test("no horizontal overflow", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const m = await page.evaluate(overflowReport);
      expect(m.scrollWidth, `document wider than the viewport on ${route}: ${m.offenders.join(", ") || "no single offender"}`).toBe(m.clientWidth);
    });

    test("no text field under 16px", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const small = await page.evaluate(smallFields);
      expect(small, `fields under 16px on ${route}: ${small.map((f) => `${f.tag}.${f.cls}=${f.size}`).join(", ")}`).toEqual([]);
    });

    // A screen that throws lands on the error boundary, which passes both
    // checks above — so this one says the screen itself has to be there.
    test("shows its screen, not the error boundary", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      await expect(page.getByText(/^This (screen|page) stopped$/)).toHaveCount(0);
    });
  });
}
