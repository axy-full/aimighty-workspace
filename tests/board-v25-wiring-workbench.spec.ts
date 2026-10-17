import { test, expect, type Page } from "@playwright/test";
import { openShotsBoard } from "./helpers/shotsV12";

/*
 * v25 PR 7, wired: the board draws the v25 parts (BoardView; lib/v12/board/v25.ts) on a board behind the new-interface switch that opts in (the house, or `?v25=1`
 * from a listed workspace): the stepper rail from the board's own stages, the Shots step as v25 cards in a real layout grid, the preview on a double-click or Space,
 * and in Director mode the settings column and the bar. Agent mode names no engine anywhere on the screen. Real routes and a seeded Film board with eight shots
 * (three finished, two rendering, three with nothing yet); nothing is generated or spent. Phones keep today's phone board.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PATH = "/suites?view=board&stage=shots&v25=1";
const ENGINE_NAMES = /seedance|kling|veo|runway|nano banana|flux|gemini|imagen|sora|luma|higgsfield|fal\b|bytedance/i;
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const cards = (page: Page) => page.getByTestId("v25-shots-grid").locator('[data-testid="v12-card"]');

async function closeDock(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
}

async function open(page: Page, path = PATH) {
  const { errors } = await openShotsBoard(page, path);
  await expect(page.getByTestId("v25-shots-stage")).toBeVisible({ timeout: 90_000 });
  await closeDock(page);
  return errors;
}

test.describe("desktop, v25 on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("the rail is the board's eleven Film stages, and Shots draws the v25 cards with their statuses", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await open(page);
    const rail = page.getByTestId("v12-steprail");
    await expect(rail).toBeVisible();
    await expect(rail.locator(".v12-steprail-step")).toHaveCount(11);
    await expect(rail.locator(".v12-steprail-label")).toHaveText(["Treatment", "Pitch", "Brief", "Script", "Cast", "Locations", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]);
    await expect(rail.locator('[aria-current="step"]')).toContainText("Shots");
    /* The earlier rail is not drawn on a v25 board. */
    await expect(page.getByTestId("v12-stage-rail")).toHaveCount(0);
    await expect(cards(page)).toHaveCount(8);
    const status = cards(page).getByTestId("v12-card-status");
    await expect.poll(async () => (await status.allInnerTexts()).filter((t) => t === "Ready").length).toBe(3);
    expect((await status.allInnerTexts()).filter((t) => t === "Making…")).toHaveLength(2);
    expect((await status.allInnerTexts()).filter((t) => t === "Not started")).toHaveLength(3);
    /* A press on the rail opens that stage (the address changes, as on the earlier rail). */
    await rail.locator('[data-step="brief"]').click();
    await expect(page).toHaveURL(/stage=brief/);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Agent is the default: no column, no bar of Director's, the ask bar over the grid, and no engine named anywhere", async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    await expect(page.getByTestId("v12-mode-switch").getByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("v12-director-column")).toHaveCount(0);
    await expect(page.getByTestId("v12-director-bar")).toHaveCount(0);
    const bar = page.getByTestId("v12-board-bar");
    await expect(bar).toBeVisible();
    /* The ask bar is reachable: it is the element on top at its centre, not the grid under it. */
    const onTop = await bar.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && el.contains(top); });
    expect(onTop).toBe(true);
    /* Owner, 16 Oct: Agent mode names no engine anywhere: not on a card, not in a tooltip, not in the preview, not on the rail. */
    const words = async () => (await page.getByTestId("v25-shots-stage").innerText()) + " " + (await page.getByTestId("v12-steprail").innerText()) + " " + (await page.getByTestId("v12-stage-header").innerText());
    expect(await words()).not.toMatch(ENGINE_NAMES);
    await cards(page).first().hover();
    await cards(page).first().getByRole("button", { name: /^Approve/ }).hover();
    await expect(page.getByTestId("v12-tooltip")).toBeVisible();
    expect(await page.getByTestId("v12-tooltip").innerText()).not.toMatch(ENGINE_NAMES);
    await cards(page).first().dblclick();
    await expect(page.getByTestId("v12-preview")).toBeVisible();
    expect(await page.getByTestId("v12-preview").innerText()).not.toMatch(ENGINE_NAMES);
    expect(await page.getByTestId("v12-preview").getAttribute("aria-label")).not.toMatch(ENGINE_NAMES);
    await expect(page.getByTestId("v12-preview-title")).toContainText("Opening wide");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-preview")).toHaveCount(0);
  });

  test("Space on a focused card opens the preview; arrows step through the shots", async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    await cards(page).nth(1).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("v12-preview-title")).toContainText("The walk");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("v12-preview-title")).toContainText("The rope");
    await page.keyboard.press("Escape");
    await expect(cards(page).nth(1)).toBeFocused();
  });

  test("Director mode: the column, the pill and the bar appear, say the same words, narrow to a selected shot, and the mode is kept", async ({ page }) => {
    test.setTimeout(240_000);
    await open(page);
    await page.getByTestId("v12-mode-switch").getByRole("radio", { name: "Director" }).click();
    const column = page.getByTestId("v12-director-column");
    await expect(column).toBeVisible();
    /* Owner, 16 Oct 2026, 2a: no Auto engine in Director; the model line opens empty and Render stays off until one is picked (PR 9's pop-up). */
    await expect(page.getByTestId("v12-director-model")).toContainText("None");
    await expect(page.getByTestId("v12-director-model")).not.toContainText("Auto");
    await expect(page.getByTestId("v12-director-go")).toBeDisabled();
    await expect(page.getByTestId("v12-director-go")).not.toHaveAttribute("data-spend", /.*/);
    await expect(page.getByTestId("v12-director-scope")).toHaveText("All 8 shots");
    await expect(page.getByTestId("v12-director-column-scope")).toHaveText("All 8 shots");
    /* The ask bar sits inside Director's bar beside its one filled button. */
    await expect(page.getByTestId("v12-director-bar").getByTestId("v12-board-bar")).toBeVisible();
    await expect(page.getByTestId("v12-director-bar").locator("button.v12-dirbar-go")).toHaveCount(1);
    /* A selected shot narrows all three; a setting on it is a chip on that card only. */
    await cards(page).nth(1).click();
    await expect(page.getByTestId("v12-director-scope")).toHaveText("Shot 2");
    await expect(page.getByTestId("v12-director-column-scope")).toHaveText("Shot 2");
    await page.getByTestId("v12-director-quality").click();
    await page.getByTestId("v12-director-popup").getByRole("radio", { name: "Draft", exact: true }).click();
    await expect(cards(page).nth(1).locator(".v12-card-chip")).toHaveText(["Draft"]);
    await expect(cards(page).nth(0).locator(".v12-card-chip")).toHaveCount(0);
    /* Kept in the draft, per person: after a reload the board is still in Director, with the chip. */
    await expect.poll(async () => { await page.waitForTimeout(1500); return page.evaluate(() => document.title); }, { timeout: 10_000 }).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("v25-shots-stage")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-mode-switch").getByRole("radio", { name: "Director" })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await expect(cards(page).nth(1).locator(".v12-card-chip")).toHaveText(["Draft"], { timeout: 30_000 });
    /* Director shows the preview's note. */
    await cards(page).nth(0).dblclick();
    await expect(page.getByTestId("v12-preview")).toBeVisible();
    await expect(page.getByTestId("v12-preview")).toContainText("The column and the bar act on this shot.");
    expect(await noSideways(page)).toBe(true);
  });

  test("a board without the opt-in keeps the earlier parts: the earlier rail and the canvas cards", async ({ page }) => {
    test.setTimeout(180_000);
    await openShotsBoard(page, "/suites?view=board&stage=shots");
    await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
    await expect(page.getByTestId("v12-steprail")).toHaveCount(0);
    await expect(page.getByTestId("v25-shots-stage")).toHaveCount(0);
    await expect(page.getByTestId("v12-mode-switch")).toHaveCount(0);
  });
});

test.describe("phones", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("a phone keeps today's phone board: none of the v25 parts", async ({ page }) => {
    test.setTimeout(180_000);
    await openShotsBoard(page, PATH);
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v25-shots-stage")).toHaveCount(0);
    await expect(page.getByTestId("v12-steprail")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});

test.describe("the large screens", () => {
  test("1728×1117 and 2560×1440: the grid gains columns, the rail and the bar are inside the window, nothing is scaled", async ({ page }, info) => {
    test.skip(info.project.name !== "workbench-1920x1080", "the large sizes are set here, once");
    test.setTimeout(240_000);
    await open(page);
    await page.getByTestId("v12-mode-switch").getByRole("radio", { name: "Director" }).click();
    await expect(page.getByTestId("v12-director-bar")).toBeVisible();
    for (const [width, height, columns] of [[1728, 1117, 4], [2560, 1440, 6]] as const) {
      await page.setViewportSize({ width, height });
      await expect(cards(page)).toHaveCount(8);
      const across = await cards(page).evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size);
      expect(across, `${width}: columns`).toBeGreaterThanOrEqual(columns - 1);
      for (const id of ["v12-steprail", "v12-director-column", "v12-director-go"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, `${width}: ${id} inside the window`).toBe(true);
      }
      /* No scale on anything with text: the cards and the bar carry no transform. */
      const transforms = await page.getByTestId("v25-shots-stage").evaluate((root) => [...root.querySelectorAll<HTMLElement>("*")].filter((el) => { const t = getComputedStyle(el).transform; return t !== "none" && (el.textContent ?? "").trim().length > 0 && !el.closest("[data-testid=v12-preview]"); }).map((el) => el.className.toString().slice(0, 40)));
      expect(transforms, `${width}: a transform over text`).toEqual([]);
      expect(await noSideways(page), `${width}: sideways`).toBe(true);
    }
  });
});
