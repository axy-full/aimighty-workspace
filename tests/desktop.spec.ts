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
  "/", "/images", "/audio", "/productions", "/all", "/studio", "/studio/shot",
  "/usage", "/settings", "/policy", "/terms", "/privacy",
  "/atomik/ideas", "/atomik/treatment", "/atomik/breakdown", "/atomik/shots",
  "/projects/demo/rig/elements", "/rig/canvas/demo", "/rig/run/demo", "/rig/recipes/demo", "/takes/demo", "/shots/demo", "/elements/demo",
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
 * One ground (design/particl-v2/README.md §2: "dark only — there is no light
 * theme"). The paper routes used to re-token themselves light; that is gone
 * with the second brand, so the thing to guard is that nothing brings it
 * back — on the wall, on an atomik route, on a statement — even on a machine
 * set to light.
 */
test("the app is dark everywhere, on a light machine too", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const route of ["/", "/atomik/ideas", "/statements/2026-09"]) {
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

/**
 * The shell (§1, §3, §4; §16 line one): four nav items and only four; the
 * balance always visible; Usage and Settings in the account menu, nowhere
 * else; the Atomik button with its shortcut.
 */
test("four nav items, a balance, and Usage / Settings only behind the avatar", async ({ page }) => {
  await page.goto("/productions");
  await settle(page);
  const header = page.locator("header").first();
  const nav = header.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("link")).toHaveText(["Make", "Productions", "Rig", "Library"]);
  await expect(nav.getByRole("link", { name: "Productions" })).toHaveAttribute("aria-current", "page");
  // Usage and Settings are not in the nav…
  await expect(nav.getByRole("link", { name: /usage|settings/i })).toHaveCount(0);
  // …the Atomik button carries its shortcut…
  const atomik = header.getByRole("button", { name: /Ask Atomik/ });
  await expect(atomik).toBeVisible();
  await expect(atomik).toContainText("⌘J");
  // …and signed in, the balance sits left of it and the account menu holds
  // Usage and Settings; signed out there is no workspace to have a balance,
  // and the avatar's place offers the way in.
  const avatar = header.getByRole("button", { name: "Account" });
  if (await avatar.count()) {
    await expect(header.getByText(/^Balance/i)).toBeVisible();
    await avatar.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /^Usage/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Settings/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Sign out/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } else {
    await expect(header.getByRole("link", { name: "Sign in" })).toBeVisible();
  }
  // The header is the handoff's 56px.
  expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(56);
});

/** §5: ⌘J toggles the rail state, Esc closes it — the button shows which. */
test("⌘J opens Atomik and Esc closes it", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  // The shell header is the page's banner; the rail has a header of its own.
  const atomik = page.getByRole("banner").getByRole("button", { name: /Atomik/ });
  await expect(atomik).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Meta+j");
  await expect(atomik).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(atomik).toHaveAttribute("aria-pressed", "false");
  await atomik.click();
  await expect(atomik).toHaveAttribute("aria-pressed", "true");
});

/**
 * §5, §16: Atomik renders nothing when closed; opens compact on click / ⌘J;
 * expands; Esc closes; the state survives a reload. The board's numbers:
 * 300 and 420 wide, a 52px header, the composer at 44 / 46.
 */
test("Atomik: nothing when closed, compact on ⌘J, expanded on Expand, and it remembers", async ({ page }) => {
  await page.goto("/productions");
  await settle(page);
  await expect(page.getByRole("complementary", { name: "Atomik" })).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  const rail = page.getByRole("complementary", { name: "Atomik" });
  await expect(rail).toBeVisible();
  expect(await rail.evaluate((el) => el.getBoundingClientRect().width)).toBe(300);
  expect(await rail.locator("header").evaluate((el) => el.getBoundingClientRect().height)).toBe(52);
  await expect(rail.getByRole("textbox", { name: "Ask Atomik" })).toBeVisible();
  expect(await rail.getByRole("textbox", { name: "Ask Atomik" }).evaluate((el) => el.getBoundingClientRect().height)).toBe(44);
  await rail.getByRole("button", { name: /^Expand/ }).click();
  expect(await rail.evaluate((el) => el.getBoundingClientRect().width)).toBe(420);
  await expect(rail.getByText("Production agent")).toBeVisible();
  expect(await rail.getByRole("textbox", { name: "Ask Atomik" }).evaluate((el) => el.getBoundingClientRect().height)).toBe(46);
  // The page beside it got narrower, not covered — by exactly the rail, at any width.
  const [pageWidth, viewport] = await Promise.all([
    page.locator(".shell-page").evaluate((el) => el.getBoundingClientRect().width),
    page.evaluate(() => window.innerWidth),
  ]);
  expect(pageWidth).toBe(viewport - 420);
  await page.reload();
  await settle(page);
  expect(await page.getByRole("complementary", { name: "Atomik" }).evaluate((el) => el.getBoundingClientRect().width)).toBe(420);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Atomik" })).toHaveCount(0);
  await page.getByRole("banner").getByRole("button", { name: /Atomik/ }).click();
  expect(await page.getByRole("complementary", { name: "Atomik" }).evaluate((el) => el.getBoundingClientRect().width)).toBe(420);
});

/**
 * §6, board 7a: the Productions page — the 64px header with the mono
 * totals, the segmented, the two header pills (one filled), and a
 * production row with its project tiles in five columns.
 */
test("Productions: the 7a header, one filled primary, rows with five-column tiles", async ({ page }) => {
  await page.goto("/productions");
  await settle(page);
  const h1 = page.getByRole("heading", { name: "Productions" });
  await expect(h1).toBeVisible();
  const head = h1.locator("xpath=ancestor::div[contains(@class,'h-[64px]')][1]");
  expect(await head.evaluate((el) => el.getBoundingClientRect().height)).toBe(64);
  await expect(head.getByRole("group", { name: "Show" }).getByRole("button")).toHaveText(["Active", "Delivered", "All"]);
  const filled = await head.locator("button").evaluateAll((els) => els.filter((b) => getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").map((b) => b.textContent));
  expect(filled, "exactly one filled primary in the header").toEqual(["New production"]);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  if (signedIn) {
    const row = page.locator("section").first();
    await expect(row).toBeVisible();
    const grid = row.locator(".grid");
    expect(await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(5);
    await expect(grid.getByRole("button", { name: "+ Project" })).toBeVisible();
    await expect(page.locator("text=/\\d+ productions · \\d+ projects · \\d+ need you/i")).toBeVisible();
  }
});

/**
 * §7, the grid of board 10a: the toolbar with Grid | Filmstrip, the mono
 * stats, `+ Shot`, and the one filled primary priced before it enables;
 * five columns; the right-click menu at 228px with its items and footnote.
 */
test("Shots: toolbar, one filled primary, five columns, and the 228px menu", async ({ page }) => {
  await page.goto("/productions");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "the grid needs a workspace");
  const tile = page.locator("section .grid a").first();
  const href = (await tile.getAttribute("href"))!.replace(/\/media$/, "/shots");
  await page.goto(href);
  await settle(page);
  await expect(page.getByRole("group", { name: "View" }).getByRole("button")).toHaveText(["Grid", "Filmstrip"]);
  await expect(page.getByRole("button", { name: "+ Shot" })).toBeVisible();
  const filled = await page.locator(".shell-page button").evaluateAll((els) => els.filter((b) => getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").map((b) => b.textContent ?? ""));
  expect(filled.length, "at most one filled primary on the page").toBeLessThanOrEqual(1);
  const grid = page.locator(".shell-page .grid:has(article)").first();
  if (await grid.count()) {
    expect(await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(5);
    expect(await grid.evaluate((el) => getComputedStyle(el).columnGap)).toBe("12px");
    const card = grid.locator("article").first();
    if (await card.count()) {
      await card.click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      expect(await menu.evaluate((el) => el.getBoundingClientRect().width)).toBe(228);
      await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Paste after/ })).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeVisible();
      await expect(menu.getByText("Takes and masters are never deleted with a shot")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  }
});

/**
 * Rig · Canvas (design/particl-v2 §8, board 6a): the 44px sub-bar with the
 * three tabs, the 56px strip, the 300px inspector, `+ Add node ⌘K`, and a
 * node landing on the board from ⌘K — the inspector follows the selection.
 * Nothing here runs a node: building is free, and the test keeps it so.
 */
test("Rig · Canvas: the 6a chrome, ⌘K adds a node, the inspector follows the selection", async ({ page }) => {
  await page.goto("/productions");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "the canvas needs a workspace");
  const tile = page.locator("section .grid a").first();
  const href = (await tile.getAttribute("href"))!;
  const projectId = href.split("/")[3];
  await page.goto(`/rig/canvas/new?project=${projectId}`);
  await page.waitForURL(/\/rig\/canvas\/brd_/);
  await settle(page);
  const tabs = page.getByRole("group", { name: "Rig" });
  await expect(tabs.getByRole("button")).toHaveText(["Canvas", "Recipes", "Run"]);
  expect(await tabs.evaluate((el) => el.parentElement!.getBoundingClientRect().height)).toBe(44);
  expect(await tabs.evaluate((el) => getComputedStyle(el.parentElement!).paddingLeft)).toBe("76px");
  await expect(page.getByRole("button", { name: /Add node/ })).toBeVisible();
  const strip = page.getByRole("complementary", { name: "Atomik" });
  expect(await strip.evaluate((el) => el.getBoundingClientRect().width)).toBe(56);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  expect(await inspector.evaluate((el) => el.getBoundingClientRect().width)).toBe(300);
  const board = page.getByRole("region", { name: "Board" });
  expect(await board.evaluate((el) => getComputedStyle(el).backgroundSize)).toBe("24px 24px");
  await page.keyboard.press("Meta+k");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Prompt/ }).click();
  await expect(page.getByRole("article", { name: "Prompt node" })).toBeVisible();
  await expect(inspector.getByText("Node · Prompt")).toBeVisible();
  const node = page.getByRole("article", { name: "Prompt node" });
  expect(await node.evaluate((el) => el.getBoundingClientRect().width)).toBe(200);
  expect(await node.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("12px");
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("article", { name: "Prompt node" })).toHaveCount(0);
});
