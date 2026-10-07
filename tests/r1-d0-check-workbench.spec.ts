import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { seedShots } from "./helpers/gaps-l1";
import { isCompact } from "./helpers/shellMode";
import { noBannedNames } from "./helpers/r1-gaps";

/*
 * Release 1 list A, item 6 · the D0 shell, screen by screen, against design/particl-graphite (SOW § 2 item 1):
 * header B, the avatar menu, ⌘K, the right-click menu (prices and Delete to trash with Undo), the phone bar on every
 * phone screen, and the public pricing page and sign-in. Real local ENGINE_MOCK=1 server; the library is mocked in the
 * browser (tests/helpers/gaps-l1.ts), the take's price is the server's own quote. Nothing paid is ever sent. A screenshot of
 * each item at 1440 and 390 goes to D0_CHECK_SHOTS (default /tmp/particl-suites/r1-d0-check/shots) for the owner.
 */
const SHOTS = process.env.D0_CHECK_SHOTS || "/tmp/particl-suites/r1-d0-check/shots";
const shot = async (page: Page, item: string, info: { project: { name: string } }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${item}-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" });
};
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

async function openBoard(page: Page) {
  const seeded = await seedShots(page, "D0 Check");
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  await expect(page.getByTestId("screen").or(page.getByTestId("phone-app")).first()).toBeVisible();
  return seeded;
}

test("header B: Home · project · Make · Atomik, Search ⌘K, Jobs, credits, avatar (the phone's header is its title and credits)", async ({ page }, info) => {
  const { project } = await openBoard(page);
  if (isCompact(info)) {
    await page.goto(`/suites?device=phone&screen=home`);
    const header = page.getByTestId("phone-header");
    await expect(header).toBeVisible();
    await expect(page.getByTestId("phone-title")).toHaveText("Particl");
    await expect(page.getByTestId("phone-credits")).toContainText(/\d/);
    await shot(page, "01-header", info);
    await noSideways(page);
    return;
  }
  const header = page.locator("header.gx-header");
  await expect(header).toBeVisible();
  const segments = header.locator('[role="tab"]');
  await expect(segments).toHaveCount(4);
  await expect(segments.nth(0)).toHaveText("Home");
  await expect(segments.nth(1)).toHaveText(project.name);
  await expect(segments.nth(2)).toHaveText("Make");
  await expect(segments.nth(3)).toHaveText("Atomik");
  const search = header.getByTestId("header-search");
  await expect(search).toContainText("Search");
  await expect(search).toContainText("⌘K");
  await expect(header.getByTestId("brand-home")).toBeVisible();
  await expect(header.getByTestId("running-jobs")).toBeVisible();
  await expect(header.getByTestId("workspace-credits")).toContainText(/\d/);
  await expect(header.getByTestId("workspace-avatar")).toBeVisible();
  /* Left to right: the segment, Search, Jobs, credits, avatar. */
  const xs = await Promise.all([segments.nth(3), search, header.getByTestId("workspace-credits"), header.getByTestId("workspace-avatar")].map(async (l) => (await l.boundingBox())!.x));
  expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  expect((await header.boundingBox())!.height).toBe(56);
  await shot(page, "01-header", info);
  await noSideways(page);
});

test("the avatar menu: the person's name, then 'workspace · role', then the five Settings sections and Sign out", async ({ page }, info) => {
  await openBoard(page);
  if (isCompact(info)) {
    /* The phone's header draws the title and credits only (Phone frames A to H): Settings are reached through Home and the credits. */
    await expect(page.getByTestId("workspace-avatar")).toHaveCount(0);
    await page.goto(`/suites?device=phone&screen=home`);
    await expect(page.getByTestId("phone-header")).toBeVisible();
    await expect(page.getByTestId("workspace-avatar")).toHaveCount(0);
    await shot(page, "02-avatar-menu", info);
    return;
  }
  const me = await (await page.request.get("/api/me")).json() as { name?: string };
  await page.getByTestId("workspace-avatar").click();
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  const lines = (await menu.innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
  expect(lines[0]).toBe(me.name || "Your account");
  expect(lines[1]).toMatch(/^.+ · (owner|admin|member)$/);
  expect(lines[1]).not.toMatch(/Settings/i);
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Team", "Plan & credits", "Spending rules", "Connections", "Advanced", "Sign out"]);
  await shot(page, "02-avatar-menu", info);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

const PALETTE = ["Home", "Brief", "Looks", "Storyboard", "Shots", "Cast", "Cut", "Deliver", "Ads", "Social", "Video", "Image", "Audio", "Motion transfer", "Object swap", "Atomik", "Team", "Plan & credits", "Spending rules", "Connections", "Advanced"];

test("⌘K lists exactly the design's places (Home, the board's rail, Ads, Social, Make's types and tools, Atomik, Settings' five) and opens by key and by the header", async ({ page }, info) => {
  const { project } = await openBoard(page);
  const palette = page.getByTestId("atomik-palette");
  if (isCompact(info)) await page.goto(`/suites?project=${project.id}&palette=1`);
  else {
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await page.getByTestId("header-search").click();
  }
  await expect(palette).toBeVisible();
  const rows = palette.getByTestId("palette-row");
  await expect(rows).toHaveCount(PALETTE.length);
  const labels = (await rows.allInnerTexts()).map((t) => t.split("\n").map((l) => l.trim()).filter(Boolean)[1]);
  expect(labels).toEqual(PALETTE);
  await expect(palette.getByRole("textbox", { name: "Search" })).toHaveAttribute("placeholder", "Search, or tell Atomik what to do");
  await shot(page, "03-command-k", info);
  await noSideways(page);
});

test("right-click a take: Recreate carries the server's quote in credits, nothing else invents a price; Delete moves it to the trash with Undo; Undo restores", async ({ page }, info) => {
  test.skip(isCompact(info), "a right-click is a mouse gesture: the phone (touch) has its own take actions (Phone frames C, D) and no context menu is drawn there");
  const seeded = await openBoard(page);
  const trashed: { id: string; trashed: unknown }[] = [];
  await page.route(/\/api\/jobs\/tk-[^/?]+$/, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.continue();
    const body = request.postDataJSON() as { trashed?: boolean; reviewState?: string };
    if (body.trashed === undefined) return route.fallback();
    const id = new URL(request.url()).pathname.split("/").pop()!;
    trashed.push({ id, trashed: body.trashed });
    const g = seeded.generations.find((x) => x.id === id);
    if (g) (g as Record<string, unknown>).trashedAt = body.trashed ? Date.now() : null;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  /* The library as the server answers it: a trashed take is hidden, a restored one is back. */
  await page.route("**/api/workbench/library?**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const source = new URL(route.request().url()).searchParams.get("source");
    const generations = seeded.generations.filter((g) => !(g as Record<string, unknown>).trashedAt);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(source === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null }) });
  });
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  const tile = page.getByTestId("board-library").locator(".bd-tile", { hasText: "tk-s1-v1" });
  if (!(await tile.isVisible().catch(() => false))) await page.getByRole("button", { name: /Library/ }).first().click();
  await expect(tile).toBeVisible();
  /* The price the menu shows is the server's own quote for this take's engine (GET /api/workbench/engines?model=…, the one Make's price line reads). */
  const quote = page.waitForResponse((r) => /\/api\/workbench\/engines\?.*model=gemini-3-pro-image/.test(r.url()) && r.request().method() === "GET");
  await tile.click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(names.map((n) => n.replace(/ · \d[\d,]* cr.*$/, "").replace(/ [⌘⌫].*$/, ""))).toEqual(
    ["Copy", "Cut", "Paste", "Duplicate", "Use as reference", "Open in Inspector", "Move to…", "Recreate", "Delete", "Undo"]);
  /* Every spending command is priced from the quote; every other command carries no spend marker and no figure. */
  const spending = menu.locator("[data-spend]");
  await expect(spending).toHaveCount(1);
  const recreate = spending.first();
  await expect(recreate).toHaveAttribute("data-spend", "priced");
  await expect(recreate).toBeEnabled();
  const price = await recreate.getAttribute("data-spend-price");
  expect(price).toMatch(/^\d[\d,]* cr$/);
  await expect(recreate).toContainText(`Recreate · ${price}`);
  const quoted = (await (await quote).json()) as { credits?: number };
  expect(typeof quoted.credits, "the server answered with a price").toBe("number");
  expect(price!.replace(/,/g, "")).toContain(String(quoted.credits));
  for (const name of names) if (!/^Recreate/.test(name)) expect(name, "an unpriced command shows no figure").not.toMatch(/\d[\d,]*\s*cr\b/);
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toHaveAttribute("data-danger", "true");
  await expect(menu.getByRole("menuitem", { name: /^Undo/ })).toBeDisabled();
  await noBannedNames(page);
  await shot(page, "04-right-click", info);
  expect(seeded.paid, "opening the menu sends nothing paid").toEqual([]);

  /* Delete: hidden in the trash, never erased (PATCH trashed, no DELETE), with Undo in the toast. */
  const deletes: string[] = [];
  page.on("request", (r) => { if (r.method() === "DELETE") deletes.push(r.url()); });
  await menu.getByRole("menuitem", { name: /^Delete/ }).click();
  await expect(menu).toBeHidden();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("to trash");
  await expect.poll(() => trashed).toEqual([{ id: "tk-s1-v1", trashed: true }]);
  await expect(page.getByTestId("board-library").locator(".bd-tile", { hasText: "tk-s1-v1" })).toHaveCount(0);
  await shot(page, "04-deleted-undo", info);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => trashed).toEqual([{ id: "tk-s1-v1", trashed: true }, { id: "tk-s1-v1", trashed: false }]);
  await expect(tile).toBeVisible();
  expect(deletes, "nothing is hard-deleted").toEqual([]);
  expect(seeded.paid).toEqual([]);
});

test("right-click in Make's Recent: the same menu, the same quoted price, Delete with Undo", async ({ page }, info) => {
  test.skip(isCompact(info), "a right-click is a mouse gesture: no context menu is drawn on the phone");
  const seeded = await seedShots(page, "D0 Recent");
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  await expect(page.getByTestId("screen")).toBeVisible();
  await expect(page.locator('[data-suite-tab="project"]')).toHaveText(seeded.project.name);
  await page.locator('[data-suite-tab="make"]').click();
  await page.getByRole("tablist", { name: "Make or Recent" }).getByRole("tab", { name: "Recent" }).click();
  const tile = page.getByTestId("make-recent-card").locator("[data-ctx]").first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  const quote = page.waitForResponse((r) => /\/api\/workbench\/engines\?.*model=gemini-3-pro-image/.test(r.url()) && r.request().method() === "GET");
  await tile.click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  const recreate = menu.locator("[data-spend]");
  await expect(recreate).toHaveCount(1);
  await expect(recreate).toHaveAttribute("data-spend", "priced");
  const quoted = (await (await quote).json()) as { credits?: number };
  expect((await recreate.getAttribute("data-spend-price"))!.replace(/,/g, "")).toContain(String(quoted.credits));
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeEnabled();
  await shot(page, "04-right-click-make-recent", info);
  expect(seeded.paid).toEqual([]);
});

const PHONE_SCREENS: { screen: string; tab: string | null; bar: boolean }[] = [
  { screen: "home", tab: "home", bar: true },
  { screen: "record", tab: "record", bar: true },
  { screen: "make", tab: "make", bar: true },
  { screen: "atomik", tab: "atomik", bar: true },
  { screen: "states", tab: "home", bar: true },
  { screen: "review", tab: null, bar: false },
  { screen: "plan", tab: null, bar: false },
];

for (const { screen, tab, bar } of PHONE_SCREENS) {
  test(`phone bar: ${screen} ${bar ? "shows Home · Record · Make · Atomik" : "has none (full-screen)"}`, async ({ page }, info) => {
    test.skip(!isCompact(info), "the bar is the phone's");
    const seeded = await seedShots(page, "D0 Phone");
    await page.goto(`/suites?project=${seeded.project.id}&device=phone&screen=${screen}`);
    await expect(page.getByTestId("phone-app")).toBeVisible();
    await expect(page.getByTestId("phone-app")).toHaveAttribute("data-screen", /.+/);
    const dock = page.getByTestId("mobile-dock");
    if (!bar) {
      await expect(dock).toHaveCount(0);
    } else {
      await expect(dock).toBeVisible();
      const labels = await dock.locator(".ph-tab-label").evaluateAll((els) => els.map((e) => (e.childNodes[0]?.textContent ?? "").trim()));
      expect(labels).toEqual(["Home", "Record", "Make", "Atomik"]);
      if (tab) await expect(dock.locator(`[data-testid="phone-tab-${tab}"]`)).toHaveAttribute("aria-current", "page");
      const box = (await dock.boundingBox())!;
      const view = page.viewportSize()!;
      expect(box.y + box.height, "the bar sits at the bottom").toBeGreaterThanOrEqual(view.height - 2);
      /* A phone on its side keeps the phone's own column (frame 390 wide); the bar spans that column. */
      const column = (await page.getByTestId("phone-app").boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(column.width - 2);
      expect(box.x).toBeLessThanOrEqual(column.x + 2);
    }
    await shot(page, `05-phone-${screen}`, info);
    await noSideways(page);
  });
}

test("the desktop shell has no phone bar", async ({ page }, info) => {
  test.skip(isCompact(info), "desktop only");
  await openBoard(page);
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  await expect(page.getByTestId("phone-app")).toHaveCount(0);
});

test("public pricing: the site's nav ends in Pricing with Request access on the page; sign-in offers Request access and no new workspace", async ({ page }, info) => {
  await page.goto("/pricing");
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  await expect(nav.getByRole("link")).toHaveText(["Studio", "Ads", "Social", "Make", "Atomik", "Pricing"]);
  await expect(nav.getByRole("link", { name: "Pricing", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#access").getByRole("button", { name: "Request access" })).toBeVisible();
  await expect(page.getByText(/Create a workspace/i)).toHaveCount(0);
  await expect(page.locator('a[href="/signup"]')).toHaveCount(0);
  await noSideways(page);
  await shot(page, "06-pricing", info);

  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request access", exact: true })).toBeVisible();
  await expect(page.getByText(/Create a workspace/i)).toHaveCount(0);
  await expect(page.locator('a[href="/signup"]')).toHaveCount(0);
  await noSideways(page);
  await shot(page, "07-sign-in", info);
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Request an invitation" })).toBeVisible();
  await shot(page, "07-sign-in-request", info);
});
