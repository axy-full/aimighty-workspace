import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { openSuitesMenu } from "./helpers/suitesMenu";
import { newProject } from "../lib/workbench/studio";
import { billCredits, creditUsd, creditsFigure, fromDeci, marginKeyOf, toDeci, usdToCredits } from "../lib/creditTerms";
import { packLine, packRequestLabel, type TopupPack } from "../lib/shell/workspace-view";
import { estimateCostUsd } from "../lib/vendorPricing";

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
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.CREDITS_OUT_SHOTS;
const SEEDANCE = "dreamina-seedance-2-0-260128";

type Seeded = { workspaceId: string; userId: string; scope: string; production: string };

async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}
async function tenant<T>(workspaceId: string, fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const url = await platform(async (db) => String((await db.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url));
  expect(url).toMatch(/^file:/);
  const db = createClient({ url, timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}
const setRole = (workspaceId: string, role: "owner" | "admin" | "member") =>
  platform((db) => db.execute({ sql: "UPDATE memberships SET role=? WHERE workspace_id=?", args: [role, workspaceId] }));
/* A grant as the app writes one: in today's credits, saying so (unit_usd; this runner and the mock server share the default). */
const grant = (workspaceId: string, credits: number) =>
  platform((db) => db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at,unit_usd) VALUES(?,?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, credits, "Credits out fixture", "manual", "test", Date.now(), creditUsd()] }));
/** Credits added and taken in whole tenths, so a figure on the page is compared with an exact one. */
const plus = (a: number, b: number) => fromDeci(toDeci(a) + toDeci(b));
const minus = (a: number, b: number) => fromDeci(toDeci(a) - toDeci(b));
const fig = (n: number) => creditsFigure(n);

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

/** Every held take here is this take: what the mock engine renders, and bills, once one is released. */
const SHAPE = { ratio: "16:9", resolution: "720p", duration: 5 } as const;

/** The engine dollars that bill exactly `needs` credits for a Seedance take (lib/creditTerms.ts billCredits),
 *  at the credit's price: this runner and the server both read CREDIT_USD, unset on the local mock server. */
function dollarsFor(needs: number): number {
  const est = (needs - 0.05) / usdToCredits(1, marginKeyOf("video", SEEDANCE));
  expect(billCredits(est, marginKeyOf("video", SEEDANCE))).toBe(needs);
  return est;
}

/**
 * What SHAPE costs as the Generate route prices a take it holds (lib/generationAdmission.ts estimateCostUsd): its
 * engine dollars, and the credits they bill. The mock engine bills a released take by the same measure when its
 * render ends (lib/ark.ts mockTokensFor), so a take held at this price settles at what its release charged. A take
 * held at any other figure settles at this one instead, and the first jobs read that reconciles what is in flight
 * after the render ends (a reload's: app/api/jobs/route.ts) moves the balance in the middle of the test.
 */
const RUN_USD = estimateCostUsd(SEEDANCE, SHAPE.resolution, SHAPE.ratio, SHAPE.duration)?.net ?? 0;
const RUN = billCredits(RUN_USD, marginKeyOf("video", SEEDANCE));

/** A take held at zero for credits, in this project, written as lib/held.ts parks one; priced to bill `needs` unless `estUsd` says otherwise. */
async function heldTake(s: Seeded, title: string, needs: number, by: string, estUsd = dollarsFor(needs)) {
  const id = `gen_held_${randomUUID().replaceAll("-", "")}`;
  await tenant(s.workspaceId, (db) => db.execute({
    sql: `INSERT INTO generations(id,model,prompt,title,params,status,kind,provider,billed_to,created_by,project_id,task,created_at,updated_at)
          VALUES(?,?,?,?,?,'held','video','byteplus','byteplus',?,?,'generate',?,?)`,
    args: [id, SEEDANCE, `${title}, a slow push in`, title, JSON.stringify({ ...SHAPE, watermark: false, held: { estUsd, needs, at: Date.now(), why: "credits" } }),
      by, s.production, Date.now() - 60_000, Date.now() - 60_000],
  }));
  return id;
}
const takeRow = (s: Seeded, id: string) => tenant(s.workspaceId, async (db) =>
  (await db.execute({ sql: "SELECT status, json_extract(params,'$.releasedAt') AS released FROM generations WHERE id=?", args: [id] })).rows[0]);
const meterRows = (id: string) => platform(async (db) => (await db.execute({ sql: "SELECT billed_credits FROM meter_events WHERE id=?", args: [id] })).rows.map((r) => Number(r.billed_credits)));

const tile = (scope: Locator, name: string) => scope.getByTestId("take-tile").filter({ hasText: name });

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
const PRICES = '[data-testid="take-chip"], [data-testid="take-need"], [data-testid="take-release"], [data-testid="workspace-credits"]';

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}

test("owner: a held take says what it needs and releases at that price, once; still short is the route's 402 with the way to credits", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const s = await seed(page);
  await grant(s.workspaceId, 20);
  const before = await balanceOf(page);
  const short = plus(before, 40);
  /* Tenths on purpose: every check below that nothing is cut runs on a figure with a decimal. */
  const dawn = await heldTake(s, "Harbour dawn", 15.3, s.userId);
  const storm = await heldTake(s, "Storm front", short, s.userId);
  /* A long price, for the checks that nothing is cut. */
  await heldTake(s, "Night ferry across the outer harbour", 12_345.6, s.userId);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=takes");
  const takes = page.getByTestId("edit-takes");
  /* The first page a fresh dev server compiles can take a while. */
  await expect(tile(takes, "Harbour dawn")).toBeVisible({ timeout: 60_000 });

  /* Its own state: held, not rendering; the need on the chip and the exact price on Release. */
  await expect(tile(takes, "Harbour dawn")).toHaveAttribute("data-status", "held");
  await expect(tile(takes, "Harbour dawn").getByTestId("take-chip")).toHaveText("Held · needs 15.3 cr");
  await expect(tile(takes, "Storm front").getByTestId("take-chip")).toHaveText(`Held · needs ${fig(short)} cr`);
  await expect(takes.getByRole("button", { name: "Release Harbour dawn · 15.3 cr", exact: true })).toBeVisible();
  /* Every price shows whole, in this font and in a wider one; on a narrow tile the need moves under the name. */
  await expect(tile(takes, "Night ferry").getByTestId("take-release")).toHaveText("Release Night ferry across the outer harbour · 12,345.6 cr");
  await whole(page, PRICES);
  let normal = await widerSans(page);
  await whole(page, PRICES);
  await shot(page, info, "held-takes-wide-font");
  await normal();
  /* Gen's results wear the same card: the whole label on the chip where the tile is wide enough. */
  await openSuitesMenu(page);
  await page.locator('[data-suite-tab="gen"]').click();
  const results = page.getByRole("region", { name: "Results" });
  await expect(tile(results, "Night ferry").getByTestId("take-chip")).toHaveText("Held · needs 12,345.6 cr");
  await expect(tile(results, "Night ferry").getByTestId("take-release")).toBeVisible();
  await whole(page, PRICES);
  normal = await widerSans(page);
  await whole(page, PRICES);
  await normal();
  await openSuitesMenu(page);
  await page.locator('[data-suite-tab="studio"]').click();
  if (!(await takes.isVisible())) await page.goto("/suites?suite=studio&page=takes");
  await expect(tile(takes, "Harbour dawn").getByTestId("take-release")).toBeVisible();

  /* Still short: the route's own words, the way to credits, and nothing charged. */
  await tile(takes, "Storm front").getByTestId("take-release").click();
  const note = tile(takes, "Storm front").getByTestId("take-release-note");
  await expect(note).toContainText(`Still short: this needs ${fig(short)} credits and ${fig(before)} are left.`);
  await expect(note.getByTestId("take-release-credits")).toHaveText("Add credits");
  expect(await takeRow(s, storm)).toMatchObject({ status: "held", released: null });
  expect(await meterRows(storm)).toEqual([]);
  expect(await balanceOf(page)).toBe(before);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="edit-takes"] [data-testid="take-release-row"]'), "Release under 44×44").toEqual([]);
    await clearOfTabBar(page, note);
  }
  await floors(page, '[data-testid="edit-takes"] [data-testid="take-release-row"]');
  await noSideScroll(page);
  await shot(page, info, "held-short");

  /* Enough: charged at admission, once, and the card moves on. */
  await takes.getByRole("button", { name: "Release Harbour dawn · 15.3 cr", exact: true }).click();
  await expect(page.getByTestId("toast")).toHaveText("Harbour dawn released · 15.3 cr");
  await expect(tile(takes, "Harbour dawn")).not.toHaveAttribute("data-status", "held");
  await expect(tile(takes, "Harbour dawn").getByTestId("take-release")).toHaveCount(0);
  expect(await meterRows(dawn)).toEqual([15.3]);
  expect(Number((await takeRow(s, dawn)).released)).toBeGreaterThan(0);
  await expect.poll(() => balanceOf(page)).toBe(minus(before, 15.3));
  /* The header reads the balance again at once. */
  await expect(page.getByTestId("workspace-credits")).toContainText(fig(minus(before, 15.3)));

  /* A wheel (a finger) reaches the page's last row (the Takes desk's grid ends the page), and on a phone it ends above the tab bar. */
  await clearOfTabBar(page, page.getByTestId("takes-grid").locator(":scope > *").last(), true);

  /* The Inspector's Release is the take's own: moving to another held take brings no word or price across. */
  const wide = WIDE.includes(info.project.name);
  if (!wide) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  const assets = page.getByTestId("library-assets");
  await tile(assets, "Storm front").locator(".gx-asset-thumb").click();
  const inspector = page.getByTestId("asset-inspector");
  await expect(page.getByTestId("inspector-title")).toHaveText("Storm front");
  /* Held at zero has reserved nothing: the usage ledger (#407) has no row for it yet. */
  const settledFact = page.getByTestId("asset-facts").locator("div").filter({ hasText: /^Settled/ });
  await expect(settledFact).toHaveText("SettledNothing charged yet");
  await inspector.getByTestId("take-release").click();
  await expect(inspector.getByTestId("take-release-note")).toContainText("Still short");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="inspector-release"]'), "Inspector Release under 44×44").toEqual([]);
  if (!wide) {
    await page.getByTestId("close-inspector").click();
    if (!(await assets.isVisible())) await page.getByTestId("toggle-library").click();
    if (!(await assets.isVisible())) await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  }
  await tile(assets, "Night ferry").locator(".gx-asset-thumb").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Night ferry across the outer harbour");
  await expect(inspector.getByTestId("take-release")).toHaveText("Release Night ferry across the outer harbour · 12,345.6 cr");
  await expect(inspector.getByTestId("take-release-note")).toHaveCount(0);
  if (!wide) {
    await page.getByTestId("close-inspector").click();
    if (!(await assets.isVisible())) await page.getByTestId("toggle-library").click();
    if (!(await assets.isVisible())) await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  }
  /* Released, it was charged at admission: the ledger holds its 15.3 cr while it runs, then charges them. */
  await tile(assets, "Harbour dawn").locator(".gx-asset-thumb").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Harbour dawn");
  await expect(settledFact).toHaveText(/^Settled(Held · 15\.3 cr|15\.3 cr)$/);
  await expect(inspector.getByTestId("take-release")).toHaveCount(0);
  if (!wide) await page.getByTestId("close-inspector").click();

  /* Add credits opens Plans & credits. */
  await tile(takes, "Storm front").getByTestId("take-release-credits").click();
  await expect(page.getByTestId("ws-plans")).toBeVisible();
  expect(await meterRows(dawn)).toEqual([15.3]);
  expect(errors).toEqual([]);
});

test("admin and member: an admin releases a teammate's take, and a lost reply pressed again charges nothing more; a member releases only their own", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const s = await seed(page);
  await grant(s.workspaceId, 30);
  const before = await balanceOf(page);
  const mate = `acct_${randomUUID().slice(0, 8)}`;
  /* Released below, so priced as it will render (RUN): the member's reload reconciles it once the mock has
     finished it, and the balance it settles at is the one its release left. */
  expect(RUN).toBeGreaterThan(0);
  const theirs = await heldTake(s, "Lamp line", RUN, mate, RUN_USD);
  /* Priced over the balance, so nothing settling in the background can start them. */
  const theirsShort = await heldTake(s, "Ferry turn", plus(before, 50), mate);
  const mine = await heldTake(s, "Tide pool", plus(before, 60), s.userId);
  await setRole(s.workspaceId, "admin");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=takes");
  const takes = page.getByTestId("edit-takes");
  await expect(tile(takes, "Lamp line").getByTestId("take-chip")).toHaveText(`Held · needs ${fig(RUN)} cr`, { timeout: 60_000 });

  /* A gateway's page instead of the route's answer: not claimed either way, and nothing reached the route. */
  await page.route("**/api/jobs/*/release", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" }), { times: 1 });
  await tile(takes, "Lamp line").getByTestId("take-release").click();
  await expect(tile(takes, "Lamp line").getByTestId("take-release-note")).toHaveText("The release was not confirmed. Press Release again to check — it is never charged twice.");
  expect(await meterRows(theirs)).toEqual([]);

  /* The first reply is lost on the way back: the release happened, the page was not told. */
  let lose = true;
  await page.route("**/api/jobs/*/release", async (route) => {
    if (!lose) return route.fallback();
    lose = false;
    await route.fetch();
    return route.abort("connectionreset");
  });
  await tile(takes, "Lamp line").getByTestId("take-release").click();
  await expect(tile(takes, "Lamp line").getByTestId("take-release-note")).toContainText("The release was not confirmed. Press Release again to check");
  expect(await meterRows(theirs)).toEqual([RUN]);
  /* Pressed again: already released, and charged once. */
  await tile(takes, "Lamp line").getByTestId("take-release").click();
  await expect(page.getByTestId("toast")).toHaveText("Lamp line was already released.");
  await expect(tile(takes, "Lamp line")).not.toHaveAttribute("data-status", "held");
  expect(await meterRows(theirs)).toEqual([RUN]);
  await expect.poll(() => balanceOf(page)).toBe(minus(before, RUN));

  /* A member: their own take carries Release; a teammate's does not, here or in the Inspector. */
  await setRole(s.workspaceId, "member");
  await page.reload();
  await expect(tile(takes, "Tide pool").getByTestId("take-chip")).toHaveText(`Held · needs ${fig(plus(before, 60))} cr`);
  await expect(tile(takes, "Ferry turn").getByTestId("take-chip")).toHaveText(`Held · needs ${fig(plus(before, 50))} cr`);
  await expect(tile(takes, "Ferry turn").getByTestId("take-release")).toHaveCount(0);
  await tile(takes, "Tide pool").getByTestId("take-release").click();
  const note = tile(takes, "Tide pool").getByTestId("take-release-note");
  await expect(note).toContainText(`Still short: this needs ${fig(plus(before, 60))} credits and ${fig(minus(before, RUN))} are left.`);
  await expect(note.getByTestId("take-release-ask")).toHaveText("Ask an admin for credits.");
  await expect(note.getByTestId("take-release-credits")).toHaveCount(0);
  expect(await meterRows(mine)).toEqual([]);
  /* The route refuses a member on a teammate's take whatever the page shows. */
  const refused = await page.request.post(`/api/jobs/${theirsShort}/release`, { headers: { "X-Workbench-Scope": s.scope }, data: { credits: plus(before, 50) } });
  expect(refused.status()).toBe(403);
  expect(await meterRows(theirsShort)).toEqual([]);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="edit-takes"] [data-testid="take-release-row"]'), "Release under 44×44").toEqual([]);
    await clearOfTabBar(page, note);
  }
  await floors(page, '[data-testid="edit-takes"] [data-testid="take-release-row"]');
  await shot(page, info, "held-member");

  /* The Inspector: Release on their own take, nothing on a teammate's. */
  if (!wide) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  const assets = page.getByTestId("library-assets");
  await tile(assets, "Ferry turn").locator(".gx-asset-thumb").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Ferry turn");
  await expect(page.getByTestId("asset-facts")).toContainText(`Held · needs ${fig(plus(before, 50))} cr`);
  await expect(page.getByTestId("asset-inspector").getByTestId("take-release")).toHaveCount(0);
  if (!wide) {
    await page.getByTestId("close-inspector").click();
    if (!(await assets.isVisible())) await page.getByTestId("toggle-library").click();
    if (!(await assets.isVisible())) await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  }
  await tile(assets, "Tide pool").locator(".gx-asset-thumb").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Tide pool");
  const inInspector = page.getByTestId("asset-inspector").getByTestId("take-release");
  await expect(inInspector).toHaveText(`Release Tide pool · ${fig(plus(before, 60))} cr`);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="inspector-release"]'), "Inspector Release under 44×44").toEqual([]);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("Plans & credits: the owner requests a pack and withdraws it, kept as withdrawn, nothing sent; a member is told to ask an admin", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const s = await seed(page);
  await grant(s.workspaceId, 120);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* The first read fails: said, with Try again, and no packs are guessed at. */
  let failRead = true;
  await page.route(/\/api\/workspaces\/topups$/, (route) => (failRead && route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: "Credits are not answering right now." } }) : route.fallback()));
  await page.goto("/suites?view=workspace&tab=credits");
  const plans = page.getByTestId("ws-plans");
  const packs = page.getByTestId("ws-pack");
  await expect(page.getByTestId("ws-topups-error")).toContainText("Credits are not answering right now.", { timeout: 60_000 });
  await expect(packs).toHaveCount(0);
  failRead = false;
  await page.getByTestId("ws-topups-error").getByRole("button", { name: "Try again" }).click();
  await expect(packs).toHaveCount(4);
  await expect(page.getByTestId("ws-topups-error")).toHaveCount(0);
  /* Priced by the platform's own packs(): credits, bonus and the pack's dollar price, the one dollar figure here. */
  const served = (await (await page.request.get("/api/workspaces/topups")).json()).packs as TopupPack[];
  expect(served.map((p) => p.id)).toEqual(["starter", "team", "studio", "agency"]);
  const [starterPack, teamPack] = served;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(packs).toHaveText(served.map((p) => new RegExp(`${p.label}\\s*${escape(packLine(p))}`)));
  await expect(packs.nth(1).getByTestId("ws-pack-request")).toHaveText(packRequestLabel(teamPack));
  await expect(page.getByTestId("ws-grant").filter({ hasText: "Credits out fixture" })).toContainText("+120 cr");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="ws-packs"]'), "pack buttons under 44×44").toEqual([]);
  await floors(page, '[data-testid="ws-pack"], [data-testid="ws-grant"], [data-testid="workspace-credits"]');
  await noSideScroll(page);
  const packPrices = '[data-testid="ws-pack-request"], .wsx-pack-line, .wsx-list-amount, [data-testid="workspace-credits"]';
  await whole(page, packPrices);
  await widerSans(page);
  await whole(page, packPrices);
  await noSideScroll(page);
  await page.reload();
  await expect(packs).toHaveCount(4);

  /* Request: queued for the platform, nothing charged, and no mail without a key. */
  const before = await balanceOf(page);
  const reply = page.waitForResponse((r) => r.url().endsWith("/api/workspaces/topups") && r.request().method() === "POST");
  await packs.nth(1).getByTestId("ws-pack-request").click();
  const posted = await (await reply).json();
  expect(posted).toMatchObject({ emailed: false, checkout: { kind: "queued" }, request: { label: "Team", credits: teamPack.credits, bonus: teamPack.bonus, usd: teamPack.usd, status: "requested" } });
  await expect(page.getByTestId("ws-plans-note")).toHaveText("Requested. It waits on the platform desk; nothing is charged here, and the credits land once payment is confirmed.");
  const request = page.getByTestId("ws-topup-request").filter({ hasText: "Team" });
  await expect(request).toContainText(`Team · ${teamPack.total.toLocaleString("en-US")} cr · waiting on the platform since`);
  expect(await balanceOf(page)).toBe(before);
  const stored = () => platform(async (db) => (await db.execute({ sql: "SELECT status FROM topup_requests WHERE id=?", args: [posted.request.id] })).rows.map((r) => String(r.status)));
  expect(await stored()).toEqual(["requested"]);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="ws-topup-requests"]'), "Withdraw under 44×44").toEqual([]);
    await clearOfTabBar(page, page.getByTestId("ws-plans-note"));
  }
  await floors(page, '[data-testid="ws-topup-request"], [data-testid="ws-plans-note"]');
  await shot(page, info, "plans-requested");

  /* A second ask whose reply is dropped: the page does not claim either way, and the list shows what landed. */
  await page.route(/\/api\/workspaces\/topups$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fetch();
    return route.abort("connectionreset");
  });
  await packs.nth(0).getByTestId("ws-pack-request").click();
  await expect(page.getByTestId("ws-plans-note")).toHaveText("The request was not confirmed. Check Requests below before asking again; nothing is charged either way.");
  const starter = page.getByTestId("ws-topup-request").filter({ hasText: "Starter" });
  await expect(starter).toContainText(`Starter · ${starterPack.total.toLocaleString("en-US")} cr · waiting on the platform since`);
  await page.unroute(/\/api\/workspaces\/topups$/);
  await starter.getByTestId("ws-topup-withdraw").click();
  await expect(starter).toHaveAttribute("data-status", "cancelled");
  expect(await balanceOf(page)).toBe(before);

  /* Withdraw: marked withdrawn and kept, never erased. */
  await request.getByTestId("ws-topup-withdraw").click();
  await expect(page.getByTestId("ws-plans-note")).toHaveText("Request withdrawn.");
  await expect(request).toHaveAttribute("data-status", "cancelled");
  await expect(request).toContainText(`Team · ${teamPack.total.toLocaleString("en-US")} cr · withdrawn`);
  await expect(request.getByTestId("ws-topup-withdraw")).toHaveCount(0);
  expect(await stored()).toEqual(["cancelled"]);
  /* A wheel (a finger) reaches the page's last element, and on a phone it ends above the tab bar. */
  await clearOfTabBar(page, plans.locator(":scope > *").last(), true);
  await noSideScroll(page);

  /* A member: the packs and their prices, no request control, and who to ask. */
  await setRole(s.workspaceId, "member");
  await page.reload();
  await expect(packs).toHaveCount(4);
  await expect(page.getByTestId("ws-pack-request")).toHaveCount(0);
  await expect(page.getByTestId("ws-packs-ask")).toHaveText("Ask an admin: the owner or an admin requests credits.");
  await expect(page.getByTestId("ws-topup-withdraw")).toHaveCount(0);
  const refused = await page.request.post("/api/workspaces/topups", { headers: { "X-Workbench-Scope": s.scope }, data: { packId: "starter" } });
  expect(refused.status()).toBe(403);
  await floors(page, '[data-testid="ws-pack"], [data-testid="ws-packs-ask"]');
  await clearOfTabBar(page, plans.locator(":scope > *").last(), true);
  await noSideScroll(page);
  await shot(page, info, "plans-member");
  expect(errors).toEqual([]);
});

test("the credits pill turns amber when the balance is below the last price quoted, reads that quote without asking for one, and opens Plans", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
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
  await page.goto("/suites?view=gen");
  const pill = page.getByTestId("workspace-credits");
  await expect(pill).toContainText(balance.toLocaleString("en-US"), { timeout: 60_000 });
  await expect(pill).not.toHaveAttribute("data-low");
  const generate = page.getByTestId("gen-generate");
  await page.getByRole("textbox", { name: "Direction", exact: true }).fill("A lighthouse beam sweeping fog at dusk");
  await expect(generate).toHaveText(`Generate · ${price.toLocaleString("en-US")} cr`);
  /* A price the balance covers: not amber. */
  await expect(pill).not.toHaveAttribute("data-low");

  /* Two takes: the button's figure doubles from the quote already given — nothing is asked again — and the balance no longer covers it. */
  const asked = quotes.length;
  await page.getByRole("group", { name: "Takes per generate" }).getByRole("button", { name: "More" }).click();
  await expect(generate).toHaveText(`Generate 2 takes · ${(2 * price).toLocaleString("en-US")} cr`);
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
  await expect(page.getByTestId("ws-plans")).toBeVisible();
  await expect(pill).toHaveAttribute("data-low", "true");
  await page.waitForTimeout(500);
  expect(quotes.length).toBe(asked);
  expect(errors).toEqual([]);
});
