import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { noHorizontalOverflow } from "./helpers/appPagesAudit";
import { smallTargets } from "./phoneFloors";

/**
 * The rate-table Rig canvas (/rig/canvas) prices a node from the browser's rate
 * table and sends that figure as its run's ceiling. A setting the table cannot
 * price (Seedance's adaptive frame) used to read "0 cr", and its Run posted a
 * ceiling of 0. A node with no confirmed price now shows no price, cannot Run,
 * and says why; the quote route (free, nothing reserved) is asked about each
 * priced node's exact body, and its "no confirmed price" answer counts the same.
 * A priced node runs as before, at the price on its button.
 *
 * Real local routes against an ENGINE_MOCK server for the account, the board and
 * the quote. Where a test needs the quote route to disagree with the table, that
 * answer is intercepted; the paid route is intercepted in the one test that runs
 * a node, and never reached in the others. Nothing is billed.
 */

const ENGINE = "dreamina-seedance-2-0-260128";
const PHONES = ["workbench-360x640", "workbench-390x844"];
const WHY = "No confirmed price for this setting yet.";
const NO_PRICE_REPLY = { status: 400, json: { error: "This model has no confirmed price." } };
const KITE = { prompt: "A red kite over the salt flats at noon", resolution: "720p", seconds: 5, ratio: "16:9" };
const LANTERN = { prompt: "A lantern swinging in a stairwell", resolution: "720p", seconds: 5, ratio: "16:9" };
const WAVES = { prompt: "Waves folding over black sand", resolution: "720p", seconds: 5, ratio: "adaptive" };
type Sent = { path: string; body: Record<string, unknown> };

const video = (id: string, label: string, x: number, settings: Record<string, unknown>) => ({
  id, kind: "video", label, x, y: 64, ref: { engine: ENGINE }, ports: [], inputs: [], output: null, settings, state: "idle", credits: 0, staleSince: null,
});

async function openBoard(page: Page, nodes: ReturnType<typeof video>[]) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const made = await page.request.post("/api/projects", { data: { name: `Unpriced canvas ${randomUUID().slice(0, 6)}` } });
  expect(made.ok(), await made.text()).toBe(true);
  const projectId = (await made.json()).id as string;
  const created = await page.request.post("/api/rig/boards", { data: { projectId, name: "Price board" } });
  expect(created.ok(), await created.text()).toBe(true);
  const boardId = ((await created.json()).board as { id: string }).id;
  const put = await page.request.put(`/api/rig/boards/${boardId}`, { data: { nodes, wires: [] } });
  expect(put.ok(), await put.text()).toBe(true);
  /* Every generate request that leaves the page: the free quote, and the paid route with its check. */
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/generate(\/check|\/quote)?$/.test(path)) sent.push({ path, body: request.postDataJSON() });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    projectId, boardId, scope: `particl-active-${me.workspace.id}-${me.id}`, errors,
    paid: () => sent.filter((s) => s.path !== "/api/generate/quote").map((s) => s.path),
    quoted: () => sent.filter((s) => s.path === "/api/generate/quote").map((s) => s.body),
  };
}

/** A node's card: on the board (desktop), or in the phone's stack. */
const card = (page: Page, phone: boolean, label: string) =>
  phone ? page.locator(`[data-phone-board] [aria-label="Video ${label}"]`) : page.getByRole("article", { name: `Video ${label}` });
const cardRun = (page: Page, phone: boolean, label: string) => card(page, phone, label).getByRole("button", { name: /^Generate/ });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
/** Selecting a node: a press on its header, clear of its fields and its Run. */
const pick = (page: Page, phone: boolean, label: string) => card(page, phone, label).click({ position: { x: 24, y: 12 }, timeout: 60_000 });
const creditsOn = async (button: Locator) => Number(/(\d[\d,]*) cr/i.exec((await button.textContent()) ?? "")?.[1]?.replace(/,/g, "") ?? NaN);

/**
 * The UI floors on what this change draws (the reasons and the price slots): no
 * serif, 12px or more on a phone, a colour at #7C7C84 or brighter once its own
 * alpha and every opacity above it are laid over what is painted behind it, and
 * never cut short. Then no horizontal overflow, and 44px targets on a phone.
 */
async function floors(page: Page, phone: boolean, where: string, drawn: Locator[]) {
  for (const locator of drawn) {
    const problems = await locator.evaluateAll((els, phone) => els.flatMap((el) => {
      const out: string[] = [];
      const style = getComputedStyle(el);
      const name = `“${(el.textContent ?? "").trim().slice(0, 40)}”`;
      const families = style.fontFamily.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase());
      if (families.some((f) => f === "serif" || /times|georgia|garamond|palatino|cambria|baskerville/.test(f))) out.push(`${name}: serif in ${style.fontFamily}`);
      if (phone && Number.parseFloat(style.fontSize) < 12) out.push(`${name}: ${style.fontSize}`);
      const rgba = (c: string) => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const fg = rgba(style.color);
      if (!fg) return [...out, `${name}: unreadable colour ${style.color}`];
      let alpha = fg.a;
      for (let e: Element | null = el; e; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
      /* The ground is black; the first painted background behind the text, laid over it. */
      let bg = { r: 0, g: 0, b: 0 };
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) { bg = { r: c.r * c.a, g: c.g * c.a, b: c.b * c.a }; break; }
      }
      const mix = (k: "r" | "g" | "b") => fg[k] * alpha + bg[k] * (1 - alpha);
      const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
      if (0.2126 * mix("r") + 0.7152 * mix("g") + 0.0722 * mix("b") < floor) out.push(`${name}: ${style.color} is under #7C7C84 after alpha`);
      if (style.textOverflow === "ellipsis" || el.scrollWidth > el.clientWidth + 1) out.push(`${name}: cut short`);
      return out;
    }), phone);
    expect(problems, where).toEqual([]);
  }
  await noHorizontalOverflow(page);
  if (phone) expect(await smallTargets(page, "[data-phone-board], [data-pinned]"), `${where}: targets under 44×44`).toEqual([]);
}

test("a node with no confirmed price shows no price, cannot Run, says why, and sends nothing", async ({ page }, info) => {
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const f = await openBoard(page, [video("n_kite", "Kite", 16, KITE), video("n_lantern", "Lantern", 212, LANTERN), video("n_waves", "Waves", 408, WAVES)]);
  /* The server has no confirmed price for the adaptive frame: its quote route says so, as it stands. */
  const adaptive = await page.request.post("/api/generate/quote", {
    headers: { "X-Workbench-Scope": f.scope },
    data: { prompt: WAVES.prompt, model: ENGINE, projectId: f.projectId, resolution: "720p", ratio: "adaptive", duration: 5 },
  });
  expect(adaptive.status(), await adaptive.text()).toBe(400);
  expect((await adaptive.json()).error).toMatch(/no confirmed price/i);
  /* The lantern's setting is one the table prices, but the quote route answers that it has no confirmed price. */
  await page.route((url) => url.pathname === "/api/generate/quote", (route) =>
    String(route.request().postDataJSON()?.prompt ?? "").startsWith("A lantern") ? route.fulfill(NO_PRICE_REPLY) : route.fallback());
  await page.goto(`/rig/canvas/${f.boardId}`);

  /* A priced node keeps its price and its Run. */
  await expect(cardRun(page, phone, "Kite")).toContainText(/\d+ cr/i, { timeout: 60_000 });
  await expect(cardRun(page, phone, "Kite")).toBeEnabled();
  for (const label of ["Waves", "Lantern"]) {
    const run = cardRun(page, phone, label);
    await expect(run).toContainText("No price", { timeout: 30_000 });
    await expect(run).not.toContainText(/\d\s*cr/i);
    await expect(run).toBeDisabled();
    await expect(card(page, phone, label).getByText(WHY)).toBeVisible();
    /* Even a click that reached it runs nothing. */
    await run.dispatchEvent("click");
  }
  await expect(cardRun(page, phone, "Kite")).toBeEnabled();

  const drawn = [card(page, phone, "Waves").getByText(WHY), card(page, phone, "Lantern").getByText(WHY), card(page, phone, "Waves").getByText("No price"), card(page, phone, "Lantern").getByText("No price")];
  if (phone) {
    /* The pinned Run follows the chosen node: no price, shut, and why; a priced one keeps both. */
    const pinned = page.locator("[data-pinned]"), press = page.locator("[data-render]");
    for (const label of ["Waves", "Lantern"]) {
      await pick(page, true, label);
      await expect(pinned).toContainText(WHY);
      await expect(press).toContainText("No price");
      await expect(press).not.toContainText(/\d\s*cr/i);
      await expect(press).toBeDisabled();
      await press.dispatchEvent("click");
    }
    drawn.push(pinned.getByText(WHY), press.getByText("No price"));
    await floors(page, true, `${info.project.name}: no confirmed price`, drawn);
    await pick(page, true, "Kite");
    await expect(pinned).toContainText("Built on desktop");
    await expect(press).toContainText(/\d+ cr/i);
    await expect(press).toBeEnabled();
  } else {
    /* One node with no confirmed price leaves the lot unpriced. */
    const all = page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: /^Run unrun/ });
    await expect(all).toContainText("No price");
    await expect(all).not.toContainText(/\d\s*cr/i);
    await expect(all).toBeDisabled();
    await all.dispatchEvent("click");
    /* The Inspector's Run: no figure, shut, and why; a priced node keeps both. */
    const press = inspector(page).getByRole("button", { name: /^Run node/ });
    for (const label of ["Waves", "Lantern"]) {
      await pick(page, false, label);
      await expect(inspector(page)).toContainText(WHY);
      await expect(press).not.toContainText(/\d\s*cr/i);
      await expect(press).toBeDisabled();
      await press.dispatchEvent("click");
    }
    drawn.push(inspector(page).getByText(WHY), press, all);
    await floors(page, false, `${info.project.name}: no confirmed price`, drawn);
    await pick(page, false, "Kite");
    await expect(press).toContainText(/\d+ cr/i);
    await expect(press).toBeEnabled();
    await expect(inspector(page).getByText(WHY)).toHaveCount(0);
  }

  /* Nothing paid left the page. The quote route was asked about the two nodes the table prices, never the one it cannot. */
  await page.waitForTimeout(1000);
  expect(f.paid()).toEqual([]);
  const prompts = f.quoted().map((b) => b.prompt);
  expect(prompts).toEqual(expect.arrayContaining([KITE.prompt, LANTERN.prompt]));
  expect(prompts).not.toContain(WAVES.prompt);
  expect(f.errors).toEqual([]);
});

test("a Run pressed before the quote route answers waits for it, and sends nothing when there is no confirmed price", async ({ page }, info) => {
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const f = await openBoard(page, [video("n_lantern", "Lantern", 16, LANTERN)]);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let asked = 0;
  await page.route((url) => url.pathname === "/api/generate/quote", async (route) => {
    asked++;
    await held;
    await route.fulfill(NO_PRICE_REPLY);
  });
  await page.goto(`/rig/canvas/${f.boardId}`);
  let press: Locator;
  if (phone) press = page.locator("[data-render]");
  else {
    await pick(page, false, "Lantern");
    press = inspector(page).getByRole("button", { name: /^Run node/ });
  }
  /* The table's price is on the button while the quote route has not answered. */
  await expect(press).toContainText(/\d+ cr/i, { timeout: 60_000 });
  await expect(press).toBeEnabled();
  await press.click();
  await expect.poll(() => asked, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(f.paid()).toEqual([]);

  release();
  await expect(page.getByRole("status").filter({ hasText: WHY })).toBeVisible({ timeout: 30_000 });
  await expect(press).toBeDisabled();
  await expect(press).not.toContainText(/\d\s*cr/i);
  await expect(cardRun(page, phone, "Lantern")).toContainText("No price");
  await page.waitForTimeout(1000);
  expect(f.paid()).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("a priced node still runs at the price on its button", async ({ page }, info) => {
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const f = await openBoard(page, [video("n_kite", "Kite", 16, KITE)]);
  /* The paid route answers with a job and the job keeps rendering: nothing is admitted, nothing is billed. */
  const posted: Record<string, unknown>[] = [];
  await page.route((url) => url.pathname === "/api/generate", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { id: "gen_rigprice", status: "queued" } });
  });
  await page.route((url) => url.pathname === "/api/jobs/gen_rigprice", (route) => route.fulfill({ json: { generation: { id: "gen_rigprice", status: "running" } } }));
  await page.goto(`/rig/canvas/${f.boardId}`);
  let press: Locator;
  if (phone) press = page.locator("[data-render]");
  else {
    await pick(page, false, "Kite");
    press = inspector(page).getByRole("button", { name: /^Run node/ });
  }
  await expect(press).toContainText(/\d+ cr/i, { timeout: 60_000 });
  await expect(press).toBeEnabled();
  /* The quote route has been asked about this node's run, and has a price for it. */
  await expect.poll(() => f.quoted().length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(cardRun(page, phone, "Kite")).toBeEnabled();
  const price = await creditsOn(press);
  expect(price).toBeGreaterThan(0);
  expect(await creditsOn(cardRun(page, phone, "Kite"))).toBe(price);

  await press.click();
  await expect.poll(() => posted.length, { timeout: 30_000 }).toBe(1);
  /* The body the node describes, its ceiling the price on the button; the same body, less the ceiling, is what was quoted. */
  expect(posted[0]).toMatchObject({ model: ENGINE, prompt: KITE.prompt, projectId: f.projectId, resolution: "720p", ratio: "16:9", duration: 5, maxCredits: price });
  const { maxCredits, ...unceilinged } = posted[0];
  expect(maxCredits).toBe(price);
  expect(f.quoted()).toContainEqual(unceilinged);
  /* Accepted, and followed: the node is rendering. */
  if (phone) await expect(press).toContainText("Running");
  else await expect(press).toHaveAttribute("aria-busy", "true");
  await page.waitForTimeout(500);
  expect(posted).toHaveLength(1);
  expect(f.paid()).toEqual(["/api/generate"]);
  expect(f.errors).toEqual([]);
});
