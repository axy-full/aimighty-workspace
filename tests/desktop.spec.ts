import { test, expect, type Page } from "@playwright/test";

/**
 * Desktop acceptance (brief rule 7, revised 8 September 2026).
 *
 * The product is used at a desk. The phone suite is the floor; this is the
 * shape. What it checks that emulation on a phone can never catch:
 *
 *   • prose stays readable. A page that is wide because it is a dashboard
 *     will run a paragraph to two hundred characters a line if nothing stops
 *     it, and nothing did.
 *   • one dark ground, even on a light machine.
 *
 * Signed out, like the phone suite, so it needs no fixtures. The routes are the ones Release 1 serves where they are (the old
 * Make, Library, Rig and Atomik addresses redirect into the shell, which the signed-in specs and r1-old-pages cover).
 */

const ROUTES = [
  "/welcome", "/login", "/signup", "/reset",
  "/policy", "/terms", "/privacy",
];

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => { /* polling routes never go idle */ });
  await page.waitForTimeout(400);
}

/**
 * Characters per line, measured rather than guessed.
 *
 * The obvious shortcut is width / (fontSize / 2), and it is wrong by enough to
 * matter: in this app's face a `ch` is about 0.65em, so that formula reports a
 * correctly capped 78ch paragraph as 102 and fails it. A probe carrying the
 * element's own font gives the real figure, which is also the unit the cap in
 * globals.css is written in.
 */
const proseReport = () => Array.from(document.querySelectorAll("p"))
  .filter((el) => {
    const text = (el.textContent ?? "").trim();
    // Prose, not a label or a stat: a real sentence with spaces in it.
    return text.length > 90 && text.split(/\s+/).length > 14 && el.getBoundingClientRect().width > 0;
  })
  .map((el) => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:1ch";
    el.appendChild(probe);
    const chPx = probe.getBoundingClientRect().width || 7;
    probe.remove();
    const r = el.getBoundingClientRect();
    return { ch: Math.round(r.width / chPx), px: Math.round(r.width), text: (el.textContent ?? "").trim().slice(0, 44) };
  })
  .filter((p) => p.ch > 95)
  .slice(0, 4);

for (const route of ROUTES) {
  test.describe(route, () => {
    test("no horizontal overflow", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${route} is wider than the window`).toBeLessThanOrEqual(clientWidth);
    });

    test("prose stays under about ninety-five characters a line", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const wide = await page.evaluate(proseReport);
      expect(wide, `${route}: ${JSON.stringify(wide)}`).toEqual([]);
    });

    test("shows its screen, not the error boundary", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      await expect(page.locator("text=/something went wrong/i")).toHaveCount(0);
    });
  });
}


/**
 * One ground (design/particl-graphite/README.md §2: "dark only — there is no light
 * theme"). The paper routes used to re-token themselves light; that is gone
 * with the second brand, so the thing to guard is that nothing brings it
 * back — on the front door and on a statement — even on a machine
 * set to light.
 */
test("the app is dark everywhere, on a light machine too", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const route of ["/", "/statements/2026-09"]) {
    await page.goto(route);
    await settle(page);
    const ground = await page.evaluate(() => ({
      paper: document.querySelector(".theme-light") !== null,
      ground: getComputedStyle(document.documentElement).getPropertyValue("--ground").trim().toUpperCase(),
      header: getComputedStyle(document.querySelector("header")!).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme.trim(),
      stamped: document.documentElement.getAttribute("data-theme"),
    }));
    expect(ground.paper, `${route} is not on paper`).toBe(false);
    expect(ground.ground, `${route} --ground`).toBe("#0B0D11");
    expect(ground.header, `${route} header on --ground`).toBe("rgb(11, 13, 17)");
    expect(ground.scheme).toBe("dark");
    expect(ground.stamped).toBeNull();
  }
});
