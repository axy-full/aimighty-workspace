import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { newProject } from "../lib/workbench/studio";
import { billCredits, marginKeyOf } from "../lib/creditTerms";
import { estimateCostUsd } from "../lib/vendorPricing";
import { openAdvanced } from "./helpers/makeAdvanced";

/**
 * Idea 4 — a way out when credits run out. A take held at zero says what it
 * needs ("Held · needs 15 cr") and carries Release at that exact price, for
 * whom the route allows (its author, the owner, an admin); still short is the
 * route's own 402 words with the way to credits, and nothing is charged; a
 * lost reply pressed again is answered "released" and charged once. Plans &
 * credits lists the packs with "Request N credits" for the owner and admins
 * (a member is told to ask an admin), open requests with Withdraw (kept as
 * withdrawn), and the credits that came in. The header pill turns amber when
 * the balance is below the last price quoted, and opens Plans.
 *
 * Real local routes on a mock engine (ENGINE_MOCK=1): the release, the
 * top-up request and the library are the app's own; takes are written into
 * this login's own tenant database. No mail key is set, so nothing is sent.
 * Screenshots are opt-in: CREDITS_OUT_SHOTS=<dir>.
 */
const DESKTOP_SIZES = ["workbench-1440x900", "workbench-1920x1080"];
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.CREDITS_OUT_SHOTS;
type Seeded = { workspaceId: string; userId: string; scope: string; production: string };

async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}const setRole = (workspaceId: string, role: "owner" | "admin" | "member") =>
  platform((db) => db.execute({ sql: "UPDATE memberships SET role=? WHERE workspace_id=?", args: [role, workspaceId] }));
const grant = (workspaceId: string, credits: number) =>
  platform((db) => db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, credits, "Credits out fixture", "manual", "test", Date.now()] }));

/** A signed-in workspace with one saved project, opened on load. */
async function seed(page: Page): Promise<Seeded> {
  const signed = await signInLocally(page.request);
  const me = await (await page.request.get("/api/me")).json();
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const project = newProject(`Harbour ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const production = String((await saved.json()).productionProjectId ?? "");
  expect(production).not.toBe("");
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  return { workspaceId: signed.workspace.id, userId: String(me.id), scope, production };
}
const balanceOf = async (page: Page) => Number((await (await page.request.get("/api/me")).json()).credits.balance);



async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(1);
}

/** No text under 12px, none dimmer than #7C7C84 on the ground it really sits on, no serif — in `scope` only. */
async function floors(page: Page, scope: string) {
  const problems = await page.evaluate((scope) => {
    const out: string[] = [];
    const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const ground = (el: Element | null): number[] => {
      const stack: number[][] = [];
      for (let node = el; node; node = node.parentElement) {
        const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor);
        if (a > 0) stack.push([r, g, b, a]);
        if (a >= 1) break;
      }
      let base = [0, 0, 0];
      for (const [r, g, b, a] of stack.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
      return base;
    };
    const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const floor = lum([0x7c, 0x7c, 0x84]) - 0.5;
    for (const root of Array.from(document.querySelectorAll(scope))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? "").trim();
        const el = node.parentElement;
        if (!text || !el || !el.getClientRects().length || el.closest(".sr-only")) continue;
        const style = getComputedStyle(el);
        if (Number.parseFloat(style.fontSize) < 12) out.push(`${style.fontSize}: “${text.slice(0, 30)}”`);
        const [r, g, b, a = 1] = rgba(style.color);
        const under = ground(el);
        const opacity = Number(getComputedStyle(el.closest("button") ?? el).opacity);
        const seen = [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)].map((v, i) => v * opacity + under[i] * (1 - opacity));
        if (lum(seen) < floor) out.push(`dim ${style.color} on rgb(${under.map(Math.round).join(",")}): “${text.slice(0, 30)}”`);
        const family = style.fontFamily.split(",")[0].trim().replace(/["']/g, "").toLowerCase();
        if (/^(serif|times|georgia|garamond|palatino|cambria)/.test(family)) out.push(`serif ${family}: “${text.slice(0, 30)}”`);
      }
    }
    return out;
  }, scope);
  expect(problems, `${scope}: text floors`).toEqual([]);
}

/**
 * `el` ends on screen and, on a phone, above the floating tab bar. With `wheel`, the pane `el` scrolls in is
 * first turned to its end by the wheel over its visible middle, as a finger would: nothing is scrolled by script.
 */
async function clearOfTabBar(page: Page, el: Locator, wheel = false) {
  const viewport = page.viewportSize()!;
  const bar = page.getByTestId("tabbar");
  const barShown = await bar.isVisible();
  const floor = barShown ? (await bar.boundingBox())!.y : viewport.height;
  /* The wheel over the visible middle of the pane `el` scrolls in, again on each look: the page may still be growing (a
     re-read landing) when the first turn of the wheel reaches the end. */
  const toEnd = async () => {
    const at = await el.evaluate((node, floor) => {
      let pane = node.parentElement;
      while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
      if (!pane) return null;
      const box = pane.getBoundingClientRect();
      const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom, floor);
      return { x: box.left + box.width / 2, y: (top + bottom) / 2 };
    }, floor);
    if (!at) return;
    await page.mouse.move(at.x, at.y);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 1200);
  };
  await expect.poll(async () => {
    if (wheel) await toEnd();
    const box = (await el.boundingBox())!;
    return Math.round((box.y + box.height) * 100) / 100 <= Math.round(floor * 100) / 100;
  }, { message: barShown ? "ends above the tab bar" : "ends on screen" }).toBe(true);
}

/** CI's Linux sans (and many Android phones') is wider than macOS's: the "whole" checks run again with a wide sans forced. */
async function widerSans(page: Page) {
  const tag = await page.addStyleTag({ content: `.gx, .gx * { font-family: Verdana, "DejaVu Sans", "Liberation Sans", sans-serif !important; }` });
  return () => tag.evaluate((node) => (node as Element).remove());
}
/** Every visible label in `selector` shows whole: no price is clipped or ellipsized. */
async function whole(page: Page, selector: string) {
  const cut = await page.evaluate((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${(el.textContent ?? "").trim()} (${el.scrollWidth} > ${el.clientWidth})`), selector);
  expect(cut, `${selector}: every price whole`).toEqual([]);
}
async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}



test("Settings › Plan & credits: the owner requests a pack and withdraws it, kept as withdrawn, nothing sent; a member is told to ask an admin", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const s = await seed(page);
  await grant(s.workspaceId, 120);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* The first read fails: said, with Try again, and no packs are guessed at. */
  let failRead = true;
  await page.route(/\/api\/workspaces\/topups$/, (route) => (failRead && route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: "Credits are not answering right now." } }) : route.fallback()));
  await page.goto("/suites?view=workspace&tab=credits&open=packs");
  const plans = page.getByTestId("settings-view");
  const packs = page.getByTestId("settings-pack");
  await expect(page.getByTestId("settings-topups-error")).toContainText("Credits are not answering right now.", { timeout: 60_000 });
  await expect(packs).toHaveCount(0);
  failRead = false;
  await page.getByTestId("settings-topups-error").getByRole("button", { name: "Try again" }).click();
  await expect(packs).toHaveCount(4);
  await expect(page.getByTestId("settings-topups-error")).toHaveCount(0);
  /* Priced by the platform's own packs(): credits, bonus and the pack's dollar price, the one dollar figure here. */
  await expect(packs).toHaveText([/Starter\s*500 cr · \$50/, /Team\s*2,200 cr · \$200 · 200 free/, /Studio\s*5,750 cr · \$500 · 750 free/, /Agency\s*24,000 cr · \$2,000 · 4,000 free/]);
  await expect(packs.nth(1).getByTestId("settings-pack-request")).toHaveText("Request");
  await page.getByTestId("settings-fold-history-toggle").click();
  await expect(page.getByTestId("settings-grant").filter({ hasText: "Credits out fixture" })).toContainText("120 cr");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="settings-fold-packs"]'), "pack buttons under 44×44").toEqual([]);
  await floors(page, '[data-testid="settings-pack"], [data-testid="settings-grant"], [data-testid="workspace-credits"]');
  await noSideScroll(page);
  const packPrices = '[data-testid="settings-pack"] .gs-row-line, [data-testid="settings-grant"] .gs-row-v, [data-testid="workspace-credits"]';
  await whole(page, packPrices);
  await widerSans(page);
  await whole(page, packPrices);
  await noSideScroll(page);
  await page.reload();
  await expect(packs).toHaveCount(4);

  /* Request: queued for the platform, nothing charged, and no mail without a key. */
  const before = await balanceOf(page);
  const reply = page.waitForResponse((r) => r.url().endsWith("/api/workspaces/topups") && r.request().method() === "POST");
  await packs.nth(1).getByTestId("settings-pack-request").click();
  const posted = await (await reply).json();
  expect(posted).toMatchObject({ emailed: false, checkout: { kind: "queued" }, request: { label: "Team", credits: 2000, bonus: 200, usd: 200, status: "requested" } });
  await expect(page.getByTestId("settings-credits-note")).toHaveText("Requested. It waits on the platform desk; nothing is charged here, and the credits land once payment is confirmed.");
  const request = page.getByTestId("settings-topup-request").filter({ hasText: "Team" });
  await expect(request).toContainText("Team · 2,200 cr · waiting on the platform since");
  expect(await balanceOf(page)).toBe(before);
  const stored = () => platform(async (db) => (await db.execute({ sql: "SELECT status FROM topup_requests WHERE id=?", args: [posted.request.id] })).rows.map((r) => String(r.status)));
  expect(await stored()).toEqual(["requested"]);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="settings-fold-packs"]'), "Withdraw under 44×44").toEqual([]);
    await clearOfTabBar(page, page.getByTestId("settings-credits-note"));
  }
  await floors(page, '[data-testid="settings-topup-request"], [data-testid="settings-credits-note"]');
  await shot(page, info, "plans-requested");

  /* A second ask whose reply is dropped: the page does not claim either way, and the list shows what landed. */
  await page.route(/\/api\/workspaces\/topups$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fetch();
    return route.abort("connectionreset");
  });
  await packs.nth(0).getByTestId("settings-pack-request").click();
  await expect(page.getByTestId("settings-credits-note")).toHaveText("The request was not confirmed. Check Requests below before asking again; nothing is charged either way.");
  const starter = page.getByTestId("settings-topup-request").filter({ hasText: "Starter" });
  await expect(starter).toContainText("Starter · 500 cr · waiting on the platform since");
  await page.unroute(/\/api\/workspaces\/topups$/);
  await starter.getByTestId("settings-topup-withdraw").click();
  await expect(starter).toContainText("Starter · 500 cr · withdrawn");
  expect(await balanceOf(page)).toBe(before);

  /* Withdraw: marked withdrawn and kept, never erased. */
  await request.getByTestId("settings-topup-withdraw").click();
  await expect(page.getByTestId("settings-credits-note")).toHaveText("Request withdrawn.");
    await expect(request).toContainText("Team · 2,200 cr · withdrawn");
  await expect(request.getByTestId("settings-topup-withdraw")).toHaveCount(0);
  expect(await stored()).toEqual(["cancelled"]);
  /* A wheel (a finger) reaches the page's last element, and on a phone it ends above the tab bar. */
  await clearOfTabBar(page, plans.locator(".gs-page > *").last(), true);
  await noSideScroll(page);

  /* A member: the packs and their prices, no request control, and who to ask. */
  await setRole(s.workspaceId, "member");
  await page.reload();
  await expect(packs).toHaveCount(4);
  await expect(page.getByTestId("settings-pack-request")).toHaveCount(0);
  await expect(page.getByTestId("settings-top-up-ask")).toContainText("Ask an admin: the owner or an admin requests credits.");
  await expect(page.getByTestId("settings-topup-withdraw")).toHaveCount(0);
  const refused = await page.request.post("/api/workspaces/topups", { headers: { "X-Workbench-Scope": s.scope }, data: { packId: "starter" } });
  expect(refused.status()).toBe(403);
  await floors(page, '[data-testid="settings-pack"], [data-testid="settings-top-up-ask"]');
  await clearOfTabBar(page, plans.locator(".gs-page > *").last(), true);
  await noSideScroll(page);
  await shot(page, info, "plans-member");
  expect(errors).toEqual([]);
});

test("the credits pill turns amber when the balance is below the last price quoted, reads that quote without asking for one, and opens Plans", async ({ page }, info) => {
  test.skip(!DESKTOP_SIZES.includes(info.project.name), "the header's credits pill and the panel's takes stepper are the desktop shell's; the phone's credits (`phone-credits`) open Settings › Plan & credits (demo-s10-phone-workbench), and its Make shows Short by N cr · Top up (demo-s10-phone-make-workbench)");
  await seed(page);
  const balance = await balanceOf(page);
  /* The Generate button's own price read (GET /api/workbench/engines?model=…), answered with a figure one take
     can afford and two cannot. */
  const quotes: string[] = [];
  const price = Math.max(1, balance - 10);
  await page.route(/\/api\/workbench\/engines\?.*model=/, async (route) => {
    quotes.push(route.request().url());
    const response = await route.fetch();
    const json = await response.json();
    return route.fulfill({ response, json: { ...json, credits: price } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?make=video");
  const pill = page.getByTestId("workspace-credits");
  await expect(pill).toContainText(balance.toLocaleString("en-US"), { timeout: 60_000 });
  await expect(pill).not.toHaveAttribute("data-low");
  const generate = page.getByTestId("gen-generate");
  await page.getByTestId("gen-prompt").fill("A lighthouse beam sweeping fog at dusk");
  await expect(generate).toHaveText(`Make · ${price.toLocaleString("en-US")} cr`);
  /* A price the balance covers: not amber. */
  await expect(pill).not.toHaveAttribute("data-low");

  /* Two takes: the button's figure doubles from the quote already given — nothing is asked again — and the balance no longer covers it. */
  const asked = quotes.length;
  await openAdvanced(page);
  await page.getByTestId("gen-takes-2").click();
  await expect(generate).toHaveText(`Make 2 takes · ${(2 * price).toLocaleString("en-US")} cr`);
  await expect(pill).toHaveAttribute("data-low", "true");
  await expect(pill).toHaveAttribute("aria-label", `Credits: ${balance.toLocaleString("en-US")} cr, below the last price quoted, ${(2 * price).toLocaleString("en-US")} cr. Open Plans & credits`);
  expect(quotes.length).toBe(asked);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="workspace-credits"]'), "the pill under 44×44").toEqual([]);
  await floors(page, '[data-testid="workspace-credits"]');
  await noSideScroll(page);
  await whole(page, '[data-testid="workspace-credits"]');
  await shot(page, info, "pill-amber");

  /* It opens Plans & credits, and asks for no price on its way there. */
  await pill.click();
  await expect(page.getByTestId("settings-balance")).toBeVisible();
  await expect(pill).toHaveAttribute("data-low", "true");
  await page.waitForTimeout(500);
  expect(quotes.length).toBe(asked);
  expect(errors).toEqual([]);
});
