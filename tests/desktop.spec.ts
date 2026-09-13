import { test, expect, type Page } from "@playwright/test";
import { PROVIDERS } from "../lib/providers";

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
  "/make/video", "/make/images", "/make/audio", "/productions", "/library", "/studio/shot",
  "/usage", "/settings", "/admin", "/policy", "/terms", "/privacy",
  "/atomik/ideas", "/atomik/treatment", "/atomik/breakdown", "/atomik/shots",
  "/projects/demo/rig/elements", "/rig/canvas/demo", "/rig/run/demo", "/rig/recipes/demo", "/rig/recipes", "/takes/demo", "/shots/demo", "/elements/demo",
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
  for (const route of ["/make/video", "/library?view=unfiled"]) {
    await page.goto(route);
    await settle(page);
    const card = await page.evaluate(() => {
      const grid = Array.from(document.querySelectorAll<HTMLElement>("[data-wall]"))
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
  for (const route of ["/make/video", "/make/images", "/make/audio"]) {
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
  await page.goto("/make/video");
  await settle(page);
  const cost = await page.evaluate(() => document.querySelector("[data-render]")?.textContent?.trim() ?? "");
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
  await expect(nav.getByRole("link")).toHaveText(["Make", "Library", "Productions", "Rig"]);   // CR1 §9: the Library is the asset home
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
      /* CR1 §10: the one menu, ten items in one order; Paste is there, disabled, with nothing on the clipboard. */
      const names = await menu.getByRole("menuitem").allTextContents();
      expect(names.map((n) => n.replace(/\s*(⌘[A-Z]|↵|⌫|▸|\d+ cr)\s*$/u, "").trim()).slice(0, 10)).toEqual(["Cut", "Copy", "Paste", "Duplicate", "Rename", "Move to ▸", "Share ▸", "Download", "Open in Rig", "Delete"]);
      await expect(menu.getByRole("menuitem", { name: /^Paste/ })).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: /^Promote to asset/ })).toBeVisible();
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
  /* CR1 §6 — zoom and pan. A trackpad pinch arrives as ctrl+wheel: the handler
     prevents the default FIRST (so the browser never zooms), then zooms about
     the cursor; the cluster reads the percentage; the view survives a reload;
     and the prompt node's output dot sits exactly where its wire would end at
     25% and at 200%, because both live in the one transformed group. */
  await page.evaluate(() => { (window as unknown as { __wheel: boolean[] }).__wheel = []; document.addEventListener("wheel", (e) => (window as unknown as { __wheel: boolean[] }).__wheel.push(e.defaultPrevented)); });
  const bb = (await board.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -40);
  await page.keyboard.up("Control");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as unknown as { __wheel: boolean[] }).__wheel), "every wheel over the board is defaultPrevented").toEqual([true]);
  const zoomOf = () => board.evaluate((el) => Number(el.getAttribute("data-zoom")));
  const z1 = await zoomOf();
  expect(z1, "ctrl+wheel up zooms in").toBeGreaterThan(1);
  await expect(page.locator("[data-zoom-readout]")).toHaveText(`${Math.round(z1 * 100)}%`);
  await page.mouse.wheel(30, 20);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __wheel: boolean[] }).__wheel)).toEqual([true, true]);
  expect(await zoomOf(), "a plain wheel pans, it does not zoom").toBeCloseTo(z1, 6);
  await page.reload();
  await settle(page);
  expect(await page.getByRole("region", { name: "Board" }).evaluate((el) => Number(el.getAttribute("data-zoom"))), "the zoom survives a reload").toBeCloseTo(z1, 6);
  /* Port dots stay exact at both ends of the range. */
  await page.keyboard.press("Meta+k");
  await page.getByRole("menu").getByRole("menuitem", { name: /^Prompt/ }).click();
  const prompt = page.getByRole("article", { name: "Prompt node" });
  await expect(prompt).toBeVisible();
  const alignment = async () => prompt.evaluate((el) => {
    const surface = el.closest("section")!; const group = el.parentElement!;
    const m = new DOMMatrix(getComputedStyle(group).transform); const s = surface.getBoundingClientRect();
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
    const expected = { x: s.left + m.e + m.a * (x + 200), y: s.top + m.f + m.d * (y + 1 + 77 + 4) };      // nodes.ts outputPoint for a prompt
    const dot = el.querySelector("[data-dot]")!.getBoundingClientRect();
    return Math.hypot(dot.left + dot.width / 2 - expected.x, dot.top + dot.height / 2 - expected.y);
  });
  for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Zoom out" }).click();
  expect(await zoomOf()).toBe(0.25);
  expect(await alignment(), "the output dot centres on the wire's endpoint at 25%").toBeLessThan(1);
  for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  expect(await zoomOf()).toBe(2);
  expect(await alignment(), "…and at 200%").toBeLessThan(1);
  await page.keyboard.press("Meta+0");
  expect(await zoomOf(), "⌘0 fits").toBeLessThanOrEqual(1);
  /* CR1 §10 — the one menu on a node: right-click, the ten items in order,
     Duplicate lands a copy 24px down and right (not run, 0 cr), Delete
     removes it with Undo in the toast. */
  await prompt.click({ button: "right", position: { x: 100, y: 16 } });
  const nodeMenu = page.getByRole("menu");
  await expect(nodeMenu).toBeVisible();
  const nodeNames = await nodeMenu.getByRole("menuitem").allTextContents();
  expect(nodeNames.map((n) => n.replace(/\s*(⌘[A-Z]|↵|⌫|▸)\s*$/u, "").trim())).toEqual(["Cut", "Copy", "Paste", "Duplicate", "Rename", "Move to ▸", "Share ▸", "Download", "Open in Rig", "Delete"]);
  await expect(nodeMenu.getByRole("menuitem", { name: /^Paste/ })).toBeDisabled();
  await expect(nodeMenu.getByRole("menuitem", { name: /^Move to/ })).toBeDisabled();
  await nodeMenu.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await expect(page.getByRole("article", { name: "Prompt node" })).toHaveCount(2);
  const [a, b] = await page.getByRole("article", { name: "Prompt node" }).evaluateAll((els) => els.map((el) => [parseFloat((el as HTMLElement).style.left), parseFloat((el as HTMLElement).style.top)]));
  expect([b[0] - a[0], b[1] - a[1]]).toEqual([24, 24]);
  await page.getByRole("article", { name: "Prompt node" }).nth(1).click({ button: "right", position: { x: 100, y: 16 } });
  await page.getByRole("menu").getByRole("menuitem", { name: /^Delete/ }).click();
  await expect(page.getByRole("article", { name: "Prompt node" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await prompt.click({ position: { x: 100, y: 16 } });   // the header, not the textarea
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("article", { name: "Prompt node" })).toHaveCount(0);
});

/**
 * Append to tests/desktop.spec.ts (design/particl-v2 §12, board 3a): the New
 * asset sheet from the Library — 760 wide, radius 16, the header, the 48px
 * name field and kind buttons, the dashed references well, the four port
 * tiles a character derives, the train row with its switch, the foot's
 * Cancel and the one filled primary; Esc closes it. Creating is free and
 * nothing here creates: the sheet is opened and closed.
 */
test("New asset: the 3a sheet opens from the Library at its numbers and closes on Esc", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "the Library needs a workspace");
  await expect(page.getByRole("button", { name: /^New asset/ }), "one primary on the screen").toHaveCount(1);
  await page.getByRole("button", { name: /^New asset/ }).click();
  const sheet = page.getByRole("dialog", { name: "New asset" });
  await expect(sheet).toBeVisible();
  const box = await sheet.evaluate((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { w: Math.round(r.width), radius: cs.borderRadius, border: cs.borderColor, bg: cs.backgroundColor }; });
  expect(box.w).toBe(760);
  expect(box.radius).toBe("16px");
  expect(box.bg).toBe("rgb(18, 20, 26)");
  const name = sheet.getByRole("textbox", { name: "Name" });
  expect(await name.evaluate((el) => el.getBoundingClientRect().height)).toBe(48);
  expect(await name.evaluate((el) => getComputedStyle(el).fontSize)).toBe("20px");
  const kinds = sheet.getByRole("group", { name: "Kind" }).getByRole("button");
  await expect(kinds).toHaveText(["Character", "Prop", "Location", "Look", "Voice"]);
  expect(await kinds.first().evaluate((el) => el.getBoundingClientRect().height)).toBe(48);
  await expect(sheet.getByRole("list", { name: "Ports" }).getByRole("listitem")).toHaveCount(4);
  await expect(sheet.getByText(/^READY|LATER|OPTIONAL$/i).first()).toBeVisible();
  const sw = sheet.getByRole("switch");
  expect(await sw.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })).toEqual([36, 20]);
  const create = sheet.locator("[data-create]");
  expect(await create.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(46);
  expect(await create.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(245, 246, 248)");
  const filled = await page.locator("[role=dialog] button").evaluateAll((els) => els.filter((b) => getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").length);
  expect(filled, "one filled primary in the sheet").toBe(1);
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

/**
 * Settings (design/particl-v2 §13, board 4a): the 240px index with its nine
 * sections, the column of `--card` sections at `18px 20px`, Workspace beside
 * Credits at `1fr 380px`, the row chips at `6px 10px`, the 34×20 switches.
 */
test("Settings: the 4a index, sections and controls at their numbers", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "settings need a workspace");
  const aside = page.getByRole("complementary", { name: "Sections" });
  expect(await aside.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(240);
  expect(await aside.evaluate((el) => getComputedStyle(el).padding)).toBe("24px 16px");
  await expect(aside.getByRole("button")).toHaveCount(9);
  const item = aside.getByRole("button").first();
  expect(await item.evaluate((el) => getComputedStyle(el).padding)).toBe("9px 10px");
  const ws = page.getByRole("region", { name: "Workspace" });
  expect(await ws.evaluate((el) => getComputedStyle(el).padding)).toBe("18px 20px");
  expect(await ws.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("12px");
  expect(await ws.evaluate((el) => getComputedStyle(el.parentElement!).gridTemplateColumns.split(" ").pop())).toBe("380px");
  const chip = ws.getByRole("button", { name: "Default model" });
  expect(await chip.evaluate((el) => getComputedStyle(el).padding)).toBe("6px 10px");
  const sw = page.getByRole("switch").first();
  expect(await sw.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })).toEqual([34, 20]);
  await expect(page.getByRole("region", { name: "Engines & rates" }).getByText(/\/ (5s|still)$/).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Account" })).toBeVisible();
});

/**
 * Library, restructured (docs/change-request-1.md §5): the three lenses are
 * gone; seven labelled sections — Characters · Locations · Props · Looks ·
 * Voices · References · Unfiled — each a titled grid with its count and its
 * own `+ New`; a 240px index on the left follows the scroll and jumps; one
 * filled primary; `+ Location` opens New asset with Location picked; every
 * card says where it is used. Nothing here creates or renders.
 */
test("Library: labelled sections under a sticky index, one primary, + Location opens the sheet on Location", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "the Library needs a workspace");
  await expect(page.getByRole("group", { name: "Lens" })).toHaveCount(0);
  const index = page.getByRole("navigation", { name: "Library index" });
  await expect(index.getByRole("button")).toHaveText([/^Characters/, /^Locations/, /^Props/, /^Looks/, /^Voices/, /^References/, /^Unfiled/]);
  expect(await index.evaluate((el) => el.getBoundingClientRect().width)).toBe(240);
  for (const name of ["Characters", "Locations", "Props", "Looks", "Voices", "References", "Unfiled"]) await expect(page.getByRole("region", { name })).toBeVisible();
  const filled = await page.locator(".shell-page button").evaluateAll((els) => els.filter((b) => getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").map((b) => b.textContent ?? ""));
  expect(filled.length, "one filled primary on the screen").toBe(1);
  /* The index follows a jump, and the column — not the page — is what scrolled. */
  await index.getByRole("button", { name: /^Unfiled/ }).click();
  await expect(index.getByRole("button", { name: /^Unfiled/ })).toHaveAttribute("aria-current", "true");
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  /* A card says where it is used, in the one form. */
  const card = page.locator("[data-asset]").first();
  if (await card.count()) await expect(card.locator("span.truncate").last()).toHaveText(/^(not in a shot yet|\d+ shots? · \d+ productions?)$/);
  /* + Location under its label opens the sheet with Location already picked. */
  await page.getByRole("region", { name: "Locations" }).getByRole("button", { name: "+ Location" }).click();
  const sheet = page.getByRole("dialog", { name: "New asset" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Location" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

/**
 * Usage (docs/particl-sow-v2.md §7.12, design/particl-sow board 12f): from
 * the account menu; the month and one line, the one filled primary, the
 * shots taking the most takes, by production · person · engine, and the
 * cap burn-down — every credit from the one ledger. Nothing here spends.
 */
test("Usage: the month, one line, one primary, and the five cards", async ({ page }) => {
  await page.goto("/usage");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "Usage needs a workspace");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(January|February|March|April|May|June|July|August|September|October|November|December)$/);
  await expect(page.locator("[data-usage-line]")).toHaveText(/^\d[\d,]* cr spent/);
  for (const name of ["The shots taking the most takes", "By production", "By person", "By engine", "Will each project finish under its cap?"]) await expect(page.getByRole("region", { name })).toBeVisible();
  const filled = await page.locator(".shell-page button").evaluateAll((els) => els.filter((b) => getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").map((b) => b.textContent ?? ""));
  expect(filled.length, "at most one filled primary — an admin's Download the statement").toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: /^Download the statement/ })).toBeVisible();
  /* No dollar figure anywhere on a credit workspace's Usage. */
  expect(await page.locator(".shell-page").innerText()).not.toMatch(/\$\s?\d/);
});

/**
 * Rig · Recipes (SOW surfaces board 12d): the recipe cards on the left with
 * the picked one on a 2px ink border, the steps table with its five mono
 * headers, the whole-run card with one filled primary priced as the steps
 * before the first checkpoint, and the floor line. The platform's two are
 * there for every workspace. Nothing here starts a run.
 */
test("Rig · Recipes: the cards, the steps table, one primary priced to the first checkpoint, the floor line", async ({ page }) => {
  await page.goto("/rig/recipes");
  await settle(page);
  const signedIn = await page.getByRole("button", { name: "Account" }).count();
  test.skip(!signedIn, "the Rig needs a workspace");
  const list = page.getByRole("complementary", { name: "Recipes" });
  expect(await list.evaluate((el) => el.getBoundingClientRect().width)).toBe(420);
  const cards = list.getByRole("button", { name: /^Recipe / });
  expect(await cards.count(), "the platform's two at least").toBeGreaterThanOrEqual(2);
  const picked = list.getByRole("button", { name: /^Recipe /, pressed: true });
  await expect(picked).toHaveCount(1);
  expect(await picked.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("2px");
  expect(await picked.evaluate((el) => getComputedStyle(el).borderTopColor), "the picked card sits on the ink border").toBe("rgb(245, 246, 248)");
  const unpicked = list.getByRole("button", { name: /^Recipe /, pressed: false }).first();
  expect(await unpicked.evaluate((el) => getComputedStyle(el).borderTopWidth), "every card is 2px; only the colour changes").toBe("2px");
  expect(await unpicked.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgba(245, 246, 248, 0.08)");
  /* The platform's own recipe first: every step names its engine and its vendor. `exact`, because a copy is `… · copy`. */
  await list.getByRole("button", { name: "Recipe 30-second spot", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("30-second spot");
  await expect(page.getByRole("table", { name: "Steps" }).getByRole("columnheader")).toHaveText(["#", "Step", "Who does it", "Costs", "Atomik"]);
  const rows = page.getByRole("table", { name: "Steps" }).getByRole("row");
  expect(await rows.count()).toBe(7);
  await expect(page.locator("[data-step='1']").getByRole("cell").nth(2), "the engine and its vendor, from the registry").toHaveText(/ · (ByteDance|Google|fal|ElevenLabs|Vercel)$/, { useInnerText: true });
  await expect(page.locator("[data-step='3']").getByRole("cell").nth(4), "keyframes ask first").toHaveText(/^Asks first/, { useInnerText: true });
  await expect(page.locator("[data-step='2']").getByRole("cell").nth(3), "a batch prints its rate per unit, the board's way").toHaveText(/ \/ PANEL$/, { useInnerText: true });
  await expect(page.locator("[data-floor]")).toHaveText("Anything over 200 cr always asks. Training, publishing and deleting always ask.");
  const filled = await page.locator(".shell-page button").evaluateAll((els) => els.filter((b) => getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").map((b) => b.textContent ?? ""));
  expect(filled.length, "one filled primary").toBe(1);
  expect(filled[0]).toMatch(/^Run to first checkpoint/);
  /* Picking another card changes the recipe on the right. */
  await list.getByRole("button", { name: "Recipe Product turntable", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Product turntable");
});

/**
 * The platform admin console (docs/particl-sow-v2.md §7.13, SOW surfaces
 * board 12h): the owner's desk under the shell header — a `PLATFORM ·
 * ADMIN` chip and the month's line, then four --card blocks. One filled
 * primary (`Send N codes`, priced from welcomeGrant()), the Studios head
 * row in mono, one switch per provider in the registry, and never the
 * accent on a dot: healthy is ink, warning is muted. A visitor sees the
 * owner-only line; the desk needs the platform owner's session, so this
 * skips in a signed-out harness.
 */
test("Admin: the four blocks, one primary, the studios head row, the switches", async ({ page }) => {
  await page.goto("/admin");
  await settle(page);
  /* Signed in means the desk grid rendered — the Account button is the fallback, not the gate: the header hides it
     on some chromes and getByRole never counts a hidden control. */
  const signedIn = (await page.locator("[data-desk-grid]").count()) || (await page.getByRole("button", { name: "Account" }).count());
  test.skip(!signedIn, "the desk needs the platform owner");
  const desk = page.locator(".shell-page");
  await expect(desk).toHaveText(/PLATFORM · ADMIN/, { useInnerText: true });
  for (const name of ["Wants in", "Engines", "Studios", "What every new studio starts with"]) await expect(page.getByRole("region", { name })).toBeVisible();
  /* The primary is the `[data-send-codes]` button (the card's copy on a desktop; the phone's pinned copy is
     display:none here). With somebody waiting it reads `Send N codes` (`Send a code` for one) and it is the one
     filled button on the desk; with nobody to send to it is outlined and blocked, and then nothing on the desk is
     filled — a filled button is `--ink`, and a switch that is on wears the ink track, so switches never count. */
  const primary = page.locator("[data-send-codes]:visible").first();
  await expect(primary).toBeVisible();
  const label = (await primary.innerText()).trim();
  const filled = await desk.locator("button").evaluateAll((els) => els.filter((b) => b.getAttribute("role") !== "switch" && (b as HTMLElement).offsetParent !== null && getComputedStyle(b).backgroundColor === "rgb(245, 246, 248)").map((b) => (b.textContent ?? "").trim()));
  if (/^Send (a code|\d+ codes)/.test(label)) {
    expect(filled.length, "one filled primary — Send N codes").toBe(1);
    expect(filled[0]).toMatch(/^Send (a code|\d+ codes)/);
  } else {
    expect(filled, "nobody to send to: the primary is outlined and nothing on the desk is filled").toEqual([]);
    await expect(primary).toBeDisabled();
  }
  /* The seven mono column heads, in the board's order. */
  await expect(page.getByRole("region", { name: "Studios" })).toHaveText(/STUDIO[\s\S]*TIER[\s\S]*ENGINE \$[\s\S]*BILLED[\s\S]*MARGIN[\s\S]*NOTE[\s\S]*PRICE/, { useInnerText: true });
  /* One switch per provider in the registry, each saying whether it is on. */
  const switches = page.getByRole("region", { name: "Engines" }).getByRole("switch");
  await expect(switches).toHaveCount(PROVIDERS.length);
  for (const sw of await switches.all()) await expect(sw).toHaveAttribute("aria-checked", /^(true|false)$/);
  /* No dot in the accent: a probe carrying `text-accent` says what the accent computes to on this page. */
  const accented = await page.getByRole("region", { name: "Engines" }).evaluate((root) => {
    const probe = document.createElement("span");
    probe.className = "text-accent"; probe.style.cssText = "position:absolute;visibility:hidden";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return Array.from(root.querySelectorAll<HTMLElement>("span.rounded-full, [data-dot]"))
      .map((d) => { const cs = getComputedStyle(d); return [cs.backgroundColor, cs.borderTopColor]; })
      .filter(([bg, bd]) => bg === accent || bd === accent);
  });
  expect(accented, "healthy is ink, warning is muted — never the accent").toEqual([]);
});
