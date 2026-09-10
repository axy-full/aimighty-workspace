import { test, expect, type Page } from "@playwright/test";

/**
 * Desktop acceptance (brief rule 7, revised 8 September 2026).
 *
 * The product is used at a desk. The phone suite is the floor; this is the
 * shape. Two things it checks that emulation on a phone can never catch:
 *
 *   • prose stays readable. A page that is wide because it is a dashboard
 *     will run a paragraph to two hundred characters a line if nothing stops
 *     it, and nothing did.
 *   • a bigger screen shows BIGGER frames. Every wall here is auto-fill with
 *     one fixed minimum, which snaps cards back down each time another column
 *     fits; a 4K monitor was showing smaller thumbnails than a laptop.
 *
 * Signed out, like the phone suite, so it needs no fixtures.
 */

const ROUTES = [
  "/", "/images", "/audio", "/projects", "/all", "/studio", "/studio/shot",
  "/usage", "/settings", "/policy", "/terms", "/privacy",
  "/atomik/ideas", "/atomik/treatment", "/atomik/breakdown", "/atomik/shots",
  "/projects/demo/rig", "/projects/demo/rig/elements", "/takes/demo", "/shots/demo", "/elements/demo",
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

/* A wall's cards must not get smaller as the window gets bigger. Checked at
   the widest project only: the minimum is what the steps in globals.css
   raise, and a card at or under the laptop-sized floor means a step is
   missing. */
test("a wide screen shows bigger frames, not more small ones", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-2560", "measured at the widest viewport");
  for (const route of ["/", "/all"]) {
    await page.goto(route);
    await settle(page);
    const card = await page.evaluate(() => {
      const grid = Array.from(document.querySelectorAll<HTMLElement>(".grp-grid"))
        .filter((g) => g.children.length > 1)
        .sort((a, b) => b.children.length - a.children.length)[0];
      if (!grid) return null;
      return Math.round((grid.children[0] as HTMLElement).getBoundingClientRect().width);
    });
    if (card === null) continue;   // signed out, this route may have no wall
    expect(card, `${route}: a card is ${card}px on a 2560 screen`).toBeGreaterThan(280);
  }
});

/**
 * Signed out, every price is in credits.
 *
 * This is the check that was missing when it mattered. The rate-table change
 * was verified locally while SIGNED IN, so the visitor path — the one on the
 * front door, the one a stranger sees — went out reading "$39.81" for a shot
 * that costs 40 credits. Not the vendor's dollars and not the price: a credit
 * figure with a dollar sign in front of it, because the formatter keyed off
 * whether there was a credit BALANCE rather than off what the table was in.
 *
 * §2: every price is in whole credits, and USD appears once, on the top-up
 * screen. A visitor has no workspace, so a visitor is quoted the platform's
 * own terms — which is what they would pay if they signed up.
 */
test("signed out, nothing is priced in dollars", async ({ page }) => {
  for (const route of ["/", "/images", "/audio"]) {
    await page.goto(route);
    await settle(page);
    const text = await page.evaluate(() => document.body.innerText);
    /* The top-up screen is the one place §2 allows a dollar, and it is not
       one of these three. */
    const dollars = text.match(/\$\s?\d[\d,.]*/g) ?? [];
    expect(dollars, `${route} shows dollars to a visitor: ${dollars.join(", ")}`).toEqual([]);
  }
});

test("signed out, the composer still quotes a price", async ({ page }) => {
  /* A guard on the guard: no dollars is trivially true if nothing is priced
     at all, and a composer that has stopped quoting is worse than one
     quoting the wrong unit. */
  await page.goto("/");
  await settle(page);
  const cost = await page.evaluate(() =>
    document.querySelector(".btn-primary-cost")?.textContent?.trim()
    ?? document.querySelector(".island-cost")?.textContent?.trim() ?? "");
  expect(cost, "the composer quotes nothing at all").toMatch(/\d/);
  expect(cost).toMatch(/cr\b/);
});

test("two productions open in two tabs do not fight over the switcher", async ({ page, context }) => {
  /* The regression: the chosen production was shared across tabs — the store
     re-read localStorage on every snapshot and subscribed to the cross-tab
     `storage` event — while every canvas page insists the switcher follows
     the production it is about. Two canvases open on different productions
     therefore wrote over each other for ever. It was measured at 73 requests
     to each of three endpoints in 1.2 seconds, until the browser began
     refusing new connections outright.
     What made it worth fixing rather than throttling: this selection is the
     `projectId` a render files into, so the loser of that argument had takes
     — and their cost — land on a production nobody chose for it.
     Counted here as writes to the key, because signed out there are no
     requests to count and the argument is client-side either way. */
  await context.addInitScript(() => {
    (window as unknown as { __sel: number }).__sel = 0;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (k === "aw_project") (window as unknown as { __sel: number }).__sel++;
      return orig.call(this, k, v);
    };
  });

  const a = page;
  await a.goto("/projects/demo-a/canvas");
  const b = await context.newPage();
  await b.goto("/projects/demo-b/canvas");

  await settle(a);
  await settle(b);
  await a.waitForTimeout(2500);

  const writes = async (p: typeof a) => p.evaluate(() => (window as unknown as { __sel: number }).__sel ?? 0);
  const [wa, wb] = [await writes(a), await writes(b)];
  await b.close();

  /* One write each is the whole job: "this page is about that production".
     A handful of extra is fine; a loop is dozens within a second. */
  expect(wa, `tab A wrote the selection ${wa} times`).toBeLessThan(5);
  expect(wb, `tab B wrote the selection ${wb} times`).toBeLessThan(5);
});

/**
 * One ground (§4, decided 10 September 2026).
 *
 * particl has no appearance setting and no system query any more, so the
 * thing to guard is the failure this replaces: a reader whose machine is set
 * to light seeing a light particl. The check emulates exactly that machine.
 *
 * atomik is checked in the same breath because it is the one light thing
 * left, and the way it stays light — `.theme-light` re-tokening a subtree —
 * is easy to delete by accident when the word "light" is being removed from
 * a stylesheet.
 */
test("particl is dark on a light machine, and atomik is still paper", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/");
  await settle(page);
  const particl = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      desk: cs.getPropertyValue("--color-desk").trim().toUpperCase(),
      ink: cs.getPropertyValue("--color-bone").trim().toUpperCase(),
      scheme: cs.colorScheme.trim(),
      stamped: document.documentElement.getAttribute("data-theme"),
    };
  });
  expect(particl.desk, "the page ground").toBe("#1D1F24");
  expect(particl.ink, "primary text").toBe("#F5F6F8");
  // Native controls and scrollbars have to come with it, or the page is dark
  // with light dropdowns in it.
  expect(particl.scheme).toBe("dark");
  // Nothing is stamped on <html> any more: there is nothing left to choose.
  expect(particl.stamped).toBeNull();

  await page.goto("/atomik/ideas");
  await settle(page);
  const atomik = await page.evaluate(() => {
    const el = document.querySelector(".theme-light");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { desk: cs.getPropertyValue("--color-desk").trim().toUpperCase(), scheme: cs.colorScheme.trim() };
  });
  expect(atomik, "atomik still wraps itself in .theme-light").not.toBeNull();
  expect(atomik!.desk, "atomik's ground").toBe("#ECEDEF");
  expect(atomik!.scheme).toBe("light");
});
