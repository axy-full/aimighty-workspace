import { test, expect, type Page } from "@playwright/test";
import { seedHome, signInSwitchedOn } from "./helpers/v12Home";

/**
 * Make as a page in the new interface (redesign C3; docs/redesign/inventory.md § 5.12). With the switch on at desktop
 * sizes: the workspace's results in justified rows, the docked composer on the shared bar (modes, chips, the server's
 * price on Make, prompt reuse that fills the words), the viewer (←/→, Esc on the overlay stack, download free), and a
 * press that goes through today's priced send and stays on the page. At phone sizes the phone app is unchanged.
 * Local ENGINE_MOCK server: the press is a mock render.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
}

test("desktop: results in justified rows, the composer, prompt reuse, the viewer, and a priced press that stays", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=make");
  const make = page.getByTestId("v12-make");
  await expect(make).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("make-panel")).toHaveCount(0);

  /* Results: newest first, counted, under a day divider; each row fills the grid's width. */
  const tiles = page.getByTestId("v12-make-tile");
  await expect(tiles).toHaveCount(6, { timeout: 60_000 });
  await expect(page.getByTestId("v12-make-count")).toHaveText("6 results");
  await expect(page.getByTestId("v12-make-day").first()).toContainText("Today");
  await expect(tiles.first()).toHaveAttribute("data-state", "ready");
  const fill = await page.evaluate(() => {
    const grid = document.querySelector(".v12-mk-grid")!.getBoundingClientRect();
    const row = document.querySelector(".v12-mk-row")!;
    const last = row.lastElementChild!.getBoundingClientRect();
    return { grid: Math.round(grid.right), row: Math.round(last.right), rows: document.querySelectorAll(".v12-mk-row").length };
  });
  if (fill.rows > 1) expect(Math.abs(fill.grid - fill.row)).toBeLessThanOrEqual(2);

  /* The Library sits beside the composer, at the composer's height. */
  await expect(page.getByTestId("v12-make-library")).toBeVisible();
  await expect(page.getByTestId("v12-make-library")).toHaveAttribute("title", /^Library · L/);

  /* The composer: six modes, Auto first; Make waits for words, then carries the server's price. */
  const modes = page.getByRole("radiogroup", { name: "What to make" }).getByRole("radio");
  await expect(modes).toHaveText(["Auto", "Image", "Video", "Audio", "Remix", "Edit"]);
  await expect(modes.first()).toHaveAttribute("aria-checked", "true");
  const input = page.getByTestId("v12-make-bar-input");
  await expect(input).toHaveAttribute("placeholder", "Describe anything · Atomik picks the model and settings");
  const go = page.getByTestId("v12-make-go");
  await expect(go).toBeDisabled();
  await page.getByRole("radio", { name: "Image" }).click();
  await expect(input).toHaveAttribute("placeholder", "Describe a still · @ to pull from the library");
  await input.fill("A paper kite over a grey sea");
  await expect(go).toHaveText(/^Make( \d takes)? · \d[\d,]* cr$/, { timeout: 60_000 });
  await expect(go).toHaveAttribute("data-spend", "priced");
  await expect(go).toBeEnabled();
  await expect(page.getByTestId("v12-make-chip-model")).toContainText("Model");
  /* The Model chip carries one take's price, the server's. */
  await expect(page.getByTestId("v12-make-chip-price")).toHaveText(/^\d[\d,]* cr$/, { timeout: 60_000 });
  await expect(page.getByTestId("v12-make-chip-count")).toContainText("Count");
  await page.getByTestId("v12-make-chip-count").click();
  await page.getByRole("menuitem", { name: "2" }).click();
  await expect(page.getByTestId("v12-make-chip-count")).toContainText("2");
  await expect(go).toHaveText(/^Make( \d takes)? · \d[\d,]* cr$/, { timeout: 60_000 });

  /* Focus on the words shows on the docked card (rule 15): a 2px ring that is not there without focus. */
  const card = page.getByTestId("v12-make-bar").locator(".v12-bar-card");
  const ring = () => card.evaluate((el) => { const c = getComputedStyle(el); return `${c.outlineStyle} ${c.outlineWidth} ${c.borderTopColor}`; });
  await page.getByRole("radio", { name: "Image" }).focus();
  const unfocused = await ring();
  await input.focus();
  const focused = await ring();
  expect(focused).not.toBe(unfocused);
  expect(focused).toMatch(/^solid 2px /);

  /* Remix and Edit: ops, and Make waits on a choice. */
  await page.getByRole("radio", { name: "Remix" }).click();
  await expect(page.getByTestId("v12-make-ops")).toContainText("what do we do with it?");
  await expect(go).toHaveText("Pick what to do");
  await expect(go).toBeDisabled();
  await expect(page.locator('[data-op="cut"]')).toBeDisabled();
  await page.getByRole("radio", { name: "Edit" }).click();
  await expect(page.getByTestId("v12-make-op")).toHaveCount(6);
  await page.getByRole("radio", { name: "Image" }).click();
  await noOverflow(page);

  /* Prompt reuse (the prototype's bug, fixed): the caption's words land in the composer's own input. */
  const firstTile = tiles.first();
  await firstTile.hover();
  const caption = firstTile.getByTestId("v12-make-tile-caption");
  const words = (await caption.innerText()).trim();
  await caption.click();
  await expect(input).toHaveValue(words);
  await expect(page.getByText("Prompt and settings loaded into the composer").first()).toBeVisible();

  /* @ pulls one of the results in as a reference. */
  await page.getByTestId("v12-make-bar-mention-button").click();
  await page.getByTestId("v12-make-bar-mention").first().click();
  await expect(page.getByTestId("v12-make-ref")).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("v12-make-ref").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("v12-make-ref")).toHaveCount(0);

  /* The viewer: ‹ › and ←/→ step, Esc closes it first (Make stays), download is free. */
  await firstTile.getByTestId("v12-make-tile-open").click();
  const viewer = page.getByTestId("v12-make-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId("v12-make-viewer-count")).toHaveText("1 / 6");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-make-viewer-count")).toHaveText("2 / 6");
  await page.getByTestId("v12-make-viewer-prev").click();
  await expect(page.getByTestId("v12-make-viewer-count")).toHaveText("1 / 6");
  await expect(page.getByTestId("v12-make-viewer-download")).toHaveAttribute("href", /\/api\/media\/.+\?download=1$/);
  await expect(page.getByTestId("v12-make-viewer-download")).toContainText("free");
  await expect(page.getByTestId("v12-make-viewer-cost")).toContainText(/\d cr/);
  await expect(page.getByTestId("v12-make-viewer-reuse")).toContainText("Variations");
  /* No take made here carries a seed, so no seed row (the seeded case is the next test). */
  await expect(page.getByTestId("v12-make-viewer-seed")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(make).toBeVisible();

  /* A press goes through today's priced send, at the figure on the button; the page stays and the take joins the results. */
  await input.fill("A paper kite over a grey sea");
  await page.getByTestId("v12-make-chip-count").click();
  await page.getByRole("menuitem", { name: "1" }).click();
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  const shown = Number((await go.innerText()).match(/· ([\d,]+) cr$/)![1].replace(/,/g, ""));
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/generate" && r.method() === "POST");
  await go.click();
  const body = (await sent).postDataJSON() as { maxCredits?: number };
  expect(body.maxCredits, "the approval is the figure on the button").toBe(shown);
  await expect(make).toBeVisible();
  await expect(page.getByTestId("v12-make-count")).toHaveText("7 results", { timeout: 90_000 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("desktop: ?view=make&viewer=1 opens the viewer on the newest result, with its seed; an empty workspace says where results go", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(240_000);
  await seedHome(page, { takes: 2 });
  /* A take that recorded its seed (Seedance through MCP can): the reply is given one here, as no mock take carries one. */
  await page.route(/\/api\/jobs\?limit=/, async (route) => {
    const reply = await route.fetch();
    const body = await reply.json();
    if (body.generations?.[0]) body.generations[0].params = { ...body.generations[0].params, seed: 8841 };
    await route.fulfill({ response: reply, json: body });
  });
  await page.goto("/suites?view=make&viewer=1");
  await expect(page.getByTestId("v12-make-viewer")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-make-viewer-count")).toHaveText("1 / 2");
  /* The seed shows; Reuse seed waits until Make's send can carry a seed, and says so rather than promise a repeat. */
  await expect(page.getByTestId("v12-make-viewer-seed")).toContainText("Seed 8841");
  await expect(page.getByTestId("v12-make-viewer-meta")).toContainText("seed 8841");
  await expect(page.getByTestId("v12-make-viewer-reuse-seed")).toBeDisabled();
  await expect(page.getByTestId("v12-make-viewer-reuse-seed")).toHaveAttribute("title", /comes when Make can send one/);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-make-viewer-count")).toHaveText("2 / 2");
  await expect(page.getByTestId("v12-make-viewer-seed")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-make-viewer-count")).toHaveText("1 / 2");
  await page.getByTestId("v12-make-viewer-close").click();
  await expect(page.getByTestId("v12-make-viewer")).toHaveCount(0);
  /* The opening address is read once: Home and back to Make opens Make without the viewer. */
  await page.getByTestId("brand-home").click();
  await expect(page.getByTestId("v12-make")).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press("Alt+KeyM");
  await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("v12-make-tile")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("v12-make-viewer")).toHaveCount(0);

  await page.context().clearCookies();
  await signInSwitchedOn(page);
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make-empty")).toHaveText("What you make shows here. Describe it below and press Make.", { timeout: 90_000 });
  await noOverflow(page);
});

test("desktop: the open viewer stays on its take when a new take lands at the front; viewer=1 on an empty workspace is spent once results load", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(240_000);
  await seedHome(page, { takes: 2 });
  /* The results are read again while takes render and after a press: a take that arrives is put at the front here. */
  let seen: Record<string, unknown>[] = [];
  let arriving: Record<string, unknown> | null = null;
  await page.route(/\/api\/jobs\?limit=/, async (route) => {
    const reply = await route.fetch();
    const body = await reply.json();
    if (Array.isArray(body.generations)) {
      if (body.generations.length) seen = body.generations;
      if (arriving) body.generations.unshift(arriving);
    }
    await route.fulfill({ response: reply, json: body });
  });
  const reread = () => page.evaluate(() => window.dispatchEvent(new Event("particl:jobs")));
  await page.goto("/suites?view=make");
  const tiles = page.getByTestId("v12-make-tile");
  await expect(tiles).toHaveCount(2, { timeout: 90_000 });
  await tiles.nth(1).getByTestId("v12-make-tile-open").click();
  const count = page.getByTestId("v12-make-viewer-count");
  const words = page.getByTestId("v12-make-viewer-prompt");
  await expect(count).toHaveText("2 / 2");
  const open = (await words.innerText()).trim();
  arriving = { ...seen[0], id: "arriving-take-0001", createdAt: Date.now() + 60_000 };
  await reread();
  await expect(tiles).toHaveCount(3, { timeout: 30_000 });
  await expect(words).toHaveText(open);
  await expect(count).toHaveText("3 / 3");
  /* ← moves from where the take is now. */
  await page.keyboard.press("ArrowLeft");
  await expect(count).toHaveText("2 / 3");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v12-make-viewer")).toHaveCount(0);

  /* An empty workspace opened with viewer=1: the request is spent when the results load, so the first take to land later
     does not open the viewer by itself. */
  const first = arriving;
  arriving = null;
  await page.context().clearCookies();
  await signInSwitchedOn(page);
  await page.goto("/suites?view=make&viewer=1");
  /* Loaded (not "Reading your results…"): the request is spent here. */
  await expect(page.getByTestId("v12-make-empty")).toHaveText("What you make shows here. Describe it below and press Make.", { timeout: 90_000 });
  arriving = first;
  await reread();
  await expect(tiles).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("v12-make-viewer")).toHaveCount(0);
});

test("desktop: a quick tool over the Make page goes back to the page with Esc or ×, never leaving Make", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(240_000);
  await seedHome(page, { takes: 1 });
  await page.goto("/suites?view=make");
  const make = page.getByTestId("v12-make");
  await expect(make).toBeVisible({ timeout: 90_000 });
  const tool = page.getByTestId("make-panel");
  for (const how of ["Escape", "×"] as const) {
    await page.getByRole("radio", { name: "Edit" }).click();
    await page.locator('[data-op="upscale"]').click();
    await expect(tool).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/make=upscale/);
    await expect(page.getByTestId("make-close")).toHaveAttribute("title", "Close · Esc");
    if (how === "Escape") {
      await page.getByTestId("make-title").click();
      await page.keyboard.press("Escape");
    } else await page.getByTestId("make-close").click();
    await expect(tool, `${how} closes the tool`).toHaveCount(0);
    await expect(make, `${how} keeps the Make page`).toBeVisible();
    await expect(page).toHaveURL(/make=(image|video|audio)/);
  }
});

test("phone sizes: the phone app is unchanged with the switch on", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone sizes");
  await signInSwitchedOn(page);
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-make")).toHaveCount(0);
  await noOverflow(page);
});
