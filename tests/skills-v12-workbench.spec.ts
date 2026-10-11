import { test, expect, type Page } from "@playwright/test";
import { seedHome } from "./helpers/v12Home";
import { openBoard } from "./helpers/boardV12";

/**
 * The "/" skills list in the new interface's bar (redesign P6-d; docs/redesign/inventory.md § 10.4), on Home, on a board and in
 * Make. It opens above the bar while the words are a command being typed, once (the prototype drew it twice on Home), with
 * each row's price from the quote layer: a built-in's is the engines route's, a saved skill's is its free preview's. Picking
 * only writes "/slug " into the bar: nothing is asked of any paid route. Enter on a saved skill's command opens its run form,
 * which plans nothing until its own button is pressed there. Local ENGINE_MOCK server; skills are answered here.
 * At phone sizes the phone app is unchanged with the switch on.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const BUILT_INS = ["product-video-ad", "talking-review", "unboxing", "try-on", "tutorial", "product-voice-over", "website-walk-through", "photoshoot"];
const SAVED = { id: "skill_wave1", slug: "wave-runner-spot", name: "Wave runner spot", description: "A short spot for a product" };

const skillView = (over: Record<string, unknown> = {}) => ({
  id: SAVED.id, slug: SAVED.slug, name: SAVED.name, description: SAVED.description, scope: "workspace", status: "active", version: 1,
  byYou: true, byName: null, editedByYou: true, editedByName: null, archivedByYou: false, archivedByName: null, archivedAt: null, createdAt: 1, updatedAt: 2, canChangeScope: true,
  template: { parameters: [{ key: "product", label: "Product", default: "Red high-tops" }], steps: [{ kind: "image", title: "Still of {{product}}", prompt: "A still of {{product}}", model: "nano-banana-2", params: {} }] },
  ...over,
});

/** The skills routes, answered here: the list, and the free preview. A run that files a plan is refused; the spec never presses one. */
async function mockSkills(page: Page) {
  const seen: { dryRun: boolean }[] = [];
  await page.route((url) => url.pathname.startsWith("/api/atomik/skills"), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/atomik/skills") return route.fulfill({ json: { skills: [skillView()] } });
    if (request.method() === "POST" && /\/run$/.test(url.pathname)) {
      const body = request.postDataJSON() as { dryRun?: boolean };
      seen.push({ dryRun: body.dryRun === true });
      if (body.dryRun !== true) return route.fulfill({ status: 500, json: { error: "Not in this test." } });
      return route.fulfill({ json: { preview: { steps: [{ index: 0, kind: "image", title: "Still of Red high-tops", prompt: "A still of Red high-tops", model: "nano-banana-2", label: "Nano Banana 2", params: {}, estCredits: 6, estUsd: null, swapped: false }], problems: [], values: { product: "Red high-tops" } } } });
    }
    return route.fallback();
  });
  return seen;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
}
const box = (page: Page, id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height }; });

/** The list as a person reads it: once, with its header, the saved skill first, the built-ins in the Formats stage's order, each with a price. */
async function checkList(page: Page, prefix: string, saved = true) {
  const list = page.getByTestId(`${prefix}-skills`);
  await expect(list).toHaveCount(1);
  await expect(list).toBeVisible();
  await expect(list).toContainText("Skills · each shows its quote before it runs");
  const rows = page.getByTestId(`${prefix}-skill`);
  await expect(rows).toHaveCount(BUILT_INS.length + (saved ? 1 : 0), { timeout: 30_000 });
  expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")))).toEqual([...(saved ? [SAVED.slug] : []), ...BUILT_INS]);
  /* Each row ends in a price word from the quote layer: never a bare figure from the page. */
  for (const price of await list.locator(".v12-bar-skill-price").all()) await expect(price).toHaveText(/^(\d[\d,]* cr|up to \d[\d,]* cr|free|quoted|…|—)$/, { timeout: 30_000 });
  if (saved) await expect(rows.first().locator(".v12-bar-skill-price")).toHaveText("up to 6 cr", { timeout: 30_000 });
  /* Not built: quoted, with its reason on hover, and nothing to pick. */
  for (const slug of ["product-voice-over", "website-walk-through"]) {
    const row = list.locator(`[data-slug="${slug}"]`);
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row.locator(".v12-bar-skill-price")).toHaveText("quoted");
  }
  /* The list sits on the screen, above the bar, and the page does not scroll sideways. */
  const at = await box(page, `${prefix}-skills`);
  const size = page.viewportSize()!;
  expect(at.x).toBeGreaterThanOrEqual(0);
  expect(at.r).toBeLessThanOrEqual(size.width + 1);
  expect(at.y).toBeGreaterThanOrEqual(0);
  expect(at.h).toBeLessThanOrEqual(361);
  await noOverflow(page);
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Home: '/' lists the skills once, priced; picking writes the command and asks nothing paid; Enter opens the saved skill's form", async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await seedHome(page);
    const seen = await mockSkills(page);
    const paid: string[] = [];
    await page.route(/\/api\/(generate|audio|atomik|workbench\/team-canvas)(\/[^?]*)?(\?.*)?$/, (route) => {
      const r = route.request();
      if (r.method() === "POST" && !/\/api\/atomik\/skills\//.test(r.url()) && r.postDataJSON()?.quoteOnly !== true) paid.push(`${r.method()} ${new URL(r.url()).pathname}`);
      return route.fallback();
    });
    await page.goto("/suites?view=home");
    await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
    const input = page.getByTestId("v12-home-bar-input");
    await input.fill("/");
    await checkList(page, "v12-home-bar");

    /* Typing narrows it; Esc closes it and leaves the words. */
    await input.fill("/tut");
    await expect(page.getByTestId("v12-home-bar-skill")).toHaveText([/\/tutorial/]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-home-bar-skills")).toHaveCount(0);
    await expect(input).toHaveValue("/tut");

    /* Picking a built-in writes "/slug " and says its quote is shown before it runs. Nothing paid is asked. */
    await input.fill("/unb");
    await expect(page.getByTestId("v12-home-bar-skill")).toHaveCount(1);
    await page.getByTestId("v12-home-bar-skill").first().click();
    await expect(input).toHaveValue("/unboxing ");
    await expect(page.getByTestId("v12-toast")).toContainText("/unboxing · its quote is shown before it runs");
    await expect(page.getByTestId("v12-home-bar-skills")).toHaveCount(0);
    /* A format is made from a Campaign board: from Home, Enter says so and leaves the words. */
    await input.press("Enter");
    await expect(page.getByTestId("v12-toast")).toContainText("Formats are made from a Campaign board's Formats stage.");
    /* The toast sits over the foot of the list for its few seconds: wait it out, as a person would, before choosing again. */
    await page.mouse.move(4, 4);
    await expect(page.getByTestId("v12-toast")).toHaveCount(0, { timeout: 15_000 });

    /* A not-built one cannot be picked: its reason is said and the words stay. */
    await input.fill("/product-voice");
    await expect(page.getByTestId("v12-home-bar-skill")).toHaveCount(1);
    await page.getByTestId("v12-home-bar-skill").first().click({ force: true });
    await expect(input).toHaveValue("/product-voice");
    await expect(page.getByTestId("v12-toast")).toContainText("No brief or engine makes narrated pack shots yet.");
    await page.mouse.move(4, 4);
    await expect(page.getByTestId("v12-toast")).toHaveCount(0, { timeout: 15_000 });

    /* The saved skill: its command, then Enter opens its run form. The only request it made was the free preview. */
    await input.fill("/wave");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("/wave-runner-spot ");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("skill-dialog")).toBeVisible();
    await expect(page.getByTestId("skill-dialog")).toContainText("Wave runner spot");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.dryRun)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("skill-dialog")).toHaveCount(0);

    /* A "/" in the middle of the words is just a character. */
    await input.fill("a film about / and back");
    await expect(page.getByTestId("v12-home-bar-skills")).toHaveCount(0);
    expect(paid, "nothing paid is asked").toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a board: '/' lists the skills above the board's bar; a format on a board that is not a Campaign says where to make it", async ({ page }) => {
    test.setTimeout(300_000);
    const { errors } = await openBoard(page, "/suites?view=board&stage=storyboard");
    await mockSkills(page);
    const input = page.getByTestId("v12-board-bar-inner-input");
    await expect(input).toBeVisible({ timeout: 60_000 });
    await input.fill("/");
    await checkList(page, "v12-board-bar-inner");
    await input.fill("/tutorial ");
    await input.press("Enter");
    await expect(page.getByTestId("v12-toast")).toContainText("Formats are made from a Campaign board's Formats stage.");
    expect(errors).toEqual([]);
  });

  test("Make: '/' lists the skills above the composer", async ({ page }) => {
    test.setTimeout(300_000);
    await seedHome(page);
    await mockSkills(page);
    await page.goto("/suites?view=make");
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    const input = page.getByTestId("v12-make-bar-input");
    await input.fill("/");
    await checkList(page, "v12-make-bar");
    await page.getByTestId("v12-make-bar-skill").nth(3).click();
    await expect(input).toHaveValue("/unboxing ");
  });
});

test("phones keep today's phone app, and no list opens there", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone sizes");
  test.setTimeout(240_000);
  await seedHome(page);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home-bar")).toHaveCount(0);
  await noOverflow(page);
});
