import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";
import { isCompact, shellIsPhone } from "./helpers/shellMode";

/**
 * Stream 10, PR 5: Make and the Atomik sheet on the phone (design/particl-graphite/README.md § 3.6, frames F and G),
 * behind the new-interface switch. Make is stream 6's logic on today's composer: the words, the type, the engine
 * line with Change, the references with Add, where it lands, and Make at the quoted price, pinned. The Atomik sheet
 * answers a question free from the how-to table, fills Make for "make …" (a person presses Make) and prices a request
 * before it can be asked. Against a local ENGINE_MOCK server; the send is answered here, and nothing is spent.
 */
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const SHOTS = process.env.S10_SHOTS;
const shot = async (page: Page, project: string, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project.replace("workbench-", "")}-${name}.png` }); };

/** `credits` is a grant on top of the new workspace's own balance; 0 grants nothing (a short balance is what the spec wants). */
async function seed(page: Page, credits = 5000) {
  const workspaceId = (await signInWithNewInterface(page.request)).workspace.id;
  if (credits !== 0) {
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, credits, "Phone Make fixture", "manual", "test", Date.now()] });
    } finally { db.close(); }
  }
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const name = `Phone ${randomUUID().slice(0, 6)}`;
  const project = newProject(name);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const seen: { generates: { maxCredits?: unknown; quoteFingerprint?: unknown }[]; errors: string[] } = { generates: [], errors: [] };
  /* The send is answered here: nothing reaches an engine. */
  await page.route("**/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    seen.generates.push(route.request().postDataJSON() as { maxCredits?: unknown });
    return route.fulfill({ status: 400, json: { error: "Fixture: not sent to an engine." } });
  });
  page.on("pageerror", (error) => seen.errors.push(error.message));
  return { name, seen, project };
}

/** Make keeps the words a person typed (lib/draft.ts): the warm-up's words would come back into the "empty" box after its reload, so they are let go first. */
const forgetDrafts = (page: Page) => page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("aw_draft:")) localStorage.removeItem(key); });

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function floors(page: Page, where: string) {
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, ".ph-app"), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, ".ph-app"), `${where}: labels under the floor`).toEqual([]);
  expect(await noOverflow(page), `${where}: sideways overflow`).toBe(true);
}

test("Make: the words, the type, the engine line with Change, References with Add, where it lands, and Make at its price", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths");
  test.setTimeout(180_000);
  const { name, seen } = await seed(page);
  /* A cold dev server reloads once while it first compiles Make's routes: warm them first. */
  await page.goto("/suites?screen=make");
  await page.getByTestId("phone-make-prompt").fill("make shot 2 at golden hour");
  await expect(page.getByTestId("phone-make-go")).toHaveText(/cr$/, { timeout: 90_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
  await forgetDrafts(page);
  await page.goto("/suites?screen=make");
  await expect(page.getByTestId("phone-title")).toHaveText("Make");
  await expect(page.getByTestId("phone-tab-make")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("phone-make-prompt")).toHaveAttribute("placeholder", "make shot 2 at golden hour");
  await expect(page.getByRole("radiogroup", { name: "Type" }).getByRole("radio")).toHaveText(["Video", "Image", "Audio"]);
  await expect(page.getByTestId("phone-make-add")).toHaveText("Add");
  await expect(page.getByTestId("phone-make-change")).toHaveText("Change");
  await expect(page.getByTestId("phone-make-dest")).toHaveText(`Lands in ${name} · Library, and on the board.`);
  /* Empty, Make waits; pressing it says why and sends nothing. */
  const go = page.getByTestId("phone-make-go");
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(go).toHaveAttribute("data-spend", "unpriced");
  await go.dispatchEvent("click");
  await expect(page.getByTestId("phone-make-blocked")).toHaveText("Say what to make.");
  await floors(page, "Make, empty");
  await shot(page, info.project.name, "make-empty");

  /* With words, the engine line and the button carry the server's quote. */
  await page.getByTestId("phone-make-prompt").fill("a fox crosses a frozen harbour at dusk");
  await expect(go).toHaveText(/^Make · [\d.,]+ cr$/, { timeout: 60_000 });
  await expect(page.getByTestId("phone-make-engine-line")).toContainText(/ · [\d.,]+ cr$/);
  await expect(go).toHaveAttribute("title", /^\$[\d.]+$/);
  await floors(page, "Make, priced");
  await shot(page, info.project.name, "make");

  /* Change: this type's engines, each priced where the composer stands. */
  await page.getByTestId("phone-make-change").click();
  const rows = page.getByTestId("phone-make-engine-row");
  await expect(rows.first()).toBeVisible();
  await floors(page, "Make, engines");
  await shot(page, info.project.name, "make-engines");
  await page.getByTestId("phone-sheet-close").click();
  await expect(page.getByTestId("phone-make-engines")).toHaveCount(0);

  /* Add: the project's pictures and videos (none yet). */
  await page.getByTestId("phone-make-add").click();
  await expect(page.getByTestId("phone-make-nopics")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("phone-make-refs-sheet")).toHaveCount(0);
  expect(seen.generates).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Make sends once, at the price on its button", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths");
  test.setTimeout(180_000);
  const { seen } = await seed(page);
  await page.goto("/suites?screen=make");
  await page.getByTestId("phone-make-prompt").fill("a fox crosses a frozen harbour at dusk");
  const go = page.getByTestId("phone-make-go");
  await expect(go).toHaveText(/^Make · [\d.,]+ cr$/, { timeout: 90_000 });
  await expect(go).toHaveAttribute("data-spend", "priced");
  const price = Number((await go.innerText()).replace(/[^\d.]/g, ""));
  await go.click();
  await expect.poll(() => seen.generates.length, { timeout: 30_000 }).toBe(1);
  expect(Number(seen.generates[0].maxCredits)).toBeGreaterThanOrEqual(price);
  expect(seen.generates[0].quoteFingerprint).toBeTruthy();
});

test("the Make tab and a make= address open the phone's Make, not the desktop panel", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await seed(page);
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-make").click();
  await expect(page).toHaveURL(/screen=make/);
  await expect(page.getByTestId("phone-make")).toBeVisible();
  await page.goto("/suites?make=image");
  await expect(page.getByTestId("phone-make")).toBeVisible();
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await expect(page.getByTestId("phone-make-type-image")).toHaveAttribute("aria-checked", "true");
});

test("the Atomik sheet: a how-to is answered free with an offer; \"make …\" fills Make and a person presses it", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths");
  test.setTimeout(120_000);
  const { seen } = await seed(page);
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-atomik").click();
  const sheet = page.getByTestId("phone-atomik");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("phone-atomik-cost")).toHaveText("How-to answers are free");
  await expect(page.getByTestId("phone-atomik-send")).toHaveText("Ask · free");
  await expect(page.getByTestId("phone-atomik-hints")).toContainText("How do I add a reference to a shot?");
  await floors(page, "Atomik sheet");
  await shot(page, info.project.name, "atomik");
  /* The Home tab's screen is still under it. */
  await page.getByTestId("phone-atomik-input").fill("how do I add a reference?");
  await expect(page.getByTestId("phone-atomik-cost")).toHaveText("A question about Particl · answered free");
  await page.getByTestId("phone-atomik-send").click();
  const lines = page.getByTestId("phone-atomik-line");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("how do I add a reference?");
  await expect(lines.nth(1)).toContainText("Atomik");
  await expect(lines.nth(1)).toContainText("Library");
  await expect(page.getByTestId("phone-atomik-offer")).toHaveText("Open the Library");
  await floors(page, "Atomik sheet, answered");
  await shot(page, info.project.name, "atomik-answered");
  /* "make …" fills Make; Make is then the person's to press. */
  await page.getByTestId("phone-atomik-input").fill("make shot 2 at golden hour");
  await page.getByTestId("phone-atomik-send").click();
  await expect(page).toHaveURL(/screen=make/);
  await expect(page.getByTestId("phone-make-prompt")).toHaveValue("shot 2 at golden hour");
  expect(seen.generates).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("the Atomik sheet closes back to the screen it opened over; Esc and the scrim close it", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await seed(page);
  await page.goto("/suites?screen=record");
  await page.getByTestId("phone-tab-atomik").click();
  await expect(page.getByTestId("phone-atomik")).toBeVisible();
  await expect(page.getByTestId("phone-record")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("phone-atomik")).toHaveCount(0);
  await expect(page).toHaveURL(/screen=record/);
  await page.getByTestId("phone-tab-atomik").click();
  await page.getByTestId("phone-scrim").click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId("phone-atomik")).toHaveCount(0);
  await expect(page.getByTestId("phone-record")).toBeVisible();
});

test("offline: the sheet's request and Make say they need a connection", async ({ page, context }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await seed(page);
  await page.goto("/suites?screen=make");
  await expect(page.getByTestId("phone-make")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("phone-make-go")).toHaveText("Needs a connection");
  await context.setOffline(false);
});

test("device=phone frames Make and the Atomik sheet at 390 px on a desktop, with no overflow", async ({ page }, info) => {
  test.skip(isCompact(info), "desktop widths");
  test.setTimeout(180_000);
  await seed(page);
  await page.goto("/suites?device=phone&screen=make");
  await expect(page.getByTestId("phone-make")).toBeVisible({ timeout: 90_000 });
  expect(Math.round((await page.getByTestId("phone-app").boundingBox())!.width)).toBe(390);
  await floors(page, "Framed Make");
  await shot(page, info.project.name, "framed-make");
  await page.getByTestId("phone-tab-atomik").click();
  await expect(page.getByTestId("phone-atomik")).toBeVisible();
  await floors(page, "Framed Atomik sheet");
  const sheet = (await page.getByRole("dialog", { name: "Atomik" }).boundingBox())!;
  const frame = (await page.getByTestId("phone-app").boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(frame.x - 1);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  await shot(page, info.project.name, "framed-atomik");
});

/* ── The phone's twins of the desktop panel's money tests (demo-s06-make, demo-s07-panel). The desktop specs skip at compact
 *    widths because the shell mounts this phone app there; these keep every price, ceiling and "nothing is sent" assertion. ── */

/** What Atomik's sheet may send: turns (the paid route), memory writes and approvals. A free line sends none of them. */
function watchAtomik(page: Page) {
  const seen: { turns: { path: string; body: Record<string, unknown> | null }[]; memory: string[]; released: string[] } = { turns: [], memory: [], released: [] };
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const path = new URL(r.url()).pathname;
    if (path === "/api/atomik/memory") seen.memory.push(path);
    else if (/^\/api\/jobs\/[^/]+\/release$/.test(path)) seen.released.push(path);
    else if (/^\/api\/atomik\/[^/]+$/.test(path) && !["memory", "skills", "threads", "ideas", "treatment"].includes(path.split("/")[3])) {
      const body = r.postDataJSON() as Record<string, unknown> | null;
      if (body?.quoteOnly !== true) seen.turns.push({ path, body });
    }
  });
  return seen;
}

/** Twin of demo-s06-make "Change: the type's engines priced in cr with dollars on hover". */
test("phone Make, Change: every engine row ends in its price in cr, with the dollars on hover", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths; the desktop panel's own is demo-s06-make");
  test.setTimeout(180_000);
  const { seen } = await seed(page);
  await page.goto("/suites?screen=make");
  await page.getByTestId("phone-make-prompt").fill("make shot 2 at golden hour");
  const go = page.getByTestId("phone-make-go");
  await expect(go).toHaveText(/^Make · [\d.,]+ cr$/, { timeout: 90_000 });
  await page.getByTestId("phone-make-change").click();
  const list = page.getByTestId("phone-make-engines");
  const rows = list.getByTestId("phone-make-engine-row");
  await expect(rows.first()).toBeVisible();
  /* The engine in use is the pressed row. */
  await expect(list.locator('[data-testid="phone-make-engine-row"][aria-pressed="true"]')).toHaveCount(1);
  /* Every figure is "N cr" with its dollars on hover, or "free"; an engine with no figure draws none (never a guess). */
  await expect(list.locator(".gx-price").first()).toHaveText(/^\d[\d,]*(\.\d)? cr$/, { timeout: 60_000 });
  const prices = list.locator(".gx-price");
  expect(await prices.count(), "at least one engine is priced").toBeGreaterThan(0);
  for (const price of await prices.all()) {
    const words = (await price.innerText()).trim();
    expect(words).toMatch(/^\d[\d,]*(\.\d)? cr$|^free$/);
    if (words !== "free") await expect(price).toHaveAttribute("title", /^\$\d[\d,]*\.\d\d?$/);
  }
  /* The price sits on its own row, never cut off: it is inside the row and the row is inside the sheet. */
  for (const row of await rows.all()) {
    const price = row.locator(".gx-price");
    if (!(await price.count())) continue;
    const [r, p] = [await row.boundingBox(), await price.boundingBox()];
    expect(p!.x + p!.width, "a price is never cut by its row").toBeLessThanOrEqual(r!.x + r!.width + 1);
  }
  expect(await list.innerText()).not.toMatch(/\bquoted\b|\babout \d/i);
  await floors(page, "Make, engines priced");
  /* Choosing a row prices Make's button at that engine, in the same units. */
  await rows.first().click();
  await expect(page.getByTestId("phone-make-engines")).toHaveCount(0);
  await expect(go).toHaveText(/^Make · [\d.,]+ cr$/, { timeout: 60_000 });
  expect(seen.generates, "nothing is sent").toEqual([]);
  expect(seen.errors).toEqual([]);
});

/** Twin of demo-s06-make "a balance short of the price says by how much, with Top up, and Make stays pressable". */
test("phone Make, a balance short of the price: Short by N cr · Top up, Make still pressable, nothing sent", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths; the desktop panel's own is demo-s06-make");
  test.setTimeout(180_000);
  /* A new workspace holds 250 cr and the phone has no takes or size controls to push a price past that, so the fixture is a
     workspace that holds 1 cr (a manual grant of -249): the engine line's price is more than it holds. */
  const { seen } = await seed(page, -249);
  await page.goto("/suites?screen=make");
  await page.getByTestId("phone-make-prompt").fill("make shot 2 at golden hour");
  const go = page.getByTestId("phone-make-go");
  await expect(go).toHaveText(/^Make · [\d.,]+ cr$/, { timeout: 90_000 });
  const short = page.getByTestId("phone-make-short");
  await expect(short).toContainText(/Short by \d[\d,.]* cr/);
  await expect(short.getByTestId("phone-make-topup")).toHaveText("Top up");
  /* Make is still pressable: the take would wait, held, until credits arrive. */
  await expect(go).toHaveText(/^Make · [\d.,]+ cr$/);
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  await expect(go).toHaveAttribute("data-spend", "priced");
  await floors(page, "Make, short");
  await shot(page, info.project.name, "make-short");
  await page.getByTestId("phone-make-topup").click();
  await expect(page).toHaveURL(/tab=credits/);
  expect(seen.generates, "nothing is sent").toEqual([]);
  expect(seen.errors).toEqual([]);
});

/** Twin of demo-s07-panel "a request: Ask · up to N cr from the server, sent with N as its ceiling". */
test("the Atomik sheet, a request: Ask · up to N cr from the server, sent with N as its ceiling, answered in the thread", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths; the desktop panel's own is demo-s07-panel");
  test.setTimeout(180_000);
  await seed(page);
  const atomik = watchAtomik(page);
  /* A cold dev server reloads once while it first compiles the quote routes (Fast Refresh, which empties the box): warm them first. */
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-atomik").click();
  await page.getByTestId("phone-atomik-input").fill("plan a short film about the market at dawn");
  await expect(page.getByTestId("phone-atomik-send")).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 60_000 }).catch(() => undefined);
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-atomik").click();
  await expect(page.getByTestId("phone-atomik")).toBeVisible();
  await page.getByTestId("phone-atomik-input").fill("plan a short film about the market at dawn");
  const send = page.getByTestId("phone-atomik-send");
  await expect(send).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 30_000 });
  await expect(send).toHaveAttribute("title", /^up to \$[\d.,]+$|^\$[\d.,]+$/);
  const shown = Number((await send.textContent())!.match(/up to (\d+) cr/)![1]);
  await expect(page.getByTestId("phone-atomik-cost")).toHaveText(/^Atomik’s thinking may cost up to \d+ cr · it plans and prices first; nothing is spent without your approval$/);
  expect(atomik.turns, "nothing is sent before the press").toEqual([]);
  await floors(page, "Atomik sheet, priced");
  await shot(page, info.project.name, "atomik-ask-priced");
  await send.click();
  const thread = page.getByTestId("phone-atomik-thread-line");
  await expect(thread.first()).toContainText("plan a short film about the market at dawn", { timeout: 30_000 });
  await expect(thread.nth(1)).toBeVisible({ timeout: 30_000 });
  expect(atomik.turns).toHaveLength(1);
  /* The figure on the button is the ceiling the turn was sent with: nothing above it can be charged. */
  expect(Math.ceil(Number(atomik.turns[0].body?.maxCredits))).toBe(shown);
  expect(Number(atomik.turns[0].body?.maxCredits)).toBeLessThanOrEqual(shown);
  expect(await noOverflow(page)).toBe(true);
  expect(atomik.released, "Atomik approves nothing").toEqual([]);
  await shot(page, info.project.name, "atomik-thread");
});

/** Twin of demo-s07-panel "commands never spend", and of "Ask Atomik how: answered free" (its "Ask · free" and no paid request). */
test("the Atomik sheet, commands and how-to are free: nothing is sent, approved or remembered by Atomik", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths; the desktop panel's own is demo-s07-panel");
  test.setTimeout(120_000);
  await seed(page);
  const atomik = watchAtomik(page);
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-atomik").click();
  const input = page.getByTestId("phone-atomik-input");
  const send = page.getByTestId("phone-atomik-send");
  const lines = page.getByTestId("phone-atomik-line");
  /* A how-to: free, and its answer is on the page. */
  await input.fill("how do I see what each run cost?");
  await expect(send).toHaveText("Ask · free");
  await send.click();
  await expect(lines.last()).toContainText("Activity shows what each run settled at.");
  /* Approve: Atomik lists nothing it can press; the person approves each item on Home with its own price. */
  await input.fill("approve everything under 10 cr");
  await expect(send).toHaveText("Ask · free");
  await send.click();
  await expect(lines.last()).toContainText("You approve each one yourself.");
  await expect(lines.last().getByTestId("phone-atomik-offer")).toHaveText("Open Home");
  /* Remember: Atomik keeps nothing by itself; a person confirms on Memory's page. */
  await input.fill("remember our films open on a detail");
  await expect(send).toHaveText("Ask · free");
  await send.click();
  await expect(lines.last()).toContainText("where you confirm it");
  await page.waitForTimeout(500);
  expect(atomik.turns, "no paid Atomik request").toEqual([]);
  expect(atomik.released, "approve approves nothing").toEqual([]);
  expect(atomik.memory, "remember writes nothing until a person confirms").toEqual([]);
  await floors(page, "Atomik sheet, commands");
});

/** The helper's rule and the shell's own agree at every size: 844x390 is a phone. */
test("shellMode says what the shell mounts: the phone app at the three small sizes, not at the two large", async ({ page }, info) => {
  await seed(page);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId(isCompact(info) ? "phone-app" : "home")).toBeVisible({ timeout: 90_000 });
  expect(await shellIsPhone(page)).toBe(isCompact(info));
  await expect(page.getByTestId("phone-app")).toHaveCount(isCompact(info) ? 1 : 0);
});

/**
 * Twin of demo-s06-make "the quick tools open over the panel". Motion transfer and Object swap stay in Release 1 (lead, 6 Oct), but the
 * phone app draws no quick tool today: `?make=motion` and `?make=swap` show Home (components/graphite/phone/phone-model.ts › readPhone draws
 * Make only, and SuitesShell mounts MakePanel only when the phone app is off). PRODUCT GAP, not a test fault: this is what the phone
 * must do once it draws them, fixme until then so the skip of the desktop test is not a silent drop. Nothing is sent either way.
 */
test("the quick tools on a phone: Motion transfer and Object swap open from their address, and nothing is sent", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths; the desktop panel's own is demo-s06-make");
  test.fixme(true, "product gap: the phone app draws no quick tools; ?make=motion|swap shows Home on a phone");
  const { seen } = await seed(page);
  for (const [tool, title] of [["motion", "Motion transfer"], ["swap", "Object swap"]] as const) {
    await page.goto(`/suites?make=${tool}`);
    await expect(page.getByTestId("phone-title")).toHaveText(title);
    await expect(page.getByTestId("phone-home")).toHaveCount(0);
    await floors(page, title);
  }
  expect(seen.generates, "nothing is sent").toEqual([]);
  expect(seen.errors).toEqual([]);
});
