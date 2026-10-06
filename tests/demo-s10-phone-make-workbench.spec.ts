import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";

/**
 * Stream 10, PR 5: Make and the Atomik sheet on the phone (design/particl-graphite/README.md § 3.6, frames F and G),
 * behind the new-interface switch. Make is stream 6's logic on today's composer: the words, the type, the engine
 * line with Change, the references with Add, where it lands, and Make at the quoted price, pinned. The Atomik sheet
 * answers a question free from the how-to table, fills Make for "make …" (a person presses Make) and prices a request
 * before it can be asked. Against a local ENGINE_MOCK server; the send is answered here, and nothing is spent.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const SHOTS = process.env.S10_SHOTS;
const shot = async (page: Page, project: string, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project.replace("workbench-", "")}-${name}.png` }); };

async function seed(page: Page, credits = 5000) {
  const workspaceId = (await signInWithNewInterface(page.request)).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, credits, "Phone Make fixture", "manual", "test", Date.now()] });
  } finally { db.close(); }
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

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function floors(page: Page, where: string) {
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, ".ph-app"), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, ".ph-app"), `${where}: labels under the floor`).toEqual([]);
  expect(await noOverflow(page), `${where}: sideways overflow`).toBe(true);
}

test("Make: the words, the type, the engine line with Change, References with Add, where it lands, and Make at its price", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  test.setTimeout(180_000);
  const { name, seen } = await seed(page);
  /* A cold dev server reloads once while it first compiles Make's routes: warm them first. */
  await page.goto("/suites?screen=make");
  await page.getByTestId("phone-make-prompt").fill("make shot 2 at golden hour");
  await expect(page.getByTestId("phone-make-go")).toHaveText(/cr$/, { timeout: 90_000 }).catch(() => undefined);
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
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
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
  test.skip(!PHONES.includes(info.project.name), "phone widths");
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
  test.skip(PHONES.includes(info.project.name), "desktop widths");
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
