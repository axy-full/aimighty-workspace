import { test, expect, type Page } from "@playwright/test";
import { openBoard } from "./helpers/boardV12";

/**
 * Storyboard in the new interface (demo plan PR 18; components/v12/board/StoryboardStage.tsx): one card per shot of the eight-shot film
 * (five drawn, one drawing, two not started), the style, ✓ and ✕, the board sheet, and drawing on the path that has always drawn frames:
 * each priced by the server, sent by one person's press at the figure on the button. Local ENGINE_MOCK server: a send goes to the mock
 * engine, which moves no money. At phone sizes the phone app is unchanged with the switch on.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const saved = (page: Page) => page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });
const cardOf = (page: Page, n: number) => page.locator(`[data-testid="v12-storyboard-stage"] [data-card^="frame-"]`).nth(n - 1);

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("a card per shot with its status; the style is kept in the draft; the price on the button is the server's; the sheet pages the frames", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=storyboard");
    const stage = page.getByTestId("v12-storyboard-stage");
    await expect(stage).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Storyboard");
    await expect(stage.getByTestId("v12-card")).toHaveCount(8);
    await expect(stage.getByTestId("v12-card-status")).toHaveText(["Ready", "Ready", "Ready", "Ready", "Ready", "Making…", "Not started", "Not started"]);
    await expect(stage.getByTestId("v12-storyboard-line")).toContainText("5 of 8 frames");

    /* The style is the board's own, kept in the draft. */
    await expect(stage.getByRole("radio", { name: "Live action" })).toBeChecked();
    const put = saved(page);
    await stage.getByRole("radio", { name: "Black & white sketch" }).click();
    await put;
    await expect(stage.getByRole("radio", { name: "Black & white sketch" })).toBeChecked();

    /* The one filled button: the two shots with no frame, at the figure the server quoted for each. */
    const draw = page.getByTestId("v12-storyboard-draw");
    await expect(draw).toHaveAttribute("data-spend", "priced", { timeout: 60_000 });
    await expect(draw).toHaveText(/^Draw 2 frames · (up to )?\d+ cr$|^Draw 2 frames · \$/);

    /* The board sheet: eight frames, two pages of six and two, then four a page, then one of nine. */
    await page.getByTestId("v12-storyboard-sheet").click();
    await expect(page.getByTestId("v12-sheet-page")).toHaveCount(2);
    await page.getByRole("radio", { name: "4 a page" }).click();
    await expect(page.getByTestId("v12-sheet-page")).toHaveCount(2);
    await page.getByRole("radio", { name: "9 a page" }).click();
    await expect(page.getByTestId("v12-sheet-page")).toHaveCount(1);
    await page.getByTestId("v12-dialog-close").click();
    await expect(page.getByTestId("v12-board-sheet")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("✓ and ✕ are kept for the picture; a frame's words are editable and kept", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=storyboard");
    const stage = page.getByTestId("v12-storyboard-stage");
    await expect(stage.getByTestId("v12-card")).toHaveCount(8, { timeout: 60_000 });
    const first = cardOf(page, 1);
    await first.hover();
    await first.locator('[data-mark="ok"]').click();
    await expect(first.getByTestId("v12-card-status")).toHaveText("✓ Approved");
    const second = cardOf(page, 2);
    await second.hover();
    await second.locator('[data-mark="no"]').click();
    await page.getByRole("button", { name: "Framing" }).click();
    await expect(second.getByTestId("v12-card-status")).toHaveText("✕ Framing");
    /* A ✕ puts the frame on the list to draw again: three to draw now, not two. */
    await expect(page.getByTestId("v12-storyboard-draw")).toContainText("Draw 3 frames", { timeout: 60_000 });

    await cardOf(page, 3).click();
    const words = page.getByTestId("v12-frame-words");
    await expect(words).toBeVisible();
    const put = saved(page);
    await words.fill("A wide of the harbour at first light, boats still tied up.");
    await page.getByTestId("v12-dialog-close").focus();
    await put;
    await page.getByTestId("v12-dialog-close").click();
    await cardOf(page, 3).click();
    await expect(page.getByTestId("v12-frame-words")).toHaveValue("A wide of the harbour at first light, boats still tied up.");
  });

  test("one press draws the missing frames at the shown price and a ✕ frame as a new take (the mock engine; nothing is spent)", async ({ page }) => {
    test.setTimeout(240_000);
    await openBoard(page, "/suites?view=board&stage=storyboard", { mockSends: true });
    const stage = page.getByTestId("v12-storyboard-stage");
    await expect(stage.getByTestId("v12-card")).toHaveCount(8, { timeout: 60_000 });
    const second = cardOf(page, 2);
    await second.hover();
    await second.locator('[data-mark="no"]').click();
    await page.getByRole("button", { name: "Light" }).click();
    const draw = page.getByTestId("v12-storyboard-draw");
    await expect(draw).toHaveAttribute("data-spend", "priced", { timeout: 60_000 });
    const sent: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/api\/generate$/.test(r.url())) sent.push(r.url()); });
    await draw.click();
    /* One send each for the two shots with no frame and the frame to draw again. */
    await expect.poll(() => sent.length, { timeout: 60_000 }).toBe(3);
    /* They land as pictures: the frame drawn again has a second version and no longer says ✕. */
    await expect(cardOf(page, 2).getByTestId("v12-card-status")).toHaveText("Ready · v2", { timeout: 180_000 });
    await expect(cardOf(page, 7).getByTestId("v12-card-status")).toHaveText("Ready", { timeout: 180_000 });
    await expect(cardOf(page, 8).getByTestId("v12-card-status")).toHaveText("Ready", { timeout: 180_000 });
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's board: no storyboard page", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=storyboard");
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-storyboard-stage")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
